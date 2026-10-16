// Consultas (migration 0030): a signed-in person records a consulta and gets a code for WhatsApp;
// only they and staff can read it, and only staff move it along.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, admin, user } from "./testing/db";

const STAFF = "00000000-0000-4000-a000-000000000001";
const SELLER = "00000000-0000-4000-a000-000000000003";
const BUYER = "00000000-0000-4000-a000-000000000004";
const LISTING = "00000000-0000-4000-b000-000000000001"; // Charizard ex, $120

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
}, 60_000);
afterAll(() => db.close());

const create = (actor: ReturnType<typeof user>, args: string, params: unknown[] = []) =>
  db.one<{ code: string }>(`select public.create_inquiry(${args}) as code`, params, actor);

describe("create_inquiry", () => {
  it("records a consulta about a listing with the listing's own title and price", async () => {
    const { code } = await create(user(BUYER), "p_listing_id => $1, p_subject => 'whatever', p_price_cents => 1", [LISTING]);
    expect(code).toMatch(/^MZ-[2-9A-HJ-NP-Z]{6}$/);
    const row = await db.one<{ subject: string; price_cents: number; source: string; status: string; user_id: string }>(
      "select subject, price_cents, source, status, user_id from public.inquiries where code = $1", [code]);
    expect(row).toEqual({ subject: "Charizard ex 199/165 SIR", price_cents: 12000, source: "carta", status: "nueva", user_id: BUYER });
  });

  it("records a card that is not on sale (watchlist) with the page's name and reference price", async () => {
    const { code } = await create(user(BUYER), "p_source => 'watchlist', p_subject => 'Mew ex 232/091', p_price_cents => 4550, p_catalog_ref => 'sv4pt5-232'");
    const row = await db.one<{ listing_id: string | null; catalog_ref: string }>("select listing_id, catalog_ref from public.inquiries where code = $1", [code]);
    expect(row).toEqual({ listing_id: null, catalog_ref: "sv4pt5-232" });
  });

  it("needs a session, a subject and a valid phone", async () => {
    await expect(db.as(admin, "select public.create_inquiry(p_subject => 'Algo')")).rejects.toThrow(/sign in/);
    await expect(create(user(BUYER), "p_subject => ' '")).rejects.toThrow(/subject/);
    await expect(create(user(BUYER), "p_subject => 'Algo', p_contact_phone => 'llámame'")).rejects.toThrow(/phone/);
    const { code } = await create(user(BUYER), "p_source => 'general', p_subject => 'Pregunta general', p_contact_phone => '+507 6123-4567'");
    expect(code).toMatch(/^MZ-/);
  });

  it("only the person who asked and staff can see it", async () => {
    const mine = await db.as(user(BUYER), "select count(*)::int as n from public.inquiries where user_id = $1", [BUYER]);
    expect(mine[0]).toEqual({ n: 3 });
    const policy = await db.q<{ qual: string }>("select qual from pg_policies where tablename = 'inquiries' and cmd = 'SELECT'");
    expect(policy[0].qual).toMatch(/auth\.uid\(\)/);
    expect(policy[0].qual).toMatch(/is_staff/);
  });
});

describe("staff_update_inquiry", () => {
  it("staff move a consulta along; nobody else can", async () => {
    const { code } = await create(user(BUYER), "p_listing_id => $1", [LISTING]);
    const { id } = await db.one<{ id: string }>("select id from public.inquiries where code = $1", [code]);
    await expect(db.as(user(SELLER), "select public.staff_update_inquiry($1, 'cerrada')", [id])).rejects.toThrow(/staff only/);
    await db.as(user(STAFF), "select public.staff_update_inquiry($1, 'en_curso', 'Le escribimos por WhatsApp')", [id]);
    const row = await db.one<{ status: string; staff_note: string; handled_by: string }>(
      "select status, staff_note, handled_by from public.inquiries where id = $1", [id]);
    expect(row).toEqual({ status: "en_curso", staff_note: "Le escribimos por WhatsApp", handled_by: STAFF });
  });
});
