// Mi portafolio (migration 0033): private per account, owner can't be changed, 500 cards max.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, user } from "./testing/db";

const ANA = "00000000-0000-4000-a000-000000000003";
const BETO = "00000000-0000-4000-a000-000000000004";

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
}, 60_000);
afterAll(() => db.close());

describe("portfolio_items", () => {
  it("keeps a card with its value and cleans the name", async () => {
    const row = await db.one<{ subject: string; quantity: number; value_cents: number }>(
      `insert into public.portfolio_items (user_id, subject, set_name, number, catalog_id, value_cents, image_url)
       values ($1, '  Charizard   ex ', '151', '199/165', 'sv3pt5-199', 41250, 'https://images.pokemontcg.io/sv3pt5/199_hires.png')
       returning subject, quantity, value_cents`, [ANA], user(ANA));
    expect(row).toEqual({ subject: "Charizard ex", quantity: 1, value_cents: 41250 });
  });

  it("refuses links that are not https and grades out of range", async () => {
    await expect(db.as(user(ANA), "insert into public.portfolio_items (user_id, subject, image_url) values ($1, 'X', 'javascript:alert(1)')", [ANA])).rejects.toThrow();
    await expect(db.as(user(ANA), "insert into public.portfolio_items (user_id, subject, grading_company, grade) values ($1, 'X', 'PSA', 11)", [ANA])).rejects.toThrow();
  });

  it("photo paths stay in the owner's folder; the bucket is private", async () => {
    await expect(db.as(user(ANA), "insert into public.portfolio_items (user_id, subject, photo_path) values ($1, 'X', $2)", [ANA, `${BETO}/x.jpg`])).rejects.toThrow(/own_folder/);
    await db.as(user(ANA), "insert into public.portfolio_items (user_id, subject, photo_path) values ($1, 'Con foto', $2)", [ANA, `${ANA}/scan-1.jpg`]);
    const bucket = await db.one<{ public: boolean }>("select public from storage.buckets where id = 'portfolio-photos'");
    expect(bucket.public).toBe(false);
    await db.q("delete from public.portfolio_items where subject = 'Con foto'");
  });

  it("an update can't move a card to another account", async () => {
    await db.as(user(ANA), "update public.portfolio_items set user_id = $1, quantity = 2 where user_id = $2", [BETO, ANA]);
    const rows = await db.q<{ user_id: string; quantity: number }>("select user_id, quantity from public.portfolio_items");
    expect(rows).toEqual([{ user_id: ANA, quantity: 2 }]);
  });

  it("only the owner can read, change or delete (RLS)", async () => {
    const policies = await db.q<{ cmd: string; qual: string | null; with_check: string | null }>(
      "select cmd, qual, with_check from pg_policies where tablename = 'portfolio_items' order by cmd");
    expect(policies.map((p) => p.cmd)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    for (const p of policies) expect(`${p.qual ?? ""} ${p.with_check ?? ""}`).toMatch(/auth\.uid\(\)/);
  });

  it("stops at 500 cards per account", async () => {
    await db.q("insert into public.portfolio_items (user_id, subject) select $1, 'Carta ' || g from generate_series(1, 500) g", [BETO]);
    await expect(db.as(user(BETO), "insert into public.portfolio_items (user_id, subject) values ($1, 'Una más')", [BETO])).rejects.toThrow(/limit 500/);
  });
});
