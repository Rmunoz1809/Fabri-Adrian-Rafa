import { describe, expect, it } from "vitest";
import { estimatePrice, priceVerdict, type ReferencePrice } from "./estimate";

const now = new Date("2026-09-25T12:00:00Z");
const ref: ReferencePrice = { market: 100, low: 60, mid: 110, high: 300, variant: "holofoil", updatedAt: "2026/09/24" };

describe("estimatePrice", () => {
  it("returns null with no basis at all", () => {
    expect(estimatePrice({ condition: "NM", grading: null, now })).toBeNull();
  });

  it("uses the TCGplayer market price for a raw NM card", () => {
    const e = estimatePrice({ reference: ref, condition: "NM", grading: null, now })!;
    expect(e.source).toBe("tcgplayer");
    expect(e.mid).toBe(100);
    expect(e.low).toBe(85);
    expect(e.high).toBe(115);
  });

  it("discounts by condition", () => {
    const e = estimatePrice({ reference: ref, condition: "MP", grading: null, now })!;
    expect(e.mid).toBe(70);
    expect(e.basis.join(" ")).toContain("MP");
  });

  it("does not apply raw reference prices to graded cards", () => {
    const e = estimatePrice({ reference: ref, condition: null, grading: { company: "PSA", grade: 10 }, now });
    expect(e).toBeNull();
  });

  it("needs at least 3 recent local sales", () => {
    const comps = [{ priceUsd: 50, soldAt: "2026-09-01" }, { priceUsd: 60, soldAt: "2026-09-02" }];
    expect(estimatePrice({ localComps: comps, condition: null, grading: { company: "PSA", grade: 9 }, now })).toBeNull();
  });

  it("ignores local sales older than 6 months", () => {
    const comps = [40, 50, 60].map((p) => ({ priceUsd: p, soldAt: "2025-12-01" }));
    expect(estimatePrice({ localComps: comps, condition: "NM", grading: null, now })).toBeNull();
  });

  it("uses quartiles of local sales", () => {
    const comps = [40, 50, 60, 70, 80].map((p) => ({ priceUsd: p, soldAt: "2026-09-10" }));
    const e = estimatePrice({ localComps: comps, condition: null, grading: { company: "PSA", grade: 10 }, now })!;
    expect(e.source).toBe("local");
    expect([e.low, e.mid, e.high]).toEqual([50, 60, 70]);
  });

  it("blends local and reference, weighting local 60%", () => {
    const comps = [80, 90, 100].map((p) => ({ priceUsd: p, soldAt: "2026-09-10" }));
    const e = estimatePrice({ reference: ref, localComps: comps, condition: "NM", grading: null, now })!;
    expect(e.source).toBe("mixto");
    expect(e.mid).toBe(94); // 90*0.6 + 100*0.4
  });

  it("marks stale references as low confidence", () => {
    const e = estimatePrice({ reference: { ...ref, updatedAt: "2026/07/01" }, condition: "NM", grading: null, now })!;
    expect(e.confidence).toBe("baja");
  });
});

describe("priceVerdict", () => {
  const est = estimatePrice({ reference: ref, condition: "NM", grading: null, now });
  it("classifies asking prices", () => {
    expect(priceVerdict(80, est)).toBe("buen-precio");
    expect(priceVerdict(100, est)).toBe("en-rango");
    expect(priceVerdict(130, est)).toBe("alto");
    expect(priceVerdict(100, null)).toBeNull();
  });
});
