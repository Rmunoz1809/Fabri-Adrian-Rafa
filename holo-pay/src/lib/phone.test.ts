import { describe, expect, it } from "vitest";
import { normalizePanamaMobile } from "./phone";

describe("normalizePanamaMobile", () => {
  it.each(["61234567", "6123-4567", "6123 4567", "+507 6123-4567", "50761234567", "0050761234567", "(+507) 6123.4567"])(
    "accepts %s",
    (v) => expect(normalizePanamaMobile(v)).toBe("61234567"),
  );
  it.each(["", "2123456", "21234567", "6123456", "612345678", "abcdefgh", "+1 6123 4567", "6123456a"])("rejects %s", (v) =>
    expect(normalizePanamaMobile(v)).toBeNull(),
  );
});
