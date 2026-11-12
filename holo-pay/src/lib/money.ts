/**
 * Money is handled as integer cents everywhere. Convert to a dollar string with two
 * decimals only at the edge (e.g. when sending amounts to Yappy).
 */

/** Shipping the buyer pays on top of the card price. */
export const SHIPPING_CENTS = 300;

export function assertCents(value: number, name = "amount"): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer of cents`);
}

/** 12345 → "123.45". Integer math only, no floating point rounding. */
export function centsToDollars(cents: number): string {
  assertCents(cents);
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${whole}.${rest.toString().padStart(2, "0")}`;
}

/** Order amounts derived only from server data (the listing price), never from the client. */
export function orderAmounts(itemCents: number, opts: { shippingCents?: number; taxesCents?: number } = {}) {
  const shippingCents = opts.shippingCents ?? SHIPPING_CENTS;
  const taxesCents = opts.taxesCents ?? 0;
  assertCents(itemCents, "itemCents");
  assertCents(shippingCents, "shippingCents");
  assertCents(taxesCents, "taxesCents");
  const subtotalCents = itemCents + shippingCents;
  const totalCents = subtotalCents + taxesCents;
  if (totalCents < 1) throw new RangeError("total must be at least 0.01");
  return { itemCents, shippingCents, subtotalCents, taxesCents, totalCents };
}
