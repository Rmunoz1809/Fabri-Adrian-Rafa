import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CardArt } from "@/components/CardArt";
import { ConditionBadge, ProtectedBadge, VerdictBadge } from "@/components/Badges";
import { EstimatePanel } from "@/components/EstimatePanel";
import { APP_NAME, categoryName, CONDITIONS } from "@/lib/catalog";
import { whatsappLink } from "@/lib/contact";
import { getListing } from "@/lib/data/listings";
import { formatUsd, quoteProtected, toCents } from "@/lib/fees";

export async function generateMetadata({ params }: PageProps<"/carta/[id]">): Promise<Metadata> {
  const listing = await getListing((await params).id);
  return listing ? { title: listing.title } : {};
}

export default async function ListingPage({ params }: PageProps<"/carta/[id]">) {
  const listing = await getListing((await params).id);
  if (!listing) notFound();

  const price = toCents(listing.priceUsd);
  const quote = listing.protectedEligible ? quoteProtected(price) : null;
  const url = `ref ${listing.id}`;
  const contact = whatsappLink(`Hola, me interesa "${listing.title}" (${formatUsd(price)}, ${url}).`);
  const buyProtected = whatsappLink(
    `Quiero comprar con Compra Protegida: "${listing.title}" (${url}). Total ${quote ? formatUsd(quote.buyerTotalCents) : ""}.`,
  );
  const condition = CONDITIONS.find((c) => c.code === listing.condition);
  // Same rules as holo.html: sold, reserved or removed listings are shown but cannot be bought.
  const forSale = listing.isDemo || listing.status === "active";
  const statusNote = listing.isDemo ? null : {
    sold: "Esta carta ya se vendió.",
    reserved: "Esta carta está reservada: hay una Compra Protegida en curso.",
    removed: "Este anuncio fue retirado.",
    draft: "Este anuncio todavía no está publicado.",
    active: null,
  }[listing.status];

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-4">
      <nav className="text-sm text-ink-2">
        <Link href="/" className="hover:text-ink">Inicio</Link>
        <span className="mx-1.5">/</span>
        <Link href={`/?cat=${listing.card.category}`} className="hover:text-ink">{categoryName(listing.card.category)}</Link>
      </nav>

      <div className="mt-4 grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-10">
        <div className="md:sticky md:top-20 md:self-start">
          <div className="card-ratio relative mx-auto max-w-sm rounded-3xl bg-surface-2 [container-type:inline-size] md:max-w-none">
            <div className="absolute inset-[8%]">
              <CardArt listing={listing} sizes="(min-width: 768px) 40vw, 90vw" preload />
            </div>
          </div>
          {listing.isDemo && listing.photos.length > 0 && (
            <p className="mt-2 text-center text-xs text-ink-2">
              Imagen de catálogo. Pide fotos reales del frente y el reverso antes de comprar.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              <ConditionBadge listing={listing} />
              {listing.protectedEligible && <ProtectedBadge />}
              <VerdictBadge listing={listing} />
            </div>
            <h1 className="mt-2 font-display text-3xl font-bold leading-tight tracking-tight">{listing.title}</h1>
            <p className="mt-1 text-sm text-ink-2">
              {listing.card.year} · {listing.card.setName}
              {listing.card.number && ` · ${listing.card.number}`}
              {listing.card.variant && ` · ${listing.card.variant}`}
            </p>
            <p className="mt-3 font-display text-4xl font-bold">{formatUsd(price)}</p>
          </div>

          {listing.isDemo && (
            <p className="rounded-xl bg-warn-bg p-3 text-sm text-warn">
              Anuncio de ejemplo para mostrar cómo funciona la plataforma. No está a la venta.
            </p>
          )}

          {statusNote && (
            <p className={`rounded-xl p-3 text-sm font-semibold ${listing.status === "sold" ? "bg-good-bg text-good" : "bg-warn-bg text-warn"}`}>
              {statusNote}
            </p>
          )}

          <EstimatePanel estimate={listing.estimate} priceUsd={listing.priceUsd} />

          {quote && forSale && (
            <section className="rounded-2xl border border-line bg-surface p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold">Compra Protegida</h2>
              <p className="mt-1 text-sm text-ink-2">
                Pagas a {APP_NAME}, verificamos la carta en persona y solo entonces le pagamos al vendedor. Si no es
                lo anunciado, te devolvemos todo.
              </p>
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-ink-2">Carta</dt><dd>{formatUsd(quote.priceCents)}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-2">Comisión para ti</dt><dd>{formatUsd(quote.feeCents + quote.itbmsCents)}</dd></div>
                <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>Total</dt><dd>{formatUsd(quote.buyerTotalCents)}</dd></div>
              </dl>
              {buyProtected ? (
                <a href={buyProtected} target="_blank" rel="noopener" className="mt-4 flex h-12 items-center justify-center rounded-xl bg-accent font-semibold text-accent-ink">
                  Comprar protegido
                </a>
              ) : (
                <p className="mt-4 rounded-xl bg-surface-2 p-3 text-center text-sm text-ink-2">Compra Protegida disponible pronto.</p>
              )}
            </section>
          )}

          {!forSale ? null : contact ? (
            <a href={contact} target="_blank" rel="noopener" className="flex h-12 items-center justify-center rounded-xl border border-line bg-surface font-semibold">
              Preguntar por WhatsApp
            </a>
          ) : (
            <p className="rounded-xl border border-dashed border-line p-3 text-center text-sm text-ink-2">
              Contacto aún no configurado (NEXT_PUBLIC_WHATSAPP_NUMBER).
            </p>
          )}

          <section className="rounded-2xl border border-line bg-surface p-4">
            <h2 className="text-sm font-semibold">Descripción</h2>
            <p className="mt-1 whitespace-pre-line text-sm">{listing.description}</p>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-ink-2">Categoría</dt><dd>{categoryName(listing.card.category)}</dd></div>
              <div>
                <dt className="text-xs text-ink-2">{listing.grading ? "Graduación" : "Condición"}</dt>
                <dd>
                  {listing.grading
                    ? `${listing.grading.company} ${listing.grading.grade}`
                    : condition ? `${condition.label} (${condition.code})` : "—"}
                </dd>
              </div>
              <div><dt className="text-xs text-ink-2">Ubicación</dt><dd>{listing.location.neighborhood}, {listing.location.district}</dd></div>
              <div><dt className="text-xs text-ink-2">Provincia</dt><dd>{listing.location.province}</dd></div>
            </dl>
          </section>

          <section className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4">
            <div className="flex size-11 items-center justify-center rounded-full bg-surface-2 font-display font-bold">
              {listing.seller.displayName.slice(0, 1)}
            </div>
            <div className="flex-1">
              <p className="flex items-center gap-1.5 font-medium">
                {listing.seller.displayName}
                {listing.seller.verified && <span className="text-xs text-accent">✓ Verificado</span>}
                {listing.seller.isShop && <span className="rounded bg-surface-2 px-1.5 text-xs text-ink-2">Tienda</span>}
              </p>
              <p className="text-xs text-ink-2">
                {listing.seller.rating ? `★ ${listing.seller.rating.toFixed(1)} · ` : ""}
                {listing.seller.salesCount} ventas
              </p>
            </div>
          </section>

          <section className="rounded-2xl bg-surface-2 p-4 text-sm">
            <h2 className="font-semibold">Compra segura</h2>
            <ul className="mt-2 space-y-1 text-ink-2">
              <li>• Reúnete en un lugar público (mall o tienda aliada) y a la luz del día.</li>
              <li>• Revisa la carta con luz: textura, brillo holo, tipografía y reverso.</li>
              <li>• Si es graduada, verifica el número de certificado en la web de la empresa.</li>
              <li>• Nunca pagues por adelantado fuera de Compra Protegida.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
