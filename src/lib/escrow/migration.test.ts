// Orders made before migration 0029 (statuses of 0014) are carried over: new status, a history
// row, and ledger entries so seller balances and escrow are right from day one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb } from "./testing/db";
import { ANA, BUYER, SHOP, expectLedgerBalanced, sellerBalance } from "./testing/flow";

let db: TestDb;
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await TestDb.create({ seed: false, stopBefore: "0029" });
  // Users and listings by hand: the seed is written for the schema after 0029.
  await db.q(`insert into auth.users (id, email, raw_user_meta_data) values
    ($1, 'a@x.test', '{"display_name":"Tienda"}'), ($2, 'b@x.test', '{"display_name":"Ana"}'), ($3, 'c@x.test', '{"display_name":"Beto"}')`,
    [SHOP, ANA, BUYER]);
  const legacy: [string, string, Record<string, unknown>][] = [
    ["awaiting", "awaiting_payment", { hold_until: "now() + interval '5 minutes'" }],
    ["paid", "paid", { paid_at: "now() - interval '1 day'" }],
    ["delivered", "delivered", { paid_at: "now() - interval '3 day'", delivered_at: "now() - interval '1 day'" }],
    ["confirmed", "delivered", { paid_at: "now() - interval '3 day'", delivered_at: "now() - interval '1 day'", buyer_confirmed_at: "now()" }],
    ["claim", "delivered", { paid_at: "now() - interval '3 day'", delivered_at: "now() - interval '1 day'", claimed_at: "now()", claim_reason: "'Llegó doblada'" }],
    ["released", "released", { paid_at: "now() - interval '9 day'", delivered_at: "now() - interval '8 day'", released_at: "now() - interval '4 day'", payout_ref: "'YAPPY-1'" }],
    ["refunded", "refunded", { paid_at: "now() - interval '9 day'" }],
    ["cancelled", "cancelled", {}],
  ];
  let i = 10;
  for (const [key, status, extra] of legacy) {
    const listing = `00000000-0000-4000-b000-0000000000${i++}`;
    await db.q(`insert into public.listings (id, seller_id, category, title, subject, set_name, condition, price_cents, province, district, neighborhood)
                values ($1, $2, 'pokemon', 'Carta vieja de prueba', 'X', 'Y', 'NM', 10000, 'Panamá', 'Panamá', 'Obarrio')`, [listing, ANA]);
    const cols = Object.keys(extra);
    const r = await db.one<{ id: string }>(
      `insert into public.protected_orders (listing_id, buyer_id, seller_id, price_cents, fee_cents, itbms_cents, seller_fee_cents, seller_itbms_cents, status${cols.map((c) => ", " + c).join("")})
       values ($1, $2, $3, 10000, 0, 0, 500, 35, '${status}'${cols.map((c) => ", " + extra[c]).join("")}) returning id`, [listing, BUYER, ANA]);
    ids[key] = r.id;
  }
  await db.migrate("0029_escrow_orders.sql");
}, 60_000);
afterAll(() => db.close());

describe("migration 0029 on existing orders", () => {
  it("maps every old status to the new machine", async () => {
    const rows = await db.q<{ id: string; status: string }>("select id, status from public.protected_orders");
    const by = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(by[ids.awaiting]).toBe("pendiente_pago");
    expect(by[ids.paid]).toBe("esperando_entrega_vendedor");
    expect(by[ids.delivered]).toBe("en_revision");
    expect(by[ids.confirmed]).toBe("en_revision");
    expect(by[ids.claim]).toBe("en_disputa");
    expect(by[ids.released]).toBe("completada");
    expect(by[ids.refunded]).toBe("reembolsada");
    expect(by[ids.cancelled]).toBe("cancelada");
    const h = await db.q("select 1 from public.order_status_history where reason like 'Migración 0029%'");
    expect(h).toHaveLength(8);
  });

  it("backfills the ledger: money still held is in escrow, paid-out sales leave no balance", async () => {
    await expectLedgerBalanced(db);
    const held = await db.one<{ s: string }>("select -sum(amount_cents) as s from public.ledger_entries where account = 'retencion'");
    // paid, delivered, confirmed, claim: 4 × $100 still held.
    expect(Number(held.s)).toBe(40000);
    expect(await sellerBalance(db, ANA)).toBe(0);
    // A buyer-confirmed order is completed by the next job run.
    expect((await db.one<{ r: { review_completed: number } }>("select public.run_order_deadlines() as r")).r.review_completed).toBe(1);
    expect(await sellerBalance(db, ANA)).toBe(9465);
    await expectLedgerBalanced(db);
  });

  it("every existing order gets a delivery code", async () => {
    const n = await db.one<{ n: number }>("select count(*)::int as n from public.order_delivery_codes");
    expect(n.n).toBe(8);
  });
});
