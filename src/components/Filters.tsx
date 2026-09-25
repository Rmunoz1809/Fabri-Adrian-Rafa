import Link from "next/link";
import { CATEGORIES, PROVINCES } from "@/lib/catalog";
import type { ListingFilters } from "@/lib/data/listings";

function hrefWith(f: ListingFilters, patch: Partial<Record<string, string | undefined>>): string {
  const params = new URLSearchParams();
  const base: Record<string, string | undefined> = {
    q: f.q,
    cat: f.category,
    tipo: f.graded,
    provincia: f.province,
    min: f.minPrice?.toString(),
    max: f.maxPrice?.toString(),
    orden: f.sort === "recientes" ? undefined : f.sort,
  };
  for (const [k, v] of Object.entries({ ...base, ...patch })) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `/?${s}` : "/";
}

const chip = (active: boolean) =>
  `shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
    active ? "border-ink bg-ink text-bg" : "border-line bg-surface text-ink hover:border-ink-2"
  }`;

export function CategoryChips({ filters }: { filters: ListingFilters }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
      <Link href={hrefWith(filters, { cat: undefined })} className={chip(!filters.category)}>
        Todo
      </Link>
      {CATEGORIES.map((c) => (
        <Link key={c.slug} href={hrefWith(filters, { cat: c.slug })} className={chip(filters.category === c.slug)}>
          {c.name}
        </Link>
      ))}
    </div>
  );
}

const field = "h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm outline-none focus:border-accent";

export function FilterForm({ filters }: { filters: ListingFilters }) {
  const activeCount = [filters.graded, filters.province, filters.minPrice, filters.maxPrice].filter(
    (v) => v != null,
  ).length;
  return (
    <details className="group rounded-2xl border border-line bg-surface" open={activeCount > 0}>
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium">
        <span>
          Filtros{activeCount > 0 && <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-ink">{activeCount}</span>}
        </span>
        <span className="text-ink-2 transition-transform group-open:rotate-180" aria-hidden>▾</span>
      </summary>
      <form action="/" className="grid grid-cols-2 gap-3 border-t border-line p-4 sm:grid-cols-3 lg:grid-cols-6">
        {filters.category && <input type="hidden" name="cat" value={filters.category} />}
        <label className="col-span-2 flex flex-col gap-1 text-xs text-ink-2 sm:col-span-3 lg:col-span-2">
          Buscar
          <input name="q" defaultValue={filters.q} placeholder="Nombre, jugador, set…" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-2">
          Tipo
          <select name="tipo" defaultValue={filters.graded ?? ""} className={field}>
            <option value="">Todas</option>
            <option value="raw">Sin graduar</option>
            <option value="graded">Graduadas</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-2">
          Provincia
          <select name="provincia" defaultValue={filters.province ?? ""} className={field}>
            <option value="">Todo Panamá</option>
            {PROVINCES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs text-ink-2">
            Mín $
            <input name="min" type="number" min={0} inputMode="decimal" defaultValue={filters.minPrice} className={field} />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-ink-2">
            Máx $
            <input name="max" type="number" min={0} inputMode="decimal" defaultValue={filters.maxPrice} className={field} />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-2">
          Ordenar
          <select name="orden" defaultValue={filters.sort} className={field}>
            <option value="recientes">Más recientes</option>
            <option value="precio-asc">Precio: menor a mayor</option>
            <option value="precio-desc">Precio: mayor a menor</option>
          </select>
        </label>
        <div className="col-span-2 flex gap-2 sm:col-span-3 lg:col-span-6">
          <button className="h-10 rounded-xl bg-ink px-5 text-sm font-semibold text-bg">Aplicar</button>
          <Link href={filters.category ? `/?cat=${filters.category}` : "/"} className="flex h-10 items-center px-3 text-sm text-ink-2 hover:text-ink">
            Limpiar
          </Link>
        </div>
      </form>
    </details>
  );
}
