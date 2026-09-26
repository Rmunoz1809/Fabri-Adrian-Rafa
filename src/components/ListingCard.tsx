import Link from "next/link";
import { formatUsd, toCents } from "@/lib/fees";
import type { Listing } from "@/lib/types";
import { CardArt } from "./CardArt";
import { ConditionBadge, ProtectedBadge, VerdictBadge } from "./Badges";

export function ListingCard({ listing, preload }: { listing: Listing; preload?: boolean }) {
  return (
    <Link
      href={`/carta/${listing.id}`}
      className="lift group flex flex-col overflow-hidden rounded-2xl border border-line bg-surface"
    >
      <div className="card-ratio relative bg-surface-2 [container-type:inline-size]">
        <div className="absolute inset-[7%]">
          <CardArt listing={listing} sizes="(min-width: 1024px) 22vw, (min-width: 640px) 30vw, 46vw" preload={preload} />
        </div>
        <div className="absolute left-2 top-2 flex gap-1">
          <ConditionBadge listing={listing} />
        </div>
        {listing.isDemo && (
          <span className="absolute right-2 top-2 rounded-md bg-surface/90 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-ink-2">
            Ejemplo
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <p className="line-clamp-2 text-sm font-medium leading-snug">{listing.title}</p>
        <p className="font-display text-lg font-bold">{formatUsd(toCents(listing.priceUsd))}</p>
        <div className="flex flex-wrap items-center gap-1">
          <VerdictBadge listing={listing} />
          {listing.protectedEligible && <ProtectedBadge />}
        </div>
        <p className="mt-auto pt-1 text-xs text-ink-2">
          {listing.location.neighborhood}, {listing.location.district}
        </p>
      </div>
    </Link>
  );
}
