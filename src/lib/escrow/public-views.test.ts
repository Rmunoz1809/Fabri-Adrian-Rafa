// Public views (public_profiles, public_collection, …) are deliberately not security_invoker, so they
// skip RLS. Simple views are auto-updatable and Supabase grants ALL on new objects, so any write
// privilege left on them lets anyone change other people's rows. 0010 fixed this for public_profiles.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, user } from "./testing/db";

const ANA = "00000000-0000-4000-a000-000000000003";
const BETO = "00000000-0000-4000-a000-000000000004";

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
}, 60_000);
afterAll(() => db.close());

describe("public views are read-only for anon and authenticated", () => {
  it("no view in public grants insert, update or delete", async () => {
    const writable = await db.q<{ view: string; role: string; priv: string }>(`
      select v.table_name as view, r.role, p.priv
        from information_schema.views v
        cross join (values ('anon'), ('authenticated')) r(role)
        cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
       where v.table_schema = 'public'
         and has_table_privilege(r.role, format('public.%I', v.table_name), p.priv)
       order by 1, 2, 3`);
    expect(writable).toEqual([]);
  });

  it("someone else can read a public card but not change or delete it", async () => {
    const [{ id }] = await db.as<{ id: string }>(user(ANA),
      "insert into public.portfolio_items (user_id, subject, value_cents, is_public) values ($1, 'Mewtwo', 5000, true) returning id", [ANA]);
    const seen = await db.asRole<{ subject: string }>(user(BETO), "select subject from public.public_collection where id = $1", [id]);
    expect(seen).toEqual([{ subject: "Mewtwo" }]);

    await expect(db.asRole(user(BETO), "update public.public_collection set value_cents = 1 where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(db.asRole(user(BETO), "delete from public.public_collection where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(db.asRole({ kind: "anon" }, "delete from public.public_collection where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(db.asRole(user(BETO), "insert into public.public_collection (user_id, subject) values ($1, 'Falsa')", [ANA])).rejects.toThrow(/permission denied/);

    const row = await db.one<{ value_cents: number }>("select value_cents from public.portfolio_items where id = $1", [id]);
    expect(row.value_cents).toBe(5000);
  });
});
