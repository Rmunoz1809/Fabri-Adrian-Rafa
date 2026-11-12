/**
 * Order state machine: the single source of truth for which status changes are allowed.
 *
 * Happy path:
 *   pending_payment → paid → seller_notified → shipped → delivered → payout_released
 * Side exits:
 *   expired, cancelled, rejected (from pending_payment), refunded, under_review.
 *
 * Nothing may skip a step (e.g. paid → shipped is rejected). under_review is where a human
 * decides what to do with a payment that doesn't add up (late "E" on an expired order, etc.).
 */

export const ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "seller_notified",
  "shipped",
  "delivered",
  "payout_released",
  "expired",
  "cancelled",
  "rejected",
  "refunded",
  "under_review",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  // Yappy IPN: E → paid, R → rejected, C → cancelled, X → expired. The expiry job → expired.
  pending_payment: ["paid", "rejected", "cancelled", "expired", "under_review"],
  paid: ["seller_notified", "refunded", "under_review"],
  seller_notified: ["shipped", "refunded", "under_review"],
  shipped: ["delivered", "refunded", "under_review"],
  delivered: ["payout_released", "refunded", "under_review"],
  // A payment ("E") that arrives after the order was closed goes to a human.
  expired: ["under_review"],
  cancelled: ["under_review"],
  rejected: ["under_review"],
  // A human reactivates the order (there is stock) or refunds the buyer.
  under_review: ["paid", "refunded"],
  payout_released: [],
  refunded: [],
};

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set(
  ORDER_STATUSES.filter((s) => TRANSITIONS[s].length === 0),
);

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function allowedNext(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Order cannot move from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export type StockAction = "reserve" | "release" | "consume" | "none";

/**
 * What a transition does to the listing's stock, given whether the order currently holds a unit.
 * - reserve: take one unit from the listing (needs stock > 0); the order now holds it.
 * - release: give the unit back to the listing.
 * - consume: the order stops holding the unit but it doesn't go back (the card already shipped).
 * - none: no change.
 */
export function stockAction(from: OrderStatus, to: OrderStatus, stockHeld: boolean): StockAction {
  assertTransition(from, to);
  if (to === "expired" || to === "cancelled" || to === "rejected") return stockHeld ? "release" : "none";
  if (to === "refunded") {
    if (!stockHeld) return "none";
    return from === "shipped" || from === "delivered" ? "consume" : "release";
  }
  // A human reactivates a late payment: it needs a unit again.
  if (to === "paid" && from === "under_review") return stockHeld ? "none" : "reserve";
  return "none";
}

/** Whether the order holds a unit after applying `action`. */
export function stockHeldAfter(stockHeld: boolean, action: StockAction): boolean {
  if (action === "reserve") return true;
  if (action === "release" || action === "consume") return false;
  return stockHeld;
}
