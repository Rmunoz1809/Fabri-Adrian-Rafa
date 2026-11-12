import { OrderStatus as PrismaOrderStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  allowedNext,
  assertTransition,
  canTransition,
  InvalidTransitionError,
  ORDER_STATUSES,
  stockAction,
  TERMINAL_STATUSES,
  type OrderStatus,
} from "./state-machine";

const HAPPY: OrderStatus[] = ["pending_payment", "paid", "seller_notified", "shipped", "delivered", "payout_released"];

describe("order state machine", () => {
  it("matches the Prisma OrderStatus enum exactly", () => {
    expect([...ORDER_STATUSES].sort()).toEqual(Object.values(PrismaOrderStatus).sort());
  });

  it("allows the happy path step by step", () => {
    for (let i = 0; i < HAPPY.length - 1; i++) expect(canTransition(HAPPY[i], HAPPY[i + 1])).toBe(true);
  });

  it("never lets an order skip a step forward", () => {
    for (let i = 0; i < HAPPY.length; i++)
      for (let j = i + 2; j < HAPPY.length; j++) expect(canTransition(HAPPY[i], HAPPY[j]), `${HAPPY[i]}→${HAPPY[j]}`).toBe(false);
  });

  it("never moves backwards on the happy path", () => {
    for (let i = 1; i < HAPPY.length; i++)
      for (let j = 0; j < i; j++) expect(canTransition(HAPPY[i], HAPPY[j]), `${HAPPY[i]}→${HAPPY[j]}`).toBe(false);
  });

  it("maps every Yappy IPN outcome from pending_payment", () => {
    for (const to of ["paid", "rejected", "cancelled", "expired"] as const) expect(canTransition("pending_payment", to)).toBe(true);
  });

  it("sends a late payment on a closed order to review, not to paid", () => {
    for (const from of ["expired", "cancelled", "rejected"] as const) {
      expect(canTransition(from, "paid")).toBe(false);
      expect(canTransition(from, "under_review")).toBe(true);
    }
  });

  it("lets a human resolve a review by reactivating or refunding only", () => {
    expect([...allowedNext("under_review")].sort()).toEqual(["paid", "refunded"]);
  });

  it("only refunds money that was received", () => {
    expect(canTransition("pending_payment", "refunded")).toBe(false);
    expect(canTransition("expired", "refunded")).toBe(false);
    expect(canTransition("paid", "refunded")).toBe(true);
  });

  it("has payout_released and refunded as the only terminal states", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["payout_released", "refunded"]);
  });

  it("forbids self-transitions", () => {
    for (const s of ORDER_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("throws InvalidTransitionError with both states", () => {
    expect(() => assertTransition("pending_payment", "shipped")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("pending_payment", "shipped")).toThrow("pending_payment to shipped");
    expect(() => assertTransition("pending_payment", "paid")).not.toThrow();
  });
});

describe("stockAction", () => {
  it("releases the unit when a pending order is rejected, cancelled or expired", () => {
    for (const to of ["rejected", "cancelled", "expired"] as const) expect(stockAction("pending_payment", to, true)).toBe("release");
  });
  it("keeps the unit while the order is paid and moving", () => {
    expect(stockAction("pending_payment", "paid", true)).toBe("none");
    expect(stockAction("paid", "seller_notified", true)).toBe("none");
  });
  it("releases on refund before shipping, consumes after shipping", () => {
    expect(stockAction("paid", "refunded", true)).toBe("release");
    expect(stockAction("seller_notified", "refunded", true)).toBe("release");
    expect(stockAction("shipped", "refunded", true)).toBe("consume");
  });
  it("never releases twice", () => {
    expect(stockAction("expired", "under_review", false)).toBe("none");
    expect(stockAction("under_review", "refunded", false)).toBe("none");
  });
  it("reserves again when a reviewed late payment is reactivated", () => {
    expect(stockAction("under_review", "paid", false)).toBe("reserve");
  });
  it("rejects invalid transitions", () => {
    expect(() => stockAction("pending_payment", "shipped", true)).toThrow(InvalidTransitionError);
  });
});
