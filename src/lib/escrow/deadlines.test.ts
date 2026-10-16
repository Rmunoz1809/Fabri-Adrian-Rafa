// run_order_deadlines() (pg_cron every 5 minutes): each deadline, the reminders before them, the
// progressive penalties for sellers who don't deliver, and the staff alerts.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TestDb, user } from "./testing/db";
import {
  ANA, LISTING, SHOP, STAFF, accountBalance, deliver, expectLedgerBalanced, expire, newAttempt, order,
  paidOrder, pickup, requestOrder, runDeadlines, sellerBalance, sellerConfirm,
} from "./testing/flow";

let db: TestDb;
beforeEach(async () => {
  await db?.close();
  db = await TestDb.create({ seed: true });
}, 60_000);
afterAll(() => db.close());

const notifications = (to: string, kind: string) =>
  db.q("select title, body from public.notifications where user_id = $1 and kind = $2", [to, kind]);

describe("deadlines", () => {
  it("seller doesn't confirm in 2 hours → cancelada, no charge; the card can be ordered again", async () => {
    const o = await requestOrder(db, LISTING.umbreon);
    expect(await runDeadlines(db)).toMatchObject({ seller_confirm_expired: 0 });
    await expire(db, o, "seller_confirm_deadline");
    expect(await runDeadlines(db)).toMatchObject({ seller_confirm_expired: 1 });
    expect((await order(db, o.id)).status).toBe("cancelada");
    expect(await db.q("select 1 from public.payment_attempts where order_id = $1", [o.id])).toHaveLength(0);
    expect((await requestOrder(db, LISTING.umbreon, SHOP)).status).toBe("esperando_confirmacion_vendedor");
  });

  it("payment not completed in time → fallida, listing still on sale", async () => {
    const o = await requestOrder(db, LISTING.umbreon);
    await sellerConfirm(db, o);
    await expire(db, o, "payment_deadline");
    expect(await runDeadlines(db)).toMatchObject({ payment_expired: 1 });
    expect((await order(db, o.id)).status).toBe("fallida");
    const l = await db.one<{ status: string }>("select status from public.listings where id = $1", [LISTING.umbreon]);
    expect(l.status).toBe("active");
  });

  it("a payment started at the last moment gets a grace period before failing", async () => {
    const o = await requestOrder(db, LISTING.umbreon);
    await sellerConfirm(db, o);
    await newAttempt(db, o);
    await expire(db, o, "payment_deadline");
    expect(await runDeadlines(db)).toMatchObject({ payment_expired: 0 });
    await db.q("update public.payment_attempts set created_at = now() - interval '3 minutes' where order_id = $1", [o.id]);
    expect(await runDeadlines(db)).toMatchObject({ payment_expired: 1 });
  });

  it("seller doesn't deliver in 48 h → cancelada, full refund, warning and listings paused", async () => {
    const o = await paidOrder(db, LISTING.umbreon);
    await expire(db, o, "delivery_deadline");
    expect(await runDeadlines(db)).toMatchObject({ delivery_expired: 1 });
    expect((await order(db, o.id)).status).toBe("cancelada");
    const refund = await db.one<{ amount_cents: number }>("select amount_cents from public.refund_requests where order_id = $1", [o.id]);
    expect(refund.amount_cents).toBe(8400); // includes shipping
    const pen = await db.one<{ level: string; amount_cents: number }>("select level, amount_cents from public.seller_penalties where seller_id = $1", [ANA]);
    expect(pen).toEqual({ level: "advertencia", amount_cents: 0 }); // a person, not a shop: no fine
    const paused = await db.q<{ status: string }>("select status from public.listings where seller_id = $1 and paused_by_penalty", [ANA]);
    expect(paused.length).toBe(3);
    expect(paused.every((l) => l.status === "draft")).toBe(true);
    expect(await notifications(ANA, "seller_penalty")).toHaveLength(1);
    // Can't re-publish while paused.
    await expect(db.as(user(ANA), "update public.listings set status = 'active' where id = $1", [LISTING.gengar])).rejects.toThrow(/paus|blocked/);
    // When the pause ends, the job puts them back.
    await db.q("update public.profiles set selling_blocked_until = now() - interval '1 second' where id = $1", [ANA]);
    await runDeadlines(db);
    const back = await db.q("select 1 from public.listings where seller_id = $1 and status = 'active'", [ANA]);
    expect(back.length).toBe(3);
    await expectLedgerBalanced(db);
  });

  it("penalties escalate: warning → suspension → ban", async () => {
    const levels: string[] = [];
    for (const listing of [LISTING.umbreon, LISTING.wemby, LISTING.gengar]) {
      await db.q("update public.profiles set selling_blocked_until = null where id = $1", [ANA]);
      await db.q("update public.listings set status = 'active', paused_by_penalty = false where seller_id = $1 and status <> 'removed'", [ANA]);
      const o = await paidOrder(db, listing);
      await expire(db, o, "delivery_deadline");
      await runDeadlines(db);
      levels.push((await db.one<{ level: string }>("select level from public.seller_penalties where order_id = $1", [o.id])).level);
    }
    expect(levels).toEqual(["advertencia", "suspension", "expulsion"]);
    const p = await db.one<{ banned: boolean }>("select banned_at is not null as banned from public.profiles where id = $1", [ANA]);
    expect(p.banned).toBe(true);
    const live = await db.q("select 1 from public.listings where seller_id = $1 and status in ('active', 'draft')", [ANA]);
    expect(live).toHaveLength(0);
  });

  it("a verified shop that doesn't deliver also pays a fine, taken from its next payouts", async () => {
    const o = await paidOrder(db, LISTING.charizard);
    await expire(db, o, "delivery_deadline");
    await runDeadlines(db);
    const pen = await db.one<{ amount_cents: number }>("select amount_cents from public.seller_penalties where order_id = $1", [o.id]);
    expect(pen.amount_cents).toBe(500);
    expect(await sellerBalance(db, SHOP)).toBe(-500);
    expect(await accountBalance(db, "holo_penalizaciones")).toBe(-500);
    // Next completed sale: the payout is the sale minus the fine.
    await db.q("update public.profiles set selling_blocked_until = null where id = $1", [SHOP]);
    await db.q("update public.listings set status = 'active', paused_by_penalty = false where id = $1", [LISTING.pikachu]);
    const o2 = await paidOrder(db, LISTING.pikachu);
    await pickup(db, o2);
    await deliver(db, o2);
    await expire(db, o2, "review_deadline");
    await runDeadlines(db);
    await db.as(user(STAFF), "select public.prepare_weekly_payouts()");
    const payout = await db.one<{ amount_cents: number }>("select amount_cents from public.payouts where seller_id = $1", [SHOP]);
    expect(payout.amount_cents).toBe(45000 - 2250 - 158 - 500);
    await expectLedgerBalanced(db);
  });

  it("review window ends without a dispute → completada", async () => {
    const o = await paidOrder(db, LISTING.umbreon);
    await pickup(db, o);
    await deliver(db, o);
    expect(await runDeadlines(db)).toMatchObject({ review_completed: 0 });
    await expire(db, o, "review_deadline");
    expect(await runDeadlines(db)).toMatchObject({ review_completed: 1 });
    expect((await order(db, o.id)).status).toBe("completada");
    expect(await sellerBalance(db, ANA)).toBe(8000 - 400 - 28);
    expect(await notifications(ANA, "order_released")).toHaveLength(1);
  });
});

describe("reminders", () => {
  it("reminds the seller once before the confirmation and the delivery deadlines", async () => {
    const o = await requestOrder(db, LISTING.umbreon);
    expect(await runDeadlines(db)).toMatchObject({ reminders: 0 });
    await db.q("update public.protected_orders set seller_confirm_deadline = now() + interval '10 minutes' where id = $1", [o.id]);
    expect(await runDeadlines(db)).toMatchObject({ reminders: 1 });
    expect(await runDeadlines(db)).toMatchObject({ reminders: 0 }); // only once
    expect(await notifications(ANA, "remind_confirm")).toHaveLength(1);

    await sellerConfirm(db, o);
    const a = await newAttempt(db, o);
    await db.q("select public.process_payment_notification($1, 'E', null, null, true)", [a.attempt_id]);
    await db.q("update public.protected_orders set delivery_deadline = now() + interval '6 hours' where id = $1", [o.id]);
    expect(await runDeadlines(db)).toMatchObject({ reminders: 1 });
    expect(await notifications(ANA, "remind_delivery")).toHaveLength(1);
  });

  it("deadlines and reminders come from the settings", async () => {
    await db.as(user(STAFF), "select public.staff_set_setting('seller_confirm_minutes', 30)");
    const o = await requestOrder(db, LISTING.umbreon);
    const d = await db.one<{ m: number }>(
      "select round(extract(epoch from seller_confirm_deadline - created_at) / 60)::int as m from public.protected_orders where id = $1", [o.id]);
    expect(d.m).toBe(30);
    // 30-minute reminder lead with a 30-minute window: due right away.
    expect(await runDeadlines(db)).toMatchObject({ reminders: 1 });
  });
});

describe("staff alerts", () => {
  it("flags orders stuck longer than expected", async () => {
    const o = await paidOrder(db, LISTING.umbreon);
    await pickup(db, o);
    await db.q("update public.protected_orders set status_changed_at = now() - interval '3 days' where id = $1", [o.id]);
    const a = await db.as<{ kind: string; detail: string }>(user(STAFF), "select kind, detail from public.staff_alerts() where order_id = $1", [o.id]);
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("atascada");
    expect(a[0].detail).toMatch(/en_custodia hace 72 h \(esperado: 48 h\)/);
  });

  it("flags the same buyer and seller trading repeatedly", async () => {
    for (const l of [LISTING.umbreon, LISTING.wemby, LISTING.gengar]) await paidOrder(db, l);
    const a = await db.as<{ kind: string; detail: string }>(user(STAFF), "select kind, detail from public.staff_alerts() where kind = 'repetida'");
    expect(a).toHaveLength(1);
    expect(a[0].detail).toContain("Beto Comprador");
    expect(a[0].detail).toContain("Ana Vendedora");
  });
});
