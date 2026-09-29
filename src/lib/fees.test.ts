import { describe, expect, it } from "vitest";
import { DEFAULT_FEES, quoteProtected, toCents } from "./fees";

describe("quoteProtected", () => {
  it("charges the buyer nothing and takes 5% + ITBMS from the seller", () => {
    const q = quoteProtected(toCents(100));
    expect(q.feeCents).toBe(0);
    expect(q.itbmsCents).toBe(0);
    expect(q.buyerTotalCents).toBe(10_000);
    expect(q.sellerFeeCents).toBe(500);
    expect(q.sellerItbmsCents).toBe(35);
    expect(q.sellerPayoutCents).toBe(9_465);
    expect(q.platformRevenueCents).toBe(500);
  });

  it("matches the published fee table", () => {
    const fee = (usd: number) => quoteProtected(toCents(usd)).sellerFeeCents;
    expect([10, 50, 150, 500, 1500].map(fee)).toEqual([50, 250, 750, 2500, 7500]);
  });

  it("has no minimum on cheap cards", () => {
    const q = quoteProtected(toCents(5));
    expect(q.sellerFeeCents).toBe(25);
    expect(q.sellerItbmsCents).toBe(2);
    expect(q.buyerTotalCents).toBe(500);
    expect(q.sellerPayoutCents).toBe(473);
  });

  it("has no cap on expensive cards", () => {
    const q = quoteProtected(toCents(5000));
    expect(q.sellerFeeCents).toBe(25_000);
    expect(q.sellerItbmsCents).toBe(1_750);
    expect(q.buyerTotalCents).toBe(500_000);
    expect(q.sellerPayoutCents).toBe(500_000 - 25_000 - 1_750);
  });

  it("rounds half cents up", () => {
    // 5% of $38.50 = 192.5¢ → 193; ITBMS 7% of 193 = 13.51 → 14
    const q = quoteProtected(3850);
    expect(q.sellerFeeCents).toBe(193);
    expect(q.sellerItbmsCents).toBe(14);
  });

  it("the buyer always pays the price and the seller always gets something", () => {
    for (const usd of [0.01, 1, 9.99, 49.5, 250, 1200]) {
      const q = quoteProtected(toCents(usd));
      expect(q.buyerTotalCents).toBe(q.priceCents);
      expect(q.sellerPayoutCents).toBe(q.priceCents - q.sellerFeeCents - q.sellerItbmsCents);
      expect(q.sellerPayoutCents).toBeGreaterThan(0);
    }
  });

  it("rejects invalid prices", () => {
    expect(() => quoteProtected(0)).toThrow(RangeError);
    expect(() => quoteProtected(-100)).toThrow(RangeError);
    expect(() => quoteProtected(10.5)).toThrow(RangeError);
  });

  it("accepts a custom config, including a buyer-side fee", () => {
    const q = quoteProtected(10_000, { ...DEFAULT_FEES, rateBps: 500, buyerRateBps: 300, minCents: 100, maxCents: 400, itbmsBps: 0 });
    expect(q.feeCents).toBe(300);
    expect(q.sellerFeeCents).toBe(400);
    expect(q.buyerTotalCents).toBe(10_300);
    expect(q.sellerPayoutCents).toBe(9_600);
  });
});
