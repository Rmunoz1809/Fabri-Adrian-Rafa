"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { CATEGORIES, CONDITIONS, GRADING_COMPANIES, LOCATIONS } from "@/lib/catalog";
import { estimatePrice, type LocalComp } from "@/lib/pricing/estimate";
import { getPokemonCard, pickReferencePrice } from "@/lib/pricing/pokemontcg";
import { createClient, getCurrentUser, isSupabaseConfigured } from "@/lib/supabase/server";

export type PublishState = { ok: true; message: string } | { ok?: false; error: string } | null;

const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024; // photos are compressed client-side first
const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

const ListingInput = z
  .object({
    category: z.enum(CATEGORIES.map((c) => c.slug) as [string, ...string[]]),
    subject: z.string().trim().min(2, "Falta el nombre del Pokémon o jugador.").max(80),
    setName: z.string().trim().min(1, "Falta el set o producto.").max(80),
    year: z.union([z.literal(""), z.coerce.number().int().min(1990).max(2030)]).optional()
      .transform((v) => (v === "" ? undefined : v)),
    number: optionalText(20),
    variant: optionalText(60),
    graded: z.enum(["true", "false"]).transform((v) => v === "true"),
    company: z.enum(GRADING_COMPANIES).optional(),
    grade: z.union([z.literal(""), z.coerce.number().min(1).max(10)]).optional()
      .transform((v) => (v === "" ? undefined : v)),
    condition: z.enum(CONDITIONS.map((c) => c.code) as [string, ...string[]]).optional(),
    price: z.coerce.number({ message: "Precio no válido." }).positive("El precio debe ser mayor a 0.").max(100_000),
    title: z.string().trim().min(5, "El título es muy corto.").max(80),
    description: optionalText(1000),
    province: z.string().min(1),
    district: z.string().min(1),
    neighborhood: z.string().min(1),
    catalogId: optionalText(40),
  })
  .refine((v) => (v.graded ? v.company && v.grade : v.condition), {
    message: "Indica la graduación o la condición de la carta.",
  })
  .refine(
    (v) => LOCATIONS.some((l) => l.province === v.province && l.district === v.district && l.neighborhoods.includes(v.neighborhood)),
    { message: "Ubicación no válida." },
  );

export async function publishListing(_prev: PublishState, form: FormData): Promise<PublishState> {
  const raw = Object.fromEntries([...form.entries()].filter(([k]) => k !== "photos"));
  const parsed = ListingInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Revisa los datos del anuncio." };
  const v = parsed.data;

  const photos = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (photos.length === 0) return { error: "Agrega al menos una foto real de la carta." };
  if (photos.length > MAX_PHOTOS) return { error: `Máximo ${MAX_PHOTOS} fotos.` };
  for (const p of photos) {
    if (!PHOTO_TYPES[p.type]) return { error: "Las fotos deben ser JPG, PNG o WebP." };
    if (p.size > MAX_PHOTO_BYTES) return { error: "Una de las fotos es muy pesada (máx. 3 MB)." };
  }

  if (!isSupabaseConfigured()) {
    return { ok: true, message: "Modo demo: el anuncio es válido, pero no se guarda hasta conectar Supabase." };
  }
  const user = await getCurrentUser();
  if (!user) return { error: "Tu sesión expiró. Vuelve a entrar para publicar." };

  const supabase = await createClient();
  const gradingKey = v.graded ? `${v.company}${v.grade}` : "raw";
  const catalogId = v.category === "pokemon" ? v.catalogId : undefined;

  // Estimate at publish time so browsing never waits on external APIs.
  let comps: LocalComp[] = [];
  if (catalogId) {
    const { data } = await supabase
      .from("sales")
      .select("price_cents, sold_at")
      .eq("catalog_id", catalogId)
      .eq("grading_key", gradingKey)
      .order("sold_at", { ascending: false })
      .limit(50);
    comps = (data ?? []).map((s) => ({ priceUsd: s.price_cents / 100, soldAt: s.sold_at }));
  }
  const catalogCard = catalogId && !v.graded ? await getPokemonCard(catalogId) : null;
  const estimate = estimatePrice({
    reference: catalogCard ? pickReferencePrice(catalogCard, v.variant) : null,
    localComps: comps,
    condition: v.graded ? null : (v.condition as never),
    grading: v.graded ? { company: v.company!, grade: v.grade! } : null,
  });

  const listingId = crypto.randomUUID();
  const { error: insertError } = await supabase.from("listings").insert({
    id: listingId,
    seller_id: user.id,
    category: v.category,
    title: v.title,
    description: v.description ?? null,
    subject: v.subject,
    set_name: v.setName,
    year: v.year ?? null,
    number: v.number ?? null,
    variant: v.variant ?? null,
    condition: v.graded ? null : v.condition,
    grading_company: v.graded ? v.company : null,
    grade: v.graded ? v.grade : null,
    price_cents: Math.round(v.price * 100),
    province: v.province,
    district: v.district,
    neighborhood: v.neighborhood,
    catalog_id: catalogId ?? null,
    estimate,
  });
  if (insertError) {
    console.error("listing insert failed", insertError);
    return { error: "No pudimos guardar el anuncio. Intenta de nuevo." };
  }

  const paths: string[] = [];
  for (const [i, photo] of photos.entries()) {
    const path = `${user.id}/${listingId}/${i}.${PHOTO_TYPES[photo.type]}`;
    const { error } = await supabase.storage.from("listing-photos").upload(path, photo, { contentType: photo.type });
    if (error) {
      console.error("photo upload failed", error);
      await supabase.storage.from("listing-photos").remove(paths);
      await supabase.from("listings").delete().eq("id", listingId);
      return { error: "No pudimos subir las fotos. Intenta de nuevo." };
    }
    paths.push(path);
  }
  const { error: photoRowsError } = await supabase
    .from("listing_photos")
    .insert(paths.map((storage_path, position) => ({ listing_id: listingId, storage_path, position })));
  if (photoRowsError) console.error("listing_photos insert failed", photoRowsError);

  redirect(`/carta/${listingId}`);
}
