import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { orderAmounts } from "@/lib/money";
import { normalizePanamaMobile } from "@/lib/phone";
import type { YappyClient } from "@/lib/yappy/client";
import { generatePublicId } from "./public-id";
import { syncListingStatus, transitionOrder } from "./transition";

/** Yappy keeps the order open 5 minutes; we give it one more before expiring it. */
export const ORDER_TTL_MS = 6 * 60_000;

/**
 * The only fields a client may send. Amounts are NOT accepted: anything else in the body is
 * dropped, and the price always comes from the listing in the database.
 */
export const createOrderInput = z.object({
  listingId: z.string().trim().min(1).max(64),
  buyerPhone: z
    .string()
    .max(30)
    .transform((v, ctx) => {
      const phone = normalizePanamaMobile(v);
      if (!phone) {
        ctx.addIssue({ code: "custom", message: "Escribe un celular de Panamá de 8 dígitos que empiece con 6." });
        return z.NEVER;
      }
      return phone;
    }),
});

export type CreateOrderResult =
  | {
      ok: true;
      order: { publicId: string; status: string; itemCents: number; shippingCents: number; totalCents: number; expiresAt: string };
      yappy: { transactionId: string; token: string; documentName: string };
    }
  | { ok: false; status: number; error: string; code?: string };

const NOT_AVAILABLE = "Esta carta ya no está disponible.";

export async function createOrder(
  db: PrismaClient,
  yappy: YappyClient,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<CreateOrderResult> {
  const parsed = createOrderInput.safeParse(rawInput);
  if (!parsed.success) return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  const { listingId, buyerPhone } = parsed.data;

  // Reserve one unit and create the order atomically.
  let order;
  try {
    order = await db.$transaction(async (tx) => {
      const listing = await tx.listing.findUnique({ where: { id: listingId } });
      if (!listing || listing.status === "sold") return null;
      const reserved = await tx.listing.updateMany({ where: { id: listingId, stock: { gt: 0 } }, data: { stock: { decrement: 1 } } });
      if (reserved.count !== 1) return null;
      const amounts = orderAmounts(listing.priceCents);
      const created = await createWithUniquePublicId(tx, {
        listingId,
        buyerPhone,
        ...amounts,
        status: "pending_payment",
        stockHeld: true,
        expiresAt: new Date(now.getTime() + ORDER_TTL_MS),
      });
      await syncListingStatus(tx, listingId);
      return created;
    });
  } catch (e) {
    console.error("[orders] create failed:", e instanceof Error ? e.message : e);
    return { ok: false, status: 500, error: "No pudimos crear la orden. Inténtalo de nuevo." };
  }
  if (!order) return { ok: false, status: 409, error: NOT_AVAILABLE };

  const payment = await yappy.createPayment({
    orderId: order.publicId,
    aliasYappy: buyerPhone,
    subtotalCents: order.subtotalCents,
    taxesCents: order.taxesCents,
    discountCents: 0,
    totalCents: order.totalCents,
  });

  if (!payment.ok) {
    // Yappy never registered the payment: close the order and give the unit back.
    await transitionOrder(db, { orderId: order.id, from: "pending_payment", to: "cancelled", reason: `yappy_error:${payment.code}` });
    return { ok: false, status: payment.code === "E005" ? 422 : 502, error: payment.message, code: payment.code };
  }

  await db.order.update({ where: { id: order.id }, data: { yappyTransactionId: payment.transactionId } });
  return {
    ok: true,
    order: {
      publicId: order.publicId,
      status: order.status,
      itemCents: order.itemCents,
      shippingCents: order.shippingCents,
      totalCents: order.totalCents,
      expiresAt: order.expiresAt.toISOString(),
    },
    yappy: { transactionId: payment.transactionId, token: payment.token, documentName: payment.documentName },
  };
}

/** Retries on the (astronomically rare) publicId collision. */
async function createWithUniquePublicId(tx: Prisma.TransactionClient, data: Omit<Prisma.OrderUncheckedCreateInput, "publicId">) {
  for (let attempt = 0; ; attempt++) {
    const publicId = generatePublicId();
    if (await tx.order.findUnique({ where: { publicId }, select: { id: true } })) {
      if (attempt >= 5) throw new Error("could not generate a unique publicId");
      continue;
    }
    return tx.order.create({ data: { ...data, publicId } });
  }
}
