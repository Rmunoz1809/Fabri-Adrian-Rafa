// Shop sign-up with the signed store agreement (migration 0037): the request keeps the data, the drawn
// signature and its evidence hash; only staff approve, and approving verifies the shop in one step.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, admin, user } from "./testing/db";

const STAFF = "00000000-0000-4000-a000-000000000001";
const SHOP = "00000000-0000-4000-a000-000000000002"; // verified shop in the seed, never signed
const ANA = "00000000-0000-4000-a000-000000000003"; // seller in the seed
const BUYER = "00000000-0000-4000-a000-000000000004"; // normal account in the seed

// A tiny valid PNG data URL, padded to the minimum length the signature check asks for.
const SIGNATURE = "data:image/png;base64," + "iVBORw0KGgo".padEnd(800, "A");
const FORM = {
  shop: "  Cartas   del Istmo ", owner: "Luis Pérez", doc: "8-123-4567", address: "Vía Argentina, edificio Sol, local 3",
  province: "Panamá", phone: "6555-0001", ig: "https://www.instagram.com/CartasDelIstmo/?igsh=abc", yappy: "", hours: "L-S 10:00 a 19:00",
  version: "tiendas-2026-10-20", signature: SIGNATURE, agent: "Mozilla/5.0 (test)",
};
type Form = typeof FORM;

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
}, 60_000);
afterAll(() => db.close());

const submit = (who: string, f: Partial<Form> = {}) => {
  const v = { ...FORM, ...f };
  return db.as<{ id: string }>(user(who),
    "select public.submit_shop_request($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as id",
    [v.shop, v.owner, v.doc, v.address, v.province, v.phone, v.ig, v.yappy, v.hours, v.version, v.signature, v.agent]);
};
const review = (who: string, id: string, approve: boolean, note: string | null = null) =>
  db.as(user(who), "select public.review_shop_request($1, $2, $3)", [id, approve, note]);
const profile = (id: string) =>
  db.one<{ is_shop: boolean; verified: boolean; shop_address: string | null; shop_hours: string | null }>(
    "select is_shop, verified, shop_address, shop_hours from public.profiles where id = $1", [id]);
const notes = (id: string) => db.q<{ kind: string }>("select kind from public.notifications where user_id = $1 order by id", [id]);

describe("ig_handle", () => {
  it("takes the handle out of @names and profile links", async () => {
    const cases: [string, string | null][] = [
      ["@mitienda", "mitienda"], ["MiTienda", "mitienda"], ["instagram.com/mi.tienda_pa/", "mi.tienda_pa"],
      ["https://www.instagram.com/CartasDelIstmo/?igsh=abc", "cartasdelistmo"], ["", null], ["mi tienda", null], ["@", null],
    ];
    for (const [raw, want] of cases) {
      const { h } = await db.one<{ h: string | null }>("select public.ig_handle($1) as h", [raw]);
      expect(h, raw).toBe(want);
    }
  });
});

describe("submit_shop_request", () => {
  it("rejects bad data, a missing signature and anonymous calls", async () => {
    await expect(db.as(admin, "select public.submit_shop_request('a','b','c','d','e','f','g','h','i','j','k')")).rejects.toThrow(/sign in/);
    const bad: [Partial<Form>, RegExp][] = [
      [{ shop: "X" }, /shop name/], [{ owner: "Lu" }, /owner name/], [{ doc: "abc" }, /cedula/], [{ address: "Mi casa" }, /address/],
      [{ phone: "123" }, /phone/], [{ ig: "mi tienda" }, /instagram/], [{ yappy: "212-3456" }, /yappy/], [{ hours: "" }, /hours/],
      [{ version: "v1" }, /terms version/], [{ signature: "data:image/png;base64,AAAA" }, /signature/],
      [{ signature: "data:image/svg+xml;base64," + "A".repeat(800) }, /signature/],
    ];
    for (const [f, err] of bad) await expect(submit(BUYER, f), String(err)).rejects.toThrow(err);
    expect(await db.q("select 1 from public.shop_requests where user_id = $1", [BUYER])).toEqual([]);
  });

  it("saves the cleaned data, the signing time and an evidence hash, and tells staff", async () => {
    const [{ id }] = await submit(BUYER);
    const r = await db.one<Record<string, unknown>>(
      `select shop_name, owner_id_doc, phone, instagram, yappy_phone, contact, location, status, terms_version,
              signed_at is not null as signed, sign_hash ~ '^[0-9a-f]{64}$' as hashed, public.shop_request_hash(r) = sign_hash as matches
         from public.shop_requests r where id = $1`, [id]);
    expect(r).toEqual({
      shop_name: "Cartas del Istmo", owner_id_doc: "8-123-4567", phone: "+50765550001", instagram: "cartasdelistmo",
      yappy_phone: "+50765550001", contact: "@cartasdelistmo", location: FORM.address, status: "pending",
      terms_version: "tiendas-2026-10-20", signed: true, hashed: true, matches: true,
    });
    expect((await notes(STAFF)).map((n) => n.kind)).toContain("staff_shop");
    await expect(submit(BUYER)).rejects.toThrow(/already pending/);
  });

  it("the hash catches a change made after signing", async () => {
    const { id } = await db.one<{ id: string }>("select id from public.shop_requests where user_id = $1 and status = 'pending'", [BUYER]);
    const intact = () => db.one<{ ok: boolean }>("select public.shop_request_intact($1) as ok", [id], user(BUYER));
    expect(await intact()).toEqual({ ok: true });
    await db.q("update public.shop_requests set yappy_phone = '+50769999999' where id = $1", [id]);
    expect(await intact()).toEqual({ ok: false });
    await db.q("update public.shop_requests set yappy_phone = '+50765550001' where id = $1", [id]);
    expect(await intact()).toEqual({ ok: true });
    expect(await db.as(user(ANA), "select public.shop_request_intact($1) as ok", [id])).toEqual([{ ok: null }]);
  });
});

describe("review_shop_request", () => {
  it("only staff decide", async () => {
    const { id } = await db.one<{ id: string }>("select id from public.shop_requests where user_id = $1 and status = 'pending'", [BUYER]);
    await expect(review(BUYER, id, true)).rejects.toThrow(/staff only/);
    await expect(review(ANA, id, true)).rejects.toThrow(/staff only/);
  });

  it("approving signs for MarketZlab and makes a verified shop that can sell, with its store page", async () => {
    const { id } = await db.one<{ id: string }>("select id from public.shop_requests where user_id = $1 and status = 'pending'", [BUYER]);
    expect(await db.q("select 1 from public.seller_accounts where user_id = $1", [BUYER])).toEqual([]);
    await review(STAFF, id, true, "Local visitado");
    const r = await db.one("select status, reviewer_id, reviewer_name, review_note, reviewed_at is not null as reviewed from public.shop_requests where id = $1", [id]);
    expect(r).toEqual({ status: "approved", reviewer_id: STAFF, reviewer_name: "Holo Staff", review_note: "Local visitado", reviewed: true });
    expect(await profile(BUYER)).toEqual({ is_shop: true, verified: true, shop_address: FORM.address, shop_hours: FORM.hours });
    expect(await db.q("select phone, pickup_address from public.seller_accounts where user_id = $1", [BUYER]))
      .toEqual([{ phone: "+50765550001", pickup_address: FORM.address }]);
    expect((await notes(BUYER)).map((n) => n.kind)).toContain("shop_verified");
    await expect(review(STAFF, id, false)).rejects.toThrow(/not pending/);
  });

  it("rejecting tells the person and lets them send it again", async () => {
    const [{ id }] = await submit(ANA, { shop: "Ana Cards" });
    await review(STAFF, id, false, "No encontramos el local");
    expect(await profile(ANA)).toMatchObject({ is_shop: false, verified: false });
    expect((await notes(ANA)).map((n) => n.kind)).toContain("shop_rejected");
    const [{ id: again }] = await submit(ANA, { shop: "Ana Cards" });
    expect(again).not.toBe(id);
  });

  it("a shop verified before 0037 can sign the agreement; its store page and seller account stay as they were", async () => {
    const before = await profile(SHOP);
    const [{ id }] = await submit(SHOP, { shop: "Cartas Panamá", address: "Otra dirección, local 99" });
    await review(STAFF, id, true);
    expect(await profile(SHOP)).toEqual(before);
    expect(await db.q("select pickup_address from public.seller_accounts where user_id = $1", [SHOP]))
      .toEqual([{ pickup_address: "Vía España, edificio Plaza, local 4" }]);
    expect((await notes(SHOP)).map((n) => n.kind)).toContain("shop_agreement");
  });
});

describe("permissions", () => {
  it("only the person and staff read requests; nobody writes them directly", async () => {
    const select = await db.q<{ qual: string }>("select qual from pg_policies where tablename = 'shop_requests' and cmd = 'SELECT'");
    expect(select).toHaveLength(1);
    expect(select[0].qual).toMatch(/auth\.uid\(\)/);
    expect(select[0].qual).toMatch(/is_staff/);
    expect(await db.q("select 1 from pg_policies where tablename = 'shop_requests' and cmd <> 'SELECT'")).toEqual([]);
    expect(await db.one("select relrowsecurity as rls from pg_class where oid = 'public.shop_requests'::regclass")).toEqual({ rls: true });
  });

  it("internal helpers are not callable from the app", async () => {
    const grants = await db.q<{ fn: string }>(
      `select p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('ig_handle', 'shop_request_hash')
          and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))`);
    expect(grants).toEqual([]);
  });
});

// Shop sign-up with the agreement uploaded as a file (migration 0038).
describe("submit_shop_document", () => {
  const NEW_SHOP = "00000000-0000-4000-a000-000000000041";
  const OTHER = "00000000-0000-4000-a000-000000000042";
  const upload = (owner: string, name: string) =>
    db.q("insert into storage.objects (bucket_id, name, owner) values ('shop-agreements', $1, $2)", [name, owner]);
  const send = (who: string, path: string, shop = "Tienda Nueva") =>
    db.as<{ id: string }>(user(who), "select public.submit_shop_document($1, $2) as id", [shop, path]);

  beforeAll(async () => {
    await db.q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'nueva@x.test', '{"display_name": "Tienda Nueva", "account_type": "shop"}'),
                ($2, 'otra@x.test', '{"display_name": "Otra"}')`, [NEW_SHOP, OTHER]);
    await upload(NEW_SHOP, `${NEW_SHOP}/acuerdo.pdf`);
    await upload(OTHER, `${OTHER}/acuerdo.pdf`);
    await upload(NEW_SHOP, `${NEW_SHOP}/acuerdo.exe`);
  });

  it("only takes the person's own uploaded agreement", async () => {
    await expect(db.as(admin, "select public.submit_shop_document('Tienda', 'x/acuerdo.pdf')")).rejects.toThrow(/sign in/);
    await expect(send(NEW_SHOP, `${OTHER}/acuerdo.pdf`)).rejects.toThrow(/document/); // someone else's file
    await expect(send(NEW_SHOP, `${NEW_SHOP}/no-subido.pdf`)).rejects.toThrow(/document/); // never uploaded
    await expect(send(NEW_SHOP, `${NEW_SHOP}/acuerdo.exe`)).rejects.toThrow(/document/);
    await expect(send(NEW_SHOP, `${NEW_SHOP}/../${OTHER}/acuerdo.pdf`)).rejects.toThrow(/document/);
    await expect(send(NEW_SHOP, `${NEW_SHOP}/acuerdo.pdf`, "X")).rejects.toThrow(/shop name/);
  });

  it("leaves the account in review and tells staff; approving verifies it", async () => {
    const [{ id }] = await send(NEW_SHOP, `${NEW_SHOP}/acuerdo.pdf`);
    expect(await db.one("select status, document_path, shop_name from public.shop_requests where id = $1", [id]))
      .toEqual({ status: "pending", document_path: `${NEW_SHOP}/acuerdo.pdf`, shop_name: "Tienda Nueva" });
    expect(await profile(NEW_SHOP)).toMatchObject({ is_shop: false, verified: false });
    await expect(send(NEW_SHOP, `${NEW_SHOP}/acuerdo.pdf`)).rejects.toThrow(/already pending/);
    await review(STAFF, id, true);
    expect(await profile(NEW_SHOP)).toMatchObject({ is_shop: true, verified: true });
    // No phone or address in an uploaded agreement: the shop adds them in Mi cuenta before selling.
    expect(await db.q("select 1 from public.seller_accounts where user_id = $1", [NEW_SHOP])).toEqual([]);
  });

  it("the file can't point outside the owner's folder, and the bucket is private and append-only", async () => {
    await expect(db.q("update public.shop_requests set document_path = $1 where user_id = $2", [`${OTHER}/acuerdo.pdf`, NEW_SHOP]))
      .rejects.toThrow(/document_own_folder/);
    expect(await db.one("select public from storage.buckets where id = 'shop-agreements'")).toEqual({ public: false });
    const cmds = await db.q<{ cmd: string }>("select cmd from pg_policies where schemaname = 'storage' and policyname in ('shops upload own agreement', 'shops and staff read agreements') order by cmd");
    expect(cmds.map((c) => c.cmd)).toEqual(["INSERT", "SELECT"]);
  });
});

// A shop that signs up with the PDF gives its phone and store address (migration 0042).
describe("shop sign-up contact", () => {
  it("saves the phone and the store address as its seller account, and a shop without them still signs up", async () => {
    const WITH = "00000000-0000-4000-a000-000000000051", WITHOUT = "00000000-0000-4000-a000-000000000052";
    await db.q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'pdf@x.test', $3), ($2, 'digital@x.test', $4)`, [WITH, WITHOUT,
      { display_name: "Tienda PDF", account_type: "shop", shop_agreement: "pdf", seller_phone: "6555-7777", pickup_address: "Vía España, edificio Plaza, local 9, Bella Vista, Panamá, Panamá" },
      { display_name: "Tienda Digital", account_type: "shop", shop_agreement: "digital" }]);
    expect(await db.q("select phone, pickup_address from public.seller_accounts where user_id = $1", [WITH]))
      .toEqual([{ phone: "+50765557777", pickup_address: "Vía España, edificio Plaza, local 9, Bella Vista, Panamá, Panamá" }]);
    expect(await db.q("select 1 from public.seller_accounts where user_id = $1", [WITHOUT])).toEqual([]);
    expect(await db.q("select 1 from public.profiles where id = $1", [WITHOUT])).toHaveLength(1);
  });
});
