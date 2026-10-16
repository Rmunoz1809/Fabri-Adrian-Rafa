// Seller accounts (migration 0031): selling needs a phone and the pickup address; people sign up as
// sellers or turn a normal account into one. Only the person and staff read that data.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, admin, user } from "./testing/db";

const STAFF = "00000000-0000-4000-a000-000000000001";
const ANA = "00000000-0000-4000-a000-000000000003"; // seller in the seed
const BUYER = "00000000-0000-4000-a000-000000000004"; // normal account in the seed
const CARLA = "00000000-0000-4000-a000-000000000031"; // signs up as a seller
const DANI = "00000000-0000-4000-a000-000000000032"; // signs up as a normal account
const EVA = "00000000-0000-4000-a000-000000000033"; // signs up as a seller with a bad phone
const LEGACY = "00000000-0000-4000-a000-000000000034"; // sold before 0031, never gave the data
const ADDRESS = "Bella Vista, calle 42, edificio Sol, apto 5";

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
  await db.q(`insert into auth.users (id, email, raw_user_meta_data) values
    ($1, 'carla@x.test', $5), ($2, 'dani@x.test', '{"display_name": "Dani"}'), ($3, 'eva@x.test', $6), ($4, 'old@x.test', '{"display_name": "Vendedor viejo"}')`,
    [CARLA, DANI, EVA, LEGACY,
      { display_name: "Carla", account_type: "seller", seller_phone: "6555-1234", pickup_address: `  ${ADDRESS}\n` },
      { display_name: "Eva", account_type: "seller", seller_phone: "llámame", pickup_address: ADDRESS }]);
}, 60_000);
afterAll(() => db.close());

const insertListing = (seller: string, status = "draft") =>
  db.as(user(seller), `insert into public.listings (seller_id, category, title, subject, set_name, condition, price_cents, province, district, neighborhood, status)
                       values ($1, 'pokemon', 'Carta de prueba', 'Prueba', 'Set', 'NM', 1000, 'Panamá', 'Panamá', 'Obarrio', $2) returning id`, [seller, status]);
const account = (id: string) => db.q<{ phone: string; pickup_address: string }>("select phone, pickup_address from public.seller_accounts where user_id = $1", [id]);

describe("pa_phone", () => {
  it("normalizes Panamanian mobiles and landlines and rejects the rest", async () => {
    const cases: [string, string | null][] = [
      ["6123-4567", "+50761234567"], ["+507 6123 4567", "+50761234567"], ["00507 61234567", "+50761234567"],
      ["(507) 212-3456", "+5072123456"], ["212 3456", "+5072123456"],
      ["6123456", null], ["1234567", null], ["llámame", null], ["+1 305 555 1234", null], ["", null],
    ];
    for (const [raw, want] of cases) {
      const { p } = await db.one<{ p: string | null }>("select public.pa_phone($1) as p", [raw]);
      expect(p, raw).toBe(want);
    }
  });
});

describe("sign-up", () => {
  it("a seller sign-up creates the seller account with the cleaned phone and address", async () => {
    expect(await account(CARLA)).toEqual([{ phone: "+50765551234", pickup_address: ADDRESS }]);
  });

  it("a normal sign-up has none, and bad seller data never blocks the sign-up", async () => {
    expect(await account(DANI)).toEqual([]);
    expect(await account(EVA)).toEqual([]);
    const people = await db.q("select id from public.profiles where id = any($1)", [[DANI, EVA]]);
    expect(people).toHaveLength(2);
  });
});

describe("save_seller_account", () => {
  it("turns a normal account into a seller account and later updates it", async () => {
    await expect(db.as(admin, "select public.save_seller_account('61234567', $1)", [ADDRESS])).rejects.toThrow(/sign in/);
    await expect(db.as(user(BUYER), "select public.save_seller_account('123', $1)", [ADDRESS])).rejects.toThrow(/phone/);
    await expect(db.as(user(BUYER), "select public.save_seller_account('61234567', 'Mi casa')")).rejects.toThrow(/address/);
    const [row] = await db.as<{ user_id: string; phone: string }>(user(BUYER), "select user_id, phone from public.save_seller_account('6000-0001', $1)", [ADDRESS]);
    expect(row).toEqual({ user_id: BUYER, phone: "+50760000001" });
    await db.as(user(BUYER), "select public.save_seller_account('+507 6000-0002', 'Costa del Este, PH Torre Azul, apto 20A')");
    const updated = await db.one<{ phone: string; pickup_address: string; later: boolean }>(
      "select phone, pickup_address, updated_at >= created_at as later from public.seller_accounts where user_id = $1", [BUYER]);
    expect(updated).toEqual({ phone: "+50760000002", pickup_address: "Costa del Este, PH Torre Azul, apto 20A", later: true });
  });

  it("only the person and staff can read it; nobody writes it directly", async () => {
    const select = await db.q<{ qual: string }>("select qual from pg_policies where tablename = 'seller_accounts' and cmd = 'SELECT'");
    expect(select[0].qual).toMatch(/auth\.uid\(\)/);
    expect(select[0].qual).toMatch(/is_staff/);
    expect(await db.q("select 1 from pg_policies where tablename = 'seller_accounts' and cmd <> 'SELECT'")).toEqual([]);
    expect(await db.one("select relrowsecurity as rls from pg_class where oid = 'public.seller_accounts'::regclass")).toEqual({ rls: true });
  });
});

describe("publishing", () => {
  it("needs a seller account", async () => {
    await expect(insertListing(DANI)).rejects.toThrow(/seller_account_required/);
    await insertListing(CARLA);
    await insertListing(ANA, "active");
  });

  it("cards already on sale before 0031 keep working, but a draft can't go on sale without the account", async () => {
    const legacyListing = async (status: string) => (await db.q<{ id: string }>(`insert into public.listings (seller_id, category, title, subject, set_name, condition, price_cents, province, district, neighborhood, status)
      values ($1, 'pokemon', 'Carta vieja de prueba', 'X', 'Y', 'NM', 2000, 'Panamá', 'Panamá', 'Obarrio', $2) returning id`, [LEGACY, status]))[0].id;
    const onSale = await legacyListing("active");
    await db.as(user(LEGACY), "update public.listings set price_cents = 1800 where id = $1", [onSale]);
    const draft = await legacyListing("draft");
    await expect(db.as(user(LEGACY), "update public.listings set status = 'active' where id = $1", [draft])).rejects.toThrow(/seller_account_required/);
    await db.as(user(STAFF), "update public.listings set status = 'active' where id = $1", [draft]);
    await db.as(user(STAFF), "update public.listings set status = 'removed' where id = $1", [draft]);
  });
});

describe("staff_seller_accounts", () => {
  it("lists sellers with their pickup data, and people selling without it", async () => {
    await expect(db.as(user(ANA), "select * from public.staff_seller_accounts()")).rejects.toThrow(/staff only/);
    const rows = await db.as<{ user_id: string; email: string; phone: string | null; cards_on_sale: number }>(user(STAFF),
      "select user_id, email, phone, cards_on_sale from public.staff_seller_accounts()");
    const by = Object.fromEntries(rows.map((r) => [r.user_id, r]));
    expect(by[CARLA]).toMatchObject({ email: "carla@x.test", phone: "+50765551234" });
    expect(by[ANA].cards_on_sale).toBeGreaterThan(0);
    expect(by[LEGACY]).toMatchObject({ phone: null, cards_on_sale: 1 });
    expect(by[DANI]).toBeUndefined();
    const search = async (q: string) => (await db.as<{ user_id: string }>(user(STAFF), "select user_id from public.staff_seller_accounts($1)", [q])).map((r) => r.user_id);
    expect(await search("carla")).toEqual([CARLA]);
    expect(await search("6555-1234")).toEqual([CARLA]);
    expect(await search("Torre Azul")).toEqual([BUYER]);
  });
});

describe("backfill", () => {
  it("re-running 0031 copies sellers whose data is only in the account metadata", async () => {
    await db.q("delete from public.seller_accounts where user_id = $1", [CARLA]);
    await db.migrate("0031_seller_accounts.sql");
    expect(await account(CARLA)).toEqual([{ phone: "+50765551234", pickup_address: ADDRESS }]);
    expect(await account(DANI)).toEqual([]);
  });
});
