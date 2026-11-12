import { prisma } from "@/lib/db";
import { panamaToday } from "@/lib/admin/export";
import { formatUsd, STATUS_LABEL } from "@/lib/format";
import { isOrderStatus, ORDER_STATUSES } from "@/lib/orders/state-machine";
import AdminNav from "./nav";

export const dynamic = "force-dynamic";

export default async function AdminOrders({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const { estado } = await searchParams;
  const filter = isOrderStatus(estado) ? estado : undefined;
  const [orders, counts] = await Promise.all([
    prisma.order.findMany({ where: filter ? { status: filter } : {}, include: { listing: true }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.order.groupBy({ by: ["status"], _count: true }),
  ]);
  const count = Object.fromEntries(counts.map((c) => [c.status, c._count]));
  const total = counts.reduce((s, c) => s + c._count, 0);
  return (
    <main className="wrap">
      <h1>Panel</h1>
      <AdminNav active="ordenes" />
      <section className="panel" style={{ marginBottom: 16 }}>
        <h2>Conciliación diaria</h2>
        <form action="/api/admin/export" method="get" className="row">
          <label className="row" style={{ fontWeight: 400 }}>
            Órdenes pagadas el
            <input type="date" name="date" defaultValue={panamaToday()} required />
          </label>
          <button className="btn">Descargar CSV</button>
        </form>
        <p className="xs muted" style={{ marginBottom: 0 }}>Hora de Panamá. Compáralo con los ingresos del día en Yappy Comercial.</p>
      </section>
      <nav className="tabs">
        <a href="/admin" className={!filter ? "on" : ""}>Todas ({total})</a>
        {ORDER_STATUSES.map((s) => (
          <a key={s} href={`/admin?estado=${s}`} className={filter === s ? "on" : ""}>
            {STATUS_LABEL[s]} ({count[s] ?? 0})
          </a>
        ))}
      </nav>
      <div className="tablewrap panel">
        <table>
          <thead>
            <tr><th>Orden</th><th>Creada</th><th>Carta</th><th>Total</th><th>Estado</th><th>Celular</th><th>Pagada</th></tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td><a href={`/admin/ordenes/${o.id}`} className="code" style={{ fontSize: 14 }}>{o.publicId}</a></td>
                <td>{o.createdAt.toLocaleString("es-PA", { timeZone: "America/Panama" })}</td>
                <td>{o.listing.title}</td>
                <td>{formatUsd(o.totalCents)}</td>
                <td><span className="pill">{STATUS_LABEL[o.status]}</span></td>
                <td>{o.buyerPhone}</td>
                <td>{o.paidAt?.toLocaleString("es-PA", { timeZone: "America/Panama" }) ?? "—"}</td>
              </tr>
            ))}
            {orders.length === 0 && <tr><td colSpan={7} className="muted">No hay órdenes.</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}
