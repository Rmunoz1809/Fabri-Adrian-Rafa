"use server";

import { z } from "zod";
import { CATEGORIES, CONDITIONS, GRADING_COMPANIES } from "@/lib/catalog";

export type PublishState = { ok: true; message: string } | { ok?: false; error: string } | null;

const ListingInput = z
  .object({
    category: z.enum(CATEGORIES.map((c) => c.slug) as [string, ...string[]]),
    subject: z.string().trim().min(2).max(80),
    setName: z.string().trim().min(1).max(80),
    year: z.coerce.number().int().min(1990).max(2030).optional().or(z.literal("").transform(() => undefined)),
    number: z.string().trim().max(20).optional(),
    variant: z.string().trim().max(60).optional(),
    graded: z.enum(["true", "false"]).transform((v) => v === "true"),
    company: z.enum(GRADING_COMPANIES).optional(),
    grade: z.coerce.number().min(1).max(10).optional(),
    condition: z.enum(CONDITIONS.map((c) => c.code) as [string, ...string[]]).optional(),
    price: z.coerce.number().positive().max(100_000),
    title: z.string().trim().min(5).max(80),
    description: z.string().trim().max(1000).optional(),
    province: z.string().min(1),
    district: z.string().min(1),
    neighborhood: z.string().min(1),
    catalogId: z.string().max(40).optional(),
  })
  .refine((v) => (v.graded ? v.company && v.grade : v.condition), {
    message: "Indica la graduación o la condición de la carta.",
  });

export async function publishListing(_prev: PublishState, form: FormData): Promise<PublishState> {
  const raw = Object.fromEntries([...form.entries()].filter(([k]) => k !== "photos"));
  const parsed = ListingInput.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: first?.message ?? "Revisa los datos del anuncio." };
  }
  const photos = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (photos.length === 0) return { error: "Agrega al menos una foto real de la carta." };

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return {
      ok: true,
      message: "Modo demo: el anuncio es válido, pero no se guarda hasta conectar Supabase.",
    };
  }

  // TODO(supabase): require auth, upload photos to storage, insert listing row.
  return { error: "Publicación aún no conectada a la base de datos." };
}
