import { describe, expect, it } from "vitest";
import { DEFAULT_FEES, quoteProtected, toCents } from "./fees";

describe("quoteProtected", () => {
  it("charges 4% plus 7% ITBMS on the fee", () => {
    const q = quoteProtected(toCents(100));
    expect(q.feeCents).toBe(400);
    expect(q.itbmsCents).toBe(28);
    expect(q.buyerTotalCents).toBe(10_428);
    expect(q.sellerPayoutCents).toBe(10_000);
    expect(q.platformRevenueCents).toBe(400);
  });

  it("matches the published fee table", () => {
    const fee = (usd: number) => quoteProtected(toCents(usd)).feeCents;
    expect([10, 50, 150, 500, 1500].map(fee)).toEqual([100, 200, 600, 2000, 4000]);
  });

  it("applies the minimum fee on cheap cards", () => {
    const q = quoteProtected(toCents(5));
    expect(q.feeCents).toBe(DEFAULT_FEES.minCents);
    expect(q.itbmsCents).toBe(7);
  });

  it("caps the fee on expensive cards", () => {
    const q = quoteProtected(toCents(5000));
    expect(q.feeCents).toBe(DEFAULT_FEES.maxCents);
    expect(q.buyerTotalCents).toBe(500_000 + 4000 + 280);
  });

  it("rounds half cents up", () => {
    // 4% of $38.63 = 154.52¢ → 155; ITBMS 7% of 155 = 10.85 → 11
    const q = quoteProtected(3863);
    expect(q.feeCents).toBe(155);
    expect(q.itbmsCents).toBe(11);
  });

  it("never pays the seller less than the asking price", () => {
    for (const usd of [1, 9.99, 49.5, 250, 1200]) {
      const q = quoteProtected(toCents(usd));
      expect(q.sellerPayoutCents).toBe(toCents(usd));
      expect(q.buyerTotalCents).toBe(q.priceCents + q.feeCents + q.itbmsCents);
    }
  });

  it("rejects invalid prices", () => {
    expect(() => quoteProtected(0)).toThrow(RangeError);
    expect(() => quoteProtected(-100)).toThrow(RangeError);
    expect(() => quoteProtected(10.5)).toThrow(RangeError);
  });

  it("accepts a custom config (admin fee settings)", () => {
    const q = quoteProtected(10_000, { ...DEFAULT_FEES, rateBps: 300, fixedCents: 0, itbmsBps: 0 });
    expect(q.feeCents).toBe(300);
    expect(q.buyerTotalCents).toBe(10_300);
  });
});
