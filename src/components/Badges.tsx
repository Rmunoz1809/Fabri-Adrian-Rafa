import { priceVerdict } from "@/lib/pricing/estimate";
import type { Listing } from "@/lib/types";

const VERDICT = {
  "buen-precio": { text: "Buen precio", cls: "bg-good-bg text-good" },
  "en-rango": { text: "Precio justo", cls: "bg-surface-2 text-ink-2" },
  alto: { text: "Sobre el mercado", cls: "bg-warn-bg text-warn" },
} as const;

export function VerdictBadge({ listing }: { listing: Pick<Listing, "priceUsd" | "estimate"> }) {
  const v = priceVerdict(listing.priceUsd, listing.estimate);
  if (!v) return null;
  const { text, cls } = VERDICT[v];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
}

export function ConditionBadge({ listing }: { listing: Pick<Listing, "grading" | "condition"> }) {
  if (listing.grading) {
    return (
      <span className="rounded-md bg-ink px-1.5 py-0.5 text-xs font-bold text-bg">
        {listing.grading.company} {listing.grading.grade}
      </span>
    );
  }
  if (!listing.condition) return null;
  return (
    <span className="rounded-md border border-line px-1.5 py-0.5 text-xs font-semibold text-ink-2">
      {listing.condition}
    </span>
  );
}

export function ProtectedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
      <svg viewBox="0 0 16 16" className="size-3" aria-hidden fill="currentColor">
        <path d="M8 1 2.5 3v4.2c0 3.4 2.3 6.4 5.5 7.8 3.2-1.4 5.5-4.4 5.5-7.8V3L8 1Zm-1 10L4.5 8.5l1-1L7 9l3.5-3.5 1 1L7 11Z" />
      </svg>
      Protegida
    </span>
  );
}
