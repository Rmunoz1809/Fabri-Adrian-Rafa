import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

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
Las notas de condición son una revisión visual preliminar, no una calificación oficial: describe lo que ves y nunca asignes una nota estilo PSA a una carta sin graduar.
En authenticity_flags señala cosas como: tipografía o colores extraños, falta de textura holo esperada, foto que parece imagen de catálogo o de internet, o un slab con etiqueta sospechosa.`;

let client: Anthropic | null = null;

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export async function recognizeCard(images: { data: string; mediaType: ImageMediaType }[]): Promise<Recognition> {
  client ??= new Anthropic();
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
  return response.parsed_output;
}

export class RecognitionError extends Error {}
