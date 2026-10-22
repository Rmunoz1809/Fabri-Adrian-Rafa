// Test database: every migration in supabase/migrations on PGlite (Postgres compiled to WASM, no
// Docker), on top of a small stand-in for Supabase's auth, storage and cron schemas.
// Used by the escrow tests and by `npm run demo:flujo`. Never points at a real Supabase project.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

// 0015 is never run: 0016 replaces it (docs/decisions.md, 2026-09-30).
const SKIP = new Set(["0015_seller_commission.sql"]);

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql") && !SKIP.has(f))
    .sort();
}

export type Actor =
  | { kind: "admin" } // SQL editor / service role: no user id
  | { kind: "service" }
  | { kind: "user"; id: string };

export class TestDb {
  private constructor(readonly pg: PGlite) {}

  /** All migrations (or those before `stopBefore`, e.g. "0029"), then optionally the seed. */
  static async create(opts: { seed?: boolean; stopBefore?: string } = {}): Promise<TestDb> {
    const pg = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
    await pg.exec(readFileSync(join(ROOT, "supabase", "tests", "supabase_shim.sql"), "utf8"));
    const db = new TestDb(pg);
    for (const f of migrationFiles()) {
      if (opts.stopBefore && f >= opts.stopBefore) break;
      await db.migrate(f);
    }
    if (opts.seed) await pg.exec(readFileSync(join(ROOT, "supabase", "seed_escrow.sql"), "utf8"));
    return db;
  }

  async migrate(file: string) {
    try {
      await this.pg.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    } catch (e) {
      throw new Error(`migration ${file} failed: ${(e as Error).message}`);
    }
  }

  /** Runs `sql` as `actor` (sets the JWT claims auth.uid()/auth.role() read) and returns the rows. */
  async as<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
    return this.pg.transaction(async (tx) => {
      const sub = actor.kind === "user" ? actor.id : "";
      const role = actor.kind === "user" ? "authenticated" : actor.kind === "service" ? "service_role" : "";
      await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [sub, role]);
      const r = await tx.query<T>(sql, params);
      return r.rows;
    });
  }

  /**
   * Like `as`, but also switches to the Postgres role the request would really have (anon or
   * authenticated), so table privileges and RLS apply. `as` keeps the superuser, which bypasses both.
   */
  async asRole<T = Record<string, unknown>>(actor: Actor | { kind: "anon" }, sql: string, params: unknown[] = []): Promise<T[]> {
    return this.pg.transaction(async (tx) => {
      const sub = actor.kind === "user" ? actor.id : "";
      const role = actor.kind === "user" ? "authenticated" : actor.kind === "anon" ? "anon" : "service_role";
      await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [sub, role]);
      await tx.query(`set local role ${role}`);
      const r = await tx.query<T>(sql, params);
      return r.rows;
    });
  }

  /** Same as `as`, for the SQL editor (admin context). */
  async q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.as<T>({ kind: "admin" }, sql, params);
  }

  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = [], actor: Actor = { kind: "admin" }): Promise<T> {
    const rows = await this.as<T>(actor, sql, params);
    if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}: ${sql}`);
    return rows[0];
  }

  async close() {
    await this.pg.close();
  }
}

export const user = (id: string): Actor => ({ kind: "user", id });
export const admin: Actor = { kind: "admin" };
export const service: Actor = { kind: "service" };
