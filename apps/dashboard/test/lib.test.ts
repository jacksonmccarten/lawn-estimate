import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { centsToInput, formatBps, parseDollars, parseRatePer1000, parseWholeNumber, rateToInput } from "@/lib/money";
import { PA_COUNTIES } from "@/lib/pa-counties";
import { fieldId, fromForm, sameForm, toForm, type PricingForm } from "@/lib/pricing-form";
import { parseTiersCsv, TIER_CSV_TEMPLATE } from "@/lib/tiers-csv";
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

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes, CRLF and a byte-order mark", () => {
    const result = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n1,2');
    expect(result).toEqual({ ok: true, rows: [["a", "b"], ["x, y", 'say "hi"'], ["1", "2"]] });
  });

  it("reports an unclosed quote with its line", () => {
    expect(parseCsv('a,b\n1,"oops\n2,3')).toEqual({ ok: false, line: 2, problem: "A quoted value is never closed" });
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

describe("parseTiersCsv", () => {
  const services = ["mow", "aerate"];

  it("imports the template", () => {
    const result = parseTiersCsv(TIER_CSV_TEMPLATE, services);
    expect(result).toEqual({
      ok: true,
      tiers: [
        { serviceCode: "mow", regionGroup: "core", minSqft: 0, maxSqft: 5000, pricePerSqftMicrocents: null, flatPriceCents: 4500 },
        { serviceCode: "mow", regionGroup: "core", minSqft: 5000, maxSqft: 10000, pricePerSqftMicrocents: 750_000, flatPriceCents: null },
        { serviceCode: "mow", regionGroup: "outer", minSqft: 0, maxSqft: 5000, pricePerSqftMicrocents: null, flatPriceCents: 5500 },
      ],
    });
  });

  it("accepts columns in any order and any case", () => {
    const result = parseTiersCsv("Flat_Price,MAX_SQFT,min_sqft,region_group,service_code,price_per_1000_sqft\n90,20000,0,core,aerate,", services);
    expect(result.ok).toBe(true);
  });

  it("reports every problem with its row and column, and imports nothing", () => {
    const csv = [
      "service_code,region_group,min_sqft,max_sqft,price_per_1000_sqft,flat_price",
      "snow,core,0,5000,,45",
      "mow,,x,5000,,45",
      "mow,core,5000,5000,7.50,45",
      "mow,core,0,100,,",
    ].join("\n");
    const result = parseTiersCsv(csv, services);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => [p.row, p.column])).toEqual([
      [2, "service_code"],
      [3, "region_group"],
      [3, "min_sqft"],
      [4, "max_sqft"],
      [4, "flat_price"],
      [5, "flat_price"],
    ]);
  });

  it("reports overlapping rows", () => {
    const csv = "service_code,region_group,min_sqft,max_sqft,price_per_1000_sqft,flat_price\nmow,core,0,5000,,45\nmow,core,4000,8000,,60";
    const result = parseTiersCsv(csv, services);
    expect(result).toEqual({ ok: false, problems: [{ row: 3, column: "min_sqft", problem: "This range overlaps row 2 for the same service and region group" }] });
  });

  it("reports a missing or unknown header, and an empty file", () => {
    const missing = parseTiersCsv("service_code,region_group,min_sqft,max_sqft,flat_price,notes\nmow,core,0,1,1,x", services);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.problems.map((p) => p.column)).toEqual(["price_per_1000_sqft", "notes"]);
    expect(parseTiersCsv("", services).ok).toBe(false);
    expect(parseTiersCsv(TIER_CSV_TEMPLATE.split("\r\n")[0]!, services).ok).toBe(false);
  });
});

describe("pricing form", () => {
  const content = {
    minChargeCents: 4500,
    coverageFactor: 0.7,
    services: [
      { code: "mow", name: "Mowing", taxable: true, season: "growing" as const },
      { code: "leaf_raking", name: "Leaf raking", taxable: false, season: "growing" as const },
    ],
    tiers: [
      { serviceCode: "mow", regionGroup: "core", minSqft: 0, maxSqft: 5000, pricePerSqftMicrocents: null, flatPriceCents: 4500 },
      { serviceCode: "mow", regionGroup: "core", minSqft: 5000, maxSqft: 10000, pricePerSqftMicrocents: 750_000, flatPriceCents: null },
    ],
  };

  it("round-trips a version's content exactly", () => {
    expect(fromForm(toForm(content))).toEqual({ ok: true, content });
  });

  it("names each problem by its field", () => {
    const form: PricingForm = toForm(content);
    form.minCharge = "lots";
    form.services[1]!.taxable = "";
    form.tiers[1]!.minSqft = "4000";
    form.tiers[0]!.price = "";
    const result = fromForm(form);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.fieldId)).toEqual([
      fieldId.minCharge,
      fieldId.service(form.services[1]!.key, "taxable"),
      fieldId.tier(form.tiers[0]!.key, "price"),
    ]);
  });

  it("has no default for a service's tax treatment (R1)", () => {
    const form = toForm({ ...content, tiers: [] });
    form.services.push({ key: "new", code: "aerate", name: "Aerating", taxable: "", season: "growing" });
    const result = fromForm(form);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.fieldId).toBe(fieldId.service("new", "taxable"));
  });

  it("rejects overlapping tiers and a tier for a missing service", () => {
    const form = toForm(content);
    form.tiers[1]!.minSqft = "4000";
    const overlap = fromForm(form);
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.errors[0]!.message).toMatch(/overlaps tier 1/);

    const orphan = toForm(content);
    orphan.services.shift();
    const result = fromForm(orphan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(2);
  });

  it("compares forms without their row keys", () => {
    expect(sameForm(toForm(content), toForm(content))).toBe(true);
    const changed = toForm(content);
    changed.tiers[0]!.price = "46.00";
    expect(sameForm(toForm(content), changed)).toBe(false);
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
