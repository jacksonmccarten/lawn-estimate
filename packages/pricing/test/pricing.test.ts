import { describe, expect, it } from "vitest";
import { priceQuote, type PricingInput, type PricingVersion, type Quote } from "../src/index.js";

// Frozen all the way down: a test fails if the engine mutates its input.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const perSqft = (serviceCode: string, regionGroup: string, minSqft: number, maxSqft: number, microcents: number) => ({
  serviceCode,
  regionGroup,
  minSqft,
  maxSqft,
  pricePerSqftMicrocents: microcents,
  flatPriceCents: null,
});
const flat = (serviceCode: string, regionGroup: string, minSqft: number, maxSqft: number, cents: number) => ({
  serviceCode,
  regionGroup,
  minSqft,
  maxSqft,
  pricePerSqftMicrocents: null,
  flatPriceCents: cents,
});

// Mowing, core region: (0, 5000] flat $45, (5000, 10000] $0.0075/sqft,
// (10000, 20000] $0.0065/sqft, nothing above 20,000 and a gap at (20000, 25000].
const version: PricingVersion = deepFreeze({
  id: "version-1",
  minChargeCents: 4500,
  services: [
    { code: "mow", name: "Mowing", taxable: true },
    { code: "fertilize", name: "Fertilizing", taxable: true },
    { code: "bed_maintenance", name: "Bed maintenance", taxable: false },
    { code: "leaf_raking", name: "Leaf raking", taxable: false },
    { code: "aerate", name: "Aerating", taxable: true },
  ],
  tiers: [
    flat("mow", "core", 0, 5000, 4500),
    perSqft("mow", "core", 5000, 10000, 750_000),
    perSqft("mow", "core", 10000, 20000, 650_000),
    perSqft("mow", "core", 25000, 40000, 600_000),
    perSqft("mow", "outer", 0, 10000, 900_000),
    perSqft("fertilize", "core", 0, 20000, 333_333),
    flat("bed_maintenance", "core", 0, 20000, 6000),
    perSqft("leaf_raking", "core", 0, 20000, 500_000),
    // aerate is sold but has no tier in any region
  ],
});

const input = (over: Partial<PricingInput> = {}): PricingInput => ({
  version,
  serviceCode: "mow",
  grassSqft: 6400,
  regionGroup: "core",
  taxRateBps: 600,
  ...over,
});

function priced(over: Partial<PricingInput> = {}): Quote {
  const result = priceQuote(input(over));
  if (!result.ok) throw new Error(`expected a price, got ${result.reason}`);
  return result.quote;
}

describe("worked example from the design doc", () => {
  it("prices 6,400 sqft of mowing in Centre County at $48.00 + $2.88 tax = $50.88", () => {
    expect(priceQuote(input())).toEqual({
      ok: true,
      quote: {
        lines: [{ serviceCode: "mow", name: "Mowing", amountCents: 4800, taxable: true }],
        subtotalCents: 4800,
        taxableSubtotalCents: 4800,
        taxRateBps: 600,
        taxCents: 288,
        totalCents: 5088,
        versionId: "version-1",
      },
    });
  });
});

describe("tier boundaries (min exclusive, max inclusive)", () => {
  it.each([
    // grassSqft, expected line amount in cents, which tier
    [1, 4500, "bottom of the first tier"],
    [100, 4500, "(0, 5000] flat"],
    [5000, 4500, "top of (0, 5000] is inclusive"],
    [5001, 4500, "first sqft of (5000, 10000]: 3750.75 -> 3751, lifted to the minimum"],
    [6100, 4575, "(5000, 10000] per sqft"],
    [10000, 7500, "top of (5000, 10000] is inclusive"],
    [10001, 6501, "first sqft of (10000, 20000]: 6500.65 -> 6501"],
    [10100, 6565, "(10000, 20000] per sqft"],
    [20000, 13000, "top of (10000, 20000] is inclusive"],
    [25001, 15001, "first sqft after the gap: 15000.6 -> 15001"],
    [40000, 24000, "top of the last tier is inclusive"],
  ])("%i sqft -> %i cents (%s)", (grassSqft, amountCents) => {
    expect(priced({ grassSqft }).lines).toEqual([
      { serviceCode: "mow", name: "Mowing", amountCents, taxable: true },
    ]);
  });

  it("uses the tier of the requested region only", () => {
    expect(priced({ grassSqft: 6400, regionGroup: "outer" }).subtotalCents).toBe(5760);
    expect(priced({ grassSqft: 6400, regionGroup: "core" }).subtotalCents).toBe(4800);
  });

  it("takes the first matching tier if a version ever holds overlapping ones", () => {
    const overlapping: PricingVersion = {
      ...version,
      tiers: [flat("mow", "core", 0, 10000, 9900), flat("mow", "core", 5000, 10000, 1)],
    };
    expect(priced({ version: overlapping, grassSqft: 6000 }).subtotalCents).toBe(9900);
  });
});

describe("no tier", () => {
  it.each([
    [0, "core", "zero is not above the lowest minimum"],
    [20001, "core", "in the gap between tiers"],
    [25000, "core", "the gap's upper edge is still exclusive"],
    [40001, "core", "above the largest tier"],
    [10001, "outer", "above the only tier of another region"],
    [6400, "nowhere", "a region with no tiers"],
  ])("%i sqft in %s: %s", (grassSqft, regionGroup) => {
    expect(priceQuote(input({ grassSqft, regionGroup }))).toEqual({ ok: false, reason: "no_tier", serviceCode: "mow" });
  });

  it("reports a service that is sold but has no tier", () => {
    expect(priceQuote(input({ serviceCode: "aerate" }))).toEqual({ ok: false, reason: "no_tier", serviceCode: "aerate" });
  });

  it("fails the whole quote when an add-on has no tier, rather than dropping the line", () => {
    expect(priceQuote(input({ addOnCodes: ["bed_maintenance", "aerate"] }))).toEqual({
      ok: false,
      reason: "no_tier",
      serviceCode: "aerate",
    });
  });

  it("never charges the minimum for a size it cannot price", () => {
    const result = priceQuote(input({ grassSqft: 40001 }));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("quote");
  });

  it("distinguishes a service the version does not sell", () => {
    expect(priceQuote(input({ serviceCode: "snow_push" }))).toEqual({
      ok: false,
      reason: "unknown_service",
      serviceCode: "snow_push",
    });
    expect(priceQuote(input({ addOnCodes: ["snow_push"] }))).toEqual({
      ok: false,
      reason: "unknown_service",
      serviceCode: "snow_push",
    });
  });
});

describe("minimum charge", () => {
  it.each([
    // grassSqft, labor in cents, charged
    [5900, 4425, 4500, "one step below the minimum is lifted to it"],
    [5999, 4499, 4500, "labor 4499.25 -> 4499, one cent short"],
    [6000, 4500, 4500, "labor exactly equal to the minimum"],
    [6001, 4501, 4501, "labor 4500.75 -> 4501, one cent over"],
    [6100, 4575, 4575, "above the minimum is charged as priced"],
  ])("%i sqft: labor %i -> charged %i (%s)", (grassSqft, _labor, charged) => {
    const quote = priced({ grassSqft });
    expect(quote.lines[0]!.amountCents).toBe(charged);
    expect(quote.subtotalCents).toBe(charged);
  });

  it("applies to a flat-price tier too", () => {
    const quote = priced({ version: { ...version, minChargeCents: 5000 }, grassSqft: 3000 });
    expect(quote.subtotalCents).toBe(5000);
  });

  it("is taxed as the quoted service is, taxable or not", () => {
    // 2,000 sqft of leaf raking is $10.00 of labor, lifted to the $45.00 minimum.
    const exempt = priced({ serviceCode: "leaf_raking", grassSqft: 2000 });
    expect(exempt).toMatchObject({ subtotalCents: 4500, taxableSubtotalCents: 0, taxCents: 0, totalCents: 4500 });
    const taxed = priced({ serviceCode: "mow", grassSqft: 2000 });
    expect(taxed).toMatchObject({ subtotalCents: 4500, taxableSubtotalCents: 4500, taxCents: 270, totalCents: 4770 });
  });

  it("applies to the quoted service only, not to each add-on", () => {
    // Fertilizing 300 sqft is 99.9999 -> 100 cents; it is not lifted to $45.
    const quote = priced({ grassSqft: 300, addOnCodes: ["fertilize"] });
    expect(quote.lines.map((l) => l.amountCents)).toEqual([4500, 100]);
  });

  it("can be zero", () => {
    expect(priced({ version: { ...version, minChargeCents: 0 }, grassSqft: 5001 }).subtotalCents).toBe(3751);
  });
});

describe("separately stated tax (R1-R4)", () => {
  it("keeps taxable and non-taxable services as separate lines and taxes only the taxable subtotal", () => {
    const quote = priced({ addOnCodes: ["bed_maintenance", "fertilize", "leaf_raking"] });
    expect(quote.lines).toEqual([
      { serviceCode: "mow", name: "Mowing", amountCents: 4800, taxable: true },
      { serviceCode: "bed_maintenance", name: "Bed maintenance", amountCents: 6000, taxable: false },
      { serviceCode: "fertilize", name: "Fertilizing", amountCents: 2133, taxable: true },
      { serviceCode: "leaf_raking", name: "Leaf raking", amountCents: 3200, taxable: false },
    ]);
    expect(quote.subtotalCents).toBe(16133);
    expect(quote.taxableSubtotalCents).toBe(6933);
    // 6933 x 6% = 415.98 -> 416. Taxing the whole quote would give 968.
    expect(quote.taxCents).toBe(416);
    expect(quote.totalCents).toBe(16549);
  });

  it("charges no tax when no line is taxable", () => {
    const quote = priced({ serviceCode: "bed_maintenance", addOnCodes: ["leaf_raking"] });
    expect(quote).toMatchObject({ subtotalCents: 9200, taxableSubtotalCents: 0, taxCents: 0, totalCents: 9200 });
  });

  it("does not let a non-taxable add-on change the tax on a taxable service", () => {
    const alone = priced();
    const withAddOn = priced({ addOnCodes: ["bed_maintenance"] });
    expect(withAddOn.taxCents).toBe(alone.taxCents);
    expect(withAddOn.totalCents).toBe(alone.totalCents + 6000);
  });

  it("taxes the taxable subtotal once, not each line", () => {
    // 4575 and 2033 are 274.5 and 121.98 at 6%: rounded per line 275 + 122 = 397; together 396.48 -> 396.
    const quote = priced({ grassSqft: 6100, addOnCodes: ["fertilize"] });
    expect(quote.lines.map((l) => l.amountCents)).toEqual([4575, 2033]);
    expect(quote.taxCents).toBe(396);
  });

  it.each([
    // taxRateBps, grassSqft, taxable subtotal, tax
    [600, 6400, 4800, 288, "6% statewide"],
    [700, 6400, 4800, 336, "7% Allegheny"],
    [800, 6400, 4800, 384, "8% Philadelphia"],
    [600, 6100, 4575, 275, "274.5 rounds half up"],
    [700, 6500, 4875, 341, "341.25 rounds down"],
    [700, 6900, 5175, 362, "362.25 rounds down"],
    [800, 6001, 4501, 360, "360.08 rounds down"],
    [600, 6011, 4508, 270, "270.48 rounds down"],
    [600, 6012, 4509, 271, "270.54 rounds up"],
    [0, 6400, 4800, 0, "a zero rate"],
  ])("%i bps on %i sqft: subtotal %i -> tax %i (%s)", (taxRateBps, grassSqft, taxable, tax) => {
    const quote = priced({ taxRateBps, grassSqft });
    expect(quote.taxableSubtotalCents).toBe(taxable);
    expect(quote.taxCents).toBe(tax);
    expect(quote.totalCents).toBe(taxable + tax);
    expect(quote.taxRateBps).toBe(taxRateBps);
  });

  it("always adds up: lines to subtotal, subtotal plus tax to total, in whole cents", () => {
    for (const grassSqft of [1, 333, 5001, 6400, 9999, 10001, 19999]) {
      for (const taxRateBps of [600, 700, 800]) {
        const quote = priced({ grassSqft, taxRateBps, addOnCodes: ["bed_maintenance", "fertilize", "leaf_raking"] });
        const amounts = quote.lines.map((l) => l.amountCents);
        for (const cents of [...amounts, quote.taxCents, quote.totalCents]) expect(Number.isInteger(cents)).toBe(true);
        expect(quote.subtotalCents).toBe(amounts.reduce((a, b) => a + b, 0));
        expect(quote.taxableSubtotalCents).toBe(
          quote.lines.filter((l) => l.taxable).reduce((a, l) => a + l.amountCents, 0),
        );
        expect(quote.totalCents).toBe(quote.subtotalCents + quote.taxCents);
      }
    }
  });
});

describe("purity and input checks", () => {
  it("returns the same result for the same input and pins the version id", () => {
    expect(priceQuote(input())).toEqual(priceQuote(input()));
    expect(priced().versionId).toBe("version-1");
  });

  it.each([
    [{ grassSqft: -1 }, /grassSqft/],
    [{ grassSqft: 6400.5 }, /grassSqft/],
    [{ grassSqft: Number.NaN }, /grassSqft/],
    [{ taxRateBps: 0.06 }, /taxRateBps/],
    [{ taxRateBps: -600 }, /taxRateBps/],
    [{ taxRateBps: 10000 }, /taxRateBps/],
    [{ version: { ...version, minChargeCents: 45.5 } }, /minChargeCents/],
    [{ addOnCodes: ["mow"] }, /twice/],
    [{ addOnCodes: ["fertilize", "fertilize"] }, /twice/],
  ] as [Partial<PricingInput>, RegExp][])("rejects %j", (over, message) => {
    expect(() => priceQuote(input(over))).toThrow(message);
    expect(() => priceQuote(input(over))).toThrow(RangeError);
  });

  it("rejects a tier with no price, and an amount too large to compute exactly", () => {
    const broken: PricingVersion = {
      ...version,
      tiers: [{ serviceCode: "mow", regionGroup: "core", minSqft: 0, maxSqft: 10000, pricePerSqftMicrocents: null, flatPriceCents: null }],
    };
    expect(() => priceQuote(input({ version: broken }))).toThrow(/neither/);
    const huge: PricingVersion = { ...version, tiers: [perSqft("mow", "core", 0, 2 ** 40, 2_000_000_000)] };
    expect(() => priceQuote(input({ version: huge, grassSqft: 2 ** 40 }))).toThrow(/too large/);
  });
});
