import { afterAll, describe, expect, it } from "vitest";
import { createTestDb, seedListing, seedPendingOrder } from "@/test/db";
import { expireIfDue, expireOrders } from "./expire";
import { transitionOrder } from "./transition";

const t = createTestDb();
const db = t.db;
afterAll(t.cleanup);

describe("expireOrders", () => {
  it("expires only overdue pending orders and releases their stock", async () => {
    const now = new Date("2026-11-12T15:00:00Z");
    const listing = await seedListing(db, { stock: 3 });
    const overdue = await seedPendingOrder(db, listing.id, { expiresAt: new Date(now.getTime() - 1000) });
    const fresh = await seedPendingOrder(db, listing.id, { expiresAt: new Date(now.getTime() + 60_000) });
    const paid = await seedPendingOrder(db, listing.id, { expiresAt: new Date(now.getTime() - 1000) });
    await transitionOrder(db, { orderId: paid.id, from: "pending_payment", to: "paid", reason: "ipn" });
    expect((await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).stock).toBe(0);

    const r = await expireOrders(db, now);
    expect(r.expired).toEqual([overdue.publicId]);
    expect((await db.order.findUniqueOrThrow({ where: { id: overdue.id } })).status).toBe("expired");
    expect((await db.order.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("pending_payment");
    expect((await db.order.findUniqueOrThrow({ where: { id: paid.id } })).status).toBe("paid");
    const l = await db.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(l.stock).toBe(1);
    expect(l.status).toBe("active");

    // Running again does nothing more.
    expect((await expireOrders(db, now)).expired).toEqual([]);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).stock).toBe(1);
  });

  it("expireIfDue expires a single due order", async () => {
    const listing = await seedListing(db, { stock: 1 });
    const o = await seedPendingOrder(db, listing.id, { expiresAt: new Date(Date.now() - 1) });
    expect(await expireIfDue(db, o)).toBe(true);
    expect(await expireIfDue(db, { ...o, status: "expired" })).toBe(false);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).stock).toBe(1);
  });
});
