// Payment provider: Yappy V2 hash verification, the mock, and the IPN endpoint (logged, idempotent),
// run end to end against the test database through the same handler the Edge Function uses.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPaymentHandler, providerFromEnv, type HandlerDeps } from "../../../supabase/functions/_shared/payments/handler.ts";
import { YappyMockProvider } from "../../../supabase/functions/_shared/payments/mock.ts";
import {
  signYappyNotification, timingSafeEqual, verifyYappyNotification,
} from "../../../supabase/functions/_shared/payments/yappy-hash.ts";
import { YappyProvider } from "../../../supabase/functions/_shared/payments/yappy.ts";
import { TestDb, service, user } from "./testing/db";
import { BUYER, LISTING, TEST_DOMAIN, TEST_SECRET, escrow, expectLedgerBalanced, order, requestOrder, sellerConfirm } from "./testing/flow";

describe("Yappy hash", () => {
  const n = async (over: Partial<{ orderId: string; status: string; domain: string; hash: string }> = {}) => {
    const orderId = over.orderId ?? "HABC123DEF45678";
    const status = over.status ?? "E";
    const domain = over.domain ?? TEST_DOMAIN;
    return { orderId, status, domain, hash: over.hash ?? (await signYappyNotification(TEST_SECRET, orderId, status, domain)) };
  };

  it("uses the part before the first '.' of the base64-decoded secret as the HMAC-SHA256 key", async () => {
    // Independent computation with Node's crypto, from Yappy's description.
    const { createHmac } = await import("node:crypto");
    const key = Buffer.from(TEST_SECRET, "base64").toString("utf8").split(".")[0];
    const expected = createHmac("sha256", key).update("HABC123DEF45678" + "E" + TEST_DOMAIN).digest("hex");
    expect(await signYappyNotification(TEST_SECRET, "HABC123DEF45678", "E", TEST_DOMAIN)).toBe(expected);
  });

  it("accepts a valid notification (hash case-insensitive)", async () => {
    const v = await verifyYappyNotification(TEST_SECRET, TEST_DOMAIN, { ...(await n()), confirmationNumber: "C1" });
    expect(v).toEqual({ valid: true, orderId: "HABC123DEF45678", status: "E", domain: TEST_DOMAIN, confirmationNumber: "C1" });
    const upper = await n();
    expect((await verifyYappyNotification(TEST_SECRET, TEST_DOMAIN, { ...upper, hash: upper.hash.toUpperCase() })).valid).toBe(true);
  });

  it("rejects a bad hash, a hash for other data, or a different secret", async () => {
    const good = await n();
    expect(await verifyYappyNotification(TEST_SECRET, TEST_DOMAIN, { ...good, hash: "0".repeat(64) })).toEqual({ valid: false, reason: "bad hash" });
    expect(await verifyYappyNotification(TEST_SECRET, TEST_DOMAIN, { ...good, status: "R" })).toEqual({ valid: false, reason: "bad hash" });
    expect(await verifyYappyNotification(btoa("otra-clave.x"), TEST_DOMAIN, good)).toEqual({ valid: false, reason: "bad hash" });
    expect(await verifyYappyNotification("%%%no-base64", TEST_DOMAIN, good)).toEqual({ valid: false, reason: "bad hash" });
  });

  it("rejects a correctly signed notification for another domain", async () => {
    const other = await n({ domain: "https://evil.example" });
    expect(await verifyYappyNotification(TEST_SECRET, TEST_DOMAIN, other)).toEqual({ valid: false, reason: "wrong domain" });
    // Trailing slash and case don't matter.
    expect((await verifyYappyNotification(TEST_SECRET, TEST_DOMAIN + "/", await n())).valid).toBe(true);
  });

  it("rejects missing parameters, unknown statuses and bad order ids", async () => {
    expect(await verifyYappyNotification(TEST_SECRET, TEST_DOMAIN, { ...(await n()), hash: "" })).toEqual({ valid: false, reason: "missing parameters" });
    expect(await verifyYappyNotification(TEST_SECRET, TEST_DOMAIN, await n({ status: "Z" }))).toEqual({ valid: false, reason: "unknown status" });
    expect(await verifyYappyNotification(TEST_SECRET, TEST_DOMAIN, await n({ orderId: "H-1234" }))).toEqual({ valid: false, reason: "bad order id" });
    expect(await verifyYappyNotification(TEST_SECRET, TEST_DOMAIN, await n({ orderId: "H12345678901234X" }))).toEqual({ valid: false, reason: "bad order id" });
  });

  it("compares in constant time", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("mock provider", () => {
  const mock = new YappyMockProvider({ secret: TEST_SECRET, domain: TEST_DOMAIN });

  it("enforces Yappy's order id and amount rules", async () => {
    await expect(mock.createCharge({ orderId: "MUY-LARGO-1234567", subtotalCents: 100, taxesCents: 0, totalCents: 100, ipnUrl: "x" }))
      .rejects.toThrow(/1-15/);
    await expect(mock.createCharge({ orderId: "H1", subtotalCents: 100, taxesCents: 0, totalCents: 101, ipnUrl: "x" }))
      .rejects.toThrow(/monto/);
    const s = await mock.createCharge({ orderId: "H2", subtotalCents: 100, taxesCents: 0, totalCents: 100, ipnUrl: "x" });
    expect(s).toMatchObject({ transactionId: "MOCKH2", simulated: true });
    await expect(mock.createCharge({ orderId: "H2", subtotalCents: 100, taxesCents: 0, totalCents: 100, ipnUrl: "x" })).rejects.toThrow(/iniciado/);
    expect(await mock.getStatus("H2")).toBe("pending");
  });

  it("simulates notifications the real verifier accepts", async () => {
    for (const status of ["E", "R", "C", "X"] as const) {
      const n = await mock.simulate("H3", status);
      expect(await mock.verifyNotification(n)).toMatchObject({ valid: true, status });
    }
  });

  it("is chosen by PAYMENT_PROVIDER, needs its secrets, and Yappy is the default", () => {
    const env = (vars: Record<string, string>) => (k: string) => vars[k];
    expect(providerFromEnv(env({ PAYMENT_PROVIDER: "mock", MOCK_PAYMENT_SECRET: TEST_SECRET, YAPPY_DOMAIN: TEST_DOMAIN })))
      .toBeInstanceOf(YappyMockProvider);
    expect(providerFromEnv(env({ PAYMENT_PROVIDER: "mock", YAPPY_DOMAIN: TEST_DOMAIN }))).toBeNull();
    expect(providerFromEnv(env({ YAPPY_MERCHANT_ID: "M", YAPPY_SECRET_KEY: TEST_SECRET, YAPPY_DOMAIN: TEST_DOMAIN })))
      .toBeInstanceOf(YappyProvider);
    expect(providerFromEnv(env({}))).toBeNull();
  });
});

describe("IPN endpoint against the database", () => {
  let db: TestDb;
  let deps: HandlerDeps;
  let handler: (req: Request) => Promise<Response>;
  const mock = new YappyMockProvider({ secret: TEST_SECRET, domain: TEST_DOMAIN });
  const bearer = (id: string) => `Bearer test.${id}.sig`;

  beforeAll(async () => {
    db = await TestDb.create({ seed: true });
    deps = {
      provider: mock,
      ipnUrl: "https://example.supabase.co/functions/v1/yappy-pago",
      devSimulator: true,
      async rpcAsUser(authorization, fn, args) {
        const uid = authorization.split(".")[1];
        const names = Object.keys(args);
        try {
          const r = await db.one<{ r: unknown }>(`select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
            Object.values(args), user(uid));
          return { data: r.r, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      },
      async rpcAsService(fn, args) {
        const names = Object.keys(args);
        try {
          const r = await db.one<{ r: unknown }>(`select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
            Object.values(args), service);
          return { data: r.r, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      },
    };
    handler = createPaymentHandler(deps);
  }, 60_000);
  afterAll(() => db.close());

  const ipn = async (n: { orderId: string; status: string; hash: string; domain: string; confirmationNumber?: string | null }) =>
    handler(new Request(`https://fn.test/yappy-pago?${new URLSearchParams({
      orderId: n.orderId, status: n.status, hash: n.hash, domain: n.domain, ...(n.confirmationNumber ? { confirmationNumber: n.confirmationNumber } : {}),
    })}`));

  const startPayment = async (orderId: string) => {
    const res = await handler(new Request("https://fn.test/yappy-pago", {
      method: "POST", headers: { Authorization: bearer(BUYER), "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: orderId }),
    }));
    return { status: res.status, body: await res.json() };
  };

  it("POST creates the charge with the database's amount", async () => {
    const o = await requestOrder(db, LISTING.umbreon);
    expect((await startPayment(o.id)).status).toBe(400); // seller hasn't confirmed: nothing to pay yet
    await sellerConfirm(db, o);
    const r = await startPayment(o.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ simulated: true, total_cents: 8400, purpose: "orden" });
    expect(r.body.attempt).toMatch(/^[A-Z0-9]{1,15}$/);
  });

  it("an executed notification is processed exactly once, however many times it arrives", async () => {
    const o = await requestOrder(db, LISTING.wemby);
    await sellerConfirm(db, o);
    const { body } = await startPayment(o.id);
    const n = await mock.simulate(body.attempt, "E");
    const first = await ipn(n);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ success: true, result: "paid" });
    for (let i = 0; i < 3; i++) {
      const again = await ipn(n);
      expect(await again.json()).toEqual({ success: true, result: "duplicate" });
    }
    expect((await order(db, o.id)).status).toBe("esperando_entrega_vendedor");
    const charges = await db.q("select * from public.ledger_entries where order_id = $1 and kind = 'cobro'", [o.id]);
    expect(charges).toHaveLength(1);
    expect(await escrow(db, o)).toBe(3900);
    const log = await db.q<{ result: string; processed: boolean }>(
      "select result, processed from public.payment_notifications where attempt_id = $1 order by id", [body.attempt]);
    expect(log).toEqual([
      { result: "paid", processed: true },
      { result: "duplicate", processed: false },
      { result: "duplicate", processed: false },
      { result: "duplicate", processed: false },
    ]);
    await expectLedgerBalanced(db);
  });

  it("invalid hash or foreign domain: 401, logged, nothing processed", async () => {
    const o = await requestOrder(db, LISTING.gengar);
    await sellerConfirm(db, o);
    const { body } = await startPayment(o.id);
    const good = await mock.simulate(body.attempt, "E");
    const forged = await ipn({ ...good, hash: "f".repeat(64) });
    expect(forged.status).toBe(401);
    const foreign = await ipn({ ...good, domain: "https://evil.example",
      hash: await signYappyNotification(TEST_SECRET, good.orderId, "E", "https://evil.example") });
    expect(foreign.status).toBe(401);
    expect((await order(db, o.id)).status).toBe("pendiente_pago");
    const log = await db.q<{ valid: boolean; result: string; raw: { rejected: string } }>(
      "select valid, result, raw from public.payment_notifications where attempt_id = $1 order by id", [body.attempt]);
    expect(log.map((l) => [l.valid, l.result, l.raw.rejected])).toEqual([[false, "invalid", "bad hash"], [false, "invalid", "wrong domain"]]);
    expect((await ipn(good)).status).toBe(200); // the real one still goes through
  });

  it("R and X fail the order (listing free again); C keeps it payable", async () => {
    const o = await requestOrder(db, LISTING.charizard);
    await sellerConfirm(db, o);
    const a1 = (await startPayment(o.id)).body.attempt;
    expect(await (await ipn(await mock.simulate(a1, "C"))).json()).toEqual({ success: true, result: "noted" });
    expect((await order(db, o.id)).status).toBe("pendiente_pago");
    const a2 = (await startPayment(o.id)).body.attempt;
    expect(await (await ipn(await mock.simulate(a2, "R"))).json()).toEqual({ success: true, result: "failed" });
    expect((await order(db, o.id)).status).toBe("fallida");
    const l = await db.one<{ status: string }>("select status from public.listings where id = $1", [LISTING.charizard]);
    expect(l.status).toBe("active");
    // A late "E" for a failed order: charged and refunded right away, order stays failed.
    expect(await (await ipn(await mock.simulate(a1, "E"))).json()).toEqual({ success: true, result: "refund: order fallida" });
    expect((await order(db, o.id)).status).toBe("fallida");
    expect(await escrow(db, o)).toBe(0);
    await expectLedgerBalanced(db);
  });

  it("the simulator endpoint works only when enabled, with the mock and a session", async () => {
    const o = await requestOrder(db, LISTING.pikachu);
    await sellerConfirm(db, o);
    const attempt = (await startPayment(o.id)).body.attempt;
    const sim = (h: (r: Request) => Promise<Response>, auth?: string) => h(new Request("https://fn.test/yappy-pago?simular", {
      method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ attempt_id: attempt, status: "E" }),
    }));
    expect((await sim(createPaymentHandler({ ...deps, devSimulator: false }), bearer(BUYER))).status).toBe(404);
    expect((await sim(handler)).status).toBe(401);
    const ok = await sim(handler, bearer(BUYER));
    expect(await ok.json()).toEqual({ success: true, result: "paid" });
  });
});
