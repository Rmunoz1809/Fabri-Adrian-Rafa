import { afterAll, describe, expect, it } from "vitest";
import { createTestDb, seedListing, seedPendingOrder } from "@/test/db";
import { transitionOrder } from "@/lib/orders/transition";
import { paidOrdersCsv, panamaDayRange, panamaToday } from "./export";
import { resolveEvent, reviewQueue } from "./review";

const t = createTestDb();
const db = t.db;
afterAll(t.cleanup);

describe("panama day", () => {
  it("is UTC-5", () => {
    expect(panamaDayRange("2026-11-12").start.toISOString()).toBe("2026-11-12T05:00:00.000Z");
    expect(panamaDayRange("2026-11-12").end.toISOString()).toBe("2026-11-13T05:00:00.000Z");
    expect(panamaToday(new Date("2026-11-13T03:00:00Z"))).toBe("2026-11-12");
  });
  it("rejects bad dates", () => {
    expect(() => panamaDayRange("2026-13-01")).toThrow();
    expect(() => panamaDayRange("hoy")).toThrow();
  });
});

describe("paidOrdersCsv", () => {
  it("exports only orders paid that Panama day, with dollar amounts", async () => {
    const listing = await seedListing(db, { priceCents: 10500, stock: 3 });
    const a = await seedPendingOrder(db, listing.id);
    const b = await seedPendingOrder(db, listing.id);
    await seedPendingOrder(db, listing.id); // unpaid
    await transitionOrder(db, { orderId: a.id, from: "pending_payment", to: "paid", reason: "t", data: { paidAt: new Date("2026-11-12T23:30:00Z"), yappyConfirmationNumber: "CONF1" } });
    await transitionOrder(db, { orderId: b.id, from: "pending_payment", to: "paid", reason: "t", data: { paidAt: new Date("2026-11-13T06:00:00Z") } });

    const r = await paidOrdersCsv(db, "2026-11-12");
    expect(r.count).toBe(1);
    expect(r.totalCents).toBe(10800);
    const lines = r.csv.trim().split("\r\n");
    expect(lines[0]).toContain('"orden","pagada_panama"');
    expect(lines[1]).toContain(`"${a.publicId}","2026-11-12 18:30:00","105.00","3.00","0.00","108.00","paid","CONF1"`);
  });
});

describe("review queue", () => {
  it("lists under_review orders and suspicious events until resolved", async () => {
    const listing = await seedListing(db, { stock: 1 });
    const o = await seedPendingOrder(db, listing.id);
    await transitionOrder(db, { orderId: o.id, from: "pending_payment", to: "expired", reason: "t" });
    await transitionOrder(db, { orderId: o.id, from: "expired", to: "under_review", reason: "t" });
    const ev = await db.paymentEvent.create({ data: { rawQuery: "{}", result: "invalid_signature" } });
    await db.paymentEvent.create({ data: { rawQuery: "{}", result: "valid" } });

    const q = await reviewQueue(db);
    expect(q.underReview.map((x) => x.id)).toContain(o.id);
    expect(q.events.map((e) => e.id)).toEqual([ev.id]);

    expect(await resolveEvent(db, ev.id, "probado por staff")).toBe(true);
    expect(await resolveEvent(db, ev.id, "otra vez")).toBe(false);
    expect((await reviewQueue(db)).events).toHaveLength(0);
  });
});
