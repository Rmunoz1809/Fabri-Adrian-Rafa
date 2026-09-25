import { describe, expect, it } from "vitest";
import { DEFAULT_FEES, quoteProtected, toCents } from "./fees";

describe("quoteProtected", () => {
  it("charges 5% + $1 plus 7% ITBMS on the fee", () => {
    const q = quoteProtected(toCents(100));
    expect(q.feeCents).toBe(600); // 5.00 + 1.00
    expect(q.itbmsCents).toBe(42);
    expect(q.buyerTotalCents).toBe(10_642);
    expect(q.sellerPayoutCents).toBe(10_000);
    expect(q.platformRevenueCents).toBe(600);
  });

  it("applies the minimum fee on cheap cards", () => {
    const q = quoteProtected(toCents(5));
    expect(q.feeCents).toBe(DEFAULT_FEES.minCents);
    expect(q.itbmsCents).toBe(14);
  });

  it("caps the fee on expensive cards", () => {
    const q = quoteProtected(toCents(5000));
    expect(q.feeCents).toBe(DEFAULT_FEES.maxCents);
    expect(q.buyerTotalCents).toBe(500_000 + 5000 + 350);
  });

  it("rounds half cents up", () => {
    // 5% of 1234.5¢… price 24.69 → 123.45¢ → 123 + 100 = 223
    const q = quoteProtected(2469);
    expect(q.feeCents).toBe(223);
    expect(q.itbmsCents).toBe(16); // 15.61 → 16
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
