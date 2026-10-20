// Staff panel ▸ Usuarios and ▸ Ventas (migration 0041): staff see every account with its data, and run
// each sale by hand: Yappy payment → card reserved → picked up and seller paid → distribution → delivered.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, admin, user } from "./testing/db";
import { ANA, BUYER, LISTING, SHOP, STAFF } from "./testing/flow";

const ADDRESS = "Calle 50, PH Sol, apto 4, Obarrio, Panamá, Panamá";

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
}, 60_000);
afterAll(() => db.close());

type Sale = { id: string; code: string; status: string; price_cents: number; shipping_cents: number; commission_cents: number;
  itbms_cents: number; payout_cents: number; seller_id: string; buyer_phone: string };
const create = (who: string, listing: string, extra: { buyer?: string; inquiry?: string; phone?: string; address?: string; name?: string } = {}) =>
  db.one<Sale>("select * from public.staff_create_sale($1, $2, $3, $4, $5, $6, null)",
    [listing, extra.name ?? "Beto Comprador", extra.phone ?? "6000-1111", extra.address ?? ADDRESS, extra.buyer ?? null, extra.inquiry ?? null], user(who));
const step = (id: string, s: string, ref: string | null = null, date: string | null = null) =>
  db.one<Sale>("select * from public.staff_sale_step($1, $2, $3, $4::date, null)", [id, s, ref, date], user(STAFF));
const listingStatus = async (id: string) => (await db.one<{ status: string }>("select status from public.listings where id = $1", [id])).status;

describe("staff_create_sale", () => {
  it("only staff create sales, and the amounts come from the listing and the settings (7% + ITBMS)", async () => {
    await expect(create(BUYER, LISTING.charizard)).rejects.toThrow(/staff only/);
    const s = await create(STAFF, LISTING.charizard, { buyer: BUYER });
    expect(s).toMatchObject({ status: "nueva", price_cents: 12000, shipping_cents: 400, commission_cents: 840, itbms_cents: 59,
      payout_cents: 11101, seller_id: SHOP, buyer_phone: "+50760001111" });
    expect(s.code).toMatch(/^V-[2-9A-HJ-NP-Z]{6}$/);
    expect(await listingStatus(LISTING.charizard)).toBe("active"); // not reserved until it is paid
    await expect(create(STAFF, LISTING.charizard)).rejects.toThrow(/open sale/);
    await step(s.id, "cancelada");
  });

  it("checks the buyer's data", async () => {
    await expect(create(STAFF, LISTING.umbreon, { phone: "123" })).rejects.toThrow(/buyer phone/);
    await expect(create(STAFF, LISTING.umbreon, { address: "Mi casa" })).rejects.toThrow(/delivery address/);
    await expect(create(STAFF, LISTING.umbreon, { name: "", buyer: undefined })).rejects.toThrow(/buyer name/);
    await expect(create(STAFF, LISTING.umbreon, { buyer: ANA })).rejects.toThrow(/buyer is the seller/);
  });

  it("links the consulta and puts it in progress", async () => {
    const code = await db.one<{ c: string }>("select public.create_inquiry('carta', $1, null, null, null, 'La quiero', '6000-2222') as c", [LISTING.gengar], user(BUYER));
    const inq = await db.one<{ id: string }>("select id from public.inquiries where code = $1", [code.c]);
    const s = await create(STAFF, LISTING.gengar, { inquiry: inq.id, buyer: BUYER, name: "" });
    expect(await db.one("select status from public.inquiries where id = $1", [inq.id])).toEqual({ status: "en_curso" });
    expect(await db.one("select buyer_name from public.concierge_sales where id = $1", [s.id])).toEqual({ buyer_name: "Beto Comprador" });
  });
});

describe("staff_sale_step: the whole flow", () => {
  it("paid → reserved → picked up (seller paid) → scheduled → out → delivered → sold", async () => {
    const s = await create(STAFF, LISTING.pikachu, { buyer: BUYER });
    await expect(step(s.id, "retirada", "YP-1")).rejects.toThrow(/nueva → retirada/);
    await expect(step(s.id, "pagada")).rejects.toThrow(/payment reference/);
    await step(s.id, "pagada", "YAPPY-123");
    expect(await listingStatus(LISTING.pikachu)).toBe("reserved");
    await expect(step(s.id, "retirada")).rejects.toThrow(/payout reference/);
    await step(s.id, "retirada", "YAPPY-PAGO-VENDEDOR");
    await expect(step(s.id, "programar", null, "2020-01-01")).rejects.toThrow(/distribution date/);
    const sched = await step(s.id, "programar", null, "2099-01-03");
    expect(sched).toMatchObject({ status: "retirada" });
    await expect(step(s.id, "cancelada")).rejects.toThrow(/already picked up/);
    await step(s.id, "en_ruta");
    const done = await step(s.id, "entregada");
    expect(done.status).toBe("entregada");
    expect(await listingStatus(LISTING.pikachu)).toBe("sold");
    expect(await db.q("select price_cents, grading_key from public.sales where listing_id = $1", [LISTING.pikachu]))
      .toEqual([{ price_cents: 45000, grading_key: "PSA9" }]);
    const row = await db.one<Record<string, unknown>>(
      "select payment_ref, payout_ref, distribution_date::text as d, paid_at is not null as p, picked_up_at is not null as k, delivered_at is not null as e from public.concierge_sales where id = $1", [s.id]);
    expect(row).toEqual({ payment_ref: "YAPPY-123", payout_ref: "YAPPY-PAGO-VENDEDOR", d: "2099-01-03", p: true, k: true, e: true });
  });

  it("cancelling a paid sale needs the refund and puts the card back on sale", async () => {
    const s = await create(STAFF, LISTING.wemby);
    await step(s.id, "pagada", "YP-9");
    await expect(step(s.id, "cancelada")).rejects.toThrow(/refund reference/);
    await step(s.id, "cancelada", "YP-REEMBOLSO");
    expect(await listingStatus(LISTING.wemby)).toBe("active");
    await expect(step(s.id, "pagada", "x")).rejects.toThrow(/cancelada → pagada/);
  });

  it("only staff move sales, and only staff read them", async () => {
    const s = await create(STAFF, LISTING.umbreon);
    await expect(db.as(user(ANA), "select public.staff_sale_step($1, 'pagada', 'x', null, null)", [s.id])).rejects.toThrow(/staff only/);
    const pol = await db.q<{ cmd: string; qual: string }>("select cmd, qual from pg_policies where tablename = 'concierge_sales'");
    expect(pol).toHaveLength(1);
    expect(pol[0]).toMatchObject({ cmd: "SELECT" });
    expect(pol[0].qual).toMatch(/is_staff/);
  });
});

describe("staff_sales", () => {
  it("lists each sale with the seller's phone, pickup address and the Yappy to pay", async () => {
    await expect(db.as(user(BUYER), "select * from public.staff_sales()")).rejects.toThrow(/staff only/);
    const rows = await db.as<{ code: string; seller_phone: string; seller_pickup_address: string; seller_yappy: string; seller_kind: string; status: string }>(
      user(STAFF), "select * from public.staff_sales('nueva')");
    const umbreon = rows.find((r) => r.status === "nueva");
    expect(umbreon).toMatchObject({ seller_phone: expect.stringMatching(/^\+507/), seller_kind: "vendedor" });
    expect(umbreon!.seller_yappy).toBe(umbreon!.seller_phone); // no shop agreement: pay to the seller's phone
  });
});

describe("Usuarios", () => {
  it("lists every account with its type, and finds by name, e-mail or phone", async () => {
    await expect(db.as(user(BUYER), "select * from public.staff_users()")).rejects.toThrow(/staff only/);
    const all = await db.as<{ user_id: string; kind: string }>(user(STAFF), "select user_id, kind from public.staff_users()");
    const kind = Object.fromEntries(all.map((r) => [r.user_id, r.kind]));
    expect(kind).toMatchObject({ [STAFF]: "staff", [SHOP]: "tienda", [ANA]: "vendedor", [BUYER]: "comprador" });
    const sellers = await db.as<{ user_id: string }>(user(STAFF), "select user_id from public.staff_users(null, 'vendedor')");
    expect(sellers.map((r) => r.user_id)).toEqual([ANA]);
    expect((await db.as<{ user_id: string }>(user(STAFF), "select user_id from public.staff_users('beto@')")).map((r) => r.user_id)).toEqual([BUYER]);
  });

  it("shows everything about one account to staff only", async () => {
    await expect(db.as(user(ANA), "select public.staff_user_detail($1)", [ANA])).rejects.toThrow(/staff only/);
    type Detail = { kind: string; account: { email: string }; seller: { phone: string; pickup_address: string };
      listings: { counts: Record<string, number> }; sales: { role: string }[] };
    const { d } = await db.one<{ d: Detail }>("select public.staff_user_detail($1) as d", [ANA], user(STAFF));
    expect(d.kind).toBe("vendedor");
    expect(d.account.email).toBe("ana@holo.test");
    expect(d.seller.phone).toMatch(/^\+507/);
    expect(d.seller.pickup_address.length).toBeGreaterThan(10);
    expect(d.listings.counts.active).toBeGreaterThan(0);
    expect(d.sales.some((s) => s.role === "vendedor")).toBe(true);
    expect(await db.one("select public.staff_user_detail('00000000-0000-4000-a000-0000000000ff') as d", [], user(STAFF))).toEqual({ d: null });
  });

  it("internal helpers are not callable from the app", async () => {
    const r = await db.one<{ ok: boolean }>("select has_function_privilege('authenticated', 'public.staff_account_kind(uuid)', 'execute') as ok", [], admin);
    expect(r.ok).toBe(false);
  });
});
