import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedListing, seedPendingOrder } from "@/test/db";
import { InvalidTransitionError } from "./state-machine";
import { transitionOrder } from "./transition";

const t = createTestDb();
const db = t.db;
afterAll(t.cleanup);

describe("transitionOrder", () => {
  let listingId: string;
  beforeAll(async () => {
    listingId = (await seedListing(db, { stock: 2 })).id;
  });

  it("marks a pending order paid, logs it, and keeps the unit reserved", async () => {
    const order = await seedPendingOrder(db, listingId);
    const paidAt = new Date();
    const r = await transitionOrder(db, { orderId: order.id, from: "pending_payment", to: "paid", reason: "test", data: { paidAt } });
    expect(r).toEqual({ ok: true, from: "pending_payment", to: "paid" });
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { transitions: true } });
    expect(after.status).toBe("paid");
    expect(after.stockHeld).toBe(true);
    expect(after.paidAt?.getTime()).toBe(paidAt.getTime());
    expect(after.transitions).toMatchObject([{ fromStatus: "pending_payment", toStatus: "paid", reason: "test" }]);
  });

  it("is idempotent: a repeated call is a no-op", async () => {
    const order = await seedPendingOrder(db, listingId);
    await transitionOrder(db, { orderId: order.id, from: "pending_payment", to: "expired", reason: "1" });
    const stockAfterFirst = (await db.listing.findUniqueOrThrow({ where: { id: listingId } })).stock;
    const r = await transitionOrder(db, { orderId: order.id, from: "pending_payment", to: "expired", reason: "2" });
    expect(r).toEqual({ ok: false, error: "stale" });
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).stock).toBe(stockAfterFirst);
    expect(await db.orderTransition.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("refuses to skip states, before touching the database", async () => {
    const order = await seedPendingOrder(db, listingId);
    await expect(transitionOrder(db, { orderId: order.id, from: "pending_payment", to: "shipped", reason: "x" })).rejects.toThrow(
      InvalidTransitionError,
    );
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("pending_payment");
  });

  it("returns not_found for an unknown order", async () => {
    expect(await transitionOrder(db, { orderId: "nope", from: "pending_payment", to: "paid", reason: "x" })).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});

describe("stock and listing status", () => {
  it("reserves → releases on expiry, and the listing goes reserved → active", async () => {
    const listing = await seedListing(db, { stock: 1 });
    const order = await seedPendingOrder(db, listing.id);
    // seedPendingOrder doesn't sync the status; a paid transition elsewhere would. Check after expiry.
    await transitionOrder(db, { orderId: order.id, from: "pending_payment", to: "expired", reason: "expiry" });
    const l = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.stock).toBe(1);
    expect(l.status).toBe("active");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).stockHeld).toBe(false);
  });

  it("marks the listing sold when the last unit is paid", async () => {
    const listing = await seedListing(db, { stock: 1 });
    const order = await seedPendingOrder(db, listing.id);
    await transitionOrder(db, { orderId: order.id, from: "pending_payment", to: "paid", reason: "ipn" });
    expect((await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe("sold");
  });

  it("reactivating a reviewed late payment needs stock, and takes it", async () => {
    const listing = await seedListing(db, { stock: 1 });
    const order = await seedPendingOrder(db, listing.id);
    await transitionOrder(db, { orderId: order.id, from: "pending_payment", to: "expired", reason: "expiry" });
    await transitionOrder(db, { orderId: order.id, from: "expired", to: "under_review", reason: "late E" });

    // Someone else bought the last unit in the meantime.
    const other = await seedPendingOrder(db, listing.id);
    expect(await transitionOrder(db, { orderId: order.id, from: "under_review", to: "paid", reason: "staff" })).toEqual({
      ok: false,
      error: "no_stock",
    });
    // Rolled back completely.
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.status).toBe("under_review");
    expect(o.stockHeld).toBe(false);

    // The other buyer's payment expires: the unit is back, reactivation works.
    await transitionOrder(db, { orderId: other.id, from: "pending_payment", to: "expired", reason: "expiry" });
    expect(await transitionOrder(db, { orderId: order.id, from: "under_review", to: "paid", reason: "staff" })).toMatchObject({ ok: true });
    const l = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.stock).toBe(0);
    expect(l.status).toBe("sold");
  });

  it("refund before shipping puts the unit back", async () => {
    const listing = await seedListing(db, { stock: 1 });
    const order = await seedPendingOrder(db, listing.id);
    await transitionOrder(db, { orderId: order.id, from: "pending_payment", to: "paid", reason: "ipn" });
    await transitionOrder(db, { orderId: order.id, from: "paid", to: "refunded", reason: "staff" });
    const l = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.stock).toBe(1);
    expect(l.status).toBe("active");
  });
});
