// "Compra Protegida" pricing. Listing is free and the buyer pays only the card price. When a sale
// completes, the platform keeps a commission (plus ITBMS on it) out of the seller's payout.
// Mirrors quoteProtected() in holo.html and protected_quote() in migration 0017. USD cents.

export interface FeeConfig {
  /** Seller's commission: percentage of the card price, in basis points (500 = 5%). */
  rateBps: number;
  /** Buyer's commission on top of the price, in basis points. 0 = the buyer pays only the price. */
  buyerRateBps: number;
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
  rateBps: 500,
  buyerRateBps: 0,
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

/** [commission, ITBMS on it] for one side; a 0 rate means that side pays nothing. */
function commission(priceCents: number, rateBps: number, cfg: FeeConfig): [number, number] {
  if (!rateBps) return [0, 0];
  const raw = roundHalfUp((priceCents * rateBps) / 10_000) + cfg.fixedCents;
  const fee = Math.min(cfg.maxCents, Math.max(cfg.minCents, raw));
  return [fee, roundHalfUp((fee * cfg.itbmsBps) / 10_000)];
}

export function quoteProtected(priceCents: number, cfg: FeeConfig = DEFAULT_FEES): ProtectedQuote {
  if (!Number.isInteger(priceCents) || priceCents <= 0) {
    throw new RangeError("priceCents must be a positive integer");
  }
  const [feeCents, itbmsCents] = commission(priceCents, cfg.buyerRateBps, cfg);
  const [sellerFeeCents, sellerItbmsCents] = commission(priceCents, cfg.rateBps, cfg);
  return {
    priceCents,
    feeCents,
    itbmsCents,
    sellerFeeCents,
    sellerItbmsCents,
    buyerTotalCents: priceCents + feeCents + itbmsCents,
    sellerPayoutCents: priceCents - sellerFeeCents - sellerItbmsCents,
    platformRevenueCents: feeCents + sellerFeeCents,
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
