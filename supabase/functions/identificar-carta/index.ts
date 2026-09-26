// Supabase Edge Function used by holo.html. Two actions:
//   "identify" (default): identifies a trading card from 1-2 photos with Claude vision.
//   "price": researches the card's current market price on the web (sold listings on eBay,
//            PriceCharting, 130point, PSA auction prices, TCGplayer…) with Claude + web search.
//            Used for every card the free catalogs do not price: graded cards, NBA and NFL.
// The Anthropic key lives only here, as a Supabase secret; holo.html never sees it.
//
// Deploy:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...        --project-ref vqcpqoedsyatxswdzqcy
//   supabase functions deploy identificar-carta --no-verify-jwt --project-ref vqcpqoedsyatxswdzqcy
// (--no-verify-jwt because the project uses the new publishable keys; the function checks the
// user's session itself below.) Migration 0008_market_quotes.sql adds the 24 h price cache;
// without it prices still work, just without the shared cache.
//
// Keep RecognitionSchema in sync with src/lib/ai/recognize.ts (the Next.js version).
import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";
import { betaZodOutputFormat } from "npm:@anthropic-ai/sdk@0.128.0/helpers/beta/zod";
import { z } from "npm:zod@4";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-sonnet-5"; // ~1-1.5 US cents per identification; Opus 5 was ~2.5x that

const RecognitionSchema = z.object({
  is_trading_card: z.boolean(),
  category: z.enum(["pokemon", "nba", "nfl", "otra"]),
  subject: z.string().describe("Nombre del Pokémon o del jugador, tal como aparece impreso"),
  set_name: z.string().describe("Nombre del set o producto, p. ej. 'Scarlet & Violet—151' o 'Panini Prizm'"),
  year: z.number().int().nullable(),
  card_number: z.string().nullable().describe("Número impreso, p. ej. '199/165' o '#12'"),
  variant: z.string().nullable().describe("Paralelo o rareza: 'Holo', 'Silver Prizm', 'Special Illustration Rare'…"),
  is_graded: z.boolean(),
  grading_company: z.enum(["PSA", "BGS", "CGC", "SGC", "TAG"]).nullable(),
  grade: z.number().nullable(),
  cert_number: z.string().nullable(),
  condition_notes: z
    .array(z.string())
    .describe("Problemas visibles en español: centrado, esquinas, bordes, superficie. Vacío si no se ven."),
  authenticity_flags: z
    .array(z.string())
    .describe("Señales de posible réplica o foto de catálogo, en español. Vacío si no hay."),
  confidence: z.enum(["alta", "media", "baja"]),
  title_es: z.string().describe("Título corto para el anuncio en español"),
});

const SYSTEM = `Identificas cartas coleccionables (Pokémon TCG, NBA, NFL) a partir de fotos que suben vendedores en Panamá.
Lee solo lo que se ve impreso en la carta o en la etiqueta del slab. Si un dato no se puede leer, devuélvelo como null en vez de adivinar, y baja la confianza.
El número impreso (p. ej. 199/165) y el símbolo o código del set distinguen versiones de la misma carta: léelos con cuidado.
Las notas de condición son una revisión visual preliminar, no una calificación oficial: describe lo que ves y nunca asignes una nota estilo PSA a una carta sin graduar.
En authenticity_flags señala cosas como: tipografía o colores extraños, falta de textura holo esperada, foto que parece imagen de catálogo o de internet, o un slab con etiqueta sospechosa.`;

const PRICE_SYSTEM = `Eres analista de precios de cartas coleccionables (Pokémon TCG, NBA, NFL) para un marketplace en Panamá.
Busca en la web el valor de mercado ACTUAL en USD de la carta exacta que te dan: mismo año, set, número, paralelo o rareza, y misma empresa y nota de graduación (una PSA 10 no vale lo mismo que una PSA 9 ni que la carta sin graduar).
Prioriza ventas completadas recientes (eBay vendidos, 130point, PriceCharting, PSA Auction Prices, Goldin, Card Ladder, TCGplayer, Cardmarket). Los precios pedidos en anuncios activos solo sirven de apoyo, nunca como única base.
Reporta únicamente precios que viste en los resultados, con su fecha y el enlace de donde salen. No inventes ventas ni fechas.
Si no aparece la versión exacta, usa la más cercana (por ejemplo, la misma carta en otra nota) y dilo claramente en "basis", con un rango más amplio.
Siempre entrega un valor aproximado: nunca respondas que no hay precio.
Al terminar, llama a la herramienta report_price una sola vez con lo que encontraste.`;

const REPORT_PRICE = {
  name: "report_price",
  description: "Entrega el precio de mercado encontrado para la carta. Llámala una sola vez, al final de la investigación.",
  strict: true,
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["market_price", "low", "high", "basis", "sales", "sources"],
    properties: {
      market_price: { type: "number", description: "Valor típico hoy en USD para esta versión y nota exactas" },
      low: { type: "number", description: "Extremo bajo del rango razonable, USD" },
      high: { type: "number", description: "Extremo alto del rango razonable, USD" },
      basis: { type: "string", description: "En español, una frase: de dónde sale el valor. Ej.: 'Mediana de 7 ventas en eBay (PSA 10) entre agosto y septiembre de 2026'" },
      sales: {
        type: "array",
        description: "Ventas completadas vistas en los resultados (máximo 25), las más recientes primero",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["date", "price", "source", "url"],
          properties: {
            date: { type: "string", description: "Fecha de la venta, YYYY-MM-DD" },
            price: { type: "number", description: "Precio de venta en USD" },
            source: { type: "string", description: "Sitio, p. ej. 'eBay', 'PriceCharting', '130point'" },
            url: { type: "string", description: "Enlace donde se ve la venta; cadena vacía si no hay" },
          },
        },
      },
      sources: {
        type: "array",
        description: "Páginas consultadas que respaldan el valor (máximo 5)",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "url"],
          properties: { name: { type: "string" }, url: { type: "string" } },
        },
      },
    },
  },
};

const MAX_IMAGES = 2;
const MAX_BASE64 = Math.ceil((5 * 1024 * 1024 * 4) / 3); // 5 MB per photo
const ALLOWED = ["image/jpeg", "image/png", "image/webp"] as const;
type MediaType = (typeof ALLOWED)[number];
const QUOTE_TTL_MS = 24 * 3_600_000;

// Best-effort abuse limits per function instance: each call costs money.
const calls = new Map<string, number[]>();
// Max new web price researches per 24 h across all users (each one is several paid
// web searches). Override with the PRICE_DAILY_MAX secret.
const PRICE_DAILY_MAX = Number(Deno.env.get("PRICE_DAILY_MAX") ?? "") || 100;

function allow(key: string, perHour: number): boolean {
  const now = Date.now();
  const recent = (calls.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= perHour) return false;
  recent.push(now);
  calls.set(key, recent);
  return true;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

let client: Anthropic | null = null;
const admin = () => {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return key ? createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } }) : null;
};

type Body = {
  action?: unknown;
  images?: { data?: unknown; media_type?: unknown }[];
  card?: Record<string, unknown>;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return json({ error: "La IA no está configurada (falta ANTHROPIC_API_KEY)." }, 503);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Solicitud no válida." }, 400);
  }

  const auth = req.headers.get("Authorization") ?? "";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: userData } = await supabase.auth.getUser(auth.replace(/^Bearer\s+/i, "")).catch(() => ({ data: null }));
  const user = userData?.user ?? null;
  client ??= new Anthropic();

  try {
    if (body.action === "price") {
      // Cached quotes are served to anyone (holo.html can be browsed without an account).
      // A cache miss runs paid web searches with client-provided card fields, so new
      // research needs a session (checked inside price()) plus the daily budget.
      const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "anon";
      if (!allow("price:all", 400) || !allow(user ? `price:${user.id}` : `price-ip:${ip}`, 60)) {
        return json({ error: "Demasiadas consultas de precio. Intenta en un rato." }, 429);
      }
      return await price(body.card ?? {}, user);
    }

    // Identification: only signed-in sellers.
    if (!user) return json({ error: "Entra a tu cuenta para identificar cartas." }, 401);
    if (!allow(`id:${user.id}`, 30)) return json({ error: "Llegaste al límite de identificaciones por hora. Intenta más tarde." }, 429);
    return await identify(body.images ?? []);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Mucha demanda ahora mismo. Intenta en un minuto." }, 429);
    if (err instanceof Anthropic.APIError) {
      console.error("anthropic error", err.status, err.message);
      return json({ error: "El servicio de IA falló. Intenta de nuevo." }, 502);
    }
    console.error(err);
    return json({ error: "Error inesperado." }, 500);
  }
});

async function identify(raw: NonNullable<Body["images"]>) {
  const images = raw.slice(0, MAX_IMAGES);
  if (!images.length) return json({ error: "Sube al menos una foto." }, 400);
  for (const img of images) {
    if (typeof img.data !== "string" || !ALLOWED.includes(img.media_type as MediaType)) {
      return json({ error: "Formato no soportado. Usa JPG, PNG o WebP." }, 415);
    }
    if (img.data.length > MAX_BASE64) return json({ error: "Cada foto debe pesar menos de 5 MB." }, 413);
  }
  const response = await client!.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: betaZodOutputFormat(RecognitionSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.media_type as MediaType, data: img.data as string },
          })),
          { type: "text" as const, text: "Identifica esta carta." },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") return json({ error: "La IA no pudo procesar esta imagen." }, 422);
  if (!response.parsed_output) return json({ error: "No se pudo leer la respuesta de la IA." }, 422);
  return json({ card: response.parsed_output });
}

const str = (v: unknown, max = 80) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function price(card: Record<string, unknown>, user: { id: string } | null) {
  const c = {
    category: ["pokemon", "nba", "nfl"].includes(str(card.category)) ? str(card.category) : "otra",
    subject: str(card.subject),
    set_name: str(card.set_name),
    year: str(String(card.year ?? ""), 4),
    number: str(card.number, 20),
    variant: str(card.variant, 60),
    grading_company: str(card.grading_company, 10),
    grade: str(String(card.grade ?? ""), 4),
    condition: str(card.condition, 10),
  };
  if (c.subject.length < 2) return json({ error: "Falta el nombre de la carta." }, 400);
  const graded = c.grading_company && c.grade;
  const key = [c.category, c.subject, c.set_name, c.year, c.number, c.variant, graded ? `${c.grading_company}${c.grade}` : `raw-${c.condition || "NM"}`]
    .map((s) => s.toLowerCase().replace(/\s+/g, " ")).join("|");

  const db = admin();
  if (db) {
    const { data } = await db.from("market_quotes").select("quote, fetched_at").eq("quote_key", key).maybeSingle();
    if (data && Date.now() - Date.parse(data.fetched_at) < QUOTE_TTL_MS) return json({ quote: data.quote, cached: true });
  }

  if (!user) return json({ error: "Entra a tu cuenta para ver precios de mercado.", login: true }, 401);

  // Hard daily budget for new web research, persisted in the database (the in-memory
  // allow() limits reset whenever the function cold-starts). Cached quotes above are
  // still served. Fails closed: no database, no paid research.
  if (!db) return json({ error: "El servicio de precios no está disponible ahora." }, 503);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error: countErr } = await db.from("market_quotes").select("quote_key", { count: "exact", head: true }).gte("fetched_at", since);
  if (countErr || (count ?? 0) >= PRICE_DAILY_MAX) {
    if (countErr) console.error("price budget check failed", countErr);
    return json({ error: "Llegamos al límite diario de consultas de precio. Intenta mañana." }, 429);
  }

  const description = [
    `Categoría: ${c.category === "pokemon" ? "Pokémon TCG" : c.category.toUpperCase()}`,
    `Carta: ${c.subject}`,
    c.set_name && `Set / producto: ${c.set_name}`,
    c.year && `Año: ${c.year}`,
    c.number && `Número: ${c.number}`,
    c.variant && `Paralelo / rareza: ${c.variant}`,
    graded ? `Graduada: ${c.grading_company} ${c.grade}` : `Sin graduar (raw), condición ${c.condition || "Near Mint"}`,
  ].filter(Boolean).join("\n");

  const tools = [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 5 }, REPORT_PRICE];
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    { role: "user", content: `Encuentra el valor de mercado actual de esta carta:\n${description}` },
  ];
  let input: Record<string, unknown> | null = null;
  for (let turn = 0; turn < 5 && !input; turn++) {
    const res = await client!.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: PRICE_SYSTEM,
      tools,
      messages,
    });
    const call = res.content.find((b) => b.type === "tool_use" && b.name === "report_price");
    if (call && call.type === "tool_use") { input = call.input as Record<string, unknown>; break; }
    if (res.stop_reason === "refusal") break;
    messages.push({ role: "assistant", content: res.content });
    // pause_turn: the server paused a long search; sending the turn back resumes it.
    if (res.stop_reason !== "pause_turn") messages.push({ role: "user", content: "Llama ahora a report_price con lo que encontraste." });
  }
  if (!input) return json({ error: "No se pudo obtener el precio ahora mismo." }, 502);

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null);
  const today = new Date().toISOString().slice(0, 10);
  const sales = (Array.isArray(input.sales) ? input.sales : [])
    .map((s: Record<string, unknown>) => ({ date: str(s.date, 10), price: num(s.price), source: str(s.source, 40), url: /^https?:\/\//.test(str(s.url, 500)) ? str(s.url, 500) : null }))
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.date <= today && s.date >= "2015-01-01" && s.price)
    .slice(0, 25);
  const prices = sales.map((s) => s.price!).sort((a, b) => a - b);
  const mid = num(input.market_price) ?? (prices.length ? prices[Math.floor(prices.length / 2)] : null);
  if (!mid) return json({ error: "No se pudo obtener el precio ahora mismo." }, 502);
  const quote = {
    market_price: mid,
    low: Math.min(num(input.low) ?? mid * 0.85, mid),
    high: Math.max(num(input.high) ?? mid * 1.15, mid),
    basis: str(input.basis, 300),
    sales,
    sources: (Array.isArray(input.sources) ? input.sources : [])
      .map((s: Record<string, unknown>) => ({ name: str(s.name, 60), url: str(s.url, 500) }))
      .filter((s) => s.name && /^https?:\/\//.test(s.url)).slice(0, 5),
    fetched_at: new Date().toISOString(),
  };
  if (db) await db.from("market_quotes").upsert({ quote_key: key, quote, fetched_at: quote.fetched_at });
  return json({ quote });
}
