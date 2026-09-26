import { estimatePrice } from "../pricing/estimate";
import { searchTokens } from "../search";
import type { Listing } from "../types";
import { LOCAL_COMPS, REFERENCE_SNAPSHOTS, SEED_LISTINGS, SELLERS } from "./seed";

export type SortKey = "recientes" | "precio-asc" | "precio-desc";

export interface ListingFilters {
  q?: string;
  category?: string;
  graded?: "raw" | "graded";
  province?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: SortKey;
}

function compKey(l: Pick<Listing, "card" | "grading">): string | null {
  const id = l.card.catalogId;
  if (!id) return null;
  return `${id}|${l.grading ? `${l.grading.company}${l.grading.grade}` : "raw"}`;
}

function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function hydrate(seed: (typeof SEED_LISTINGS)[number]): Listing {
  const { sellerKey, ...rest } = seed;
  const key = compKey(seed);
  const estimate = estimatePrice({
    reference: seed.card.catalogId ? REFERENCE_SNAPSHOTS[seed.card.catalogId] : null,
    localComps: key ? LOCAL_COMPS[key] : [],
    condition: seed.condition,
    grading: seed.grading,
    now: new Date("2026-09-25T12:00:00Z"),
  });
  return { ...rest, seller: SELLERS[sellerKey], estimate, isDemo: true };
}

export function matchesFilters(l: Listing, f: ListingFilters): boolean {
  if (l.status !== "active") return false;
  if (f.category && l.card.category !== f.category) return false;
  if (f.graded === "graded" && !l.grading) return false;
  if (f.graded === "raw" && l.grading) return false;
  if (f.province && l.location.province !== f.province) return false;
  if (f.minPrice != null && l.priceUsd < f.minPrice) return false;
  if (f.maxPrice != null && l.priceUsd > f.maxPrice) return false;
  if (f.q) {
    const hay = normalize(
      [l.title, l.card.subject, l.card.setName, l.card.variant, l.card.number, l.location.neighborhood, l.location.district, l.location.province].join(" "),
    );
    // Same words as the database search, so demo and real listings match alike.
    if (!searchTokens(f.q).every((t) => hay.includes(t))) return false;
  }
  return true;
}

export function sortListings(list: Listing[], sort: SortKey = "recientes"): Listing[] {
  const copy = [...list];
  if (sort === "precio-asc") copy.sort((a, b) => a.priceUsd - b.priceUsd);
  else if (sort === "precio-desc") copy.sort((a, b) => b.priceUsd - a.priceUsd);
  else copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return copy;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function showDemo(): boolean {
  return !process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SHOW_DEMO_LISTINGS === "true";
}

// Real listings come from Supabase when configured; demo listings are mixed in
// until SHOW_DEMO_LISTINGS is turned off, and are always labeled as examples.
export async function listListings(filters: ListingFilters = {}): Promise<Listing[]> {
  const demo = showDemo() ? SEED_LISTINGS.map(hydrate).filter((l) => matchesFilters(l, filters)) : [];
  let real: Listing[] = [];
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
    const { fetchListings } = await import("./supabase-listings");
    real = await fetchListings(filters).catch((e) => {
      console.error(e);
      return [];
    });
  }
  return sortListings([...real, ...demo], filters.sort);
}

export async function getListing(id: string): Promise<Listing | null> {
  if (UUID.test(id) && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    const { fetchListing } = await import("./supabase-listings");
    return fetchListing(id);
  }
  const seed = SEED_LISTINGS.find((l) => l.id === id);
  return seed ? hydrate(seed) : null;
}

export function parseFilters(sp: Record<string, string | string[] | undefined>): ListingFilters {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const num = (k: string) => {
    const v = one(k);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const graded = one("tipo");
  const sort = one("orden");
  return {
    q: one("q"),
    category: one("cat"),
    graded: graded === "raw" || graded === "graded" ? graded : undefined,
    province: one("provincia"),
    minPrice: num("min"),
    maxPrice: num("max"),
    sort: sort === "precio-asc" || sort === "precio-desc" ? sort : "recientes",
  };
}
