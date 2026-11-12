import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { TEMPLATE_DB } from "./db";

/** Builds an empty SQLite database from the Prisma schema once; each test file copies it. */
export default function setup() {
  rmSync(TEMPLATE_DB, { force: true });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
    env: { ...process.env, DATABASE_URL: `file:${TEMPLATE_DB}` },
    stdio: "pipe",
  });
}
