// The ledger must balance after every kind of ending: a full sale, a cancellation, refunds, a
// dispute (both outcomes), an incident covered by the reserve fund, and the weekly payout.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, user } from "./testing/db";
import {
  ANA, BUYER, LISTING, SHOP, STAFF, accountBalance, deliver, escrow, expectLedgerBalanced, expire, history, order,
  paidOrder, pickup, requestOrder, runDeadlines, sellerBalance, sellerConfirm, newAttempt, notify,
} from "./testing/flow";

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
}, 60_000);
afterAll(() => db.close());

describe("full flow with Holo delivery", () => {
  it("goes request → paid → custody → delivered → review → completed, and pays out weekly", async () => {
    const o = await requestOrder(db, LISTING.charizard);
    expect(o.status).toBe("esperando_confirmacion_vendedor");
    expect(o.price_cents).toBe(12000);
    expect(o.shipping_cents).toBe(400);
    await sellerConfirm(db, o);
    expect((await order(db, o.id)).status).toBe("pendiente_pago");

    const a = await newAttempt(db, o);
    expect(a.total_cents).toBe(12400); // price + shipping, from the database
    expect(a.attempt_id).toMatch(/^[A-Z0-9]{1,15}$/);
    expect(await notify(db, a.attempt_id, "E")).toBe("paid");

    const listing = await db.one<{ status: string }>("select status from public.listings where id = $1", [LISTING.charizard]);
    expect(listing.status).toBe("sold"); // marked sold as soon as it is paid
    expect(await escrow(db, o)).toBe(12400);

    await pickup(db, await order(db, o.id));
    expect((await order(db, o.id)).status).toBe("en_custodia");
    await deliver(db, await order(db, o.id));
    expect((await order(db, o.id)).status).toBe("en_revision");
    expect(await sellerBalance(db, SHOP)).toBe(0); // nothing for the seller during the review window

    await expire(db, o, "review_deadline");
    expect((await runDeadlines(db)).review_completed).toBe(1);
    const done = await order(db, o.id);
    expect(done.status).toBe("completada");

    // $120 − 5% ($6.00) − 7% ITBMS on it ($0.42) = $113.58; Holo keeps $6 + $0.42 + $4 shipping.
    expect(await sellerBalance(db, SHOP)).toBe(11358);
    expect(await escrow(db, o)).toBe(0);
    expect(await accountBalance(db, "holo_comision")).toBe(-600);
    expect(await accountBalance(db, "holo_itbms")).toBe(-42);
    expect(await accountBalance(db, "holo_envio")).toBe(-400);
    await expectLedgerBalanced(db);

    const steps = (await history(db, o)).map((h) => h.to_status);
    expect(steps).toEqual([
      "esperando_confirmacion_vendedor", "pendiente_pago", "pagada_retenida", "esperando_entrega_vendedor",
      "en_custodia", "en_camino", "entregada", "en_revision", "completada",
    ]);

    // Weekly payout: one pending row per seller with balance; CSV; paid with the bank reference.
    const n = await db.one<{ n: number }>("select public.prepare_weekly_payouts() as n", [], user(STAFF));
    expect(n.n).toBe(1);
    const csv = await db.one<{ c: string }>("select public.staff_payouts_csv() as c", [], user(STAFF));
    expect(csv.c.split("\n")[0]).toBe("vendedor,tienda,yappy,titular,monto,semana,id");
    expect(csv.c).toContain('"Cartas Panamá",si,61234567,"Cartas Panamá S.A.",113.58');
    const p = await db.one<{ id: string }>("select id from public.payouts where seller_id = $1 and status = 'pendiente'", [SHOP]);
    await db.as(user(STAFF), "select public.staff_mark_payout_paid($1, 'YAPPY-889900')", [p.id]);
    expect(await sellerBalance(db, SHOP)).toBe(0);
    expect(await accountBalance(db, "banco")).toBe(12400 - 11358);
    await expectLedgerBalanced(db);

    // Reconciliation: the day's charges match what the provider collected.
    const day = await db.one<{ payments: number; charged_cents: string; payouts_paid_cents: string }>(
      "select * from public.staff_reconciliation(7) limit 1", [], user(STAFF));
    expect(day.payments).toBe(1);
    expect(Number(day.charged_cents)).toBe(12400);
    expect(Number(day.payouts_paid_cents)).toBe(11358);
  });
});

describe("cancellations and refunds", () => {
  it("seller never confirms: cancelled, nothing charged, nothing in the ledger", async () => {
    const o = await requestOrder(db, LISTING.umbreon);
    await expire(db, o, "seller_confirm_deadline");
    expect((await runDeadlines(db)).seller_confirm_expired).toBe(1);
    expect((await order(db, o.id)).status).toBe("cancelada");
    const n = await db.one<{ n: number }>("select count(*)::int as n from public.ledger_entries where order_id = $1", [o.id]);
    expect(n.n).toBe(0);
  });

  it("seller doesn't deliver in 48 h: full refund including shipping, request paid by staff", async () => {
    const o = await paidOrder(db, LISTING.umbreon);
    await expire(db, o, "delivery_deadline");
    expect((await runDeadlines(db)).delivery_expired).toBe(1);
    expect((await order(db, o.id)).status).toBe("cancelada");
    const r = await db.one<{ id: string; amount_cents: number; status: string }>(
      "select id, amount_cents, status from public.refund_requests where order_id = $1", [o.id]);
    expect(r).toMatchObject({ amount_cents: 8400, status: "pendiente" });
    expect(await escrow(db, o)).toBe(0);
    await db.as(user(STAFF), "select public.staff_mark_refund_paid($1, 'YAPPY-REF-1')", [r.id]);
    const comprador = await db.one<{ b: string }>(
      "select coalesce(sum(amount_cents), 0) as b from public.ledger_entries where account = 'comprador' and party_id = $1", [BUYER]);
    expect(Number(comprador.b)).toBe(0);
    await expectLedgerBalanced(db);
    // Listing back on sale for the next buyer (but paused by the penalty: Ana is a new seller).
    const l = await db.one<{ status: string; paused_by_penalty: boolean }>(
      "select status, paused_by_penalty from public.listings where id = $1", [LISTING.umbreon]);
    expect(l).toEqual({ status: "draft", paused_by_penalty: true });
  });

  it("buyer absent twice: back to the seller, refund minus shipping; retry fee charged", async () => {
    await db.q("update public.profiles set selling_blocked_until = null where id = $1", [ANA]);
    await db.q("update public.listings set status = 'active', paused_by_penalty = false where seller_id = $1 and paused_by_penalty", [ANA]);
    const o = await paidOrder(db, LISTING.wemby);
    await pickup(db, o);
    await db.as(user(STAFF), "select public.staff_out_for_delivery($1)", [o.id]);
    await db.as(user(STAFF), "select public.staff_delivery_failed($1, 'nadie en casa')", [o.id]);
    expect((await order(db, o.id)).status).toBe("en_custodia");
    // Second attempt needs the retry fee paid first.
    await expect(db.as(user(STAFF), "select public.staff_out_for_delivery($1)", [o.id])).rejects.toThrow(/retry not paid/);
    const a = await newAttempt(db, o);
    expect(a).toMatchObject({ purpose: "reintento", total_cents: 300 });
    expect(await notify(db, a.attempt_id, "E")).toBe("retry paid");
    await db.as(user(STAFF), "select public.staff_out_for_delivery($1)", [o.id]);
    await db.as(user(STAFF), "select public.staff_delivery_failed($1, 'otra vez ausente')", [o.id]);
    await expect(db.as(user(STAFF), "select public.staff_out_for_delivery($1)", [o.id])).rejects.toThrow(/no attempts left/);
    await db.as(user(STAFF), "select public.staff_return_to_seller($1)", [o.id]);
    expect((await order(db, o.id)).status).toBe("reembolsada");
    const r = await db.one<{ amount_cents: number }>("select amount_cents from public.refund_requests where order_id = $1", [o.id]);
    expect(r.amount_cents).toBe(3500); // $35 card back, $4 shipping kept
    expect(await escrow(db, o)).toBe(0);
    const l = await db.one<{ status: string }>("select status from public.listings where id = $1", [LISTING.wemby]);
    expect(l.status).toBe("active");
    await expectLedgerBalanced(db);
  });
});

describe("disputes", () => {
  it("resolved for the seller: the sale completes", async () => {
    const o = await paidOrder(db, LISTING.pikachu);
    await pickup(db, o);
    await deliver(db, o);
    await db.as(user(BUYER), "select public.buyer_open_dispute($1, 'La carta tiene una esquina doblada', $2)",
      [o.id, [`${BUYER}/${o.id}/foto1.jpg`]]);
    expect((await order(db, o.id)).status).toBe("en_disputa");
    // While the dispute is open nothing is released, even after the review window.
    await expire(db, o, "review_deadline");
    expect((await runDeadlines(db)).review_completed).toBe(0);
    const before = await sellerBalance(db, SHOP);
    await db.as(user(STAFF), "select public.staff_resolve_dispute($1, 'vendedor', null, 'Fotos de recogida muestran la esquina igual')", [o.id]);
    expect((await order(db, o.id)).status).toBe("completada");
    expect(await sellerBalance(db, SHOP)).toBe(before + 45000 - 2250 - 158);
    await expectLedgerBalanced(db);
  });

  it("partial refund for the buyer: commission on what the seller keeps", async () => {
    await db.q("update public.listings set status = 'active' where id = $1", [LISTING.gengar]);
    const o = await paidOrder(db, LISTING.gengar);
    await pickup(db, o);
    await deliver(db, o);
    await db.as(user(BUYER), "select public.buyer_open_dispute($1, 'No es la versión que decía el anuncio', $2)",
      [o.id, [`${BUYER}/${o.id}/a.jpg`]]);
    const before = await sellerBalance(db, ANA);
    await db.as(user(STAFF), "select public.staff_resolve_dispute($1, 'comprador_parcial', 2000, 'Descuento acordado')", [o.id]);
    expect((await order(db, o.id)).status).toBe("completada");
    // Seller keeps $40: −5% ($2) −ITBMS ($0.14) = $37.86. Buyer gets $20 back.
    expect(await sellerBalance(db, ANA)).toBe(before + 3786);
    const r = await db.one<{ amount_cents: number }>("select amount_cents from public.refund_requests where order_id = $1", [o.id]);
    expect(r.amount_cents).toBe(2000);
    expect(await escrow(db, o)).toBe(0);
    await expectLedgerBalanced(db);
  });

  it("total refund for the buyer: everything back, seller gets nothing", async () => {
    await db.q("insert into public.listings (id, seller_id, category, title, subject, set_name, condition, price_cents, province, district, neighborhood) values ('00000000-0000-4000-b000-000000000099', $1, 'pokemon', 'Mew ex 232/091', 'Mew ex', 'Paldean Fates', 'NM', 5000, 'Panamá', 'Panamá', 'Obarrio')", [SHOP]);
    const o = await paidOrder(db, "00000000-0000-4000-b000-000000000099");
    await pickup(db, o);
    await deliver(db, o);
    await db.as(user(BUYER), "select public.buyer_open_dispute($1, 'Es una réplica, el holo no es el original', $2)",
      [o.id, [`${BUYER}/${o.id}/x.jpg`]]);
    const before = await sellerBalance(db, SHOP);
    await db.as(user(STAFF), "select public.staff_resolve_dispute($1, 'comprador_total')", [o.id]);
    expect((await order(db, o.id)).status).toBe("reembolsada");
    expect(await sellerBalance(db, SHOP)).toBe(before);
    const r = await db.one<{ amount_cents: number }>("select amount_cents from public.refund_requests where order_id = $1", [o.id]);
    expect(r.amount_cents).toBe(5400);
    await expectLedgerBalanced(db);
  });
});

describe("incidents", () => {
  it("lost in Holo's custody: buyer refunded, seller paid from the reserve fund, capped", async () => {
    await db.q("insert into public.listings (id, seller_id, category, title, subject, set_name, condition, price_cents, province, district, neighborhood) values ('00000000-0000-4000-b000-000000000098', $1, 'pokemon', 'Lugia V Alt Art 186/195', 'Lugia V', 'Silver Tempest', 'NM', 30000, 'Panamá', 'Panamá', 'Obarrio')", [SHOP]);
    const o = await paidOrder(db, "00000000-0000-4000-b000-000000000098");
    await pickup(db, o);
    await expect(db.as(user(STAFF), "select public.staff_report_incident($1, 'perdida', 'holo', 'Se perdió en la oficina', 25000)", [o.id]))
      .rejects.toThrow(/cap/);
    const before = await sellerBalance(db, SHOP);
    await db.as(user(STAFF), "select public.staff_report_incident($1, 'perdida', 'holo', 'Se perdió en la oficina')", [o.id]);
    expect((await order(db, o.id)).status).toBe("reembolsada");
    // Seller would have netted $283.95; the cap per shipment is $200.
    expect(await sellerBalance(db, SHOP)).toBe(before + 20000);
    expect(await accountBalance(db, "fondo_reserva")).toBe(20000);
    const r = await db.one<{ amount_cents: number }>("select amount_cents from public.refund_requests where order_id = $1", [o.id]);
    expect(r.amount_cents).toBe(30400);
    expect(await escrow(db, o)).toBe(0);
    await expectLedgerBalanced(db);
  });
});

describe("ledger is append-only", () => {
  it("rejects updates and deletes", async () => {
    await expect(db.q("update public.ledger_entries set amount_cents = 1 where id = (select min(id) from public.ledger_entries)"))
      .rejects.toThrow(/append|can't be changed/);
    await expect(db.q("delete from public.ledger_entries")).rejects.toThrow(/can't be changed/);
  });

  it("rejects an unbalanced transaction", async () => {
    await expect(db.q(`select public.ledger_post(null, '[{"account":"banco","kind":"cobro","amount":100}]'::jsonb)`))
      .rejects.toThrow(/does not balance/);
  });
});
