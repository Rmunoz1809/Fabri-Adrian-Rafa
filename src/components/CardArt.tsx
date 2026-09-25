import Image from "next/image";
import type { Listing } from "@/lib/types";

const SPORT_STYLE: Record<string, { from: string; to: string; label: string }> = {
  nba: { from: "#1d428a", to: "#c8102e", label: "NBA" },
  nfl: { from: "#013369", to: "#2f6f3e", label: "NFL" },
};

/** Card image, or a labeled placeholder when the listing has no photo yet. */
export function CardArt({
  listing,
  sizes,
  priority,
}: {
  listing: Pick<Listing, "photos" | "card" | "title">;
  sizes: string;
  priority?: boolean;
}) {
  const photo = listing.photos[0];
  if (photo) {
    return (
      <Image
        src={photo}
        alt={listing.title}
        fill
        sizes={sizes}
        priority={priority}
        className="object-contain drop-shadow-[0_6px_14px_rgba(0,0,0,0.25)]"
      />
    );
  }
  const s = SPORT_STYLE[listing.card.category] ?? { from: "#444", to: "#888", label: "Carta" };
  return (
    <div
      role="img"
      aria-label={`${listing.title} (sin foto todavía)`}
      className="absolute inset-[6%] flex flex-col justify-between rounded-[6%] p-[8%] text-white shadow-lg"
      style={{ background: `linear-gradient(150deg, ${s.from}, ${s.to})` }}
    >
      <span className="self-start rounded bg-white/20 px-1.5 py-0.5 text-[0.6rem] font-bold tracking-widest">
        {s.label}
      </span>
      <div>
        <p className="font-display text-[clamp(0.8rem,4cqi,1.4rem)] font-bold leading-tight">{listing.card.subject}</p>
        <p className="mt-1 text-[0.65rem] opacity-80">
          {listing.card.year} {listing.card.setName} {listing.card.number}
        </p>
        <p className="mt-2 text-[0.6rem] uppercase tracking-wider opacity-60">Foto de ejemplo</p>
      </div>
    </div>
  );
}
