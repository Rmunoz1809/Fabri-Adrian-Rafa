// Public collection and "Me interesa" (migration 0036): what everyone sees of a portfolio, who can mark
// interest, and the owner's counts (never who).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, user } from "./testing/db";

const TIENDA = "00000000-0000-4000-a000-000000000002";
const ANA = "00000000-0000-4000-a000-000000000003";
const BETO = "00000000-0000-4000-a000-000000000004";
const LISTING = "00000000-0000-4000-b000-000000000001"; // TIENDA's Charizard, active

let db: TestDb;
let pub: string, priv: string;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
  [{ id: pub }] = await db.as<{ id: string }>(user(ANA),
    `insert into public.portfolio_items (user_id, subject, catalog_id, paid_cents, note, photo_path, value_cents, is_public)
     values ($1, 'Umbreon VMAX', 'swsh7-215', 150000, 'La compré en la feria', $2, 229994, true) returning id`, [ANA, `${ANA}/scan.jpg`]);
  [{ id: priv }] = await db.as<{ id: string }>(user(ANA),
    "insert into public.portfolio_items (user_id, subject) values ($1, 'Carta privada') returning id", [ANA]);
}, 60_000);
afterAll(() => db.close());

describe("public_collection", () => {
  it("shows only public cards, without what was paid, the note or the photo", async () => {
    const rows = await db.q<Record<string, unknown>>("select * from public.public_collection where user_id = $1", [ANA]);
    expect(rows.map((r) => r.subject)).toEqual(["Umbreon VMAX"]);
    expect(rows[0]).not.toHaveProperty("paid_cents");
    expect(rows[0]).not.toHaveProperty("note");
    expect(rows[0]).not.toHaveProperty("photo_path");
    expect(rows[0]).not.toHaveProperty("value_log");
    expect(rows[0].value_cents).toBe(229994);
  });
});

describe("card_interests", () => {
  it("anyone signed in marks a public card or a listing on sale; the owner is filled in", async () => {
    const [a] = await db.as<{ owner_id: string }>(user(BETO),
      "insert into public.card_interests (user_id, portfolio_item_id, owner_id) values ($1, $2, $1) returning owner_id", [BETO, pub]);
    expect(a.owner_id).toBe(ANA);
    const [b] = await db.as<{ owner_id: string }>(user(ANA),
      "insert into public.card_interests (user_id, listing_id, owner_id) values ($1, $2, $1) returning owner_id", [ANA, LISTING]);
    expect(b.owner_id).toBe(TIENDA);
    await db.as(user(TIENDA), "insert into public.card_interests (user_id, portfolio_item_id, owner_id) values ($1, $2, $1)", [TIENDA, pub]);
  });

  it("refuses private cards, your own cards, cards off sale, both or none, and twice the same", async () => {
    const ins = (who: string, item: string | null, listing: string | null = null) => db.as(user(who),
      "insert into public.card_interests (user_id, portfolio_item_id, listing_id, owner_id) values ($1, $2, $3, $1)", [who, item, listing]);
    await expect(ins(BETO, priv)).rejects.toThrow(/not available/);
    await expect(ins(ANA, pub)).rejects.toThrow(/own card/);
    await expect(ins(BETO, pub)).rejects.toThrow(/card_interests_item_uq|duplicate/);
    await expect(ins(BETO, pub, LISTING)).rejects.toThrow(/one_card/);
    await expect(ins(BETO, null, null)).rejects.toThrow(/one_card|not available/);
    await db.q("update public.listings set status = 'sold' where id = $1", [LISTING]);
    await expect(ins(BETO, null, LISTING)).rejects.toThrow(/not available/);
    await db.q("update public.listings set status = 'active' where id = $1", [LISTING]);
  });

  it("the owner gets counts per card and people in total, never who", async () => {
    const mine = await db.one<{ r: { people: number; cards: { portfolio_item_id: string; people: number }[] } }>(
      "select public.my_card_interests() as r", [], user(ANA));
    expect(mine.r.people).toBe(2);
    expect(mine.r.cards).toHaveLength(1);
    expect(mine.r.cards[0]).toMatchObject({ portfolio_item_id: pub, listing_id: null, people: 2 });
    expect(JSON.stringify(mine.r)).not.toContain(BETO);
    const shop = await db.one<{ r: { people: number; cards: { listing_id: string; people: number }[] } }>(
      "select public.my_card_interests() as r", [], user(TIENDA));
    expect(shop.r).toMatchObject({ people: 1, cards: [{ listing_id: LISTING, people: 1 }] });
    const nobody = await db.one<{ r: unknown }>("select public.my_card_interests() as r", [], user(BETO));
    expect(nobody.r).toEqual({ people: 0, cards: [] });
  });

  it("each person reads and deletes only their own marks; nobody updates them (RLS)", async () => {
    const policies = await db.q<{ cmd: string; qual: string | null; with_check: string | null }>(
      "select cmd, qual, with_check from pg_policies where tablename = 'card_interests' order by cmd");
    expect(policies.map((p) => p.cmd)).toEqual(["DELETE", "INSERT", "SELECT"]);
    for (const p of policies) expect(`${p.qual ?? ""} ${p.with_check ?? ""}`).toMatch(/user_id = auth\.uid\(\)/);
    const grants = await db.q<{ grantee: string }>(
      "select grantee from information_schema.routine_privileges where routine_name = 'my_card_interests' and grantee in ('anon', 'authenticated')");
    expect(grants.map((g) => g.grantee)).toEqual(["authenticated"]);
  });

  it("removing the card removes its marks", async () => {
    await db.q("delete from public.portfolio_items where id = $1", [pub]);
    const left = await db.q("select 1 from public.card_interests where portfolio_item_id = $1", [pub]);
    expect(left).toHaveLength(0);
  });
});

describe("supabase/seed_coleccion_ejemplo.sql", () => {
  const seed = readFileSync(join(__dirname, "..", "..", "..", "supabase", "seed_coleccion_ejemplo.sql"), "utf8")
    .replace("TU_CORREO@ejemplo.com", "tienda@holo.test");

  it("gives the account 7 public example cards and 8 example people interested, and can run again", async () => {
    for (let run = 0; run < 2; run++) {
      await db.q(seed);
      const mine = await db.one<{ r: { people: number; cards: { portfolio_item_id: string | null; listing_id: string | null; people: number }[] } }>(
        "select public.my_card_interests() as r", [], user(TIENDA));
      expect(mine.r.people).toBe(9); // the 8 example accounts + ANA, who marked TIENDA's listing above
      const cards = mine.r.cards.filter((c) => c.portfolio_item_id);
      expect(cards.map((c) => c.people)).toEqual([8, 6, 5, 4, 3, 2, 1]);
      // TIENDA's cards on sale get people too (LISTING also has ANA's real mark from the tests above).
      expect(mine.r.cards.filter((c) => c.listing_id).length).toBeGreaterThan(0);
      expect(mine.r.cards.find((c) => c.listing_id === LISTING)?.people).toBeGreaterThanOrEqual(2);
      const shown = await db.q("select 1 from public.public_collection where user_id = $1", [TIENDA]);
      expect(shown).toHaveLength(7);
      const old = await db.one<{ days: number }>(
        "select extract(day from now() - min(created_at))::int as days from public.portfolio_items where user_id = $1", [TIENDA]);
      expect(old.days).toBe(60);
    }
    // The guards are back on after the seed.
    await expect(db.as(user(TIENDA), "insert into public.card_interests (user_id, listing_id) values ($1, $2)", [TIENDA, LISTING])).rejects.toThrow(/own card/);
  });

  it("refuses an email with no account", async () => {
    await expect(db.q(seed.replace("tienda@holo.test", "nadie@holo.test"))).rejects.toThrow(/No hay ninguna cuenta/);
  });
});
