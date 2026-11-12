import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatUsd, STATUS_LABEL } from "@/lib/format";
import { allowedNext } from "@/lib/orders/state-machine";
import AdminNav from "../../nav";

export const dynamic = "force-dynamic";
const fmt = (d: Date | null) => d?.toLocaleString("es-PA", { timeZone: "America/Panama" }) ?? "—";

export default async function AdminOrder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const o = await prisma.order.findUnique({
    where: { id },
    include: {
      listing: { include: { seller: true } },
      events: { orderBy: { createdAt: "asc" } },
      transitions: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!o) notFound();
  const next = allowedNext(o.status);
  return (
    <main className="wrap">
      <h1>Orden <span className="code">{o.publicId}</span></h1>
      <AdminNav active="ordenes" />
      <section className="panel" style={{ marginBottom: 16 }}>
        <p style={{ marginTop: 0 }}><span className="pill">{STATUS_LABEL[o.status]}</span></p>
        <dl className="lines">
          <div><dt>Carta</dt><dd>{o.listing.title}</dd></div>
          <div><dt>Vendedor</dt><dd>{o.listing.seller.name}</dd></div>
          <div><dt>Celular comprador</dt><dd>{o.buyerPhone}</dd></div>
          <div><dt>Precio</dt><dd>{formatUsd(o.itemCents)}</dd></div>
          <div><dt>Envío</dt><dd>{formatUsd(o.shippingCents)}</dd></div>
          <div><dt>Impuestos</dt><dd>{formatUsd(o.taxesCents)}</dd></div>
          <div className="total"><dt>Total</dt><dd>{formatUsd(o.totalCents)}</dd></div>
          <div><dt>Creada</dt><dd>{fmt(o.createdAt)}</dd></div>
          <div><dt>Vence</dt><dd>{fmt(o.expiresAt)}</dd></div>
          <div><dt>Pagada</dt><dd>{fmt(o.paidAt)}</dd></div>
          <div><dt>Confirmación Yappy</dt><dd>{o.yappyConfirmationNumber ?? "—"}</dd></div>
          <div><dt>Transacción Yappy</dt><dd>{o.yappyTransactionId ?? "—"}</dd></div>
        </dl>
        {next.length > 0 && (
          <div className="row">
            {next.map((to) => (
              <form key={to} method="post" action={`/api/admin/orders/${o.id}/transition`}>
                <input type="hidden" name="from" value={o.status} /><input type="hidden" name="to" value={to} />
                <input type="hidden" name="back" value={`/admin/ordenes/${o.id}`} />
                <button className={`btn sm${to === "refunded" ? " danger" : ""}`}>Pasar a: {STATUS_LABEL[to]}</button>
              </form>
            ))}
          </div>
        )}
        <p className="xs muted" style={{ marginBottom: 0 }}>“Reembolsada” solo marca la orden: el dinero se devuelve desde Yappy Comercial.</p>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <h2>Historial</h2>
        <div className="tablewrap"><table>
          <thead><tr><th>Fecha</th><th>De</th><th>A</th><th>Motivo</th></tr></thead>
          <tbody>
            {o.transitions.map((t) => (
              <tr key={t.id}><td>{fmt(t.createdAt)}</td><td>{STATUS_LABEL[t.fromStatus]}</td><td>{STATUS_LABEL[t.toStatus]}</td><td className="xs">{t.reason}</td></tr>
            ))}
            {o.transitions.length === 0 && <tr><td colSpan={4} className="muted">Sin cambios todavía.</td></tr>}
          </tbody>
        </table></div>
      </section>

      <section className="panel">
        <h2>Log de IPN (PaymentEvent)</h2>
        <div className="tablewrap"><table>
          <thead><tr><th>Fecha</th><th>Status</th><th>Resultado</th><th>Confirmación</th><th>Query</th></tr></thead>
          <tbody>
            {o.events.map((e) => (
              <tr key={e.id}>
                <td>{fmt(e.createdAt)}</td><td>{e.status}</td><td><span className="pill">{e.result}</span></td>
                <td>{e.confirmationNumber ?? "—"}</td><td className="xs" style={{ wordBreak: "break-all" }}>{e.rawQuery}</td>
              </tr>
            ))}
            {o.events.length === 0 && <tr><td colSpan={5} className="muted">No ha llegado ningún IPN.</td></tr>}
          </tbody>
        </table></div>
      </section>
    </main>
  );
}
