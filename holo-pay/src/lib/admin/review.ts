import type { IpnResult, PrismaClient } from "@prisma/client";

/** IPN outcomes a human should look at. */
export const SUSPICIOUS_RESULTS: IpnResult[] = [
  "invalid_signature",
  "order_not_found",
  "duplicate",
  "invalid_transition",
  "invalid_status",
  "malformed",
  "late_payment",
];

/** Everything in the "pagos por revisar" queue. */
export async function reviewQueue(db: PrismaClient) {
  const [underReview, stuckPaid, events] = await Promise.all([
    db.order.findMany({ where: { status: "under_review" }, include: { listing: true }, orderBy: { updatedAt: "asc" } }),
    // Paid but the seller notification failed.
    db.order.findMany({ where: { status: "paid" }, include: { listing: true }, orderBy: { paidAt: "asc" } }),
    db.paymentEvent.findMany({
      where: { resolvedAt: null, result: { in: SUSPICIOUS_RESULTS } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);
  return { underReview, stuckPaid, events };
}

export async function resolveEvent(db: PrismaClient, eventId: string, note: string, now: Date = new Date()) {
  const r = await db.paymentEvent.updateMany({
    where: { id: eventId, resolvedAt: null },
    data: { resolvedAt: now, resolvedNote: note.slice(0, 500) || "resuelto" },
  });
  return r.count === 1;
}
