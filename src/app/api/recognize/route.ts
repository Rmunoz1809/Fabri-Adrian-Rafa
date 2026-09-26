import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { recognizeCard, RecognitionError, type ImageMediaType } from "@/lib/ai/recognize";
import { pickReferencePrice, searchPokemonCards } from "@/lib/pricing/pokemontcg";
import { estimatePrice } from "@/lib/pricing/estimate";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUser, isSupabaseConfigured } from "@/lib/supabase/server";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 2;
const ALLOWED: ImageMediaType[] = ["image/jpeg", "image/png", "image/webp"];
const PER_HOUR = 30; // same limit as the Edge Function; every call costs money

// Best-effort limit per server instance.
const calls = new Map<string, number[]>();
function allow(key: string): boolean {
  const now = Date.now();
  const recent = (calls.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_HOUR) return false;
  recent.push(now);
  calls.set(key, recent);
  return true;
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "El reconocimiento con IA no está configurado todavía (falta ANTHROPIC_API_KEY)." },
      { status: 503 },
    );
  }
  // Only signed-in sellers (without Supabase, the demo mode has no accounts to check).
  const user = isSupabaseConfigured() ? await getCurrentUser() : null;
  if (isSupabaseConfigured() && !user) {
    return NextResponse.json({ error: "Entra a tu cuenta para identificar cartas." }, { status: 401 });
  }
  if (!allow(user?.id ?? "demo")) {
    return NextResponse.json({ error: "Llegaste al límite de identificaciones por hora. Intenta más tarde." }, { status: 429 });
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_IMAGES * MAX_BYTES + 64 * 1024) {
    return NextResponse.json({ error: "Cada foto debe pesar menos de 5 MB." }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Solicitud no válida." }, { status: 400 });
  }
  const files = form.getAll("photos").filter((f): f is File => f instanceof File).slice(0, MAX_IMAGES);
  if (files.length === 0) {
    return NextResponse.json({ error: "Sube al menos una foto." }, { status: 400 });
  }
  for (const f of files) {
    if (!ALLOWED.includes(f.type as ImageMediaType)) {
      return NextResponse.json({ error: "Formato no soportado. Usa JPG, PNG o WebP." }, { status: 415 });
    }
    if (f.size > MAX_BYTES) {
      return NextResponse.json({ error: "Cada foto debe pesar menos de 5 MB." }, { status: 413 });
    }
  }

  const images = await Promise.all(
    files.map(async (f) => ({
      data: Buffer.from(await f.arrayBuffer()).toString("base64"),
      mediaType: f.type as ImageMediaType,
    })),
  );

  try {
    const card = await recognizeCard(images);

    // The grade can only come from the slab in the photo: record it so the database accepts the graded
    // listing (migration 0009), exactly like the Edge Function does for holo.html.
    if (user && card.is_graded && card.grading_company && card.grade != null) {
      const admin = createAdminClient();
      const { error } = await admin?.from("grading_detections").insert({
        user_id: user.id, grading_company: card.grading_company, grade: card.grade,
        cert_number: card.cert_number?.trim().slice(0, 30) || null,
      }) ?? { error: { message: "SUPABASE_SERVICE_ROLE_KEY is not set" } };
      if (error) console.error("grading_detections insert failed:", error.message);
    }

    // For Pokémon we can match the catalog and pull a reference price.
    let match = null;
    let estimate = null;
    if (card.is_trading_card && card.category === "pokemon" && card.subject) {
      const candidates = await searchPokemonCards({
        name: card.subject,
        number: card.card_number ?? undefined,
      }).catch((e) => {
        console.warn("catalog lookup failed:", e instanceof Error ? e.message : e);
        return [];
      });
      const best = candidates[0] ?? null;
      if (best) {
        match = { id: best.id, name: best.name, set: best.set.name, number: best.number, image: best.images.small };
        estimate = estimatePrice({
          reference: pickReferencePrice(best, card.variant ?? undefined),
          condition: card.is_graded ? null : "NM",
          grading: card.is_graded && card.grading_company && card.grade
            ? { company: card.grading_company, grade: card.grade }
            : null,
        });
      }
    }

    return NextResponse.json({ card, match, estimate });
  } catch (err) {
    if (err instanceof RecognitionError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "Mucha demanda ahora mismo. Intenta en un minuto." }, { status: 429 });
    }
    if (err instanceof Anthropic.APIError) {
      console.error("anthropic error", err.status, err.message);
      return NextResponse.json({ error: "El servicio de IA falló. Intenta de nuevo." }, { status: 502 });
    }
    if (err instanceof Anthropic.AnthropicError) {
      // messages.parse() could not validate the answer (e.g. a value outside the schema).
      console.error("anthropic parse error", err.message);
      return NextResponse.json({ error: "No se pudo leer la respuesta de la IA." }, { status: 422 });
    }
    console.error(err);
    return NextResponse.json({ error: "Error inesperado. Intenta de nuevo." }, { status: 500 });
  }
}
