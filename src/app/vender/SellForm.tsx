"use client";

import { startTransition, useActionState, useMemo, useState, type FormEvent } from "react";
import { CATEGORIES, CONDITIONS, LOCATIONS } from "@/lib/catalog";
import { formatUsd, toCents } from "@/lib/fees";
import { priceVerdict } from "@/lib/pricing/estimate";
import type { PriceEstimate } from "@/lib/types";
import type { Recognition } from "@/lib/ai/recognize";
import { compressImage } from "@/lib/image";
import { publishListing, type PublishState } from "./actions";

type RecognizeResponse = {
  card: Recognition;
  match: { id: string; name: string; set: string; number: string; image: string } | null;
  estimate: PriceEstimate | null;
};

const field = "h-11 w-full rounded-xl border border-line bg-surface px-3 text-base outline-none focus:border-accent sm:text-sm";
const label = "flex flex-col gap-1.5 text-sm font-medium";

export function SellForm() {
  const [previews, setPreviews] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [ai, setAi] = useState<RecognizeResponse | null>(null);

  const [category, setCategory] = useState("pokemon");
  const [subject, setSubject] = useState("");
  const [setName, setSetName] = useState("");
  const [year, setYear] = useState("");
  const [number, setNumber] = useState("");
  const [variant, setVariant] = useState("");
  const [condition, setCondition] = useState("NM");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [locIndex, setLocIndex] = useState(0);

  const [state, formAction, publishing] = useActionState<PublishState, FormData>(publishListing, null);

  // The grade is read from the slab label in the photo and cannot be typed or changed (migration 0009
  // enforces the same rule in the database).
  const scanned = ai?.card;
  const grading = scanned?.is_graded && scanned.grading_company && scanned.grade != null
    ? { company: scanned.grading_company, grade: scanned.grade, cert: scanned.cert_number }
    : null;
  const slabUnread = Boolean(scanned?.is_graded && !grading);

  const priceNum = Number(price);
  const verdict = useMemo(
    () => (priceNum > 0 ? priceVerdict(priceNum, ai?.estimate ?? null) : null),
    [priceNum, ai],
  );

  const [preparing, setPreparing] = useState(false);

  async function onFiles(list: FileList | null) {
    const picked = Array.from(list ?? []).slice(0, 4);
    if (picked.length === 0) return;
    setPreparing(true);
    const compressed = await Promise.all(picked.map(compressImage));
    setPreparing(false);
    previews.forEach((u) => URL.revokeObjectURL(u));
    setFiles(compressed);
    setPreviews(compressed.map((f) => URL.createObjectURL(f)));
    setAi(null);
    setScanError(null);
  }

  // onSubmit instead of <form action>: React resets a form after its action runs, which after a failed
  // publish would silently snap selects back to their first option and empty the description.
  // Photos live in state (not the file input) for the same reason.
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.delete("photos");
    files.forEach((f) => fd.append("photos", f));
    startTransition(() => formAction(fd));
  }

  async function scan() {
    if (files.length === 0) return;
    setScanning(true);
    setScanError(null);
    try {
      const body = new FormData();
      files.slice(0, 2).forEach((f) => body.append("photos", f));
      const res = await fetch("/api/recognize", { method: "POST", body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "No se pudo identificar la carta.");
      const r = json as RecognizeResponse;
      setAi(r);
      const c = r.card;
      if (!c.is_trading_card) {
        setScanError("No parece una carta coleccionable. Prueba con una foto más cercana y con buena luz.");
        return;
      }
      if (c.category !== "otra") setCategory(c.category);
      setSubject(r.match?.name ?? c.subject);
      setSetName(r.match?.set ?? c.set_name);
      setYear(c.year?.toString() ?? "");
      setNumber(c.card_number ?? "");
      setVariant(c.variant ?? "");
      setTitle(c.title_es.slice(0, 80));
    } catch (e) {
      setScanError(e instanceof Error ? e.message : "Error inesperado.");
    } finally {
      setScanning(false);
    }
  }

  const loc = LOCATIONS.flatMap((l) => l.neighborhoods.map((n) => ({ ...l, neighborhood: n })));

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      {/* Step 1: photos + AI */}
      <section className="flex flex-col gap-3 lg:sticky lg:top-20 lg:self-start">
        <h2 className="font-display text-lg font-bold">1. Fotos</h2>
        <label className="card-ratio relative mx-auto flex w-full max-w-[260px] cursor-pointer lg:max-w-none flex-col items-center justify-center gap-2 overflow-hidden rounded-3xl border-2 border-dashed border-line bg-surface text-center hover:border-ink-2">
          {previews[0] ? (
            // eslint-disable-next-line @next/next/no-img-element -- local blob preview
            <img src={previews[0]} alt="Vista previa" className="absolute inset-0 size-full object-contain p-4" />
          ) : (
            <>
              <span className="text-4xl" aria-hidden>📸</span>
              <span className="font-medium">Toma o sube una foto</span>
              <span className="px-6 text-xs text-ink-2">Frente y reverso (hasta 4 fotos), con buena luz y sin reflejos.</span>
            </>
          )}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="sr-only"
            onChange={(e) => onFiles(e.target.files)}
          />
        </label>
        {preparing && <p className="text-xs text-ink-2">Preparando fotos…</p>}
        {previews.length > 1 && (
          <div className="flex gap-2">
            {previews.map((u, i) => (
              // eslint-disable-next-line @next/next/no-img-element -- local blob preview
              <img key={u} src={u} alt={`Foto ${i + 1}`} className="h-16 w-12 rounded-md border border-line object-cover" />
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={scan}
          disabled={files.length === 0 || scanning}
          className="holo-border flex h-12 items-center justify-center gap-2 rounded-xl font-semibold disabled:opacity-50"
        >
          {scanning ? "Identificando…" : <>Identificar con <span className="holo-text">IA</span></>}
        </button>
        {scanError && <p className="rounded-xl bg-bad-bg p-3 text-sm text-bad">{scanError}</p>}

        {ai && ai.card.is_trading_card && (
          <div className="rounded-2xl border border-line bg-surface p-4 text-sm">
            <p className="font-semibold">
              La IA reconoció: {ai.card.subject}{" "}
              <span className="font-normal text-ink-2">(confianza {ai.card.confidence})</span>
            </p>
            {ai.card.condition_notes.length > 0 && (
              <>
                <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-ink-2">Revisión visual preliminar</p>
                <ul className="mt-1 space-y-0.5 text-ink-2">
                  {ai.card.condition_notes.map((n) => <li key={n}>• {n}</li>)}
                </ul>
                <p className="mt-1 text-xs text-ink-2">No es una calificación oficial.</p>
              </>
            )}
            {ai.card.authenticity_flags.length > 0 && (
              <div className="mt-3 rounded-xl bg-warn-bg p-3 text-warn">
                <p className="font-semibold">Revisa esto antes de publicar</p>
                <ul className="mt-1 space-y-0.5">{ai.card.authenticity_flags.map((n) => <li key={n}>• {n}</li>)}</ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Step 2: details */}
      <section className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-bold">2. Detalles de la carta</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>
            Categoría
            <select name="category" value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
              {CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
          </label>
          <label className={label}>
            {category === "pokemon" ? "Pokémon" : "Jugador"}
            <input name="subject" required value={subject} onChange={(e) => setSubject(e.target.value)} className={field} />
          </label>
          <label className={label}>
            Set / producto
            <input name="setName" required value={setName} onChange={(e) => setSetName(e.target.value)} placeholder={category === "pokemon" ? "151" : "Panini Prizm"} className={field} />
          </label>
          <label className={label}>
            Año
            <input name="year" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} className={field} />
          </label>
          <label className={label}>
            Número
            <input name="number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="199/165" className={field} />
          </label>
          <label className={label}>
            Variante / paralelo
            <input name="variant" value={variant} onChange={(e) => setVariant(e.target.value)} placeholder="Holo, Silver…" className={field} />
          </label>
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">Graduación</legend>
          <input type="hidden" name="graded" value={String(Boolean(grading))} />
          {grading ? (
            <div className="rounded-2xl border border-line bg-surface p-4 text-sm">
              <input type="hidden" name="company" value={grading.company} />
              <input type="hidden" name="grade" value={grading.grade} />
              <p className="font-semibold">
                Graduada {grading.company} {grading.grade}{grading.cert ? ` · Certificado ${grading.cert}` : ""}
              </p>
              <p className="mt-1 text-xs text-ink-2">
                Lo leímos de la etiqueta del slab en tu foto y no se puede cambiar a mano. Si está mal, sube una foto más clara de la etiqueta.
              </p>
            </div>
          ) : (
            <>
              <p className={`text-xs ${slabUnread ? "rounded-xl bg-warn-bg p-3 text-warn" : "text-ink-2"}`}>
                {slabUnread
                  ? "Vimos un slab pero no pudimos leer la empresa o la nota. Sube una foto de frente donde se lea la etiqueta."
                  : "Si tu carta está en un slab (PSA, BGS, CGC, SGC, TAG), identifícala con una foto donde se lea la etiqueta: la empresa y la nota salen de ahí."}
              </p>
              <label className={label}>
                Condición
                <select name="condition" value={condition} onChange={(e) => setCondition(e.target.value)} className={field}>
                  {CONDITIONS.map((c) => <option key={c.code} value={c.code}>{c.label} ({c.code}): {c.hint}</option>)}
                </select>
              </label>
            </>
          )}
        </fieldset>

        <h2 className="mt-2 font-display text-lg font-bold">3. Precio y ubicación</h2>
        {ai?.estimate ? (
          <div className="holo-border rounded-2xl p-4 text-sm">
            <p className="font-semibold">Precio estimado: {formatUsd(toCents(ai.estimate.low))} – {formatUsd(toCents(ai.estimate.high))}</p>
            <p className="text-xs text-ink-2">{ai.estimate.basis.join(" · ")}. Es una referencia, no una garantía.</p>
          </div>
        ) : ai ? (
          <p className="rounded-2xl bg-surface-2 p-4 text-sm text-ink-2">
            No tenemos datos suficientes para estimar esta carta. Revisa ventas recientes antes de poner precio.
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>
            Precio (USD)
            <input name="price" required type="number" min={1} step="0.01" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} className={field} />
          </label>
          <label className={label}>
            Barrio / zona
            <select name="location" value={locIndex} onChange={(e) => setLocIndex(Number(e.target.value))} className={field}>
              {loc.map((l, i) => <option key={`${l.district}-${l.neighborhood}`} value={i}>{l.neighborhood}, {l.district}</option>)}
            </select>
          </label>
        </div>
        {verdict === "alto" && <p className="text-sm text-warn">Tu precio está por encima del rango estimado. Puede tardar más en venderse.</p>}
        {verdict === "buen-precio" && <p className="text-sm text-good">Tu precio está por debajo del rango. Se va a vender rápido.</p>}
        <p className="text-xs text-ink-2">Solo mostramos el barrio, nunca tu dirección.</p>

        <label className={label}>
          Título
          <input name="title" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
        </label>
        <label className={label}>
          Descripción
          <textarea name="description" rows={4} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Estado, detalles, dónde puedes entregarla…" className="w-full rounded-xl border border-line bg-surface p-3 text-base outline-none focus:border-accent sm:text-sm" />
        </label>
        <input type="hidden" name="province" value={loc[locIndex]?.province} />
        <input type="hidden" name="district" value={loc[locIndex]?.district} />
        <input type="hidden" name="neighborhood" value={loc[locIndex]?.neighborhood} />
        <input type="hidden" name="catalogId" value={ai?.match?.id ?? ""} />

        {state && "error" in state && <p className="rounded-xl bg-bad-bg p-3 text-sm text-bad">{state.error}</p>}
        {state && "message" in state && <p className="rounded-xl bg-good-bg p-3 text-sm text-good">{state.message}</p>}
        {slabUnread && <p className="rounded-xl bg-warn-bg p-3 text-sm text-warn">Para publicar una carta graduada, la nota tiene que leerse en la foto del slab.</p>}
        <button disabled={publishing || slabUnread} className="h-12 rounded-xl bg-accent font-semibold text-accent-ink disabled:opacity-60">
          {publishing ? "Publicando…" : "Publicar gratis"}
        </button>
      </section>
    </form>
  );
}
