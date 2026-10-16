// Watchlist (migration 0032): each person keeps their own list of wanted cards. Row-level security
// is checked for real here: the queries run as Supabase's `authenticated` / `anon` roles.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb } from "./testing/db";

const STAFF = "00000000-0000-4000-a000-000000000001";
const SELLER = "00000000-0000-4000-a000-000000000003";
const BUYER = "00000000-0000-4000-a000-000000000004";

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
}, 60_000);
afterAll(() => db.close());

/** Runs `sql` as a page visitor: the `anon` role, or `authenticated` with that user's id. */
function asRole<T = Record<string, unknown>>(uid: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  const role = uid ? "authenticated" : "anon";
  return db.pg.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [uid ?? "", role]);
    await tx.exec(`set local role ${role}`);
    return (await tx.query<T>(sql, params)).rows;
  });
}
/** Inserts one row with these columns as `uid`. */
function add(uid: string, cols: Record<string, string | number | boolean | null>) {
  const keys = Object.keys(cols);
  return asRole(uid, `insert into public.watchlist (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(cols));
}

describe("watchlist", () => {
  it("a signed-in person adds a card (even one nobody sells) and reads it back", async () => {
    await asRole(BUYER, `insert into public.watchlist (category, name, catalog_id, set_name, number, ref_price_cents, image_url)
      values ('pokemon', '  Mew   ex ', 'sv4pt5-232', 'Paldean Fates', '232/091', 4550, 'https://images.pokemontcg.io/sv4pt5/232.png')`);
    const rows = await asRole<{ user_id: string; name: string; category: string; graded: boolean }>(BUYER, "select user_id, name, category, graded from public.watchlist");
    expect(rows).toEqual([{ user_id: BUYER, name: "Mew ex", category: "pokemon", graded: false }]);
  });

  it("nobody else can see, change or delete it", async () => {
    expect(await asRole(SELLER, "select id from public.watchlist")).toEqual([]);
    expect(await asRole(SELLER, "update public.watchlist set ref_price_cents = 1 returning id")).toEqual([]);
    expect(await asRole(SELLER, "delete from public.watchlist returning id")).toEqual([]);
    await expect(asRole(SELLER, "insert into public.watchlist (user_id, name) values ($1, 'Pikachu')", [BUYER])).rejects.toThrow(/row-level security/);
    await expect(asRole(null, "select id from public.watchlist")).rejects.toThrow(/permission denied/);
    await expect(asRole(null, "insert into public.watchlist (name) values ('Pikachu')")).rejects.toThrow(/permission denied/);
  });

  it("an update only refreshes the reference price, never swaps the card", async () => {
    const [row] = await asRole<{ name: string; ref_price_cents: number }>(BUYER,
      "update public.watchlist set ref_price_cents = 4800, name = 'Otra carta' where catalog_id = 'sv4pt5-232' returning name, ref_price_cents");
    expect(row).toEqual({ name: "Mew ex", ref_price_cents: 4800 });
  });

  it("each card once per person, raw and graded (by catalog id, else by name + number); others can add it too", async () => {
    await expect(add(BUYER, { name: "Mew ex", catalog_id: "sv4pt5-232" })).rejects.toThrow(/duplicate key/);
    expect(await add(BUYER, { name: "Mew ex", catalog_id: "sv4pt5-232", graded: true, grading_company: "PSA", grade: 10 })).toHaveLength(1);
    await expect(add(BUYER, { name: "Mew ex", catalog_id: "sv4pt5-232", graded: true, grading_company: "CGC", grade: 9.5 })).rejects.toThrow(/duplicate key/);
    await add(BUYER, { name: "Wembanyama Prizm 2023", category: null });
    await expect(add(BUYER, { name: "wembanyama prizm 2023" })).rejects.toThrow(/duplicate key/);
    expect(await add(SELLER, { name: "Mew ex", catalog_id: "sv4pt5-232" })).toHaveLength(1);
  });

  it("rejects bad data and stops at 100 cards per account", async () => {
    await expect(add(SELLER, { name: "X" })).rejects.toThrow(/check constraint/);
    await expect(add(SELLER, { name: "Pikachu", image_url: "javascript:alert(1)" })).rejects.toThrow(/check constraint/);
    await expect(add(SELLER, { name: "Pikachu", grading_company: "PSA", grade: 10 })).rejects.toThrow(/check constraint/);
    await expect(add(SELLER, { name: "Pikachu", graded: true, grading_company: "XYZ" })).rejects.toThrow(/check constraint/);
    await db.q(`insert into public.watchlist (user_id, name, catalog_id) select $1, 'Carta ' || g, 'test-' || g from generate_series(1, 99) g`, [SELLER]);
    expect((await asRole<{ n: number }>(SELLER, "select count(*)::int as n from public.watchlist"))[0]).toEqual({ n: 100 });
    await expect(add(SELLER, { name: "Una más", catalog_id: "test-100" })).rejects.toThrow(/limit 100/);
  });
});

// "Lo más buscado" for staff (migration 0034): counts per card, never who wants it.
describe("watchlist_summary", () => {
  it("staff see the most wanted cards and how many are on sale; nobody else can call it", async () => {
    // Charizard ex 199/165 (sv3pt5-199) is wanted by two people; the seed has no listing with that catalog id.
    await asRole(BUYER, "insert into public.watchlist (name, catalog_id, set_name, number) values ('Charizard ex', 'sv3pt5-199', '151', '199/165')");
    await db.q("insert into public.watchlist (user_id, name, catalog_id) values ($1, 'Charizard ex', 'sv3pt5-199')", [STAFF]);
    const rows = await db.as<{ catalog_id: string; people: string; on_sale: string }>({ kind: "user", id: STAFF }, "select catalog_id, people, on_sale from public.watchlist_summary(10)");
    const charizard = rows.find((r) => r.catalog_id === "sv3pt5-199");
    expect(Number(charizard?.people)).toBe(2);
    expect(Number(charizard?.on_sale)).toBe(0);
    // Most wanted first.
    expect(rows.map((r) => Number(r.people))).toEqual([...rows.map((r) => Number(r.people))].sort((a, b) => b - a));
    // Once someone lists it, it counts as on sale.
    await db.q("update public.listings set catalog_id = 'sv3pt5-199' where id = '00000000-0000-4000-b000-000000000001'");
    const [again] = await db.as<{ on_sale: string }>({ kind: "user", id: STAFF }, "select on_sale from public.watchlist_summary(10) where catalog_id = 'sv3pt5-199'");
    expect(Number(again.on_sale)).toBe(1);
    await expect(db.as({ kind: "user", id: BUYER }, "select * from public.watchlist_summary()")).rejects.toThrow(/staff only/);
  });
});
