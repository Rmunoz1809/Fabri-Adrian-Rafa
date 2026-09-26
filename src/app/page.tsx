import Link from "next/link";
import { CategoryChips, FilterForm } from "@/components/Filters";
import { ListingCard } from "@/components/ListingCard";
import { listListings, parseFilters } from "@/lib/data/listings";

export default async function Home({ searchParams }: PageProps<"/">) {
  const filters = parseFilters(await searchParams);
  const listings = await listListings(filters);
  const isFiltered = Boolean(filters.q || filters.category || filters.graded || filters.province || filters.minPrice || filters.maxPrice);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16">
      {!isFiltered && (
        <section className="py-8 sm:py-12">
          <h1 className="max-w-2xl font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
            Cartas coleccionables en Panamá, <span className="holo-text">con precio claro</span>.
          </h1>
          <p className="mt-3 max-w-xl text-ink-2">
            Pokémon, NBA y NFL. Cada anuncio muestra un rango de precio de mercado, y con Compra Protegida
            verificamos la carta antes de que el vendedor reciba tu pago.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/vender" className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink">
              Publica tu carta gratis
            </Link>
            <Link href="/protegida" className="rounded-full border border-line bg-surface px-5 py-2.5 text-sm font-semibold">
              ¿Cómo funciona Compra Protegida?
            </Link>
          </div>
        </section>
      )}

      <div className={`flex flex-col gap-3 ${isFiltered ? "pt-6" : ""}`}>
        <form action="/" className="sm:hidden">
          {filters.category && <input type="hidden" name="cat" value={filters.category} />}
          <label className="sr-only" htmlFor="q-mobile">Buscar</label>
          <input
            id="q-mobile"
            name="q"
            defaultValue={filters.q}
            placeholder="Busca Charizard, Wembanyama…"
            className="h-11 w-full rounded-full border border-line bg-surface px-4 text-sm outline-none focus:border-accent"
          />
        </form>
        <CategoryChips filters={filters} />
        <FilterForm filters={filters} />
      </div>

      <div className="mt-6 flex items-baseline justify-between">
        <h2 className="font-display text-xl font-bold">
          {filters.q ? `Resultados para “${filters.q}”` : "Recién publicadas"}
        </h2>
        <p className="text-sm text-ink-2">{listings.length} {listings.length === 1 ? "carta" : "cartas"}</p>
      </div>

      {listings.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-line p-10 text-center">
          <p className="font-medium">No encontramos cartas con esos filtros.</p>
          <p className="mt-1 text-sm text-ink-2">Prueba con otra búsqueda o <Link href="/" className="underline">ve todo</Link>.</p>
        </div>
      ) : (
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
          {listings.map((l, i) => (
            <li key={l.id} className="flex">
              <ListingCard listing={l} preload={i < 4} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
