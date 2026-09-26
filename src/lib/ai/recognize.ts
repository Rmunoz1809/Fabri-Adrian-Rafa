import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

// Same model, schema and instructions as supabase/functions/identificar-carta/index.ts (the one holo.html
// uses). Keep both in sync.
const MODEL = "claude-sonnet-5";

export const RecognitionSchema = z.object({
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

export type Recognition = z.infer<typeof RecognitionSchema>;

const SYSTEM = `Identificas cartas coleccionables (Pokémon TCG, NBA, NFL) a partir de fotos que suben vendedores en Panamá.
Lee solo lo que se ve impreso en la carta o en la etiqueta del slab. Si un dato no se puede leer, devuélvelo como null en vez de adivinar, y baja la confianza.
El número impreso (p. ej. 199/165) y el símbolo o código del set distinguen versiones de la misma carta: léelos con cuidado.
Las notas de condición son una revisión visual preliminar, no una calificación oficial: describe lo que ves y nunca asignes una nota estilo PSA a una carta sin graduar.
is_graded es true solo si la carta está sellada dentro de un slab con la etiqueta de PSA, BGS, CGC, SGC o TAG visible en la foto. grading_company, grade y cert_number salen únicamente de lo que se lee en esa etiqueta; si la etiqueta no se lee con claridad, déjalos en null. Una carta suelta, en funda o en toploader no está graduada.
En authenticity_flags señala cosas como: tipografía o colores extraños, falta de textura holo esperada, foto que parece imagen de catálogo o de internet, o un slab con etiqueta sospechosa.`;

let client: Anthropic | null = null;

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export async function recognizeCard(images: { data: string; mediaType: ImageMediaType }[]): Promise<Recognition> {
  client ??= new Anthropic();
  const response = await client.beta.messages.parse({
    model: MODEL,
    // Thinking shares this budget; a low cap truncates the JSON on hard photos.
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: betaZodOutputFormat(RecognitionSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
          })),
          { type: "text", text: "Identifica esta carta." },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new RecognitionError("La IA no pudo procesar esta imagen.");
  }
  if (!response.parsed_output) {
    throw new RecognitionError("No se pudo leer la respuesta de la IA.");
  }
  return normalizeGrading(response.parsed_output);
}

/**
 * The grade is only what the slab label says, rounded to half points like the Edge Function. A slab
 * whose company or grade could not be read keeps is_graded but loses both, so the form asks for a
 * clearer photo instead of publishing a made-up grade.
 */
export function normalizeGrading(card: Recognition): Recognition {
  const grade = card.grade != null ? Math.round(card.grade * 2) / 2 : null;
  if (card.is_graded && card.grading_company && grade != null && grade >= 1 && grade <= 10) return { ...card, grade };
  return card.is_graded ? { ...card, grading_company: null, grade: null } : card;
}

export class RecognitionError extends Error {}
