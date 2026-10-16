// Order state machine (migration 0029): every from → to pair is checked against order_transitions,
// for every actor, plus the business rules around the transitions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, admin, user } from "./testing/db";
import {
  ANA, BUYER, LISTING, SHOP, STAFF, deliver, deliveryCode, expire, history, order, paidOrder, pickup, requestOrder,
  sellerConfirm, addPhoto,
} from "./testing/flow";

const STATUSES = [
  "esperando_confirmacion_vendedor", "pendiente_pago", "pagada_retenida", "esperando_entrega_vendedor",
  "en_custodia", "en_camino", "entregada", "en_revision", "completada", "en_disputa",
  "cancelada", "reembolsada", "fallida",
];
const ACTORS = ["comprador", "vendedor", "admin", "sistema", "proveedor"];

// The documented machine. If this table changes, the business rules changed: update docs too.
const ALLOWED: Record<string, string[]> = {
  "esperando_confirmacion_vendedor>pendiente_pago": ["vendedor", "admin"],
  "esperando_confirmacion_vendedor>cancelada": ["vendedor", "comprador", "sistema", "admin"],
  "pendiente_pago>pagada_retenida": ["proveedor", "admin"],
  "pendiente_pago>fallida": ["proveedor", "sistema", "admin"],
  "pendiente_pago>cancelada": ["comprador", "admin"],
  "pagada_retenida>esperando_entrega_vendedor": ["proveedor", "sistema", "admin"],
  "pagada_retenida>reembolsada": ["proveedor", "sistema", "admin"],
  "esperando_entrega_vendedor>en_custodia": ["admin"],
  "esperando_entrega_vendedor>entregada": ["vendedor", "admin"],
  "esperando_entrega_vendedor>cancelada": ["sistema", "admin"],
  "en_custodia>en_camino": ["admin"],
  "en_custodia>reembolsada": ["admin"],
  "en_camino>entregada": ["admin"],
  "en_camino>en_custodia": ["admin"],
  "en_camino>reembolsada": ["admin"],
  "entregada>en_revision": ["sistema", "admin"],
  "en_revision>completada": ["sistema", "comprador", "admin"],
  "en_revision>en_disputa": ["comprador", "admin"],
  "en_disputa>completada": ["admin"],
  "en_disputa>reembolsada": ["admin"],
};

let db: TestDb;
let probe: string;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
  probe = (await requestOrder(db, LISTING.gengar)).id;
}, 60_000);
afterAll(() => db.close());

/** Puts the probe order in `from` without going through the guard, then tries `to` as `actor`. */
async function tryMove(from: string, to: string, actor: string): Promise<boolean> {
  await db.pg.exec("set session_replication_role = replica");
  await db.pg.query("update public.protected_orders set status = $1 where id = $2", [from, probe]);
  await db.pg.exec("set session_replication_role = default");
  try {
    await db.q("select public.order_move($1, $2, $3, 'test')", [probe, to, actor]);
    return true;
  } catch (e) {
    expect((e as Error).message).toMatch(/order_transition/);
    return false;
  }
}

describe("transition matrix", () => {
  it("the table in the database is the documented one", async () => {
    const rows = await db.q<{ from_status: string; to_status: string; actors: string[] }>("select * from public.order_transitions");
    const actual = Object.fromEntries(rows.map((r) => [`${r.from_status}>${r.to_status}`, [...r.actors].sort()]));
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, [...v].sort()]));
    expect(actual).toEqual(expected);
  });

  it("accepts exactly the allowed (from, to, actor) triples and rejects the rest", async () => {
    let accepted = 0;
    let rejected = 0;
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to) continue;
        for (const actor of ACTORS) {
          const ok = await tryMove(from, to, actor);
          const should = (ALLOWED[`${from}>${to}`] ?? []).includes(actor);
          expect.soft(ok, `${from} → ${to} as ${actor}`).toBe(should);
          if (ok) accepted++; else rejected++;
        }
      }
    }
    expect(accepted).toBe(Object.values(ALLOWED).flat().length);
    expect(rejected).toBeGreaterThan(700);
  }, 60_000);

  it("terminal states have no way out", async () => {
    for (const from of ["completada", "cancelada", "reembolsada", "fallida"]) {
      for (const to of STATUSES.filter((s) => s !== from)) expect(await tryMove(from, to, "admin")).toBe(false);
    }
  });

  it("a new order can only start waiting for the seller or for payment", async () => {
    await expect(db.q(
      "insert into public.protected_orders (listing_id, seller_id, buyer_id, price_cents, fee_cents, itbms_cents, status) values ($1, $2, $3, 100, 0, 0, 'completada')",
      [LISTING.gengar, ANA, BUYER])).rejects.toThrow(/can't start as completada/);
  });

  it("staff writing the table directly still go through the machine", async () => {
    const o = await requestOrder(db, LISTING.charizard);
    await expect(db.as(user(STAFF), "update public.protected_orders set status = 'completada' where id = $1", [o.id]))
      .rejects.toThrow(/order_transition/);
    await db.as(user(BUYER), "select public.buyer_cancel_order($1)", [o.id]);
  });
});

describe("history", () => {
  it("records who, when and why for every change", async () => {
    const o = await requestOrder(db, LISTING.charizard);
    await db.as(user(SHOP), "select public.seller_decline_order($1, 'Se vendió en la tienda')", [o.id]);
    const h = await history(db, o);
    expect(h).toEqual([
      { from_status: null, to_status: "esperando_confirmacion_vendedor", actor_kind: "comprador", reason: "Solicitud de compra" },
      { from_status: "esperando_confirmacion_vendedor", to_status: "cancelada", actor_kind: "vendedor",
        reason: "El vendedor no la tiene: Se vendió en la tienda" },
    ]);
    const at = await db.one<{ n: number }>("select count(*)::int as n from public.order_status_history where order_id = $1 and created_at is not null", [o.id]);
    expect(at.n).toBe(2);
  });
});

describe("rules around the transitions", () => {
  it("only the seller confirms, and only within 2 hours", async () => {
    const o = await requestOrder(db, LISTING.charizard);
    await expect(db.as(user(BUYER), "select public.seller_confirm_order($1)", [o.id])).rejects.toThrow(/not yours/);
    await expire(db, o, "seller_confirm_deadline");
    await expect(sellerConfirm(db, o)).rejects.toThrow(/can't confirm now/);
    await db.as(user(BUYER), "select public.buyer_cancel_order($1)", [o.id]);
  });

  it("nothing is charged before the seller confirms", async () => {
    const o = await requestOrder(db, LISTING.charizard);
    await expect(db.as(user(BUYER), "select public.new_payment_attempt($1, 'mock')", [o.id])).rejects.toThrow(/not payable/);
    await db.as(user(BUYER), "select public.buyer_cancel_order($1)", [o.id]);
  });

  it("one unit can't be requested by two buyers at once; the seller can't buy their own card", async () => {
    const o = await requestOrder(db, LISTING.charizard);
    await expect(requestOrder(db, LISTING.charizard, ANA)).rejects.toThrow(/on hold/);
    await expect(requestOrder(db, LISTING.charizard, SHOP)).rejects.toThrow(/own listing/);
    // The same buyer asking again gets the same order back.
    expect((await requestOrder(db, LISTING.charizard)).id).toBe(o.id);
    await db.as(user(BUYER), "select public.buyer_cancel_order($1)", [o.id]);
  });

  it("an accepted offer skips the confirmation and uses the offer price", async () => {
    await db.q("insert into public.offers (listing_id, buyer_id, seller_id, amount_cents, status) values ($1, $2, $3, 10000, 'accepted')",
      [LISTING.charizard, BUYER, SHOP]);
    const o = await requestOrder(db, LISTING.charizard);
    expect(o).toMatchObject({ status: "pendiente_pago", price_cents: 10000, shipping_cents: 400 });
    await db.as(user(BUYER), "select public.buyer_cancel_order($1)", [o.id]);
    await db.q("delete from public.offers where listing_id = $1", [LISTING.charizard]);
  });

  it("pickup requires front and back photos; delivery requires the buyer's code and a photo", async () => {
    const o = await paidOrder(db, LISTING.charizard);
    await addPhoto(db, o, "recogida", "frente");
    await expect(db.as(user(STAFF), "select public.staff_pickup($1)", [o.id])).rejects.toThrow(/front and back/);
    await pickup(db, o);
    await db.as(user(STAFF), "select public.staff_out_for_delivery($1)", [o.id]);
    const wrong = (await deliveryCode(db, o)) === "0000" ? "1111" : "0000";
    // No photo yet → refused even with the right code; wrong code → counted, not delivered.
    await expect(db.as(user(STAFF), "select public.deliver_with_code($1, $2)", [o.id, await deliveryCode(db, o)])).rejects.toThrow(/photo required/);
    await addPhoto(db, o, "entrega", "otra");
    const r = await db.one<{ r: { ok: boolean; failures: number } }>("select public.deliver_with_code($1, $2) as r", [o.id, wrong], user(STAFF));
    expect(r.r).toMatchObject({ ok: false, failures: 1 });
    expect((await order(db, o.id)).status).toBe("en_camino");
  });

  it("the delivery code is visible only to the buyer and locks after 5 wrong tries", async () => {
    const o = (await db.q<{ id: string }>("select id from public.protected_orders where status = 'en_camino' limit 1"))[0];
    const asBuyer = await db.as<{ delivery_code: string | null }>(user(BUYER), "select delivery_code from public.my_orders() where id = $1", [o.id]);
    expect(asBuyer[0].delivery_code).toMatch(/^\d{4}$/);
    const asSeller = await db.as<{ delivery_code: string | null }>(user(SHOP), "select delivery_code from public.my_orders() where id = $1", [o.id]);
    expect(asSeller[0].delivery_code).toBeNull();
    const code = (await db.one<{ code: string }>("select code from public.order_delivery_codes where order_id = $1", [o.id])).code;
    const wrong = code === "0000" ? "1111" : "0000";
    for (let i = 0; i < 4; i++) await db.as(user(STAFF), "select public.deliver_with_code($1, $2)", [o.id, wrong]);
    await expect(db.as(user(STAFF), "select public.deliver_with_code($1, $2)", [o.id, code])).rejects.toThrow(/locked/);
    const alerts = await db.as<{ kind: string }>(user(STAFF), "select kind from public.staff_alerts() where order_id = $1", [o.id]);
    expect(alerts.map((a) => a.kind)).toContain("codigo_bloqueado");
  });

  it("shop pickup skips custody: the shop hands it over with the buyer's code", async () => {
    await db.q("update public.listings set status = 'active' where id = $1", [LISTING.pikachu]);
    const o = await paidOrder(db, LISTING.pikachu, { pickup: true });
    expect(o.shipping_cents).toBe(0);
    await expect(db.as(user(STAFF), "select public.staff_pickup($1)", [o.id])).rejects.toThrow(/not ready for pickup/);
    const r = await db.one<{ r: { ok: boolean } }>("select public.deliver_with_code($1, $2) as r", [o.id, await deliveryCode(db, o)], user(SHOP));
    expect(r.r.ok).toBe(true);
    expect((await order(db, o.id)).status).toBe("en_revision");
  });

  it("a dispute can be opened only during the review window, with a reason and photos", async () => {
    await db.q("update public.listings set status = 'active' where id = $1", [LISTING.umbreon]);
    const o = await paidOrder(db, LISTING.umbreon);
    await expect(db.as(user(BUYER), "select public.buyer_open_dispute($1, 'Llegó doblada la carta', $2)", [o.id, [`${BUYER}/${o.id}/a.jpg`]]))
      .rejects.toThrow(/window closed/);
    await pickup(db, o);
    await deliver(db, o);
    await expect(db.as(user(BUYER), "select public.buyer_open_dispute($1, 'Llegó doblada la carta', $2)", [o.id, []]))
      .rejects.toThrow(/photos/);
    await expect(db.as(user(BUYER), "select public.buyer_open_dispute($1, 'Llegó doblada la carta', $2)", [o.id, [`${ANA}/${o.id}/a.jpg`]]))
      .rejects.toThrow(/bad photo path/);
    await expire(db, o, "review_deadline");
    await expect(db.as(user(BUYER), "select public.buyer_open_dispute($1, 'Llegó doblada la carta', $2)", [o.id, [`${BUYER}/${o.id}/a.jpg`]]))
      .rejects.toThrow(/window closed/);
  });

  it("non-staff can't call staff functions", async () => {
    const o = (await db.q<{ id: string }>("select id from public.protected_orders limit 1"))[0];
    for (const sql of [
      "select public.staff_pickup($1)", "select public.staff_out_for_delivery($1)",
      "select public.staff_resolve_dispute($1, 'vendedor')", "select public.staff_order_detail($1)",
    ]) {
      await expect(db.as(user(BUYER), sql, [o.id])).rejects.toThrow(/staff only/);
    }
    await expect(db.as(user(BUYER), "select public.run_order_deadlines()")).rejects.toThrow(/staff only/);
    await expect(db.as(user(ANA), "select public.staff_set_setting('commission_bps', 0)")).rejects.toThrow(/staff only/);
    // The jobs run with no user (pg_cron / SQL editor).
    await db.as(admin, "select public.run_order_deadlines()");
  });
});
