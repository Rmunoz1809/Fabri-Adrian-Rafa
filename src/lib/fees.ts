// "Compra Protegida" pricing. Listing is free. Both sides pay the same commission (plus ITBMS on
// it): the buyer on top of the price, the seller out of their payout.
// Mirrors quoteProtected() in holo.html and protected_quote() in migration 0016. USD cents.

export interface FeeConfig {
  /** Percentage of the card price, in basis points (500 = 5%). */
  rateBps: number;
  /** Fixed part added to every protected order, in cents. */
  fixedCents: number;
  /** Floor for the commission (before tax), in cents. */
  minCents: number;
  /** Cap for the commission (before tax), in cents. */
  maxCents: number;
  /** ITBMS applied to our commission, in basis points (700 = 7%). */
  itbmsBps: number;
}

export const DEFAULT_FEES: FeeConfig = {
  rateBps: 300,
  fixedCents: 0,
  minCents: 0,
  maxCents: Number.POSITIVE_INFINITY,
  itbmsBps: 700,
};

export interface ProtectedQuote {
  priceCents: number;
  feeCents: number;
  itbmsCents: number;
  sellerFeeCents: number;
  sellerItbmsCents: number;
  buyerTotalCents: number;
  sellerPayoutCents: number;
  platformRevenueCents: number;
}

function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

export function quoteProtected(priceCents: number, cfg: FeeConfig = DEFAULT_FEES): ProtectedQuote {
  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    throw new RangeError("priceCents must be a positive integer");
  }
  const raw = roundHalfUp((priceCents * cfg.rateBps) / 10_000) + cfg.fixedCents;
  const feeCents = Math.min(cfg.maxCents, Math.max(cfg.minCents, raw));
  const itbmsCents = roundHalfUp((feeCents * cfg.itbmsBps) / 10_000);
  return {
    priceCents,
    feeCents,
    itbmsCents,
    sellerFeeCents: feeCents,
    sellerItbmsCents: itbmsCents,
    buyerTotalCents: priceCents + feeCents + itbmsCents,
    sellerPayoutCents: priceCents - feeCents - itbmsCents,
    platformRevenueCents: feeCents * 2,
  };
}

export function toCents(usd: number): number {
  return Math.round(usd * 100);
}

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("es-PA", {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
