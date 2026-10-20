// Amounts: integer cents, computed by the database from the listing (never sent by the client),
// and the TypeScript mirror (quoteOrder) agrees with order_quote() for every price.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SHIPPING_CENTS, quoteOrder } from "../fees";
import { TestDb, user } from "./testing/db";
import { ANA, BUYER, LISTING, SHOP, STAFF, newAttempt, requestOrder, sellerConfirm } from "./testing/flow";

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
}, 60_000);
afterAll(() => db.close());

describe("quoteOrder (TypeScript)", () => {
  it("$100 card: buyer pays $104 with shipping, seller gets $92.51", () => {
    const q = quoteOrder(10_000);
    expect(q).toMatchObject({
      priceCents: 10_000, shippingCents: 400, orderTotalCents: 10_400,
      sellerFeeCents: 700, sellerItbmsCents: 49, sellerPayoutCents: 9_251, platformRevenueCents: 700,
    });
  });

  it("no shipping with pickup at the shop", () => {
    expect(quoteOrder(10_000, { pickup: true })).toMatchObject({ shippingCents: 0, orderTotalCents: 10_000 });
  });

  it("rounds half up and keeps every amount an integer", () => {
    for (const price of [1, 9, 10, 11, 99, 101, 1_234, 3_333, 99_999]) {
      const q = quoteOrder(price);
      for (const v of Object.values(q)) expect(Number.isInteger(v)).toBe(true);
      expect(q.sellerPayoutCents + q.sellerFeeCents + q.sellerItbmsCents).toBe(price);
    }
    expect(quoteOrder(50).sellerFeeCents).toBe(4); // 3.5 → 4
    expect(quoteOrder(7).sellerFeeCents).toBe(0); // 0.49 → 0
  });

  it("rejects non-integer or non-positive prices", () => {
    expect(() => quoteOrder(10.5)).toThrow(RangeError);
    expect(() => quoteOrder(0)).toThrow(RangeError);
    expect(() => quoteOrder(100, { shippingCents: -1 })).toThrow(RangeError);
  });
});

describe("order_quote (database) matches quoteOrder", () => {
  it("for a sweep of prices, with and without pickup", async () => {
    const prices = [1, 9, 10, 19, 20, 99, 100, 250, 999, 1_000, 1_234, 3_500, 9_999, 12_000, 45_000, 1_000_000];
    for (const price of prices) {
      for (const pickup of [false, true]) {
        const db_ = await db.one<{ q: Record<string, number> }>("select public.order_quote($1, $2) as q", [price, pickup]);
        const ts = quoteOrder(price, { pickup, shippingCents: DEFAULT_SHIPPING_CENTS });
        expect(db_.q).toMatchObject({
          price, shipping: ts.shippingCents, total: ts.orderTotalCents,
          seller_fee: ts.sellerFeeCents, seller_itbms: ts.sellerItbmsCents, payout: ts.sellerPayoutCents,
        });
      }
    }
  });
});

describe("amounts come from the database", () => {
  it("the order takes the listing's price and the configured shipping; the attempt the order's total", async () => {
    const o = await requestOrder(db, LISTING.umbreon);
    expect(o).toMatchObject({ price_cents: 8000, shipping_cents: 400, seller_fee_cents: 560, seller_itbms_cents: 39 });
    await sellerConfirm(db, o);
    const a = await newAttempt(db, o);
    expect(a.total_cents).toBe(8400);
    // There is no parameter to send an amount: the RPC signatures only take ids.
    const args = await db.q<{ args: string }>(
      "select pg_get_function_arguments(p.oid) as args from pg_proc p where proname in ('request_order', 'new_payment_attempt', 'seller_confirm_order')");
    for (const r of args) expect(r.args).not.toMatch(/amount|price|total|cents/i);
    await db.as(user(BUYER), "select public.buyer_cancel_order($1)", [o.id]).catch(() => undefined);
  });

  it("commission and shipping are configurable by staff and apply to new orders only", async () => {
    await db.as(user(STAFF), "select public.staff_set_setting('commission_bps', 800)");
    await db.as(user(STAFF), "select public.staff_set_setting('shipping_cents', 500)");
    const o = await requestOrder(db, LISTING.gengar);
    expect(o).toMatchObject({ price_cents: 6000, shipping_cents: 500, seller_fee_cents: 480, seller_itbms_cents: 34 });
    await expect(db.as(user(STAFF), "select public.staff_set_setting('commission_bps', 20000)")).rejects.toThrow(/bps over/);
    await expect(db.as(user(STAFF), "select public.staff_set_setting('nope', 1)")).rejects.toThrow(/unknown key/);
    await db.as(user(STAFF), "select public.staff_set_setting('commission_bps', 700)");
    await db.as(user(STAFF), "select public.staff_set_setting('shipping_cents', 400)");
    await db.as(user(BUYER), "select public.buyer_cancel_order($1)", [o.id]);
  });
});

describe("staff concierge orders", () => {
  it("are priced by the database and start waiting for payment", async () => {
    const o = await db.one<{ status: string; price_cents: number; shipping_cents: number; buyer_contact: string }>(
      "select * from public.staff_create_order($1, null, 'Carlos 6000-0000', false)", [LISTING.wemby], user(STAFF));
    expect(o).toMatchObject({ status: "pendiente_pago", price_cents: 3500, shipping_cents: 400, buyer_contact: "Carlos 6000-0000" });
    await expect(db.as(user(BUYER), "select public.staff_create_order($1, null, 'x y z', false)", [LISTING.gengar])).rejects.toThrow(/staff only/);
  });
});

describe("new sellers and blocked sellers", () => {
  const insertListing = (seller: string, price: number) =>
    db.as(user(seller), `insert into public.listings (seller_id, category, title, subject, set_name, condition, price_cents, province, district, neighborhood, status)
                         values ($1, 'pokemon', 'Carta de prueba cara', 'Prueba', 'Set', 'NM', $2, 'Panamá', 'Panamá', 'Obarrio', 'active')`, [seller, price]);

  it("a new seller can't list above the cap until N completed sales; verified shops can", async () => {
    await expect(insertListing(ANA, 20_000)).rejects.toThrow(/new_seller_price_cap/);
    await insertListing(ANA, 15_000);
    await insertListing(SHOP, 90_000);
  });

  it("a blocked seller can't publish and can't receive orders", async () => {
    await db.q("update public.profiles set selling_blocked_until = now() + interval '1 day' where id = $1", [ANA]);
    await expect(insertListing(ANA, 1_000)).rejects.toThrow(/seller_blocked/);
    await expect(requestOrder(db, LISTING.wemby)).rejects.toThrow(/can't sell right now/);
    // And can't lift it themselves.
    await expect(db.as(user(ANA), "update public.profiles set selling_blocked_until = null where id = $1", [ANA]))
      .rejects.toThrow(/standing/);
    await db.q("update public.profiles set selling_blocked_until = null where id = $1", [ANA]);
  });
});
