import type { Prisma, PrismaClient } from "@prisma/client";
import {
  assertTransition,
  stockAction,
  stockHeldAfter,
  type OrderStatus,
} from "./state-machine";

/** Statuses after payment in which a listing with no stock left counts as sold. */
const SOLD_STATUSES: OrderStatus[] = ["paid", "seller_notified", "shipped", "delivered", "payout_released"];

type Tx = Prisma.TransactionClient;

/** Extra columns that may be written together with a status change (never status/stock/amounts). */
export type TransitionData = Pick<
  Prisma.OrderUpdateManyMutationInput,
  "paidAt" | "yappyTransactionId" | "yappyConfirmationNumber"
>;

export type TransitionResult =
  | { ok: true; from: OrderStatus; to: OrderStatus }
  /** The order was not in `from` any more (already moved, e.g. a duplicate IPN). Nothing changed. */
  | { ok: false; error: "stale" }
  /** Reactivating needs a unit of stock and there is none. Nothing changed. */
  | { ok: false; error: "no_stock" }
  | { ok: false; error: "not_found" };

class Rollback extends Error {
  constructor(readonly result: TransitionResult) {
    super(result.ok ? "ok" : result.error);
  }
}

/**
 * The only way to change an order's status. Atomic and idempotent:
 * the UPDATE only matches while the order is still in `from` (UPDATE ... WHERE status = from),
 * so two concurrent or repeated calls can't both apply. Stock and the listing status move in the
 * same transaction, and every change is written to OrderTransition.
 *
 * Throws InvalidTransitionError if `from → to` is not allowed by the state machine.
 */
export async function transitionOrder(
  db: PrismaClient,
  args: { orderId: string; from: OrderStatus; to: OrderStatus; reason: string; data?: TransitionData },
): Promise<TransitionResult> {
  const { orderId, from, to, reason, data } = args;
  assertTransition(from, to);
  try {
    return await db.$transaction((tx) => applyTransition(tx, { orderId, from, to, reason, data }));
  } catch (e) {
    if (e instanceof Rollback) return e.result;
    throw e;
  }
}

async function applyTransition(
  tx: Tx,
  { orderId, from, to, reason, data }: { orderId: string; from: OrderStatus; to: OrderStatus; reason: string; data?: TransitionData },
): Promise<TransitionResult> {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, stockHeld: true, listingId: true } });
  if (!order) return { ok: false, error: "not_found" };
  if (order.status !== from) return { ok: false, error: "stale" };

  const action = stockAction(from, to, order.stockHeld);
  // Conditional on the state we just read: if anything changed in between, count is 0.
  const updated = await tx.order.updateMany({
    where: { id: orderId, status: from, stockHeld: order.stockHeld },
    data: { ...data, status: to, stockHeld: stockHeldAfter(order.stockHeld, action) },
  });
  if (updated.count !== 1) return { ok: false, error: "stale" };

  if (action === "release") {
    await tx.listing.update({ where: { id: order.listingId }, data: { stock: { increment: 1 } } });
  } else if (action === "reserve") {
    const reserved = await tx.listing.updateMany({
      where: { id: order.listingId, stock: { gt: 0 } },
      data: { stock: { decrement: 1 } },
    });
    if (reserved.count !== 1) throw new Rollback({ ok: false, error: "no_stock" });
  }

  await tx.orderTransition.create({ data: { orderId, fromStatus: from, toStatus: to, reason } });
  await syncListingStatus(tx, order.listingId);
  return { ok: true, from, to };
}

/**
 * Listing status follows its stock: active while units are left; with none left, sold if a paid
 * order holds the last unit, otherwise reserved (a payment is pending).
 */
export async function syncListingStatus(tx: Tx, listingId: string): Promise<void> {
  const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId }, select: { stock: true } });
  let status: "active" | "reserved" | "sold" = "active";
  if (listing.stock <= 0) {
    const paid = await tx.order.count({ where: { listingId, stockHeld: true, status: { in: SOLD_STATUSES } } });
    status = paid > 0 ? "sold" : "reserved";
  }
  await tx.listing.update({ where: { id: listingId }, data: { status } });
}
