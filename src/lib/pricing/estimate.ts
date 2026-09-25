import type { ConditionCode, Grading, PriceEstimate } from "../types";

/** One variant's prices as returned by TCGplayer (via pokemontcg.io), in USD. */
export interface ReferencePrice {
  market: number | null;
  low: number | null;
  mid: number | null;
  high: number | null;
  variant: string;
  updatedAt: string; // YYYY/MM/DD or ISO
}

/** A completed sale in Panama recorded on our platform. */
export interface LocalComp {
  priceUsd: number;
  soldAt: string; // ISO
}

// Rough discount by condition relative to Near Mint, in line with common TCG
// marketplace conventions. Only applied to raw (ungraded) cards.
export const CONDITION_FACTOR: Record<ConditionCode, number> = {
  NM: 1,
  LP: 0.85,
  MP: 0.7,
  HP: 0.5,
  DMG: 0.3,
};

const MIN_LOCAL_COMPS = 3;
const LOCAL_WINDOW_DAYS = 180;
const STALE_REFERENCE_DAYS = 14;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseDate(s: string): Date {
  return new Date(s.includes("/") ? s.replaceAll("/", "-") : s);
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface EstimateInput {
  reference?: ReferencePrice | null;
  localComps?: LocalComp[];
  condition: ConditionCode | null;
  grading: Grading | null;
  now?: Date;
}

/**
 * Combine an external reference price with local Panama sales. Returns null when
 * there is no honest basis for a number; the UI must then say so instead of
 * inventing one.
 */
export function estimatePrice(input: EstimateInput): PriceEstimate | null {
  const now = input.now ?? new Date();
  const basis: string[] = [];

  const recent = (input.localComps ?? [])
    .filter((c) => daysBetween(parseDate(c.soldAt), now) <= LOCAL_WINDOW_DAYS)
    .map((c) => c.priceUsd)
    .sort((a, b) => a - b);

  let local: { low: number; mid: number; high: number } | null = null;
  if (recent.length >= MIN_LOCAL_COMPS) {
    local = {
      low: quantile(recent, 0.25),
      mid: quantile(recent, 0.5),
      high: quantile(recent, 0.75),
    };
    basis.push(`${recent.length} ventas en Panamá en los últimos 6 meses`);
  }

  // Raw reference prices say nothing reliable about a graded copy.
  let ref: { low: number; mid: number; high: number; stale: boolean } | null = null;
  const r = input.reference;
  const refValue = r ? (r.market ?? r.mid) : null;
  if (r && refValue && refValue > 0 && !input.grading) {
    const factor = input.condition ? CONDITION_FACTOR[input.condition] : 1;
    const mid = refValue * factor;
    const stale = daysBetween(parseDate(r.updatedAt), now) > STALE_REFERENCE_DAYS;
    ref = { low: mid * 0.85, mid, high: mid * 1.15, stale };
    basis.push(`Precio de mercado en EE.UU. (TCGplayer, ${r.variant})`);
    if (input.condition && input.condition !== "NM") {
      basis.push(`Ajustado por condición ${input.condition} (×${factor})`);
    }
  }

  if (!local && !ref) return null;

  let low: number, mid: number, high: number;
  let source: PriceEstimate["source"];
  if (local && ref) {
    // Local sales reflect what Panamanians actually pay; weight them more.
    const w = 0.6;
    low = local.low * w + ref.low * (1 - w);
    mid = local.mid * w + ref.mid * (1 - w);
    high = local.high * w + ref.high * (1 - w);
    source = "mixto";
  } else if (local) {
    ({ low, mid, high } = local);
    source = "local";
  } else {
    ({ low, mid, high } = ref!);
    source = "tcgplayer";
  }

  let confidence: PriceEstimate["confidence"];
  if (local && recent.length >= 8) confidence = "alta";
  else if (ref && !ref.stale && !input.condition) confidence = "media";
  else if (local || (ref && !ref.stale)) confidence = "media";
  else confidence = "baja";
  if (ref?.stale) basis.push("La referencia externa tiene más de 2 semanas");

  return {
    low: round2(low),
    mid: round2(mid),
    high: round2(high),
    currency: "USD",
    confidence,
    basis,
    source,
    updatedAt: now.toISOString(),
  };
}

/** Where an asking price sits against the estimate, for the "¿precio justo?" badge. */
export function priceVerdict(
  priceUsd: number,
  est: PriceEstimate | null,
): "buen-precio" | "en-rango" | "alto" | null {
  if (!est) return null;
  if (priceUsd < est.low) return "buen-precio";
  if (priceUsd > est.high) return "alto";
  return "en-rango";
}
