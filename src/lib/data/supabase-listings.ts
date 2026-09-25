import "server-only";
import { createClient, supabaseConfig } from "../supabase/server";
import type { ConditionCode, GradingCompany, Listing, PriceEstimate, Seller } from "../types";
import type { ListingFilters } from "./listings";

const SELECT = `id, seller_id, title, description, category, subject, set_name, year, number, variant,
  condition, grading_company, grade, cert_number, price_cents, province, district, neighborhood,
  status, protected_eligible, catalog_id, estimate, created_at,
  listing_photos (storage_path, position)`;

interface Row {
  id: string;
  seller_id: string;
  title: string;
  description: string | null;
  category: string;
  subject: string;
  set_name: string;
  year: number | null;
  number: string | null;
  variant: string | null;
  condition: ConditionCode | null;
  grading_company: GradingCompany | null;
  grade: number | null;
  cert_number: string | null;
  price_cents: number;
  province: string;
  district: string;
  neighborhood: string;
  status: Listing["status"];
  protected_eligible: boolean;
  catalog_id: string | null;
  estimate: PriceEstimate | null;
  created_at: string;
  listing_photos: { storage_path: string; position: number }[];
}

interface ProfileRow {
  id: string;
  display_name: string;
  is_shop: boolean;
  verified: boolean;
  created_at: string;
}

export function photoUrl(path: string): string {
  const cfg = supabaseConfig();
  return `${cfg?.url}/storage/v1/object/public/listing-photos/${path}`;
}

function toSeller(p: ProfileRow | undefined, id: string): Seller {
  return {
    id,
    displayName: p?.display_name ?? "Vendedor",
    isShop: p?.is_shop ?? false,
    verified: p?.verified ?? false,
    rating: null,
    salesCount: 0,
    memberSince: p?.created_at ?? "",
  };
}

function toListing(r: Row, seller: Seller): Listing {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? "",
    card: {
      category: r.category,
      subject: r.subject,
      setName: r.set_name,
      year: r.year ?? undefined,
      number: r.number ?? undefined,
      variant: r.variant ?? undefined,
      catalogId: r.catalog_id ?? undefined,
    },
    condition: r.condition,
    grading: r.grading_company && r.grade != null
      ? { company: r.grading_company, grade: Number(r.grade), certNumber: r.cert_number ?? undefined }
      : null,
    priceUsd: r.price_cents / 100,
    photos: [...r.listing_photos].sort((a, b) => a.position - b.position).map((p) => photoUrl(p.storage_path)),
    location: { province: r.province, district: r.district, neighborhood: r.neighborhood },
    seller,
    status: r.status,
    estimate: r.estimate,
    protectedEligible: r.protected_eligible,
    createdAt: r.created_at,
  };
}

async function withSellers(rows: Row[]): Promise<Listing[]> {
  if (rows.length === 0) return [];
  const supabase = await createClient();
  const ids = [...new Set(rows.map((r) => r.seller_id))];
  const { data } = await supabase.from("public_profiles").select("id, display_name, is_shop, verified, created_at").in("id", ids);
  const byId = new Map((data as ProfileRow[] | null)?.map((p) => [p.id, p]));
  return rows.map((r) => toListing(r, toSeller(byId.get(r.seller_id), r.seller_id)));
}

// PostgREST filter syntax uses , ( ) and % specially; strip them from user input.
function searchTokens(q: string): string[] {
  return q
    .replace(/[,()%*\\"'.:]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 5);
}

export async function fetchListings(f: ListingFilters): Promise<Listing[]> {
  const supabase = await createClient();
  let query = supabase.from("listings").select(SELECT).eq("status", "active").limit(60);
  if (f.category) query = query.eq("category", f.category);
  if (f.graded === "graded") query = query.not("grading_company", "is", null);
  if (f.graded === "raw") query = query.is("grading_company", null);
  if (f.province) query = query.eq("province", f.province);
  if (f.minPrice != null) query = query.gte("price_cents", Math.round(f.minPrice * 100));
  if (f.maxPrice != null) query = query.lte("price_cents", Math.round(f.maxPrice * 100));
  for (const t of searchTokens(f.q ?? "")) {
    const cols = ["title", "subject", "set_name", "neighborhood", "district", "province"];
    query = query.or(cols.map((c) => `${c}.ilike.%${t}%`).join(","));
  }
  if (f.sort === "precio-asc") query = query.order("price_cents", { ascending: true });
  else if (f.sort === "precio-desc") query = query.order("price_cents", { ascending: false });
  else query = query.order("created_at", { ascending: false });

  const { data, error } = await query;
  if (error) throw new Error(`listings query failed: ${error.message}`);
  return withSellers((data ?? []) as Row[]);
}

export async function fetchListing(id: string): Promise<Listing | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("listings").select(SELECT).eq("id", id).maybeSingle();
  if (error) throw new Error(`listing query failed: ${error.message}`);
  if (!data) return null;
  const [listing] = await withSellers([data as Row]);
  return listing;
}
