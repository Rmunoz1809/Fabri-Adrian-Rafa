import { describe, expect, it } from "vitest";
import { DEFAULT_FEES, quoteProtected, toCents } from "./fees";

describe("quoteProtected", () => {
  it("charges 3% + ITBMS to the buyer and takes 3% + ITBMS from the seller", () => {
    const q = quoteProtected(toCents(100));
    expect(q.feeCents).toBe(300);
    expect(q.itbmsCents).toBe(21);
    expect(q.buyerTotalCents).toBe(10_321);
    expect(q.sellerFeeCents).toBe(300);
    expect(q.sellerItbmsCents).toBe(21);
    expect(q.sellerPayoutCents).toBe(9_679);
    expect(q.platformRevenueCents).toBe(600);
  });

  it("matches the published fee table", () => {
    const fee = (usd: number) => quoteProtected(toCents(usd)).feeCents;
    expect([10, 50, 150, 500, 1500].map(fee)).toEqual([30, 150, 450, 1500, 4500]);
  });

  it("has no minimum on cheap cards", () => {
    const q = quoteProtected(toCents(5));
    expect(q.feeCents).toBe(15);
    expect(q.itbmsCents).toBe(1);
    expect(q.buyerTotalCents).toBe(516);
    expect(q.sellerPayoutCents).toBe(484);
  });

  it("has no cap on expensive cards", () => {
    const q = quoteProtected(toCents(5000));
    expect(q.feeCents).toBe(15_000);
    expect(q.itbmsCents).toBe(1_050);
    expect(q.buyerTotalCents).toBe(500_000 + 15_000 + 1_050);
    expect(q.sellerPayoutCents).toBe(500_000 - 15_000 - 1_050);
  });

  it("rounds half cents up", () => {
    // 3% of $38.50 = 115.5¢ → 116; ITBMS 7% of 116 = 8.12 → 8
    const q = quoteProtected(3850);
    expect(q.feeCents).toBe(116);
    expect(q.itbmsCents).toBe(8);
  });

  it("buyer total and seller payout sit symmetrically around the price", () => {
    for (const usd of [1, 9.99, 49.5, 250, 1200]) {
      const q = quoteProtected(toCents(usd));
      const side = q.feeCents + q.itbmsCents;
      expect(q.buyerTotalCents).toBe(q.priceCents + side);
      expect(q.sellerPayoutCents).toBe(q.priceCents - side);
      expect(q.sellerPayoutCents).toBeGreaterThan(0);
    }
  });

  it("rejects invalid prices", () => {
    expect(() => quoteProtected(0)).toThrow(RangeError);
    expect(() => quoteProtected(-100)).toThrow(RangeError);
    expect(() => quoteProtected(10.5)).toThrow(RangeError);
  });

  it("accepts a custom config (admin fee settings)", () => {
    const q = quoteProtected(10_000, { ...DEFAULT_FEES, rateBps: 500, minCents: 100, maxCents: 400, itbmsBps: 0 });
    expect(q.feeCents).toBe(400);
    expect(q.buyerTotalCents).toBe(10_400);
    expect(q.sellerPayoutCents).toBe(9_600);
  });
});
