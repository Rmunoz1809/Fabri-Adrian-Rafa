import { formatUsd, toCents } from "@/lib/fees";
import type { PriceEstimate } from "@/lib/types";

// Cents on an estimate imply false precision; round anything above $20.
function fmt(usd: number): string {
  return formatUsd(toCents(usd >= 20 ? Math.round(usd) : usd));
}

const CONFIDENCE = {
  alta: "Confianza alta",
  media: "Confianza media",
  baja: "Confianza baja",
} as const;

/** Low–high range bar with the asking price marked on it. */
export function EstimatePanel({ estimate, priceUsd }: { estimate: PriceEstimate | null; priceUsd: number }) {
  if (!estimate) {
    return (
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Precio estimado</h2>
        <p className="mt-1 text-sm text-ink-2">
          Todavía no hay suficientes datos para estimar esta carta. Para cartas deportivas y graduadas usamos
          ventas reales en Panamá, y aún no tenemos 3 o más ventas comparables.
        </p>
      </section>
    );
  }

  const span = estimate.high - estimate.low;
  const pad = span * 0.35 || estimate.mid * 0.2;
  const min = Math.max(0, estimate.low - pad);
  const max = estimate.high + pad;
  const pct = (v: number) => `${Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100))}%`;

  return (
    <section className="holo-border rounded-2xl p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Precio estimado <span className="holo-text font-bold">IA</span>
        </h2>
        <span className="text-xs text-ink-2">{CONFIDENCE[estimate.confidence]}</span>
      </div>
      <p className="mt-2 font-display text-2xl font-bold">
        {fmt(estimate.low)} – {fmt(estimate.high)}
      </p>
      <p className="text-sm text-ink-2">Valor medio {fmt(estimate.mid)}</p>

      <div className="relative mt-6 mb-2 h-2 rounded-full bg-surface-2" aria-hidden>
        <div
          className="absolute h-2 rounded-full"
          style={{ left: pct(estimate.low), right: `calc(100% - ${pct(estimate.high)})`, background: "var(--holo)" }}
        />
        <div className="absolute -top-5 -translate-x-1/2 text-[0.65rem] font-semibold whitespace-nowrap" style={{ left: pct(priceUsd) }}>
          Este anuncio
        </div>
        <div className="absolute -top-1 h-4 w-1 -translate-x-1/2 rounded-full bg-ink" style={{ left: pct(priceUsd) }} />
      </div>

      <ul className="mt-4 space-y-1 text-xs text-ink-2">
        {estimate.basis.map((b) => (
          <li key={b}>• {b}</li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-2">
        Es una referencia, no una garantía ni una tasación. El precio final lo acuerdan comprador y vendedor.
      </p>
    </section>
  );
}
