// "Compra Protegida" pricing. Listing is free for sellers; the buyer pays an
// optional protection fee (Vinted-style) when they want the platform to hold the
// payment and verify the card. Amounts are in USD cents to avoid float drift.

export interface FeeConfig {
  /** Percentage of the card price, in basis points (500 = 5%). */
  rateBps: number;
  /** Fixed part added to every protected order, in cents. */
  fixedCents: number;
  /** Floor for the protection fee (before tax), in cents. */
  minCents: number;
  /** Cap for the protection fee (before tax), in cents. */
  maxCents: number;
  /** ITBMS applied to our service fee, in basis points (700 = 7%). */
  itbmsBps: number;
}

export const DEFAULT_FEES: FeeConfig = {
  rateBps: 500,
  fixedCents: 100,
  minCents: 200,
  maxCents: 5000,
  itbmsBps: 700,
};

export interface ProtectedQuote {
  priceCents: number;
  feeCents: number;
  itbmsCents: number;
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
    buyerTotalCents: priceCents + feeCents + itbmsCents,
    sellerPayoutCents: priceCents,
    platformRevenueCents: feeCents,
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
