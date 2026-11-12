import { prisma } from "@/lib/db";
import { reviewQueue } from "@/lib/admin/review";
import { formatUsd } from "@/lib/format";
import AdminNav from "../nav";

export const dynamic = "force-dynamic";

const RESULT_LABEL: Record<string, string> = {
  invalid_signature: "Firma inválida",
  order_not_found: "Pago sin orden",
  duplicate: "Duplicado",
  invalid_transition: "Estado no permitido",
  invalid_status: "Estado desconocido",
  malformed: "Datos incompletos",
  late_payment: "Pago tardío",
};

const fmt = (d: Date | null) => d?.toLocaleString("es-PA", { timeZone: "America/Panama" }) ?? "—";

export default async function ReviewQueue() {
  const { underReview, stuckPaid, events } = await reviewQueue(prisma);
  return (
    <main className="wrap">
      <h1>Pagos por revisar</h1>
      <AdminNav active="revision" />

      <section className="panel" style={{ marginBottom: 16 }}>
        <h2>Órdenes en revisión ({underReview.length})</h2>
        <p className="small muted">Pagos que llegaron después de que la orden expiró o se canceló. Reactiva si todavía hay stock, o reembolsa en Yappy Comercial y márcala reembolsada.</p>
        {underReview.map((o) => (
          <div key={o.id} className="notice warn">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <a href={`/admin/ordenes/${o.id}`} className="code" style={{ fontSize: 16 }}>{o.publicId}</a> · {o.listing.title} · <b>{formatUsd(o.totalCents)}</b>
                <div className="xs muted">Pago recibido {fmt(o.paidAt)} · stock disponible: {o.listing.stock}</div>
              </div>
              <div className="row">
                <form method="post" action={`/api/admin/orders/${o.id}/transition`}>
                  <input type="hidden" name="from" value="under_review" /><input type="hidden" name="to" value="paid" />
                  <input type="hidden" name="back" value="/admin/revision" />
                  <button className="btn sm" disabled={o.listing.stock < 1}>Reactivar</button>
                </form>
                <form method="post" action={`/api/admin/orders/${o.id}/transition`}>
                  <input type="hidden" name="from" value="under_review" /><input type="hidden" name="to" value="refunded" />
                  <input type="hidden" name="back" value="/admin/revision" />
                  <button className="btn sm danger">Reembolsado</button>
                </form>
              </div>
            </div>
          </div>
        ))}
        {underReview.length === 0 && <p className="muted small" style={{ margin: 0 }}>Nada en revisión.</p>}
      </section>

      {stuckPaid.length > 0 && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <h2>Pagadas sin avisar al vendedor ({stuckPaid.length})</h2>
          <p className="small muted">La notificación automática falló. Avísale al vendedor y márcala.</p>
          {stuckPaid.map((o) => (
            <div key={o.id} className="notice row" style={{ justifyContent: "space-between" }}>
              <span><a href={`/admin/ordenes/${o.id}`} className="code" style={{ fontSize: 16 }}>{o.publicId}</a> · {o.listing.title} · {formatUsd(o.totalCents)}</span>
              <form method="post" action={`/api/admin/orders/${o.id}/transition`}>
                <input type="hidden" name="from" value="paid" /><input type="hidden" name="to" value="seller_notified" />
                <input type="hidden" name="back" value="/admin/revision" />
                <button className="btn sm">Vendedor avisado</button>
              </form>
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <h2>IPN sospechosos ({events.length})</h2>
        <p className="small muted">Firmas inválidas, pagos sin orden, duplicados y estados no permitidos. Nada de esto cambió una orden.</p>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Fecha</th><th>Tipo</th><th>orderId</th><th>Status</th><th>Domain</th><th></th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{fmt(e.createdAt)}</td>
                  <td><span className="pill">{RESULT_LABEL[e.result ?? ""] ?? e.result}</span></td>
                  <td>{e.orderId ? <a href={`/admin/ordenes/${e.orderId}`}>{e.receivedOrderId}</a> : e.receivedOrderId ?? "—"}</td>
                  <td>{e.status ?? "—"}</td>
                  <td className="xs">{e.domain ?? "—"}</td>
                  <td>
                    <form method="post" action={`/api/admin/events/${e.id}/resolve`} className="row">
                      <input name="note" placeholder="Nota" maxLength={500} style={{ padding: 6, width: 140 }} />
                      <button className="btn sm">Resolver</button>
                    </form>
                  </td>
                </tr>
              ))}
              {events.length === 0 && <tr><td colSpan={6} className="muted">Nada pendiente.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
