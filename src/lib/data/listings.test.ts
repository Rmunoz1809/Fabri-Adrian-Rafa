import { describe, expect, it } from "vitest";
import { getListing, listListings, parseFilters } from "./listings";

describe("listListings", () => {
  it("filters by category", async () => {
    const nba = await listListings({ category: "nba" });
    expect(nba.length).toBeGreaterThan(0);
    expect(nba.every((l) => l.card.category === "nba")).toBe(true);
  });

  it("searches accent-insensitively across fields", async () => {
    const r = await listListings({ q: "pokemon charizard" });
    expect(r).toEqual([]); // "pokemon" is not in the text fields
    const r2 = await listListings({ q: "charizard 151" });
    expect(r2.map((l) => l.id).sort()).toEqual(["l-001", "l-002"]);
    const r3 = await listListings({ q: "chiriqui" });
    expect(r3.map((l) => l.id)).toEqual(["l-005"]);
    const r4 = await listListings({ q: "albrook" });
    expect(r4.map((l) => l.id)).toEqual(["l-004"]);
  });

  it("filters graded vs raw and price range", async () => {
    const graded = await listListings({ graded: "graded" });
    expect(graded.every((l) => l.grading)).toBe(true);
    const cheap = await listListings({ maxPrice: 10, sort: "precio-asc" });
    expect(cheap.map((l) => l.priceUsd)).toEqual([8, 9]);
  });
});

describe("estimates on seed data", () => {
  it("uses local PSA 10 comps for a graded Charizard", async () => {
    const l = await getListing("l-002");
    expect(l?.estimate?.source).toBe("local");
  });

  it("has no estimate for a sports card without comps", async () => {
    const l = await getListing("l-008");
    expect(l?.estimate).toBeNull();
  });
});

describe("parseFilters", () => {
  it("parses and sanitizes search params", () => {
    expect(parseFilters({ q: " pikachu ", tipo: "graded", min: "-5", max: "100", orden: "x" })).toEqual({
      q: "pikachu",
      category: undefined,
      graded: "graded",
      province: undefined,
      minPrice: undefined,
      maxPrice: 100,
      sort: "recientes",
    });
  });
});
