// Helpers that drive an order through migration 0029 on the test database, the way the page, the
// payment Edge Function, the courier and the jobs would. Shared by the tests and the local demo.
import { expect } from "vitest";
import { signYappyNotification } from "../../../../supabase/functions/_shared/payments/yappy-hash.ts";
import { admin, service, user, type TestDb } from "./db";

export const STAFF = "00000000-0000-4000-a000-000000000001";
export const SHOP = "00000000-0000-4000-a000-000000000002";
export const ANA = "00000000-0000-4000-a000-000000000003";
export const BUYER = "00000000-0000-4000-a000-000000000004";
export const LISTING = {
  charizard: "00000000-0000-4000-b000-000000000001", // shop, $120
  pikachu: "00000000-0000-4000-b000-000000000002", // shop, $450
  umbreon: "00000000-0000-4000-b000-000000000003", // Ana, $80
  wemby: "00000000-0000-4000-b000-000000000004", // Ana, $35
  gengar: "00000000-0000-4000-b000-000000000005", // Ana, $60
};

// Test-only secret in Yappy's format: base64("<hmac key>.<rest>").
export const TEST_SECRET = btoa("holo-test-key.0123456789");
export const TEST_DOMAIN = "https://holo.test";

export interface Order {
  id: string;
  status: string;
  price_cents: number;
  shipping_cents: number;
  seller_fee_cents: number;
  seller_itbms_cents: number;
  buyer_id: string;
  seller_id: string;
  listing_id: string;
}

export async function order(db: TestDb, id: string): Promise<Order> {
  return db.one<Order>("select * from public.protected_orders where id = $1", [id]);
}

export async function requestOrder(db: TestDb, listing: string, buyer = BUYER, pickup = false): Promise<Order> {
  return db.one<Order>("select * from public.request_order($1, $2)", [listing, pickup], user(buyer));
}

export async function sellerConfirm(db: TestDb, o: Order): Promise<void> {
  await db.as(user(o.seller_id), "select public.seller_confirm_order($1)", [o.id]);
}

export async function newAttempt(db: TestDb, o: Order, buyer = BUYER) {
  return db.one<{ a: { attempt_id: string; total_cents: number; purpose: string } }>(
    "select public.new_payment_attempt($1, 'mock') as a", [o.id], user(buyer)).then((r) => r.a);
}

/** What the payment Edge Function does after checking the hash: log + process once. */
export async function notify(db: TestDb, attempt: string, status: "E" | "R" | "C" | "X", valid = true): Promise<string> {
  const hash = await signYappyNotification(TEST_SECRET, attempt, status, TEST_DOMAIN);
  const r = await db.one<{ r: string }>(
    "select public.process_payment_notification($1, $2, $3, $4, $5, $6, null, 'mock') as r",
    [attempt, status, TEST_DOMAIN, hash, valid, status === "E" ? "CONF123" : null], service);
  return r.r;
}

export async function pay(db: TestDb, o: Order, buyer = BUYER) {
  const a = await newAttempt(db, o, buyer);
  expect(await notify(db, a.attempt_id, "E")).toBe("paid");
  return a;
}

/** Request → seller confirms → paid: the order is waiting for the seller to hand the card over. */
export async function paidOrder(db: TestDb, listing: string, opts: { buyer?: string; pickup?: boolean } = {}): Promise<Order> {
  const o = await requestOrder(db, listing, opts.buyer ?? BUYER, opts.pickup ?? false);
  await sellerConfirm(db, o);
  await pay(db, o, opts.buyer ?? BUYER);
  const p = await order(db, o.id);
  expect(p.status).toBe("esperando_entrega_vendedor");
  return p;
}

export async function addPhoto(db: TestDb, o: Order, stage: "recogida" | "entrega", side: "frente" | "reverso" | "otra") {
  await db.as(user(STAFF), "select public.staff_add_order_photo($1, $2, $3, $4)", [o.id, stage, side, `${o.id}/${stage}-${side}.jpg`]);
}

export async function pickup(db: TestDb, o: Order) {
  await addPhoto(db, o, "recogida", "frente");
  await addPhoto(db, o, "recogida", "reverso");
  await db.as(user(STAFF), "select public.staff_pickup($1)", [o.id]);
}

export async function deliveryCode(db: TestDb, o: Order): Promise<string> {
  return (await db.one<{ code: string }>("select code from public.order_delivery_codes where order_id = $1", [o.id])).code;
}

export async function deliver(db: TestDb, o: Order) {
  await db.as(user(STAFF), "select public.staff_out_for_delivery($1)", [o.id]);
  await addPhoto(db, o, "entrega", "otra");
  const r = await db.one<{ r: { ok: boolean } }>("select public.deliver_with_code($1, $2) as r", [o.id, await deliveryCode(db, o)], user(STAFF));
  expect(r.r.ok).toBe(true);
}

/** Moves a deadline into the past, as if the time had passed. */
export async function expire(db: TestDb, o: Order, column: string) {
  await db.q(`update public.protected_orders set ${column} = now() - interval '1 second' where id = $1`, [o.id]);
}

export async function runDeadlines(db: TestDb) {
  return (await db.one<{ r: Record<string, number> }>("select public.run_order_deadlines() as r", [], admin)).r;
}

export async function sellerBalance(db: TestDb, seller: string): Promise<number> {
  return Number((await db.one<{ b: string }>("select public.seller_ledger_balance($1) as b", [seller])).b);
}

export async function escrow(db: TestDb, o: Order): Promise<number> {
  return Number((await db.one<{ b: string }>("select public.order_escrow_cents($1) as b", [o.id])).b);
}

export async function accountBalance(db: TestDb, account: string): Promise<number> {
  return Number((await db.one<{ b: string }>(
    "select coalesce(sum(amount_cents), 0) as b from public.ledger_entries where account = $1", [account])).b);
}

/** The ledger's invariants: every transaction sums to zero, and so does the whole book. */
export async function expectLedgerBalanced(db: TestDb) {
  const bad = await db.q("select txn_id, sum(amount_cents) as s from public.ledger_entries group by txn_id having sum(amount_cents) <> 0");
  expect(bad).toEqual([]);
  const total = await db.one<{ s: string | null }>("select sum(amount_cents) as s from public.ledger_entries");
  expect(Number(total.s ?? 0)).toBe(0);
}

export async function history(db: TestDb, o: Order) {
  return db.q<{ from_status: string | null; to_status: string; actor_kind: string; reason: string | null }>(
    "select from_status, to_status, actor_kind, reason from public.order_status_history where order_id = $1 order by id", [o.id]);
}
