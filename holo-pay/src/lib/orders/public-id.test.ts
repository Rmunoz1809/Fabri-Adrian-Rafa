import { describe, expect, it } from "vitest";
import { generatePublicId, YAPPY_ORDER_ID } from "./public-id";

describe("generatePublicId", () => {
  it("is always 1-15 alphanumeric characters (Yappy orderId rule)", () => {
    for (let i = 0; i < 10_000; i++) {
      const id = generatePublicId();
      expect(id).toMatch(YAPPY_ORDER_ID);
      expect(id.length).toBeGreaterThanOrEqual(1);
      expect(id.length).toBeLessThanOrEqual(15);
      expect(id).toMatch(/^H[0-9A-Z]{9}$/);
    }
  });

  it("does not repeat across many generations", () => {
    const ids = new Set(Array.from({ length: 50_000 }, generatePublicId));
    expect(ids.size).toBe(50_000);
  });
});
