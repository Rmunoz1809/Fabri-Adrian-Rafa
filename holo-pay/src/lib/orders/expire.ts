import type { PrismaClient } from "@prisma/client";
import { transitionOrder } from "./transition";

/**
 * Expires pending orders whose expiresAt has passed and releases their stock.
 * Safe to run concurrently or repeatedly: each order moves only if it is still pending.
 * A payment ("E") that arrives later is handled by the IPN (→ under_review).
 */
export async function expireOrders(db: PrismaClient, now: Date = new Date(), batch = 200): Promise<{ expired: string[] }> {
  const due = await db.order.findMany({
    where: { status: "pending_payment", expiresAt: { lte: now } },
    select: { id: true, publicId: true },
    orderBy: { expiresAt: "asc" },
    take: batch,
  });
  const expired: string[] = [];
  for (const o of due) {
    const r = await transitionOrder(db, { orderId: o.id, from: "pending_payment", to: "expired", reason: "expiry_job" });
    if (r.ok) expired.push(o.publicId);
  }
  if (expired.length) console.info(`[expire] ${expired.length} order(s) expired`);
  return { expired };
}

/** Expires a single order if it is due (used when the buyer's page polls its status). */
export async function expireIfDue(db: PrismaClient, order: { id: string; status: string; expiresAt: Date }, now: Date = new Date()) {
  if (order.status !== "pending_payment" || order.expiresAt > now) return false;
  const r = await transitionOrder(db, { orderId: order.id, from: "pending_payment", to: "expired", reason: "expired_on_status_check" });
  return r.ok;
}
