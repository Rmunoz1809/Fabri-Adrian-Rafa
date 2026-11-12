import { describe, expect, it } from "vitest";
import { centsToDollars, orderAmounts, SHIPPING_CENTS } from "./money";

describe("centsToDollars", () => {
  it.each([
    [0, "0.00"],
    [1, "0.01"],
    [10, "0.10"],
    [300, "3.00"],
    [10500, "105.00"],
    [10803, "108.03"],
    [123456789, "1234567.89"],
  ])("%i → %s", (cents, out) => expect(centsToDollars(cents)).toBe(out));

  it.each([1.5, -1, NaN, Infinity])("rejects %s", (v) => expect(() => centsToDollars(v)).toThrow(RangeError));
});

describe("orderAmounts", () => {
  it("adds $3 shipping to the item price", () => {
    expect(SHIPPING_CENTS).toBe(300);
    expect(orderAmounts(10500)).toEqual({ itemCents: 10500, shippingCents: 300, subtotalCents: 10800, taxesCents: 0, totalCents: 10800 });
  });
  it("adds taxes to the total", () => {
    expect(orderAmounts(1000, { taxesCents: 70 }).totalCents).toBe(1370);
  });
  it("rejects fractional cents", () => expect(() => orderAmounts(10.5)).toThrow(RangeError));
  it("requires a total of at least one cent", () => expect(() => orderAmounts(0, { shippingCents: 0 })).toThrow(RangeError));
});
