import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  it("allows up to the limit per window and per key, then resets", () => {
    const r = new RateLimiter(2, 1000);
    expect(r.check("a", 0)).toBe(true);
    expect(r.check("a", 10)).toBe(true);
    expect(r.check("a", 20)).toBe(false);
    expect(r.check("b", 20)).toBe(true);
    expect(r.check("a", 1000)).toBe(true);
  });
});
