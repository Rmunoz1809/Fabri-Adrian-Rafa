// Categories are data, not an enum baked into the schema: adding soccer, One Piece,
// Yu-Gi-Oh! or Magic later means inserting a row, not a migration.
export type CategorySlug = "pokemon" | "nba" | "nfl" | (string & {});

export interface Category {
  slug: CategorySlug;
  name: string;
  kind: "tcg" | "sports";
}

export type ConditionCode = "NM" | "LP" | "MP" | "HP" | "DMG";

export type GradingCompany = "PSA" | "BGS" | "CGC" | "SGC" | "TAG";

export interface Grading {
  company: GradingCompany;
  grade: number; // 1–10, half points allowed
  certNumber?: string;
}

export interface CardIdentity {
  category: CategorySlug;
  /** Pokémon name or player name. */
  subject: string;
  setName: string;
  year?: number;
  number?: string;
  /** Parallel / variant: "Holo", "Silver Prizm", "Special Illustration Rare"… */
  variant?: string;
  /** External catalog id when we know it (e.g. pokemontcg.io "sv3pt5-199"). */
  catalogId?: string;
}

export interface Location {
  province: string;
  district: string;
  /** Neighborhood-level only. We never store or show exact addresses. */
  neighborhood: string;
}

export type ListingStatus = "draft" | "active" | "reserved" | "sold" | "removed";

export interface PriceEstimate {
  low: number;
  mid: number;
  high: number;
  currency: "USD";
  confidence: "alta" | "media" | "baja";
  /** Human-readable basis, shown next to the estimate. */
  basis: string[];
  source: "tcgplayer" | "local" | "mixto";
  updatedAt: string;
}

export interface Seller {
  id: string;
  displayName: string;
  avatarUrl?: string;
  isShop: boolean;
  verified: boolean;
  rating: number | null;
  salesCount: number;
  memberSince: string;
  whatsapp?: string;
}

export interface Listing {
  id: string;
  title: string;
  description: string;
  card: CardIdentity;
  condition: ConditionCode | null;
  grading: Grading | null;
  priceUsd: number;
  photos: string[];
  location: Location;
  seller: Seller;
  status: ListingStatus;
  estimate: PriceEstimate | null;
  protectedEligible: boolean;
  createdAt: string;
}
