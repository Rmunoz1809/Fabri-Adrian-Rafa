import type { IpnResult, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { SellerNotifier } from "@/lib/notify/seller";
import type { OrderStatus } from "@/lib/orders/state-machine";
import { transitionOrder } from "@/lib/orders/transition";
import { verifyIpnSignature } from "./signature";

/** Yappy IPN status letters → order status. */
const STATUS_MAP: Record<string, OrderStatus> = { E: "paid", R: "rejected", C: "cancelled", X: "expired" };

/** Statuses that mean the payment was already accepted (a repeated "E" is a no-op). */
const ALREADY_PAID: OrderStatus[] = ["paid", "seller_notified", "shipped", "delivered", "payout_released", "under_review", "refunded"];
/** Closed without payment: a late "E" here needs a human. */
const CLOSED_UNPAID: OrderStatus[] = ["expired", "cancelled", "rejected"];

const ipnQuery = z.object({
  orderId: z.string().min(1).max(64),
  status: z.string().min(1).max(4),
  hash: z.string().min(1).max(256),
  domain: z.string().min(1).max(512),
  confirmationNumber: z.string().max(128).optional(),
});

export type IpnOutcome = { result: IpnResult; eventId: string; orderPublicId?: string };

/**
 * Handles one Yappy IPN. Steps, in order:
 * a) store the raw event (always, even if invalid);
 * b) verify the HMAC signature (constant time); invalid → nothing changes;
 * c) find the order by publicId;
 * d) amounts come only from the database (the IPN has none);
 * e/f) apply the status atomically and idempotently through transitionOrder().
 */
export async function handleIpn(
  db: PrismaClient,
  query: Record<string, string>,
  opts: { secretKey: string; notifier: SellerNotifier; now?: Date },
): Promise<IpnOutcome> {
  const now = opts.now ?? new Date();
  const q = (k: string) => (typeof query[k] === "string" ? query[k].slice(0, 512) : null);

  // a) Raw log first.
  const event = await db.paymentEvent.create({
    data: {
      receivedOrderId: q("orderId"),
      status: q("status"),
      hash: q("hash"),
      domain: q("domain"),
      confirmationNumber: q("confirmationNumber"),
      rawQuery: JSON.stringify(query),
    },
  });
  const finish = async (result: IpnResult, orderId?: string, orderPublicId?: string): Promise<IpnOutcome> => {
    await db.paymentEvent.update({ where: { id: event.id }, data: { result, orderId } });
    if (result !== "valid" && result !== "duplicate") console.warn(`[ipn] ${result} for orderId=${q("orderId") ?? "-"}`);
    return { result, eventId: event.id, orderPublicId };
  };

  const parsed = ipnQuery.safeParse(query);
  if (!parsed.success) return finish("malformed");
  const ipn = parsed.data;

  // b) Signature.
  if (!verifyIpnSignature(ipn, opts.secretKey)) return finish("invalid_signature");

  // c) Order.
  const order = await db.order.findUnique({
    where: { publicId: ipn.orderId },
    include: { listing: { include: { seller: true } } },
  });
  if (!order) return finish("order_not_found");

  const target = STATUS_MAP[ipn.status.toUpperCase()];
  if (!target) return finish("invalid_status", order.id, order.publicId);

  // e/f) Apply. Re-read once if someone else moved the order meanwhile.
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = attempt === 0 ? order.status : (await db.order.findUniqueOrThrow({ where: { id: order.id } })).status;

    if (current === "pending_payment") {
      const r = await transitionOrder(db, {
        orderId: order.id,
        from: "pending_payment",
        to: target,
        reason: `yappy_ipn:${ipn.status}`,
        data: target === "paid" ? { paidAt: now, yappyConfirmationNumber: ipn.confirmationNumber ?? null } : undefined,
      });
      if (!r.ok) continue; // stale: re-read
      if (target === "paid") await notifySeller(db, opts.notifier, order);
      return finish("valid", order.id, order.publicId);
    }

    if (target === "paid") {
      if (ALREADY_PAID.includes(current)) return finish("duplicate", order.id, order.publicId);
      if (CLOSED_UNPAID.includes(current)) {
        // Paid after we closed it: a human decides (reactivate if stock, or refund).
        const r = await transitionOrder(db, {
          orderId: order.id,
          from: current,
          to: "under_review",
          reason: `yappy_ipn:E_after_${current}`,
          data: { paidAt: now, yappyConfirmationNumber: ipn.confirmationNumber ?? null },
        });
        if (!r.ok) continue;
        return finish("late_payment", order.id, order.publicId);
      }
    }
    if (current === target) return finish("duplicate", order.id, order.publicId);
    return finish("invalid_transition", order.id, order.publicId);
  }
  return finish("invalid_transition", order.id, order.publicId);
}

async function notifySeller(
  db: PrismaClient,
  notifier: SellerNotifier,
  order: { id: string; publicId: string; totalCents: number; listing: { title: string; seller: { name: string } } },
) {
  try {
    await notifier.orderPaid({
      publicId: order.publicId,
      listingTitle: order.listing.title,
      sellerName: order.listing.seller.name,
      totalCents: order.totalCents,
    });
    await transitionOrder(db, { orderId: order.id, from: "paid", to: "seller_notified", reason: "seller_notified" });
  } catch (e) {
    // The payment stands; the order stays "paid" and shows up for staff to notify by hand.
    console.error(`[ipn] seller notification failed for ${order.publicId}:`, e instanceof Error ? e.message : e);
  }
}
