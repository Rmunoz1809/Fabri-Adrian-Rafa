import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps paths on this site", () => {
    expect(safeNext("/vender")).toBe("/vender");
    expect(safeNext("/carta/abc?x=1#top")).toBe("/carta/abc?x=1#top");
  });

  it("rejects anything that could leave the site", () => {
    for (const bad of ["//evil.com", "/\\evil.com", "/\\\\evil.com", "/\t/evil.com", "https://evil.com", "evil.com", "", null, 42]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});
