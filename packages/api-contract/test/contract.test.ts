import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  Company,
  ErrorCode,
  LeadDecisionRequest,
  ErrorResponse,
  EstimateRequest,
  EstimateResponse,
  ListLeadsQuery,
  PricingVersionContent,
  PricingVersionDiff,
  routes,
  SubmitRequest,
  SubmitResponse,
  UpdateCompanyRequest,
  type QuoteLine,
} from "../src/index.js";

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

const quote = {
  lines: [
    { serviceCode: "mow", name: "Mowing", amountCents: 4800, taxable: true },
    { serviceCode: "bed_maintenance", name: "Bed maintenance", amountCents: 6000, taxable: false },
  ],
  subtotalCents: 10800,
  taxableSubtotalCents: 4800,
  taxRateBps: 600,
  taxCents: 288,
  totalCents: 11088,
};

describe("POST /estimate", () => {
  const first = { company: "joes-lawn", address: "123 Main St, State College, PA", service: "mow", turnstile: "t", embedOrigin: "https://joeslawn.com" };
  const adjust = { token: "signed.token", adjust: "smaller", turnstile: "t", embedOrigin: null };

  it("accepts the two request forms of section 5", () => {
    expect(ok(EstimateRequest, first)).toBe(true);
    expect(ok(EstimateRequest, adjust)).toBe(true);
    expect(ok(EstimateRequest, { ...first, embedOrigin: null })).toBe(true);
    expect(ok(EstimateRequest, { ...first, manual: { zip: "16801", size: { kind: "bucket", bucket: "half_acre" } } })).toBe(true);
    expect(ok(EstimateRequest, { ...first, manual: { zip: "16801", size: { kind: "sqft", sqft: 8000 } } })).toBe(true);
    expect(ok(EstimateRequest, { ...first, manual: { zip: "16801", size: { kind: "drawn", sqft: 8000 } } })).toBe(true);
    expect(ok(EstimateRequest, { ...first, manual: { zip: "16801", size: { kind: "drawn", sqft: 99 } } })).toBe(false);
  });

  it("requires a zip on the manual path", () => {
    const size = { kind: "sqft", sqft: 8000 };
    expect(ok(EstimateRequest, { ...first, manual: { size } })).toBe(false);
    expect(ok(EstimateRequest, { ...first, manual: size })).toBe(false);
    for (const zip of ["", "1680", "168011", "16801-1234", "1680a", 16801]) {
      expect(ok(EstimateRequest, { ...first, manual: { zip, size } }), String(zip)).toBe(false);
    }
    // A county is only ever a choice within a manual request, never a top-level field.
    expect(ok(EstimateRequest, { ...first, county: "Centre" })).toBe(false);
  });

  it("lets a manual request carry the county chosen after county_required", () => {
    const manual = { zip: "15085", size: { kind: "bucket", bucket: "half_acre" } };
    expect(ok(EstimateRequest, { ...first, manual })).toBe(true);
    expect(ok(EstimateRequest, { ...first, manual: { ...manual, county: "Westmoreland" } })).toBe(true);
    expect(ok(EstimateRequest, { ...first, manual: { ...manual, county: "" } })).toBe(false);
    expect(ok(EstimateRequest, { ...first, manual: { ...manual, county: ["Allegheny", "Westmoreland"] } })).toBe(false);
    // Not a way to choose a rate.
    expect(ok(EstimateRequest, { ...first, manual: { ...manual, county: "Westmoreland", taxRateBps: 600 } })).toBe(false);
  });

  it("answers county_required with the candidate counties and nothing about rates", () => {
    const required = { status: "county_required", zip: "15085", candidates: ["Allegheny", "Westmoreland"] };
    expect(ok(EstimateResponse, required)).toBe(true);
    expect(ok(EstimateResponse, { ...required, candidates: ["Allegheny"] })).toBe(false);
    expect(ok(EstimateResponse, { ...required, candidates: [] })).toBe(false);
    expect(ok(EstimateResponse, { ...required, zip: undefined })).toBe(false);
    expect(ok(EstimateResponse, { ...required, candidates: [{ county: "Allegheny", taxRateBps: 700 }, { county: "Westmoreland", taxRateBps: 600 }] })).toBe(false);
    expect(ok(EstimateResponse, { ...required, taxRates: { Allegheny: 700 } })).toBe(false);
  });

  it.each([
    ["no Turnstile token", { ...first, turnstile: undefined }],
    ["an empty Turnstile token", { ...first, turnstile: "" }],
    ["no embedOrigin field at all", { ...first, embedOrigin: undefined }],
    ["an origin with a path", { ...first, embedOrigin: "https://joeslawn.com/quote" }],
    ["a company id instead of a slug", { ...first, company: "Joes Lawn" }],
    ["a client-supplied area on the first call", { ...first, grassSqft: 100 }],
    ["a client-supplied price", { ...first, totalCents: 1 }],
    ["a mix of both forms", { ...first, token: "signed.token", adjust: "smaller" }],
    ["a free-form adjustment", { ...adjust, adjust: -0.9 }],
    ["an adjustment without its token", { ...adjust, token: undefined }],
    ["a fractional manual area", { ...first, manual: { zip: "16801", size: { kind: "sqft", sqft: 8000.5 } } }],
  ])("rejects %s", (_name, body) => {
    expect(ok(EstimateRequest, body)).toBe(false);
  });

  const priced = {
    status: "priced",
    quote,
    token: "signed.token",
    grassSqft: 6400,
    parcelSqft: 11200,
    origin: "regrid",
    county: "Centre",
    assumptions: ["70% of the lot outside the house is lawn"],
    canAdjust: true,
  };

  it("accepts each response of the flow", () => {
    expect(ok(EstimateResponse, priced)).toBe(true);
    expect(ok(EstimateResponse, { status: "manual_required", reason: "no_match" })).toBe(true);
    expect(ok(EstimateResponse, { status: "call_us", reason: "outside_service_area", phone: "814-555-0100" })).toBe(true);
    expect(ok(EstimateResponse, { status: "call_us", reason: "no_price_for_size", phone: null })).toBe(true);
    // An unknown county goes to the manual path (whose zip supplies one), and
    // to "call us" only if the zip has none either. Never to a default rate.
    expect(ok(EstimateResponse, { status: "manual_required", reason: "unknown_county" })).toBe(true);
    expect(ok(EstimateResponse, { status: "call_us", reason: "unknown_county", phone: null })).toBe(true);
  });

  it("always shows the county on a priced quote", () => {
    const { county: _county, ...withoutCounty } = priced;
    expect(ok(EstimateResponse, withoutCounty)).toBe(false);
    expect(ok(EstimateResponse, { ...priced, county: "" })).toBe(false);
  });

  it("has no place for a rate, a tier or a region group in a priced response", () => {
    // The schemas are strict, so a Lambda that tried to return any of these would fail validation.
    for (const leak of [
      { pricePerSqftMicrocents: 750000 },
      { regionGroup: "core" },
      { tier: { minSqft: 5000, maxSqft: 10000 } },
      { minChargeCents: 4500 },
      { coverageFactor: 0.7 },
      { versionId: "9b2f5e0e-6f0e-4a56-9f5e-0f8f1c2d3e4f" },
    ]) {
      expect(ok(EstimateResponse, { ...priced, ...leak }), JSON.stringify(leak)).toBe(false);
      expect(ok(EstimateResponse, { ...priced, quote: { ...quote, ...leak } }), JSON.stringify(leak)).toBe(false);
      const lines = [{ ...quote.lines[0], ...leak }];
      expect(ok(EstimateResponse, { ...priced, quote: { ...quote, lines } }), JSON.stringify(leak)).toBe(false);
    }
    expectTypeOf<QuoteLine>().toEqualTypeOf<{ serviceCode: string; name: string; amountCents: number; taxable: boolean }>();
  });

  it("requires line items, each with its own taxable flag, and whole cents", () => {
    expect(ok(EstimateResponse, { ...priced, quote: { ...quote, lines: [] } })).toBe(false);
    expect(ok(EstimateResponse, { ...priced, quote: { ...quote, lines: [{ serviceCode: "mow", name: "Mowing", amountCents: 4800 }] } })).toBe(false);
    expect(ok(EstimateResponse, { ...priced, quote: { ...quote, totalCents: 110.88 } })).toBe(false);
    expect(ok(EstimateResponse, { ...priced, quote: { ...quote, taxRateBps: 0.06 } })).toBe(false);
  });
});

describe("POST /submit", () => {
  const body = { token: "signed.token", contact: { name: "Pat", phone: "814-555-0100" }, turnstile: "t", embedOrigin: null };

  it("accepts a contact with a phone, an email, or both", () => {
    expect(ok(SubmitRequest, body)).toBe(true);
    expect(ok(SubmitRequest, { ...body, contact: { name: "Pat", email: "pat@example.com" } })).toBe(true);
    expect(ok(SubmitRequest, { ...body, contact: { name: "Pat", phone: "(814) 555-0100", email: "pat@example.com" } })).toBe(true);
    expect(ok(SubmitRequest, { ...body, website: "" })).toBe(true);
  });

  it.each([
    ["a contact with neither phone nor email", { ...body, contact: { name: "Pat" } }],
    ["a blank name", { ...body, contact: { name: "  ", phone: "814-555-0100" } }],
    ["a malformed email", { ...body, contact: { name: "Pat", email: "pat@" } }],
    ["a filled honeypot", { ...body, website: "http://spam.example" }],
    ["no quote token", { ...body, token: undefined }],
    ["no Turnstile token", { ...body, turnstile: undefined }],
    ["a price in the request", { ...body, totalCents: 1 }],
    ["an address asked for a second time", { ...body, address: "123 Main St" }],
  ])("rejects %s", (_name, value) => {
    expect(ok(SubmitRequest, value)).toBe(false);
  });

  it("answers with the quote id", () => {
    expect(ok(SubmitResponse, { status: "submitted", quoteId: "9b2f5e0e-6f0e-4a56-9f5e-0f8f1c2d3e4f" })).toBe(true);
    expect(ok(SubmitResponse, { status: "submitted", quoteId: "1" })).toBe(false);
  });
});

describe("company-api", () => {
  const content = {
    minChargeCents: 4500,
    coverageFactor: 0.7,
    services: [{ code: "mow", name: "Mowing", taxable: true, season: "growing" }],
    tiers: [{ serviceCode: "mow", regionGroup: "core", minSqft: 5000, maxSqft: 10000, pricePerSqftMicrocents: 750000, flatPriceCents: null }],
  };
  const withTier = (tier: object) => ({ ...content, tiers: [{ ...content.tiers[0], ...tier }] });

  it("accepts a pricing version", () => {
    expect(ok(PricingVersionContent, content)).toBe(true);
    expect(ok(PricingVersionContent, withTier({ pricePerSqftMicrocents: null, flatPriceCents: 4500 }))).toBe(true);
  });

  it.each([
    ["a service without a taxable flag", { ...content, services: [{ code: "mow", name: "Mowing", season: "growing" }] }],
    ["a tier with both prices", withTier({ flatPriceCents: 4500 })],
    ["a tier with neither price", withTier({ pricePerSqftMicrocents: null })],
    ["a tier whose range is empty", withTier({ minSqft: 10000, maxSqft: 10000 })],
    ["a tier for a service the version does not have", withTier({ serviceCode: "aerate" })],
    ["two services with one code", { ...content, services: [content.services[0], content.services[0]] }],
    ["a price in dollars", { ...content, minChargeCents: 45.5 }],
    ["a coverage factor above 1", { ...content, coverageFactor: 70 }],
  ])("rejects %s", (_name, value) => {
    expect(ok(PricingVersionContent, value)).toBe(false);
  });

  it("validates theming: hex color, logo key from our bucket only", () => {
    expect(ok(UpdateCompanyRequest, { theme: { color: "#116633", logoKey: "logos/abc/logo.png" } })).toBe(true);
    expect(ok(UpdateCompanyRequest, {})).toBe(true);
    for (const theme of [
      { color: "red" },
      { color: "#11663" },
      { color: "#116633;background:url(//evil.example)" },
      { logoKey: "https://evil.example/logo.png" },
      { logoKey: "logos/../secret.png" },
      { css: "body{display:none}" },
    ]) {
      expect(ok(UpdateCompanyRequest, { theme }), JSON.stringify(theme)).toBe(false);
    }
  });

  it("never lets a request choose the company or the slug", () => {
    expect(ok(UpdateCompanyRequest, { id: "9b2f5e0e-6f0e-4a56-9f5e-0f8f1c2d3e4f" })).toBe(false);
    expect(ok(UpdateCompanyRequest, { slug: "someone-else" })).toBe(false);
    expect(ok(UpdateCompanyRequest, { companyId: "9b2f5e0e-6f0e-4a56-9f5e-0f8f1c2d3e4f" })).toBe(false);
    expect(ok(UpdateCompanyRequest, { allowedOrigins: ["https://joeslawn.com/"] })).toBe(false);
    expect(Object.keys(Company.shape)).not.toContain("stripeCustomerId");
  });

  it("carries allowed origins and theme on the company route, both ways", () => {
    const company = {
      id: "9b2f5e0e-6f0e-4a56-9f5e-0f8f1c2d3e4f",
      slug: "joes-lawn",
      name: "Joe's Lawn",
      hicNo: null,
      allowedOrigins: ["https://joeslawn.com", "https://www.joeslawn.com"],
      theme: { color: "#116633", logoKey: "logos/joes-lawn/logo.png" },
    };
    expect(ok(Company, company)).toBe(true);
    expect(ok(Company, { ...company, allowedOrigins: undefined })).toBe(false);
    expect(ok(Company, { ...company, theme: undefined })).toBe(false);
    expect(ok(UpdateCompanyRequest, { allowedOrigins: [], theme: {} })).toBe(true);
    expect(ok(UpdateCompanyRequest, { allowedOrigins: company.allowedOrigins })).toBe(true);
    for (const origin of ["joeslawn.com", "https://joeslawn.com/", "https://*.joeslawn.com", "*", "javascript:alert(1)"]) {
      expect(ok(UpdateCompanyRequest, { allowedOrigins: [origin] }), origin).toBe(false);
    }
    expect(routes.getCompany.response).toBe(Company);
    expect(routes.updateCompany.request).toBe(UpdateCompanyRequest);
  });

  it("describes a draft's diff against the published version", () => {
    const service = content.services[0]!;
    const tier = content.tiers[0]!;
    const diff = {
      draftId: "9b2f5e0e-6f0e-4a56-9f5e-0f8f1c2d3e4f",
      publishedId: "1b2f5e0e-6f0e-4a56-9f5e-0f8f1c2d3e4f",
      identical: false,
      minChargeCents: { from: 4500, to: 5000 },
      coverageFactor: null,
      services: { added: [], removed: [], changed: [{ from: service, to: { ...service, taxable: false } }] },
      tiers: { added: [{ ...tier, minSqft: 10000, maxSqft: 20000 }], removed: [], changed: [{ from: tier, to: { ...tier, pricePerSqftMicrocents: 800000 } }] },
    };
    const empty = { added: [], removed: [], changed: [] };
    expect(ok(PricingVersionDiff, diff)).toBe(true);
    // Nothing published yet, and a draft that changes nothing.
    expect(ok(PricingVersionDiff, { ...diff, publishedId: null })).toBe(true);
    expect(ok(PricingVersionDiff, { ...diff, identical: true, minChargeCents: null, services: empty, tiers: empty })).toBe(true);
    expect(ok(PricingVersionDiff, { ...diff, minChargeCents: { from: 4500 } })).toBe(false);
    expect(ok(PricingVersionDiff, { ...diff, minChargeCents: { from: 45.0, to: 50.5 } })).toBe(false);
    expect(ok(PricingVersionDiff, { ...diff, tiers: { ...empty, changed: [{ from: tier, to: { ...tier, flatPriceCents: 1 } }] } })).toBe(false);
    expect(routes.diffPricingVersion).toMatchObject({ method: "GET", path: "/pricing-versions/{id}/diff", auth: "owner" });
  });

  it("validates a lead decision: accept, adjust or decline", () => {
    expect(ok(LeadDecisionRequest, { action: "accept" })).toBe(true);
    expect(ok(LeadDecisionRequest, { action: "adjust", adjustedTotalCents: 5500 })).toBe(true);
    expect(ok(LeadDecisionRequest, { action: "decline" })).toBe(true);
    for (const body of [
      { action: "adjust" },
      { action: "adjust", adjustedTotalCents: 55.5 },
      { action: "adjust", adjustedTotalCents: -1 },
      { action: "accept", adjustedTotalCents: 5500 },
      { action: "decline", adjustedTotalCents: 5500 },
      { action: "expire" },
      { decision: "accepted" },
      { action: "accept", companyId: "9b2f5e0e-6f0e-4a56-9f5e-0f8f1c2d3e4f" },
    ]) {
      expect(ok(LeadDecisionRequest, body), JSON.stringify(body)).toBe(false);
    }
    expect(routes.decideLead).toMatchObject({ method: "POST", path: "/leads/{id}/decision", auth: "owner" });
  });

  it("answers a second decision on a lead with 409 lead_already_decided", () => {
    expect(routes.decideLead.errors).toEqual({ 409: "lead_already_decided" });
    expect(ErrorCode.options).toContain(routes.decideLead.errors[409]);
    expect(ok(ErrorResponse, { error: { code: "lead_already_decided", message: "lead is already accepted" } })).toBe(true);
    // Every route-specific error is a known code.
    for (const route of Object.values(routes)) {
      if ("errors" in route) {
        for (const code of Object.values(route.errors)) expect(ErrorCode.options, route.path).toContain(code);
      }
    }
  });

  it("validates the lead list query", () => {
    expect(ListLeadsQuery.parse({})).toEqual({ limit: 25 });
    expect(ListLeadsQuery.parse({ limit: "50", status: "submitted" })).toEqual({ limit: 50, status: "submitted" });
    expect(ok(ListLeadsQuery, { limit: "500" })).toBe(false);
    expect(ok(ListLeadsQuery, { status: "priced" })).toBe(false);
  });
});

describe("routes", () => {
  it("lists every route once, public ones only for estimate, submit, the website contact form and the profile", () => {
    const list = Object.values(routes);
    const keys = list.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(list.filter((r) => r.auth === "public").map((r) => r.path)).toEqual(["/estimate", "/submit", "/contact", "/profile/{company}"]);
    for (const route of list) {
      expect(route.response, route.path).toBeInstanceOf(z.ZodType);
      if (route.method !== "GET") expect("request" in route, route.path).toBe(true);
    }
  });

  it("has one error shape", () => {
    expect(ok(ErrorResponse, { error: { code: "turnstile_failed", message: "Turnstile verification failed" } })).toBe(true);
    expect(ok(ErrorResponse, { error: { code: "made_up", message: "x" } })).toBe(false);
  });
});
