// Same accent-insensitive search as holo.html: every word becomes a case-insensitive regex (PostgREST
// imatch) where vowels, n and c also match their accented forms, so "pacifica" finds "Pacífica". Only
// letters, digits and # / & - survive, so nothing can break the filter syntax.
const ACCENTS: Record<string, string> = { a: "aáàâäã", e: "eéèêë", i: "iíìîï", o: "oóòôöõ", u: "uúùûü", n: "nñ", c: "cç" };
export function searchTokens(q: string): string[] {
  return q
    .normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}#/&-]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 5);
}
export function searchFilter(t: string, cols: string[]): string {
  const re = [...t].map((ch) => (ACCENTS[ch] ? `[${ACCENTS[ch]}]` : ch)).join("");
  return cols.map((c) => `${c}.imatch.${re}`).join(",");
}
