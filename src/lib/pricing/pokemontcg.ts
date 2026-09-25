import type { ReferencePrice } from "./estimate";

// pokemontcg.io exposes the card catalog plus TCGplayer reference prices.
// We cache responses for 12h: prices move slowly and the free tier is rate-limited.
const API = "https://api.pokemontcg.io/v2";
const REVALIDATE_SECONDS = 60 * 60 * 12;

export interface PokemonCatalogCard {
  id: string;
  name: string;
  number: string;
  rarity?: string;
  set: { id: string; name: string; releaseDate: string; printedTotal: number };
  images: { small: string; large: string };
  tcgplayer?: {
    updatedAt: string;
    prices?: Record<string, { low: number | null; mid: number | null; high: number | null; market: number | null }>;
  };
}

function headers(): HeadersInit {
  const key = process.env.POKEMONTCG_API_KEY;
  return key ? { "X-Api-Key": key } : {};
}

// Without an API key the service returns frequent 5xx; retry those with backoff.
const RETRIES = 3;

async function get<T>(path: string): Promise<T> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * 2 ** (attempt - 1)));
    const res = await fetch(`${API}${path}`, {
      headers: headers(),
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (res?.ok) return res.json() as Promise<T>;
    lastStatus = res?.status ?? 0;
    if (res && res.status < 500 && res.status !== 429) break;
  }
  throw new Error(`pokemontcg.io ${lastStatus || "network error"}`);
}

const SELECT = "id,name,number,rarity,set,images,tcgplayer";

function escapeQuery(s: string): string {
  return s.replace(/["\\]/g, "").trim();
}

export async function searchPokemonCards(opts: {
  name: string;
  number?: string;
  setName?: string;
}): Promise<PokemonCatalogCard[]> {
  // Exact phrase match: wildcards inside quotes make the API return 5xx.
  const name = `name:"${escapeQuery(opts.name)}"`;
  const number = opts.number?.split("/")[0].replace(/^#/, "").trim();
  const queries = number ? [`${name} number:"${escapeQuery(number)}"`, name] : [name];
  for (const q of queries) {
    const data = await get<{ data: PokemonCatalogCard[] }>(
      `/cards?q=${encodeURIComponent(q)}&pageSize=12&orderBy=-set.releaseDate&select=${SELECT}`,
    );
    if (data.data.length > 0) return data.data;
  }
  return [];
}

export async function getPokemonCard(id: string): Promise<PokemonCatalogCard | null> {
  try {
    const data = await get<{ data: PokemonCatalogCard }>(`/cards/${encodeURIComponent(id)}?select=${SELECT}`);
    return data.data;
  } catch {
    return null;
  }
}

// Prefer the variant that matches what the seller told us; otherwise the one with
// the most liquid market (normal > holofoil > reverse).
const VARIANT_ORDER = ["normal", "holofoil", "reverseHolofoil", "1stEditionHolofoil", "unlimitedHolofoil"];

export function pickReferencePrice(card: PokemonCatalogCard, variantHint?: string): ReferencePrice | null {
  const prices = card.tcgplayer?.prices;
  if (!prices) return null;
  const keys = Object.keys(prices);
  const hint = variantHint?.toLowerCase().replace(/[^a-z0-9]/g, "");
  const key =
    (hint && keys.find((k) => k.toLowerCase().includes(hint))) ||
    VARIANT_ORDER.find((k) => keys.includes(k)) ||
    keys[0];
  if (!key) return null;
  const p = prices[key];
  return { ...p, variant: key, updatedAt: card.tcgplayer!.updatedAt };
}
