// Local walk-through of the whole order flow (migration 0029) on an in-memory Postgres (PGlite):
// no Supabase, no Docker, no real money. Uses the same SQL, the same mock Yappy provider and the
// same IPN handler as production. Run: npm run demo:flujo
import { createPaymentHandler } from "../supabase/functions/_shared/payments/handler.ts";
import { YappyMockProvider } from "../supabase/functions/_shared/payments/mock.ts";
import { TestDb, admin, service, user } from "../src/lib/escrow/testing/db";

const STAFF = "00000000-0000-4000-a000-000000000001";
const SHOP = "00000000-0000-4000-a000-000000000002";
const BUYER = "00000000-0000-4000-a000-000000000004";
const CHARIZARD = "00000000-0000-4000-b000-000000000001";
const DOMAIN = "https://holo.local";
const usd = (c: number | string) => `$${(Number(c) / 100).toFixed(2)}`;
const step = (t: string) => console.log(`\n▸ ${t}`);

async function main() {
  const db = await TestDb.create({ seed: true });
  const rpc = (actor: Parameters<TestDb["as"]>[0]) => async (fn: string, args: Record<string, unknown>) => {
    const names = Object.keys(args);
    try {
      const r = await db.one<{ r: unknown }>(`select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, Object.values(args), actor);
      return { data: r.r, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  };
  // A throwaway secret in Yappy's format, generated for this run only.
  const mock = new YappyMockProvider({ secret: btoa(`demo-${crypto.randomUUID()}.local`), domain: DOMAIN });
  const handler = createPaymentHandler({
    provider: mock,
    ipnUrl: "http://localhost/yappy-pago",
    devSimulator: true,
    rpcAsUser: (auth, fn, args) => rpc(user(auth.split(".")[1]))(fn, args),
    rpcAsService: (fn, args) => rpc(service)(fn, args),
  });
  const status = async (id: string) =>
    (await db.one<{ status: string }>("select status from public.protected_orders where id = $1", [id])).status;

  step("Beto pide comprar el Charizard ex de Cartas Panamá ($120)");
  const o = await db.one<{ id: string; status: string; price_cents: number; shipping_cents: number }>(
    "select * from public.request_order($1, false)", [CHARIZARD], user(BUYER));
  console.log(`  orden ${o.id.slice(0, 8)} · ${o.status} · precio ${usd(o.price_cents)} + envío ${usd(o.shipping_cents)}`);

  step("La tienda confirma que aún tiene la carta");
  await db.as(user(SHOP), "select public.seller_confirm_order($1)", [o.id]);
  console.log(`  ${await status(o.id)}`);

  step("Beto paga: el handler crea el intento y el cobro en el proveedor (mock de Yappy)");
  const res = await handler(new Request("http://localhost/yappy-pago", {
    method: "POST", headers: { Authorization: `Bearer demo.${BUYER}.sig`, "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: o.id }),
  }));
  const charge = await res.json();
  console.log(`  intento ${charge.attempt} por ${usd(charge.total_cents)} (calculado en la base)`);

  step("Yappy (simulado) avisa por IPN: status E — y lo reenvía otra vez");
  const n = await mock.simulate(charge.attempt, "E");
  const ipnUrl = `http://localhost/yappy-pago?${new URLSearchParams({ orderId: n.orderId, status: n.status, hash: n.hash, domain: n.domain })}`;
  console.log("  1.º aviso:", await (await handler(new Request(ipnUrl))).json());
  console.log("  2.º aviso:", await (await handler(new Request(ipnUrl))).json());
  console.log(`  ${await status(o.id)} · anuncio: ${(await db.one<{ status: string }>("select status from public.listings where id = $1", [CHARIZARD])).status}`);

  step("Holo recoge la carta con fotos de frente y reverso");
  for (const side of ["frente", "reverso"]) {
    await db.as(user(STAFF), "select public.staff_add_order_photo($1, 'recogida', $2, $3)", [o.id, side, `${o.id}/recogida-${side}.jpg`]);
  }
  await db.as(user(STAFF), "select public.staff_pickup($1)", [o.id]);
  console.log(`  ${await status(o.id)}`);

  step("Sale a entregarse; Beto da su código de 4 dígitos al mensajero");
  await db.as(user(STAFF), "select public.staff_out_for_delivery($1)", [o.id]);
  await db.as(user(STAFF), "select public.staff_add_order_photo($1, 'entrega', 'otra', $2)", [o.id, `${o.id}/entrega.jpg`]);
  const code = (await db.as<{ delivery_code: string }>(user(BUYER), "select delivery_code from public.my_orders() where id = $1", [o.id]))[0].delivery_code;
  console.log(`  código que ve Beto: ${code}`);
  console.log("  entrega:", (await db.one<{ r: unknown }>("select public.deliver_with_code($1, $2) as r", [o.id, code], user(STAFF))).r);
  console.log(`  ${await status(o.id)}`);

  step("Pasan las 48 h de revisión sin disputa (adelantamos el reloj) y corre el job de plazos");
  await db.q("update public.protected_orders set review_deadline = now() - interval '1 second' where id = $1", [o.id]);
  console.log("  job:", (await db.one<{ r: unknown }>("select public.run_order_deadlines() as r", [], admin)).r);
  console.log(`  ${await status(o.id)}`);

  step("Liquidación semanal");
  await db.as(user(STAFF), "select public.prepare_weekly_payouts()");
  console.log((await db.one<{ c: string }>("select public.staff_payouts_csv() as c", [], user(STAFF))).c.replace(/^/gm, "  "));
  const p = await db.one<{ id: string }>("select id from public.payouts where status = 'pendiente'");
  await db.as(user(STAFF), "select public.staff_mark_payout_paid($1, 'YAPPY-DEMO-001')", [p.id]);

  step("Historial de la orden");
  for (const h of await db.q<{ to_status: string; actor_kind: string; reason: string }>(
    "select to_status, actor_kind, reason from public.order_status_history where order_id = $1 order by id", [o.id])) {
    console.log(`  ${h.to_status.padEnd(32)} ${h.actor_kind.padEnd(10)} ${h.reason ?? ""}`);
  }

  step("Libro contable (débito > 0, crédito < 0)");
  for (const e of await db.q<{ kind: string; account: string; amount_cents: string; memo: string }>(
    "select kind, account, amount_cents, memo from public.ledger_entries order by id")) {
    console.log(`  ${e.account.padEnd(15)} ${e.kind.padEnd(12)} ${String(usd(e.amount_cents)).padStart(9)}  ${e.memo ?? ""}`);
  }
  const total = await db.one<{ s: string }>("select sum(amount_cents) as s from public.ledger_entries");
  const bank = await db.one<{ s: string }>("select sum(amount_cents) as s from public.ledger_entries where account = 'banco'");
  console.log(`  suma total: ${usd(total.s)} (cuadra) · queda en el banco para Holo: ${usd(bank.s)}`);
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
