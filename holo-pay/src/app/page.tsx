import { prisma } from "@/lib/db";
import { formatUsd } from "@/lib/format";
import { SHIPPING_CENTS } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function Home() {
  const listings = await prisma.listing.findMany({
    where: { status: "active", stock: { gt: 0 } },
    include: { seller: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return (
    <main className="wrap">
      <h1>Cartas a la venta</h1>
      <p className="muted small">Pagas con Yappy. Envío {formatUsd(SHIPPING_CENTS)}.</p>
      {listings.length === 0 ? (
        <p className="muted">Todavía no hay cartas publicadas.</p>
      ) : (
        <div className="grid">
          {listings.map((l) => (
            <a key={l.id} href={`/comprar/${l.id}`} className="panel" style={{ textDecoration: "none" }}>
              <h2>{l.title}</h2>
              <p className="muted small" style={{ margin: 0 }}>
                {l.seller.name}
                {l.seller.verified ? " · verificada" : ""}
              </p>
              <p style={{ fontSize: 22, fontWeight: 800, margin: "8px 0 0" }}>{formatUsd(l.priceCents)}</p>
            </a>
          ))}
        </div>
      )}
    </main>
  );
}
