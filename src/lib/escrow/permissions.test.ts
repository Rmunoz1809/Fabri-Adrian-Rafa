// Grants (migration 0029): the page's roles can call the RPCs meant for them and none of the
// internal helpers that move money or change status without the checks.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb } from "./testing/db";

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create({ seed: true });
}, 60_000);
afterAll(() => db.close());

async function canExecute(role: string, fn: string): Promise<boolean> {
  const r = await db.q<{ ok: boolean }>(
    `select bool_or(has_function_privilege($1, p.oid, 'EXECUTE')) as ok from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $2`, [role, fn]);
  return r[0].ok;
}

const INTERNAL = [
  "ledger_post", "order_move", "post_charge", "post_completion", "request_refund", "complete_order", "order_paid",
  "order_delivered", "penalize_no_delivery", "record_wrong_code", "check_delivery_code", "staff_confirm_delivery",
  "process_payment_notification", "confirm_payment", "seller_ledger_balance", "order_escrow_cents", "setting_int",
];
const USER_RPCS = [
  "request_order", "seller_confirm_order", "seller_decline_order", "buyer_cancel_order", "new_payment_attempt",
  "buyer_confirm_received", "buyer_open_dispute", "deliver_with_code", "my_orders", "my_seller_balance",
  "staff_orders", "staff_resolve_dispute", "staff_mark_refund_paid", "staff_mark_payout_paid", "run_order_deadlines",
];

describe("function grants", () => {
  it("anon and authenticated can't call the internal helpers", async () => {
    for (const fn of INTERNAL) {
      expect.soft(await canExecute("anon", fn), `anon → ${fn}`).toBe(false);
      expect.soft(await canExecute("authenticated", fn), `authenticated → ${fn}`).toBe(false);
    }
  });

  it("only the service role processes payment notifications", async () => {
    expect(await canExecute("service_role", "process_payment_notification")).toBe(true);
  });

  it("signed-in users can call the RPCs (each one checks who may act); anon can't", async () => {
    for (const fn of USER_RPCS) {
      expect.soft(await canExecute("authenticated", fn), `authenticated → ${fn}`).toBe(true);
      expect.soft(await canExecute("anon", fn), `anon → ${fn}`).toBe(false);
    }
  });

  it("an authenticated session really is refused", async () => {
    await expect(db.pg.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.query(`select public.ledger_post(null, '[]'::jsonb)`);
    })).rejects.toThrow(/permission denied/);
  });
});
