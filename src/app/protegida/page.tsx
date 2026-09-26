import type { Metadata } from "next";
import Link from "next/link";
import { APP_NAME } from "@/lib/catalog";
import { DEFAULT_FEES, formatUsd, quoteProtected, toCents } from "@/lib/fees";

export const metadata: Metadata = { title: "Compra Protegida" };

const STEPS = [
  { t: "Pagas a " + APP_NAME, d: "Por Yappy o transferencia. El vendedor todavía no recibe el dinero." },
  { t: "Verificamos la carta", d: "La revisamos en persona: autenticidad, condición y que sea la misma de las fotos." },
  { t: "Recibes tu carta", d: "Te la entregamos en un punto seguro o la retiras en una tienda aliada." },
  { t: "El vendedor cobra", d: "Solo cuando confirmas. Si la carta no es lo anunciado, te devolvemos todo." },
];

export default function ProtectedPage() {
  const examples = [10, 50, 150, 500, 1500].map((usd) => quoteProtected(toCents(usd)));
  return (
    <div className="mx-auto max-w-3xl px-4 pb-16 pt-8">
      <h1 className="font-display text-4xl font-bold tracking-tight">Compra Protegida</h1>
      <p className="mt-2 text-ink-2">
        Para comprar cartas de valor sin miedo a réplicas, cartas en peor estado o gente que no llega.
        Publicar sigue siendo gratis para el vendedor.
      </p>

      <ol className="mt-8 grid gap-3 sm:grid-cols-2">
        {STEPS.map((s, i) => (
          <li key={s.t} className="rounded-2xl border border-line bg-surface p-4">
            <span className="font-display text-sm font-bold text-accent">Paso {i + 1}</span>
            <p className="mt-1 font-semibold">{s.t}</p>
            <p className="mt-1 text-sm text-ink-2">{s.d}</p>
          </li>
        ))}
      </ol>

      <h2 className="mt-10 font-display text-2xl font-bold">Cuánto cuesta</h2>
      <p className="mt-1 text-sm text-ink-2">
        {DEFAULT_FEES.rateBps / 100}%{DEFAULT_FEES.fixedCents > 0 && ` + ${formatUsd(DEFAULT_FEES.fixedCents)}`}, mínimo {formatUsd(DEFAULT_FEES.minCents)} y
        máximo {formatUsd(DEFAULT_FEES.maxCents)}. Lo paga el comprador, más 7% de ITBMS sobre la tarifa.
      </p>
      <div className="mt-4 overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-ink-2">
            <tr className="border-b border-line">
              <th className="p-3 font-medium">Precio de la carta</th>
              <th className="p-3 font-medium">Protección</th>
              <th className="p-3 font-medium">ITBMS</th>
              <th className="p-3 font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {examples.map((q) => (
              <tr key={q.priceCents} className="border-b border-line last:border-0">
                <td className="p-3">{formatUsd(q.priceCents)}</td>
                <td className="p-3">{formatUsd(q.feeCents)}</td>
                <td className="p-3">{formatUsd(q.itbmsCents)}</td>
                <td className="p-3 font-semibold">{formatUsd(q.buyerTotalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-10 flex flex-wrap gap-2">
        <Link href="/" className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink">Ver cartas</Link>
        <Link href="/vender" className="rounded-full border border-line bg-surface px-5 py-2.5 text-sm font-semibold">Vender una carta</Link>
      </div>
    </div>
  );
}
