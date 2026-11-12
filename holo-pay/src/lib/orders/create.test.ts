import { afterAll, describe, expect, it } from "vitest";
import { createTestDb, seedListing } from "@/test/db";
import { MockYappyClient } from "@/lib/yappy/client";
import { YAPPY_ERRORS } from "@/lib/yappy/errors";
import { createOrder, ORDER_TTL_MS } from "./create";

const t = createTestDb();
const db = t.db;
afterAll(t.cleanup);

describe("createOrder", () => {
  it("creates a pending order with server-side amounts + $3 shipping, reserves stock and calls Yappy", async () => {
    const listing = await seedListing(db, { priceCents: 10500, stock: 1 });
    const yappy = new MockYappyClient();
    const now = new Date("2026-11-12T15:00:00Z");
    const r = await createOrder(db, yappy, { listingId: listing.id, buyerPhone: "6123-4567" }, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order).toMatchObject({ status: "pending_payment", itemCents: 10500, shippingCents: 300, totalCents: 10800 });
    expect(new Date(r.order.expiresAt).getTime()).toBe(now.getTime() + ORDER_TTL_MS);
    expect(yappy.calls[0]).toEqual({ orderId: r.order.publicId, aliasYappy: "61234567", subtotalCents: 10800, taxesCents: 0, discountCents: 0, totalCents: 10800 });

    const order = await db.order.findUniqueOrThrow({ where: { publicId: r.order.publicId } });
    expect(order.yappyTransactionId).toBe(`MOCK-${r.order.publicId}`);
    expect(order.buyerPhone).toBe("61234567");
    const l = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.stock).toBe(0);
    expect(l.status).toBe("reserved");
  });

  it("never lets the client set the amount", async () => {
    const listing = await seedListing(db, { priceCents: 25000, stock: 1 });
    const yappy = new MockYappyClient();
    const r = await createOrder(db, yappy, {
      listingId: listing.id,
      buyerPhone: "61234567",
      totalCents: 1,
      subtotalCents: 1,
      priceCents: 1,
      shippingCents: 0,
      taxesCents: 0,
      total: "0.01",
    });
    expect(r.ok && r.order.totalCents).toBe(25300);
    expect(yappy.calls[0].totalCents).toBe(25300);
    const order = await db.order.findFirstOrThrow({ where: { listingId: listing.id } });
    expect(order.totalCents).toBe(25300);
    expect(order.itemCents).toBe(25000);
  });

  it("refuses when there is no stock left", async () => {
    const listing = await seedListing(db, { stock: 1 });
    const yappy = new MockYappyClient();
    expect((await createOrder(db, yappy, { listingId: listing.id, buyerPhone: "61234567" })).ok).toBe(true);
    const second = await createOrder(db, yappy, { listingId: listing.id, buyerPhone: "61234568" });
    expect(second).toMatchObject({ ok: false, status: 409 });
    expect(yappy.calls).toHaveLength(1);
  });

  it("refuses an unknown listing", async () => {
    expect(await createOrder(db, new MockYappyClient(), { listingId: "nope", buyerPhone: "61234567" })).toMatchObject({ ok: false, status: 409 });
  });

  it.each([["21234567"], ["6123"], [""], [123]])("validates the phone (%s) before calling Yappy", async (buyerPhone) => {
    const yappy = new MockYappyClient();
    const r = await createOrder(db, yappy, { listingId: "x", buyerPhone });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(yappy.calls).toHaveLength(0);
  });

  it("on a Yappy error (E005) cancels the order, releases the stock and returns a clear message", async () => {
    const listing = await seedListing(db, { stock: 1 });
    const r = await createOrder(db, new MockYappyClient(), { listingId: listing.id, buyerPhone: "60000005" });
    expect(r).toEqual({ ok: false, status: 422, error: YAPPY_ERRORS.E005, code: "E005" });
    const order = await db.order.findFirstOrThrow({ where: { listingId: listing.id } });
    expect(order.status).toBe("cancelled");
    const l = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.stock).toBe(1);
    expect(l.status).toBe("active");
  });
});
