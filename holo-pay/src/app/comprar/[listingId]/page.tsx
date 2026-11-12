import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatUsd } from "@/lib/format";
import { orderAmounts } from "@/lib/money";
import CheckoutForm from "./checkout-form";

export const dynamic = "force-dynamic";

export default async function Checkout({ params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = await params;
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { seller: true } });
  if (!listing) notFound();
  const a = orderAmounts(listing.priceCents);
  const available = listing.status === "active" && listing.stock > 0;
  return (
    <main className="wrap narrow">
      <h1>{listing.title}</h1>
      <p className="muted small">Vende {listing.seller.name}{listing.seller.verified ? " (verificada)" : ""}</p>
      <section className="panel" style={{ marginTop: 16 }}>
        <h2>Comprar</h2>
        <dl className="lines">
          <div><dt>Precio</dt><dd>{formatUsd(a.itemCents)}</dd></div>
          <div><dt>Envío</dt><dd>{formatUsd(a.shippingCents)}</dd></div>
          <div className="total"><dt>Total</dt><dd>{formatUsd(a.totalCents)}</dd></div>
        </dl>
        {available ? <CheckoutForm listingId={listing.id} /> : <p className="notice warn">Esta carta ya no está disponible.</p>}
        <p className="xs muted" style={{ marginBottom: 0 }}>
          Pagas a Holo con Yappy y le pagamos al vendedor cuando la carta llega. Nunca le pagues a nadie por fuera de Holo.
        </p>
      </section>
    </main>
  );
}
