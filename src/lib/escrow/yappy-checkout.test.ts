// "Pagar con Yappy" straight to the payment (migration 0043): the order (#001…) is created with the
// account's Yappy phone, the charge goes to that phone and Yappy's notice marks the sale paid. Run against
// the test database through the same handler the yappy-pago Edge Function uses.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPaymentHandler, type HandlerDeps } from "../../../supabase/functions/_shared/payments/handler.ts";
import { YappyMockProvider } from "../../../supabase/functions/_shared/payments/mock.ts";
import { signYappyNotification } from "../../../supabase/functions/_shared/payments/yappy-hash.ts";
import { TestDb, admin, service, user } from "./testing/db";
import { ANA, BUYER, LISTING, SHOP, STAFF, TEST_DOMAIN, TEST_SECRET } from "./testing/flow";

type WebOrder = {
  sale_id: string; order_no: number; order_label: string; status: string; title: string; description: string; phone: string;
  price_cents: number; shipping_cents: number; total_cents: number; pay_deadline: string | null;
  payment: { id: string; status: string; error: string | null } | null;
};
type WebPayment = WebOrder & { attempt_id: string; existing: boolean; alias: string; subtotal_cents: number; taxes_cents: number };

let db: TestDb;
const mock = new YappyMockProvider({ secret: TEST_SECRET, domain: TEST_DOMAIN });
let handler: (req: Request) => Promise<Response>;

const rpc = (actor: ReturnType<typeof user> | typeof service) => async (fn: string, args: Record<string, unknown>) => {
  const names = Object.keys(args);
  try {
    const r = await db.one<{ r: unknown }>(`select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
      Object.values(args), actor);
    return { data: r.r, error: null };
  } catch (e) {
    return { data: null, error: { message: (e as Error).message } };
  }
};

beforeAll(async () => {
  db = await TestDb.create({ seed: true });
  const deps: HandlerDeps = {
    provider: mock,
    ipnUrl: "https://example.supabase.co/functions/v1/yappy-pago",
    devSimulator: false,
    rpcAsUser: (authorization, fn, args) => rpc(user(authorization.split(".")[1]))(fn, args),
    rpcAsService: (fn, args) => rpc(service)(fn, args),
  };
  handler = createPaymentHandler(deps);
}, 60_000);
afterAll(() => db.close());

const checkout = (who: string, listing: string, phone: string | null = null) =>
  db.one<{ c: WebOrder }>("select public.web_checkout($1, $2) as c", [listing, phone], user(who)).then((r) => r.c);
const startPayment = (who: string, listing: string, phone: string | null = null) =>
  db.one<{ c: WebPayment }>("select public.start_web_payment($1, $2, 'mock') as c", [listing, phone], user(who)).then((r) => r.c);
const sale = (id: string) => db.one<{ status: string; payment_ref: string | null; note: string | null; order_no: number; source: string;
  buyer_phone: string; delivery_address: string | null }>("select * from public.concierge_sales where id = $1", [id]);
const listingStatus = async (id: string) => (await db.one<{ status: string }>("select status from public.listings where id = $1", [id])).status;
const expireWindow = (saleId: string) => db.q("update public.concierge_sales set pay_deadline = now() - interval '1 minute' where id = $1", [saleId]);
const notify = async (attempt: string, status: "E" | "R" | "C" | "X", valid = true) => {
  const hash = await signYappyNotification(TEST_SECRET, attempt, status, TEST_DOMAIN);
  return (await db.one<{ r: string }>("select public.process_yappy_notification($1, $2, $3, $4, $5, $6, null, 'mock') as r",
    [attempt, status, TEST_DOMAIN, hash, valid, status === "E" ? "YP-CONF-1" : null], service)).r;
};
const post = (who: string | null, body: unknown) => handler(new Request("https://fn.test/yappy-pago", {
  method: "POST", headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer test.${who}.sig` } : {}) },
  body: JSON.stringify(body),
}));
const ipn = async (orderId: string, status: string) => {
  const hash = await signYappyNotification(TEST_SECRET, orderId, status, TEST_DOMAIN);
  return handler(new Request(`https://fn.test/yappy-pago?${new URLSearchParams({ orderId, status, hash, domain: TEST_DOMAIN, confirmationNumber: "YP-77" })}`));
};

describe("web_checkout: the order and the phone", () => {
  it("needs a session and a mobile phone; the phone is saved on the account", async () => {
    await expect(db.one("select public.web_checkout($1, null)", [LISTING.umbreon], admin)).rejects.toThrow(/login required/);
    await expect(checkout(BUYER, LISTING.umbreon)).rejects.toThrow(/phone required/); // a buyer account has none yet
    await expect(checkout(BUYER, LISTING.umbreon, "212-3456")).rejects.toThrow(/phone must be a mobile/); // landline: no Yappy
    await expect(checkout(BUYER, LISTING.umbreon, "123")).rejects.toThrow(/phone must be a mobile/);
    const o = await checkout(BUYER, LISTING.umbreon, "6000-1111");
    expect(o).toMatchObject({ order_no: 1, order_label: "001", status: "nueva", phone: "+50760001111",
      price_cents: 8000, shipping_cents: 300, total_cents: 8300, description: "Pago Umbreon VMAX Alt Art 215/203 #001" });
    expect(await db.one("select phone from public.buyer_phones where user_id = $1", [BUYER])).toEqual({ phone: "+50760001111" });
    expect(await sale(o.sale_id)).toMatchObject({ source: "web", delivery_address: null, buyer_phone: "+50760001111" });
    expect(await listingStatus(LISTING.umbreon)).toBe("active"); // reserved only once it is paid
  });

  it("the same buyer gets the same order back; the account's phone is used without asking", async () => {
    const first = await checkout(BUYER, LISTING.umbreon);
    const again = await checkout(BUYER, LISTING.umbreon);
    expect(again.sale_id).toBe(first.sale_id);
    expect(again.order_label).toBe("001");
    const mine = await db.one<{ c: { phone: string; order: WebOrder } }>("select public.my_web_checkout($1) as c", [LISTING.umbreon], user(BUYER));
    expect(mine.c).toMatchObject({ phone: "+50760001111", order: { sale_id: first.sale_id, status: "nueva" } });
    expect((await db.one<{ c: unknown }>("select public.my_web_checkout($1) as c", [LISTING.umbreon], user(ANA))).c)
      .toEqual({ phone: "+50767654321", order: null }); // a seller's phone counts as their Yappy
  });

  it("a seller can't buy their own card; nobody can buy a card that isn't active", async () => {
    await expect(checkout(ANA, LISTING.umbreon)).rejects.toThrow(/own listing/);
    await db.q("update public.listings set status = 'removed' where id = $1", [LISTING.gengar]);
    await expect(checkout(BUYER, LISTING.gengar)).rejects.toThrow(/listing not available/);
    await db.q("update public.listings set status = 'active' where id = $1", [LISTING.gengar]);
  });

  it("holds the card for the buyer while the payment window is open, then frees it for the next one", async () => {
    const beto = await checkout(BUYER, LISTING.wemby);
    expect(beto.order_label).toBe("002");
    await expect(checkout(SHOP, LISTING.wemby)).rejects.toThrow(/listing on hold/);
    await expireWindow(beto.sale_id);
    const shop = await checkout(SHOP, LISTING.wemby);
    expect(shop).toMatchObject({ order_label: "003", phone: "+50761234567" });
    expect(await sale(beto.sale_id)).toMatchObject({ status: "cancelada", note: expect.stringMatching(/Venció sin pago/) });
  });

  it("staff sales get the next order number too", async () => {
    const s = await db.one<{ order_no: number }>(
      "select * from public.staff_create_sale($1, 'Carla', '6000-3333', 'Calle 50, PH Sol, apto 4, Obarrio', null, null, null)",
      [LISTING.pikachu], user(STAFF));
    expect(s.order_no).toBe(4);
    await db.as(user(STAFF), "select public.staff_sale_step($1, 'cancelada')", [(await db.one<{ id: string }>(
      "select id from public.concierge_sales where order_no = 4")).id]);
  });
});

describe("start_web_payment and Yappy's notice", () => {
  it("one charge per try: the order number is Yappy's orderId, then 001B, 001C…", async () => {
    const a = await startPayment(BUYER, LISTING.umbreon);
    expect(a).toMatchObject({ attempt_id: "001", existing: false, alias: "60001111", subtotal_cents: 8300, taxes_cents: 0, total_cents: 8300 });
    // A second tap within a minute returns the same charge instead of sending another one.
    expect(await startPayment(BUYER, LISTING.umbreon)).toMatchObject({ attempt_id: "001", existing: true });
    await db.as(user(BUYER), "select public.web_payment_failed('001', 'Ese número no está registrado en Yappy.')");
    expect(await db.one("select status, error from public.sale_payments where id = '001'"))
      .toEqual({ status: "failed", error: "Ese número no está registrado en Yappy." });
    await expect(db.as(user(SHOP), "select public.web_payment_failed('001', null)")).rejects.toThrow(/not yours/);
    const b = await startPayment(BUYER, LISTING.umbreon);
    expect(b.attempt_id).toBe("001B");
  });

  it("E: the sale is paid and the card reserved, once however many times it arrives", async () => {
    const o = await checkout(BUYER, LISTING.umbreon);
    expect(await notify("001B", "E", false)).toBe("invalid"); // a bad signature is only logged
    expect((await sale(o.sale_id)).status).toBe("nueva");
    expect(await notify("001B", "E")).toBe("paid");
    expect(await notify("001B", "E")).toBe("duplicate");
    expect(await sale(o.sale_id)).toMatchObject({ status: "pagada", payment_ref: "Yappy YP-CONF-1 (#001B)" });
    expect(await listingStatus(LISTING.umbreon)).toBe("reserved");
    await expect(startPayment(BUYER, LISTING.umbreon)).rejects.toThrow(/listing not available|already paid/);
    const logged = await db.q<{ result: string }>("select result from public.payment_notifications where attempt_id = '001B' order by id");
    expect(logged.map((r) => r.result)).toEqual(["invalid", "paid", "duplicate"]);
  });

  it("R, C or X close the charge and free the card; the buyer can try again with the same order", async () => {
    const a = await startPayment(SHOP, LISTING.wemby); // order #003
    expect(a.attempt_id).toBe("003");
    expect(await notify("003", "R")).toBe("noted");
    const s = await db.one<{ open: boolean }>("select pay_deadline <= now() as open from public.concierge_sales where id = $1", [a.sale_id]);
    expect(s.open).toBe(true);
    const retry = await startPayment(SHOP, LISTING.wemby);
    expect(retry).toMatchObject({ attempt_id: "003B", order_label: "003" });
  });

  it("a payment for an order that was cancelled meanwhile is noted for a refund", async () => {
    await expireWindow((await checkout(SHOP, LISTING.wemby)).sale_id);
    const beto = await checkout(BUYER, LISTING.wemby); // takes the card: #003 is cancelled
    expect(beto.order_label).toBe("005");
    expect(await notify("003B", "E")).toBe("late payment: refund");
    const old = await db.one<{ status: string; note: string }>("select status, note from public.concierge_sales where order_no = 3");
    expect(old.status).toBe("cancelada");
    expect(old.note).toMatch(/Pago por Yappy YP-CONF-1 \(#003B\) de \$38 cuando la orden estaba cancelada: reembolsar\./);
  });

  it("only the service role processes notices; signed-in users call the checkout RPCs, anon can't", async () => {
    const can = async (role: string, fn: string) => (await db.q<{ ok: boolean }>(
      `select bool_or(has_function_privilege($1, p.oid, 'EXECUTE')) as ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $2`, [role, fn]))[0].ok;
    for (const fn of ["process_yappy_notification", "process_sale_payment_notification", "account_yappy_phone", "web_order_json"]) {
      expect.soft(await can("authenticated", fn), fn).toBe(false);
      expect.soft(await can("anon", fn), fn).toBe(false);
    }
    expect(await can("service_role", "process_yappy_notification")).toBe(true);
    for (const fn of ["web_checkout", "start_web_payment", "my_web_checkout", "web_payment_failed"]) {
      expect.soft(await can("authenticated", fn), fn).toBe(true);
      expect.soft(await can("anon", fn), fn).toBe(false);
    }
    // Only the person and staff read a buyer's phone.
    expect(await db.asRole(user(SHOP), "select * from public.buyer_phones")).toEqual([]);
    expect(await db.asRole(user(BUYER), "select phone from public.buyer_phones")).toEqual([{ phone: "+50760001111" }]);
  });
});

describe("the Edge Function: POST { listing_id } and the IPN", () => {
  it("creates the order, sends the charge to the buyer's phone and the IPN marks it paid", async () => {
    const r = await post(BUYER, { listing_id: LISTING.gengar });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body).toMatchObject({ checkout: true, attempt: "006", simulated: true,
      order: { order_label: "006", status: "nueva", total_cents: 6300, description: "Pago Gengar VMAX Alt Art 271/264 #006", phone: "+50760001111" } });
    expect(mock.charge("006")).toMatchObject({ orderId: "006", aliasYappy: "60001111", subtotalCents: 6300, taxesCents: 0, totalCents: 6300,
      description: "Pago Gengar VMAX Alt Art 271/264 #006" });
    expect((await ipn("006", "E")).status).toBe(200);
    expect((await db.one<{ c: { order: WebOrder } }>("select public.my_web_checkout($1) as c", [LISTING.gengar], user(BUYER))).c.order)
      .toMatchObject({ status: "pagada", payment: { id: "006", status: "executed" } });
  });

  it("asks for the phone when the account has none or Yappy doesn't know it, and frees the card", async () => {
    await db.q("delete from public.buyer_phones where user_id = $1", [BUYER]);
    const noPhone = await post(BUYER, { listing_id: LISTING.charizard });
    expect(noPhone.status).toBe(400);
    expect(await noPhone.json()).toMatchObject({ checkout: true, need_phone: true });
    const unknown = await post(BUYER, { listing_id: LISTING.charizard, phone: "6000-0005" });
    expect(unknown.status).toBe(502);
    const body = await unknown.json();
    expect(body).toMatchObject({ checkout: true, need_phone: true, error: "Ese número no está registrado en Yappy.", order: { order_label: "007" } });
    expect(await db.one("select status from public.sale_payments where id = '007'")).toEqual({ status: "failed" });
    const ok = await post(BUYER, { listing_id: LISTING.charizard, phone: "6000-2222" });
    expect(await ok.json()).toMatchObject({ attempt: "007B", order: { order_label: "007", phone: "+50760002222" } });
  });

  it("errors carry checkout: true so the page can tell this function apart; no session, no charge", async () => {
    expect(await (await post(null, { listing_id: LISTING.pikachu })).json()).toEqual({ checkout: true, error: "Inicia sesión para pagar." });
    const own = await post(SHOP, { listing_id: LISTING.pikachu });
    expect(await own.json()).toMatchObject({ checkout: true, error: "No puedes comprar tu propia carta." });
  });

  it("staff see the order number, the Yappy description and the last charge in Ventas", async () => {
    const rows = await db.as<{ order_label: string; source: string; yappy_description: string; last_payment_status: string; last_payment_id: string }>(
      user(STAFF), "select order_label, source, yappy_description, last_payment_status, last_payment_id from public.staff_sales(null) where order_label = '007'");
    expect(rows).toEqual([{ order_label: "007", source: "web", yappy_description: "Pago Charizard ex 199/165 SIR #007",
      last_payment_status: "created", last_payment_id: "007B" }]);
    await expect(db.as(user(BUYER), "select * from public.staff_sales(null)")).rejects.toThrow(/staff only/);
  });
});

describe("the Edge Function before migration 0043", () => {
  it("answers without checkout, so the page falls back to the consulta", async () => {
    const old = await TestDb.create({ seed: true, stopBefore: "0043" });
    try {
      const call = async (fn: string, args: Record<string, unknown>, actor: ReturnType<typeof user>) => {
        const names = Object.keys(args);
        try {
          const r = await old.one<{ r: unknown }>(`select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, Object.values(args), actor);
          return { data: r.r, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      };
      const h = createPaymentHandler({
        provider: mock, ipnUrl: "https://example.supabase.co/functions/v1/yappy-pago", devSimulator: false,
        rpcAsUser: (authorization, fn, args) => call(fn, args, user(authorization.split(".")[1])),
        rpcAsService: () => Promise.resolve({ data: null, error: { message: "unused" } }),
      });
      const r = await h(new Request("https://fn.test/yappy-pago", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer test.${BUYER}.sig` },
        body: JSON.stringify({ listing_id: LISTING.umbreon, phone: "6000-1111" }),
      }));
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "El pago todavía no está configurado." });
    } finally {
      await old.close();
    }
  }, 60_000);
});
