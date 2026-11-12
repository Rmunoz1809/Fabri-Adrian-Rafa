import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, seedListing, seedPendingOrder } from "@/test/db";
import { TEST_DOMAIN, TEST_SECRET } from "@/test/keys";
import type { SellerNotifier } from "@/lib/notify/seller";
import { transitionOrder } from "@/lib/orders/transition";
import { handleIpn } from "./ipn";
import { signIpn } from "./signature";

const t = createTestDb();
const db = t.db;
afterAll(t.cleanup);

let notifier: SellerNotifier & { orderPaid: ReturnType<typeof vi.fn> };
beforeEach(() => {
  notifier = { orderPaid: vi.fn(async () => {}) };
});

function ipn(orderId: string, status: string, extra: Record<string, string> = {}) {
  return { orderId, status, domain: TEST_DOMAIN, hash: signIpn({ orderId, status, domain: TEST_DOMAIN }, TEST_SECRET), ...extra };
}
const run = (q: Record<string, string>) => handleIpn(db, q, { secretKey: TEST_SECRET, notifier });

async function freshOrder(stock = 1) {
  const listing = await seedListing(db, { priceCents: 10500, stock });
  const order = await seedPendingOrder(db, listing.id);
  return { listing, order };
}
const stockOf = async (id: string) => (await db.listing.findUniqueOrThrow({ where: { id } })).stock;
const statusOf = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).status;

describe("IPN", () => {
  it("E marks the order paid, notifies the seller and logs the raw event", async () => {
    const { order } = await freshOrder();
    const q = ipn(order.publicId, "E", { confirmationNumber: "ABC123" });
    const out = await run(q);
    expect(out.result).toBe("valid");
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.status).toBe("seller_notified");
    expect(o.paidAt).not.toBeNull();
    expect(o.yappyConfirmationNumber).toBe("ABC123");
    expect(notifier.orderPaid).toHaveBeenCalledWith(expect.objectContaining({ publicId: order.publicId, totalCents: 10800 }));
    const ev = await db.paymentEvent.findUniqueOrThrow({ where: { id: out.eventId } });
    expect(ev).toMatchObject({ receivedOrderId: order.publicId, status: "E", hash: q.hash, domain: TEST_DOMAIN, orderId: order.id, result: "valid" });
    expect(JSON.parse(ev.rawQuery)).toEqual(q);
  });

  it("is idempotent: a second E changes nothing", async () => {
    const { listing, order } = await freshOrder();
    await run(ipn(order.publicId, "E"));
    const before = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    const out = await run(ipn(order.publicId, "E"));
    expect(out.result).toBe("duplicate");
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe(before.status);
    expect(after.paidAt?.getTime()).toBe(before.paidAt?.getTime());
    expect(notifier.orderPaid).toHaveBeenCalledTimes(1);
    expect(await stockOf(listing.id)).toBe(0);
    expect(await db.orderTransition.count({ where: { orderId: order.id } })).toBe(2); // paid, seller_notified
    expect(await db.paymentEvent.count({ where: { orderId: order.id } })).toBe(2); // both stored
  });

  it("two concurrent E IPNs apply only once", async () => {
    const { order } = await freshOrder();
    const results = await Promise.all([run(ipn(order.publicId, "E")), run(ipn(order.publicId, "E"))]);
    expect(results.map((r) => r.result).sort()).toEqual(["duplicate", "valid"]);
    expect(notifier.orderPaid).toHaveBeenCalledTimes(1);
  });

  it("invalid signature: stored as invalid_signature, order untouched", async () => {
    const { order } = await freshOrder();
    const out = await run({ ...ipn(order.publicId, "E"), hash: "f".repeat(64) });
    expect(out.result).toBe("invalid_signature");
    expect(await statusOf(order.id)).toBe("pending_payment");
    expect(notifier.orderPaid).not.toHaveBeenCalled();
  });

  it("altered status (signed R, sent E) is rejected", async () => {
    const { order } = await freshOrder();
    const out = await run({ ...ipn(order.publicId, "R"), status: "E" });
    expect(out.result).toBe("invalid_signature");
    expect(await statusOf(order.id)).toBe("pending_payment");
  });

  it("altered orderId is rejected", async () => {
    const a = await freshOrder();
    const b = await freshOrder();
    const out = await run({ ...ipn(a.order.publicId, "E"), orderId: b.order.publicId });
    expect(out.result).toBe("invalid_signature");
    expect(await statusOf(b.order.id)).toBe("pending_payment");
  });

  it("unknown order: stored as order_not_found, nothing else happens", async () => {
    const out = await run(ipn("HNOTEXIST1", "E"));
    expect(out.result).toBe("order_not_found");
    const ev = await db.paymentEvent.findUniqueOrThrow({ where: { id: out.eventId } });
    expect(ev.orderId).toBeNull();
    expect(ev.receivedOrderId).toBe("HNOTEXIST1");
  });

  it("malformed query is still stored", async () => {
    const out = await run({ orderId: "H1" });
    expect(out.result).toBe("malformed");
    expect(await db.paymentEvent.findUnique({ where: { id: out.eventId } })).not.toBeNull();
  });

  it("unknown status letter: invalid_status", async () => {
    const { order } = await freshOrder();
    expect((await run(ipn(order.publicId, "Z"))).result).toBe("invalid_status");
    expect(await statusOf(order.id)).toBe("pending_payment");
  });

  it.each([
    ["R", "rejected"],
    ["C", "cancelled"],
    ["X", "expired"],
  ] as const)("%s → %s and releases the stock", async (letter, status) => {
    const { listing, order } = await freshOrder();
    expect(await stockOf(listing.id)).toBe(0);
    expect((await run(ipn(order.publicId, letter))).result).toBe("valid");
    expect(await statusOf(order.id)).toBe(status);
    expect(await stockOf(listing.id)).toBe(1);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe("active");
    // Repeated: stock is not released twice.
    expect((await run(ipn(order.publicId, letter))).result).toBe("duplicate");
    expect(await stockOf(listing.id)).toBe(1);
    expect(notifier.orderPaid).not.toHaveBeenCalled();
  });

  it("E for an expired order goes to under_review without taking stock or notifying", async () => {
    const { listing, order } = await freshOrder();
    await transitionOrder(db, { orderId: order.id, from: "pending_payment", to: "expired", reason: "expiry job" });
    expect(await stockOf(listing.id)).toBe(1);
    const out = await run(ipn(order.publicId, "E"));
    expect(out.result).toBe("late_payment");
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.status).toBe("under_review");
    expect(o.paidAt).not.toBeNull();
    expect(await stockOf(listing.id)).toBe(1);
    expect(notifier.orderPaid).not.toHaveBeenCalled();
    // And a repeat is a duplicate.
    expect((await run(ipn(order.publicId, "E"))).result).toBe("duplicate");
  });

  it("E for a cancelled order also goes to under_review", async () => {
    const { order } = await freshOrder();
    await run(ipn(order.publicId, "C"));
    expect((await run(ipn(order.publicId, "E"))).result).toBe("late_payment");
    expect(await statusOf(order.id)).toBe("under_review");
  });

  it("R after the order was paid does not undo the payment", async () => {
    const { order } = await freshOrder();
    await run(ipn(order.publicId, "E"));
    expect((await run(ipn(order.publicId, "R"))).result).toBe("invalid_transition");
    expect(await statusOf(order.id)).toBe("seller_notified");
  });

  it("uses the amount stored in the database, whatever the IPN carries", async () => {
    const { order } = await freshOrder();
    await run(ipn(order.publicId, "E", { total: "0.01", amount: "0.01" }));
    expect(notifier.orderPaid).toHaveBeenCalledWith(expect.objectContaining({ totalCents: 10800 }));
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).totalCents).toBe(10800);
  });

  it("if notifying the seller fails, the payment stands as paid", async () => {
    const { order } = await freshOrder();
    notifier.orderPaid.mockRejectedValueOnce(new Error("whatsapp down"));
    expect((await run(ipn(order.publicId, "E"))).result).toBe("valid");
    expect(await statusOf(order.id)).toBe("paid");
  });
});
