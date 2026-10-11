import { describe, expect, it } from "vitest";
import { centsToInput, formatBps, parseDollars, parseRatePer1000, parseWholeNumber, rateToInput } from "@/lib/money";
import { PA_COUNTIES } from "@/lib/pa-counties";
import { fieldId, fromForm, OPEN_END_SQFT, rangeLabel, sameForm, toForm } from "@/lib/pricing-form";
import { findOverlaps } from "@/lib/tiers";
import { brandColorUse, contrastRatio } from "@/lib/contrast";
import { dark, light, pairings } from "@/lib/tokens";

describe("money", () => {
  it.each([
    ["45", 4500],
    ["45.5", 4550],
    ["45.50", 4550],
    ["$1,200.00", 120000],
    ["0", 0],
    ["0.07", 7],
  ])("parses %s dollars to %i cents", (text, cents) => {
    expect(parseDollars(text)).toBe(cents);
  });

  it.each(["", "abc", "-5", "4.505", "1e3", "4 5"])("rejects %j as dollars", (text) => {
    expect(parseDollars(text)).toBeNull();
  });

  it("never loses a cent to floating point", () => {
    // 0.29 * 100 is 28.999999999999996 in binary floating point.
    expect(parseDollars("0.29")).toBe(29);
    expect(parseDollars("1.15")).toBe(115);
    expect(centsToInput(29)).toBe("0.29");
    expect(centsToInput(4500)).toBe("45.00");
  });

  it("converts dollars per 1,000 sq ft to microcents per sq ft and back", () => {
    // The design's worked example: $0.0075 per sq ft is $7.50 per 1,000 sq ft.
    expect(parseRatePer1000("7.50")).toBe(750_000);
    expect(parseRatePer1000("7.5")).toBe(750_000);
    expect(parseRatePer1000("0.00001")).toBe(1);
    expect(parseRatePer1000("0.000001")).toBeNull();
    expect(rateToInput(750_000)).toBe("7.50");
    expect(rateToInput(712_345)).toBe("7.12345");
    expect(rateToInput(0)).toBe("0.00");
  });

  it("handles square feet and basis points", () => {
    expect(parseWholeNumber("10,000")).toBe(10000);
    expect(parseWholeNumber("10.5")).toBeNull();
    expect(formatBps(600)).toBe("6%");
    expect(formatBps(650)).toBe("6.5%");
  });
});

describe("findOverlaps", () => {
  const tier = (minSqft: number, maxSqft: number, regionGroup = "core") => ({ serviceCode: "mow", regionGroup, minSqft, maxSqft, pricePerSqftMicrocents: null, flatPriceCents: 100 });

  it("treats touching ranges as separate: a tier covers min < area <= max", () => {
    expect(findOverlaps([tier(0, 5000), tier(5000, 10000)])).toEqual([]);
  });

  it("finds overlaps only within a service and region group", () => {
    expect(findOverlaps([tier(0, 5000), tier(4999, 10000), tier(0, 5000, "outer")])).toEqual([[0, 1]]);
  });
});

describe("pricing form", () => {
  const flat = (minSqft: number, maxSqft: number, cents: number, regionGroup = "standard") => ({
    serviceCode: "mow",
    regionGroup,
    minSqft,
    maxSqft,
    pricePerSqftMicrocents: null,
    flatPriceCents: cents,
  });
  const content = {
    minChargeCents: 0,
    coverageFactor: 1,
    services: [{ code: "mow", name: "Mowing", taxable: true, season: "growing" as const }],
    tiers: [flat(0, 2500, 4500), flat(2500, 5000, 5000), flat(5000, OPEN_END_SQFT, 6000)],
  };

  it("round-trips flat-rate categories exactly", () => {
    expect(fromForm(toForm(content), content, ["standard"])).toEqual({ ok: true, content });
  });

  it("starts a new version with the example categories", () => {
    const form = toForm({ ...content, tiers: [] });
    expect(form.categories.map((c) => [c.upTo, c.price])).toEqual([
      ["2500", "45.00"],
      ["5000", "50.00"],
      ["10000", "60.00"],
      ["15000", "75.00"],
      [String(OPEN_END_SQFT), "90.00"],
    ]);
  });

  it("writes the same categories for every region group, with no minimum charge and only the mowing service", () => {
    const legacy = {
      ...content,
      minChargeCents: 4500,
      services: [...content.services, { code: "leaf_raking", name: "Leaf raking", taxable: false, season: "growing" as const }],
    };
    const result = fromForm(toForm(content), legacy, ["outer", "core"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.minChargeCents).toBe(0);
    expect(result.content.services.map((s) => s.code)).toEqual(["mow"]);
    expect(result.content.tiers).toEqual([
      flat(0, 2500, 4500, "core"),
      flat(2500, 5000, 5000, "core"),
      flat(5000, OPEN_END_SQFT, 6000, "core"),
      flat(0, 2500, 4500, "outer"),
      flat(2500, 5000, 5000, "outer"),
      flat(5000, OPEN_END_SQFT, 6000, "outer"),
    ]);
  });

  it("brings a per-square-foot tier through with no price, to be filled in", () => {
    const form = toForm({ ...content, tiers: [flat(0, 5000, 4500), { ...flat(5000, 10000, 0), flatPriceCents: null, pricePerSqftMicrocents: 750_000 }] });
    expect(form.categories.map((c) => c.price)).toEqual(["45.00", ""]);
    const result = fromForm(form, content, ["standard"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.fieldId)).toEqual([fieldId.category(form.categories[1]!.key, "price")]);
  });

  it("names each problem by its field: a missing price, a bound not above the one before", () => {
    const form = toForm(content);
    form.categories[0]!.price = "";
    form.categories[1]!.upTo = "2000";
    const result = fromForm(form, content, ["standard"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => [e.fieldId, e.message])).toEqual([
      [fieldId.category(form.categories[0]!.key, "price"), "Enter a dollar amount, such as 45.00"],
      [fieldId.category(form.categories[1]!.key, "max"), "Must be more than 2,500, where the category above ends"],
    ]);
    expect(fromForm({ categories: [] }, content, ["standard"]).ok).toBe(false);
  });

  it("labels ranges as the homeowner reads them", () => {
    expect(rangeLabel(0, 2500)).toBe("0–2,500 sq ft");
    expect(rangeLabel(2500, 5000)).toBe("2,501–5,000 sq ft");
    expect(rangeLabel(15000, OPEN_END_SQFT)).toBe("15,001+ sq ft");
  });

  it("compares forms by what they would save, ignoring the open-ended bound", () => {
    expect(sameForm(toForm(content), toForm(content))).toBe(true);
    const changed = toForm(content);
    changed.categories[0]!.price = "46";
    expect(sameForm(toForm(content), changed)).toBe(false);
    const last = toForm(content);
    last.categories[2]!.upTo = "123";
    expect(sameForm(toForm(content), last)).toBe(true);
  });
});

describe("design tokens", () => {
  for (const [name, scheme] of [["light", light], ["dark", dark]] as const) {
    it.each(pairings.map(([fg, bg, min]) => ({ fg, bg, min })))(`${name}: $fg on $bg is at least $min to 1`, ({ fg, bg, min }) => {
      expect(contrastRatio(scheme[fg], scheme[bg])).toBeGreaterThanOrEqual(min);
    });
  }

  it("uses a brand color as a fill only when text on it reaches 4.5 to 1", () => {
    expect(brandColorUse("#1f6b3a")).toMatchObject({ use: "fill", text: "#ffffff" });
    expect(brandColorUse("#ffd400")).toMatchObject({ use: "fill", text: "#111111" });
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});

describe("PA counties", () => {
  it("lists all 67 once", () => {
    expect(new Set(PA_COUNTIES).size).toBe(67);
  });
});
