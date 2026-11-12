import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("csv", () => {
  it("quotes and escapes", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell(null)).toBe('""');
  });
  it("neutralizes spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell("+1")).toBe(`"'+1"`);
  });
  it("builds rows with CRLF", () => expect(toCsv(["a"], [[1]])).toBe('"a"\r\n"1"\r\n'));
});
