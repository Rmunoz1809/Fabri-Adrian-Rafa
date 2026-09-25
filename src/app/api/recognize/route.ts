import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { recognizeCard, RecognitionError, type ImageMediaType } from "@/lib/ai/recognize";
import { getPokemonCard, pickReferencePrice, searchPokemonCards } from "@/lib/pricing/pokemontcg";
import { estimatePrice } from "@/lib/pricing/estimate";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 2;
const ALLOWED: ImageMediaType[] = ["image/jpeg", "image/png", "image/webp"];

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "El reconocimiento con IA no está configurado todavía (falta ANTHROPIC_API_KEY)." },
      { status: 503 },
    );
  }

  const form = await req.formData();
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

    // For Pokémon we can match the catalog and pull a reference price.
    let match = null;
    let estimate = null;
    if (card.is_trading_card && card.category === "pokemon" && card.subject) {
      const candidates = await searchPokemonCards({
        name: card.subject,
        number: card.card_number ?? undefined,
      }).catch(() => []);
      const best = candidates[0] ? await getPokemonCard(candidates[0].id) : null;
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
    throw err;
  }
}
