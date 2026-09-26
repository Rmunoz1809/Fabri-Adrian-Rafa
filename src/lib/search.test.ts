import { describe, expect, it } from "vitest";
import { searchFilter, searchTokens } from "./search";

describe("searchTokens", () => {
  it("ignores accents, case and punctuation", () => {
    expect(searchTokens("Pokémon  Pacífica, (Charizard)")).toEqual(["pokemon", "pacifica", "charizard"]);
  });

  it("keeps card numbers and drops one-letter words", () => {
    expect(searchTokens("Mew ex 151/165 #57 a")).toEqual(["mew", "ex", "151/165", "#57"]);
  });

  it("strips characters with a meaning in PostgREST filters or regexes", () => {
    for (const t of searchTokens("a.b,c(d)e*f%g:h\"i'j[k]l+m?n|o^p$q{r}s\\t")) {
      expect(t).toMatch(/^[\p{L}\p{N}#/&-]+$/u);
    }
  });
});

describe("searchFilter", () => {
  it("matches accented forms of vowels, n and c", () => {
    expect(searchFilter("pacifica", ["title"])).toBe("title.imatch.p[aáàâäã][cç][iíìîï]f[iíìîï][cç][aáàâäã]");
    const re = new RegExp(searchFilter("nandu", ["x"]).slice("x.imatch.".length), "i");
    expect(re.test("Ñandú")).toBe(true);
  });

  it("builds one condition per column", () => {
    expect(searchFilter("mew", ["title", "subject"]).split(",")).toHaveLength(2);
  });
});
