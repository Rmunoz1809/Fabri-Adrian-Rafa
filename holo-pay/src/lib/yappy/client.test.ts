import { describe, expect, it, vi } from "vitest";
import { HttpYappyClient, MockYappyClient, type CreatePaymentInput } from "./client";
import type { YappyConfig } from "./config";
import { YAPPY_ERRORS } from "./errors";

const config: YappyConfig = {
  merchantId: "MERCHANT1",
  secretKey: "unused",
  domain: "https://holo.test",
  baseUrl: "https://api-comecom-uat.yappycloud.com",
  ipnUrl: "https://holo.test/api/yappy/ipn",
};
const input: CreatePaymentInput = { orderId: "HABC123XYZ", aliasYappy: "61234567", subtotalCents: 10800, taxesCents: 0, discountCents: 0, totalCents: 10800 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("HttpYappyClient", () => {
  it("validates the merchant, then sends payment-wc with the token and dollar amounts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ status: { code: "0000" }, body: { token: "tok-123", epochTime: 1731400000000 } }))
      .mockResolvedValueOnce(json({ status: { code: "0000" }, body: { transactionId: "T1", token: "pay-tok", documentName: "doc" } }));
    const r = await new HttpYappyClient(config, fetchMock).createPayment(input);
    expect(r).toEqual({ ok: true, transactionId: "T1", token: "pay-tok", documentName: "doc" });

    const [url1, init1] = fetchMock.mock.calls[0];
    expect(url1).toBe("https://api-comecom-uat.yappycloud.com/payments/validate/merchant");
    expect(JSON.parse(init1!.body as string)).toEqual({ merchantId: "MERCHANT1", urlDomain: "https://holo.test" });

    const [url2, init2] = fetchMock.mock.calls[1];
    expect(url2).toBe("https://api-comecom-uat.yappycloud.com/payments/payment-wc");
    expect((init2!.headers as Record<string, string>).Authorization).toBe("tok-123");
    expect(JSON.parse(init2!.body as string)).toEqual({
      merchantId: "MERCHANT1",
      orderId: "HABC123XYZ",
      domain: "https://holo.test",
      paymentDate: 1731400000000,
      aliasYappy: "61234567",
      ipnUrl: "https://holo.test/api/yappy/ipn",
      discount: "0.00",
      taxes: "0.00",
      subtotal: "108.00",
      total: "108.00",
    });
  });

  it.each(Object.keys(YAPPY_ERRORS))("maps %s to a clear message", async (code) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ body: { token: "t", epochTime: 1 } }))
      .mockResolvedValueOnce(json({ status: { code, description: "x" }, body: null }, 400));
    const r = await new HttpYappyClient(config, fetchMock).createPayment(input);
    expect(r).toEqual({ ok: false, code, message: YAPPY_ERRORS[code] });
  });

  it("fails cleanly when the merchant validation fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ status: { code: "E100" }, body: null }, 400));
    expect(await new HttpYappyClient(config, fetchMock).createPayment(input)).toMatchObject({ ok: false, code: "E100" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails cleanly on network errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    expect(await new HttpYappyClient(config, fetchMock).createPayment(input)).toMatchObject({ ok: false, code: "NETWORK" });
  });
});

describe("MockYappyClient", () => {
  it("succeeds and rejects a repeated orderId with E007", async () => {
    const m = new MockYappyClient();
    expect(await m.createPayment(input)).toMatchObject({ ok: true });
    expect(await m.createPayment(input)).toMatchObject({ ok: false, code: "E007" });
  });
  it("reproduces E005, E009 and E010", async () => {
    const m = new MockYappyClient();
    expect(await m.createPayment({ ...input, aliasYappy: "60000005" })).toMatchObject({ code: "E005" });
    expect(await m.createPayment({ ...input, orderId: "H1234567890123456" })).toMatchObject({ code: "E009" });
    expect(await m.createPayment({ ...input, orderId: "HX2", totalCents: 1 })).toMatchObject({ code: "E010" });
  });
});
