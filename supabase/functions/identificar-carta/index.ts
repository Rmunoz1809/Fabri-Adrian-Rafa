// Supabase Edge Function: identifies a trading card from 1-2 photos with Claude vision.
// Called by holo.html (viewSell) right after the seller picks a photo. The Anthropic key lives
// only here, as a Supabase secret; holo.html never sees it.
//
// Deploy (once):
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...        --project-ref vqcpqoedsyatxswdzqcy
//   supabase functions deploy identificar-carta --no-verify-jwt --project-ref vqcpqoedsyatxswdzqcy
// (--no-verify-jwt because the project uses the new publishable keys; the function checks the
// user's session itself below.)
//
// Keep RecognitionSchema in sync with src/lib/ai/recognize.ts (the Next.js version).
import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";
import { betaZodOutputFormat } from "npm:@anthropic-ai/sdk@0.128.0/helpers/beta/zod";
import { z } from "npm:zod@4";
import { createClient } from "npm:@supabase/supabase-js@2";

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

const MAX_IMAGES = 2;
const MAX_BASE64 = Math.ceil((5 * 1024 * 1024 * 4) / 3); // 5 MB per photo
const ALLOWED = ["image/jpeg", "image/png", "image/webp"] as const;
type MediaType = (typeof ALLOWED)[number];

// Best-effort abuse limit per user (per function instance): each call costs money.
const LIMIT_PER_HOUR = 30;
const calls = new Map<string, number[]>();
function allow(userId: string): boolean {
  const now = Date.now();
  const recent = (calls.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= LIMIT_PER_HOUR) return false;
  recent.push(now);
  calls.set(userId, recent);
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return json({ error: "El reconocimiento con IA no está configurado (falta ANTHROPIC_API_KEY)." }, 503);
  }

  // Only signed-in sellers can use it.
  const auth = req.headers.get("Authorization") ?? "";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: userData } = await supabase.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  const user = userData?.user;
  if (!user) return json({ error: "Entra a tu cuenta para identificar cartas." }, 401);
  if (!allow(user.id)) return json({ error: "Llegaste al límite de identificaciones por hora. Intenta más tarde." }, 429);

  let body: { images?: { data?: unknown; media_type?: unknown }[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Solicitud no válida." }, 400);
  }
  const images = (body.images ?? []).slice(0, MAX_IMAGES);
  if (!images.length) return json({ error: "Sube al menos una foto." }, 400);
  for (const img of images) {
    if (typeof img.data !== "string" || !ALLOWED.includes(img.media_type as MediaType)) {
      return json({ error: "Formato no soportado. Usa JPG, PNG o WebP." }, 415);
    }
    if (img.data.length > MAX_BASE64) return json({ error: "Cada foto debe pesar menos de 5 MB." }, 413);
  }

  client ??= new Anthropic();
  try {
    const response = await client.beta.messages.parse({
      model: "claude-opus-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
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
