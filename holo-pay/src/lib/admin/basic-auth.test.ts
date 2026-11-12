import { describe, expect, it } from "vitest";
import { checkBasicAuth } from "./basic-auth";

const h = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;
const PW = "a-long-password-123";

describe("checkBasicAuth", () => {
  it("accepts the right credentials", () => expect(checkBasicAuth(h("admin", PW), "admin", PW)).toBe(true));
  it("rejects wrong user or password", () => {
    expect(checkBasicAuth(h("admin", "nope"), "admin", PW)).toBe(false);
    expect(checkBasicAuth(h("root", PW), "admin", PW)).toBe(false);
  });
  it("stays locked when not configured or the password is short", () => {
    expect(checkBasicAuth(h("admin", ""), "admin", "")).toBe(false);
    expect(checkBasicAuth(h("admin", "short"), "admin", "short")).toBe(false);
    expect(checkBasicAuth(h("admin", PW), undefined, PW)).toBe(false);
  });
  it("rejects malformed headers", () => {
    expect(checkBasicAuth(null, "admin", PW)).toBe(false);
    expect(checkBasicAuth("Bearer x", "admin", PW)).toBe(false);
    expect(checkBasicAuth("Basic !!!", "admin", PW)).toBe(false);
  });
});
