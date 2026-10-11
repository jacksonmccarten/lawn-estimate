// /estimate and /submit against a real database, as app_public through
// withPublic. Regrid, Turnstile and the notifier are fakes: no test calls a
// real service.

import { EstimateResponse } from "@lq/api-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Entitlement } from "../src/billing.js";
import type { PublicDeps } from "../src/public/deps.js";
import { createEstimateHandler } from "../src/public/estimate.js";
import { createProfileHandler } from "../src/public/profile.js";
import type { AlertTargets, LeadAlert } from "../src/public/notify.js";
import type { Parcel, RegridResult } from "../src/public/regrid.js";
import { createSubmitHandler } from "../src/public/submit.js";
import { createTokenCodec } from "../src/public/token.js";
import type { TurnstileResult } from "../src/public/turnstile.js";
import { createTestDb, event, read, type TestCompany, type TestDb } from "./harness.js";

const HOME = "123 Main St, State College, PA 16801";
// The worked example of design section 8.
const HOME_PARCEL: Parcel = { regridId: "parcel-home", parcelSqft: 11_200, footprintSqft: 2_100, state: "PA", county: "Centre", zip: "16801" };

let db: TestDb;
let alpha: TestCompany;
let bravo: TestCompany; // no quota: a company that has not subscribed
let deps: PublicDeps;
let estimate: ReturnType<typeof createEstimateHandler>;
let submit: ReturnType<typeof createSubmitHandler>;

// The fakes, reset before each test.
let parcels: Map<string, RegridResult>;
let regridCalls: string[];
let turnstile: TurnstileResult;
let alerts: { alert: LeadAlert; targets: AlertTargets }[];
let smsGoesOut: boolean;
let logs: { level: string; event: string; fields: unknown }[];

const post = async (handler: typeof estimate, body: unknown, headers?: Record<string, string>) =>
  read(await handler(event({ body, ...(headers ? { headers } : {}) })));

const estimateBody = (over: Record<string, unknown> = {}) => ({
  company: "alpha",
  address: HOME,
  service: "mow",
  turnstile: "ts-token",
  embedOrigin: null,
  ...over,
});

/** A fresh address in 16801 with a parcel of its own, so tests do not share cache rows. */
let serial = 0;
function newAddress(parcel: Partial<Parcel> = {}): string {
  const address = `${++serial} Oak Ln, State College, PA 16801`;
  parcels.set(address, { kind: "match", parcel: { ...HOME_PARCEL, regridId: `parcel-${serial}`, ...parcel } });
  return address;
}

const usage = (company: TestCompany) =>
  db.asCompany(company.id, async (q) => {
    const res = await q.query<{ regrid_lookups: number; quotes: number }>("SELECT regrid_lookups, quotes FROM usage_meters");
    return res.rows[0] ?? { regrid_lookups: 0, quotes: 0 };
  });

const rows = <R extends object>(company: TestCompany, sql: string, params: unknown[] = []) =>
  db.asCompany(company.id, async (q) => (await q.query<R>(sql, params)).rows);

beforeAll(async () => {
  db = await createTestDb();
  alpha = await db.seedCompany("alpha", { allowedOrigins: ["https://joeslawn.com"] });
  bravo = await db.seedCompany("bravo", { quota: 0 });
  // A zip the Census file does not have, inside alpha's service area.
  await db.asCompany(alpha.id, (q) =>
    q.query("INSERT INTO service_regions (company_id, kind, value, tier_group) VALUES ($1, 'zip', '99999', 'core')", [alpha.id]),
  );

  deps = {
    withPublic: db.withPublic,
    turnstile: async () => turnstile,
    regrid: async (address) => {
      regridCalls.push(address);
      return parcels.get(address) ?? { kind: "no_match" };
    },
    tokens: createTokenCodec("test-secret-test-secret-test-secret"),
    notifier: {
      async leadCreated(alert, targets) {
        alerts.push({ alert, targets });
        return { email: targets.email !== null, sms: smsGoesOut && targets.smsAllowed };
      },
    },
    billing: null,
    ipHashSalt: "pepper",
    widgetOrigin: null,
    log: (level, name, fields) => void logs.push({ level, event: name, fields }),
  };
  estimate = createEstimateHandler(deps);
  submit = createSubmitHandler(deps);
}, 120_000);

afterAll(() => db?.close());

beforeEach(() => {
  parcels = new Map([[HOME, { kind: "match", parcel: HOME_PARCEL }]]);
  regridCalls = [];
  turnstile = "ok";
  alerts = [];
  smsGoesOut = false;
  logs = [];
});

describe("POST /estimate", () => {
  it("prices the worked example: 11,200 sqft lot, 2,100 sqft house, $50.88", async () => {
    const { status, body } = await post(estimate, estimateBody());
    expect(status).toBe(200);
    expect(body).toEqual({
      status: "priced",
      quote: {
        lines: [{ serviceCode: "mow", name: "Mowing", amountCents: 4800, taxable: true }],
        subtotalCents: 4800,
        taxableSubtotalCents: 4800,
        taxRateBps: 600,
        taxCents: 288,
        totalCents: 5088,
      },
      token: expect.any(String),
      grassSqft: 6400,
      parcelSqft: 11_200,
      origin: "regrid",
      county: "Centre",
      assumptions: ["Lot size is from county tax records, not a survey.", "Buildings on the lot are left out of the lawn area."],
      canAdjust: true,
    });

    // The quote owns its numbers (R12) and pins the version that priced it.
    const [quote] = await rows<Record<string, unknown>>(alpha, "SELECT * FROM quotes WHERE address_text = $1", [HOME]);
    expect(quote).toMatchObject({
      version_id: alpha.versionId,
      status: "priced",
      zip: "16801",
      county: "Centre",
      region_group: "core",
      parcel_sqft: 11_200,
      footprint_sqft: 2_100,
      grass_sqft: 6400,
      origin: "regrid",
      tax_rate: "0.0600",
      tax_cents: 288,
      total_cents: 5088,
      regrid_parcel_id: "parcel-home",
      turnstile_ok: true,
      host_origin: null,
    });
    // The IP is stored only as a salted hash.
    expect(quote!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(quote)).not.toContain("203.0.113.7");
  });

  it("looks an address up once: the second estimate comes from parcel_cache and is not metered", async () => {
    const address = newAddress();
    const before = await usage(alpha);
    await post(estimate, estimateBody({ address }));
    // Same address, typed differently.
    const again = await post(estimate, estimateBody({ address: `  ${address.toUpperCase().replace(",", " ,")}` }));
    expect(again.body.status).toBe("priced");
    expect(regridCalls).toEqual([address]);
    expect(await usage(alpha)).toEqual({ regrid_lookups: before.regrid_lookups + 1, quotes: before.quotes + 2 });
  });

  it("keeps pricing from a quote's own numbers after parcel_cache is truncated (R10)", async () => {
    const address = newAddress();
    const first = await post(estimate, estimateBody({ address }));
    await db.owner.query("TRUNCATE parcel_cache");
    const adjusted = await post(estimate, { token: first.body.token, adjust: "larger", turnstile: "t", embedOrigin: null });
    expect(adjusted.body).toMatchObject({ status: "priced", grassSqft: 8000 });
  });

  it("never sends a rate, a tier, a region group or the coverage factor", async () => {
    const { body } = await post(estimate, estimateBody({ address: newAddress() }));
    const text = JSON.stringify(body);
    for (const secret of ["750000", "900000", "core", "4500", "0.7", "minCharge", "tier", "regionGroup", "version"]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("uses the no-footprint formula when Regrid sends no footprint, and says so", async () => {
    const { body } = await post(estimate, estimateBody({ address: newAddress({ parcelSqft: 10_000, footprintSqft: null }) }));
    expect(body).toMatchObject({ status: "priced", grassSqft: 6000 });
    expect(body.assumptions).toContain("Includes the house footprint.");
  });

  it("applies the minimum charge, and taxes it as the service is taxed", async () => {
    // 3,000 sqft lot: 2,100 grass x $0.009 = $18.90, below the $45.00 minimum.
    const { body } = await post(estimate, estimateBody({ address: newAddress({ parcelSqft: 3_000, footprintSqft: 0 }) }));
    expect(body.quote).toMatchObject({ lines: [{ amountCents: 4500, taxable: true }], taxCents: 270, totalCents: 4770 });
  });

  it("takes the tax county from the parcel, not the zip: Allegheny at 7%", async () => {
    // 15085 is mostly Westmoreland (6%); this parcel is on the Allegheny side.
    const address = "9 Border Rd, Trafford, PA 15085";
    parcels.set(address, { kind: "match", parcel: { ...HOME_PARCEL, regridId: "parcel-border", county: "allegheny", zip: "15085" } });
    const { body } = await post(estimate, estimateBody({ address }));
    expect(body).toMatchObject({ status: "priced", county: "Allegheny", quote: { taxRateBps: 700, taxCents: 448 } });
  });

  it("finds the region by county when no zip region matches: Philadelphia at 8%", async () => {
    const address = "1 Market St, Philadelphia, PA 19103";
    parcels.set(address, { kind: "match", parcel: { ...HOME_PARCEL, regridId: "parcel-phl", county: "Philadelphia", zip: "19103" } });
    const { body } = await post(estimate, estimateBody({ address }));
    expect(body).toMatchObject({ status: "priced", county: "Philadelphia", quote: { taxRateBps: 800 } });
  });

  describe("no automatic price", () => {
    it("refuses an address outside every region before any Regrid call, with the company's phone", async () => {
      const before = await usage(alpha);
      const { body } = await post(estimate, estimateBody({ address: "5 State St, Harrisburg, PA 17101" }));
      expect(body).toEqual({ status: "call_us", reason: "outside_service_area", phone: "814-555-0100" });
      expect(regridCalls).toEqual([]);
      expect(await usage(alpha)).toEqual(before);
    });

    it("refuses after the lookup when only the parcel shows the place is outside", async () => {
      const address = "7 Nowhere Rd, Harrisburg";
      parcels.set(address, { kind: "match", parcel: { ...HOME_PARCEL, regridId: "parcel-hbg", county: "Dauphin", zip: "17101" } });
      expect((await post(estimate, estimateBody({ address }))).body).toMatchObject({ status: "call_us", reason: "outside_service_area" });
    });

    it.each([
      ["no_match", { kind: "no_match" }, "no_match"],
      ["more than one candidate", { kind: "ambiguous" }, "ambiguous_match"],
      ["a Regrid outage", { kind: "unavailable" }, "lookup_unavailable"],
      ["a parcel over two acres", { kind: "match", parcel: { ...HOME_PARCEL, regridId: "big", parcelSqft: 87_121 } }, "parcel_over_two_acres"],
      ["a parcel with no size", { kind: "match", parcel: { ...HOME_PARCEL, regridId: "nosize", parcelSqft: null } }, "no_match"],
      ["a county with no tax rate on file", { kind: "match", parcel: { ...HOME_PARCEL, regridId: "oh", state: "OH", county: "Franklin" } }, "unknown_county"],
      ["a parcel with no county", { kind: "match", parcel: { ...HOME_PARCEL, regridId: "nocounty", county: null } }, "unknown_county"],
    ] as const)("shows the manual path for %s", async (_name, result, reason) => {
      const address = `${++serial} Elm St, State College, PA 16801`;
      parcels.set(address, result as RegridResult);
      const quotesBefore = (await usage(alpha)).quotes;
      expect((await post(estimate, estimateBody({ address }))).body).toEqual({ status: "manual_required", reason });
      // Nothing was priced, at any rate, least of all a default one (R4).
      expect((await usage(alpha)).quotes).toBe(quotesBefore);
    });

    it("asks the homeowner to call when no tier covers the size", async () => {
      const address = newAddress({ parcelSqft: 80_000, footprintSqft: 0 });
      expect((await post(estimate, estimateBody({ address }))).body).toEqual({
        status: "call_us",
        reason: "no_price_for_size",
        phone: "814-555-0100",
      });
    });
  });

  describe("manual path", () => {
    const manual = (zip: string, over: Record<string, unknown> = {}) =>
      estimateBody({ address: `${++serial} Manual Way`, manual: { zip, size: { kind: "bucket", bucket: "quarter_acre" }, ...over } });

    it("prices a lot-size bucket in full at the zip's county, with no Regrid call", async () => {
      const { body } = await post(estimate, manual("19103"));
      // The whole quarter acre: 10,890 rounds to 10,900; x $0.01 = $109.00; Philadelphia's 8% is $8.72.
      expect(body).toMatchObject({
        status: "priced",
        grassSqft: 10_900,
        parcelSqft: null,
        origin: "bucket",
        county: "Philadelphia",
        assumptions: ["Based on the lot size you chose.", "Counts the whole lot, house and driveway included."],
        canAdjust: false,
        quote: { subtotalCents: 10_900, taxRateBps: 800, taxCents: 872, totalCents: 11_772 },
      });
      expect(regridCalls).toEqual([]);
    });

    it("asks the homeowner to call when the whole lot is larger than any tier", async () => {
      // The core group's tiers stop at 10,000 sq ft; a quarter acre, counted in full, is over that.
      expect((await post(estimate, manual("16801"))).body).toMatchObject({ status: "call_us", reason: "no_price_for_size" });
    });

    it("takes a typed lawn area as given", async () => {
      const { body } = await post(estimate, manual("16801", { size: { kind: "sqft", sqft: 4_449 } }));
      expect(body).toMatchObject({ status: "priced", grassSqft: 4400, origin: "manual", assumptions: ["Based on the lawn area you entered."] });
    });

    it("prices the lawn the homeowner outlined on the aerial photo, with no coverage factor and no Regrid call", async () => {
      const address = "9 Drawn Ct, State College, PA 16801";
      const { status, body } = await post(estimate, estimateBody({ address, manual: { zip: "16801", size: { kind: "drawn", sqft: 6_449 } } }));
      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "priced",
        grassSqft: 6400,
        parcelSqft: null,
        origin: "drawn",
        county: "Centre",
        assumptions: ["Measured on an aerial photo, not a survey."],
        canAdjust: false,
        quote: { subtotalCents: 4800, taxCents: 288, totalCents: 5088 },
      });
      expect(regridCalls).toEqual([]);
      const [quote] = await rows<{ origin: string; grass_sqft: number }>(alpha, "SELECT origin, grass_sqft FROM quotes WHERE address_text = $1", [address]);
      expect(quote).toEqual({ origin: "drawn", grass_sqft: 6400 });
    });

    it("asks which county when the zip's counties are taxed differently, and sends no rates", async () => {
      const { body } = await post(estimate, manual("15085"));
      expect(body).toEqual({ status: "county_required", zip: "15085", candidates: ["Westmoreland", "Allegheny"] });
    });

    it("prices at the county the homeowner chose", async () => {
      const allegheny = await post(estimate, manual("15085", { county: "allegheny" }));
      expect(allegheny.body).toMatchObject({ status: "priced", county: "Allegheny", quote: { taxRateBps: 700 } });
      const westmoreland = await post(estimate, manual("15085", { county: "Westmoreland" }));
      expect(westmoreland.body).toMatchObject({ status: "priced", county: "Westmoreland", quote: { taxRateBps: 600 } });
    });

    it("accepts only a county the zip lies in", async () => {
      const { status, body } = await post(estimate, manual("15085", { county: "Philadelphia" }));
      expect(status).toBe(400);
      expect(body.error).toMatchObject({ code: "invalid_request", fields: { "manual.county": expect.any(String) } });
    });

    it("lets a cached parcel's county win over the zip", async () => {
      // The parcel was too large for the formula, but its county is known.
      const address = "40 Farm Rd, Trafford, PA 15085";
      parcels.set(address, { kind: "match", parcel: { ...HOME_PARCEL, regridId: "farm", parcelSqft: 200_000, county: "Allegheny", zip: "15085" } });
      expect((await post(estimate, estimateBody({ address }))).body).toMatchObject({ reason: "parcel_over_two_acres" });
      const { body } = await post(estimate, estimateBody({ address, manual: { zip: "15085", size: { kind: "sqft", sqft: 30_000 } } }));
      expect(body).toMatchObject({ status: "priced", county: "Allegheny", quote: { taxRateBps: 700 } });
    });

    it("asks the homeowner to call when the zip has no county on file: never a default rate", async () => {
      const quotesBefore = (await usage(alpha)).quotes;
      expect((await post(estimate, manual("99999"))).body).toEqual({ status: "call_us", reason: "unknown_county", phone: "814-555-0100" });
      expect((await usage(alpha)).quotes).toBe(quotesBefore);
    });

    it("requires the zip", async () => {
      const { status, body } = await post(estimate, estimateBody({ manual: { size: { kind: "sqft", sqft: 5000 } } }));
      expect(status).toBe(400);
      expect(body.error.code).toBe("invalid_request");
    });
  });

  describe("gate", () => {
    it("refuses a failed Turnstile check before anything else", async () => {
      turnstile = "failed";
      const { status, body } = await post(estimate, estimateBody({ address: newAddress() }));
      expect([status, body.error.code]).toEqual([403, "turnstile_failed"]);
      expect(regridCalls).toEqual([]);
    });

    it("spends nothing at Regrid while Turnstile is down, and keeps the manual path open", async () => {
      turnstile = "unavailable";
      expect((await post(estimate, estimateBody({ address: newAddress() }))).body).toEqual({
        status: "manual_required",
        reason: "lookup_unavailable",
      });
      expect(regridCalls).toEqual([]);

      const address = `${++serial} Manual Way`;
      const priced = await post(estimate, estimateBody({ address, manual: { zip: "16801", size: { kind: "sqft", sqft: 5000 } } }));
      expect(priced.body.status).toBe("priced");
      const [quote] = await rows<{ turnstile_ok: boolean }>(alpha, "SELECT turnstile_ok FROM quotes WHERE address_text = $1", [address]);
      expect(quote!.turnstile_ok).toBe(false);
    });

    it("allows the hosted page and listed sites, and refuses any other embedding origin", async () => {
      const listed = await post(estimate, estimateBody({ embedOrigin: "https://JoesLawn.com" }));
      expect(listed.body.status).toBe("priced");

      const address = newAddress();
      const { status, body } = await post(estimate, estimateBody({ address, embedOrigin: "https://evil.example" }));
      expect([status, body.error.code]).toEqual([403, "origin_not_allowed"]);
      expect(regridCalls).not.toContain(address);
      expect(logs).toContainEqual({ level: "warn", event: "origin_refused", fields: { check: "embed", company: "alpha" } });
    });

    it("lets any site embed the widget of a company that lists none", async () => {
      const setOrigins = (origins: string[]) => db.asCompany(alpha.id, (q) => q.query("UPDATE companies SET allowed_origins = $1 WHERE id = $2", [origins, alpha.id]));
      await setOrigins([]);
      try {
        const anywhere = await post(estimate, estimateBody({ address: newAddress(), embedOrigin: "https://any-site.example" }));
        expect(anywhere.body.status).toBe("priced");
      } finally {
        await setOrigins(["https://joeslawn.com"]);
      }
    });

    it("refuses a request that does not come from the widget app, when its origin is configured", async () => {
      const strict = createEstimateHandler({ ...deps, widgetOrigin: "https://w.example.com" });
      const refused = await post(strict, estimateBody(), { origin: "https://elsewhere.example" });
      expect([refused.status, refused.body.error.code]).toEqual([403, "origin_not_allowed"]);
      const allowed = await post(strict, estimateBody(), { origin: "https://w.example.com" });
      expect(allowed.body.status).toBe("priced");
    });

    it("gives a company with no quota no estimates and no Regrid calls", async () => {
      for (const body of [
        estimateBody({ company: "bravo", address: newAddress() }),
        estimateBody({ company: "bravo", manual: { zip: "16801", size: { kind: "sqft", sqft: 5000 } } }),
      ]) {
        const res = await post(estimate, body);
        expect([res.status, res.body.error.code]).toEqual([429, "quota_exceeded"]);
      }
      expect(regridCalls).toEqual([]);
      expect(await usage(bravo)).toEqual({ regrid_lookups: 0, quotes: 0 });
    });

    it("stops a company at its monthly quota", async () => {
      const charlie = await db.seedCompany("charlie", { quota: 2 });
      const lookup = () => post(estimate, estimateBody({ company: "charlie", address: newAddress() }));
      expect((await lookup()).body.status).toBe("priced");
      expect((await lookup()).body.status).toBe("priced");
      // 80% of 2 rounds up to 2: the alert fires on the last lookup.
      expect(logs).toContainEqual({ level: "warn", event: "regrid_quota_80", fields: { company: "charlie", lookups: 2 } });
      const third = await lookup();
      expect([third.status, third.body.error.code]).toEqual([429, "quota_exceeded"]);
      expect(regridCalls).toHaveLength(2);
      expect((await usage(charlie)).regrid_lookups).toBe(2);
    });

    it("falls back to the manual path at the global cap of 8,000 lookups, and alarms", async () => {
      const delta = await db.seedCompany("delta");
      await db.asCompany(delta.id, (q) =>
        q.query("INSERT INTO usage_meters (company_id, month, regrid_lookups) VALUES ($1, usage_month(), 8000)", [delta.id]),
      );
      try {
        const address = newAddress();
        expect((await post(estimate, estimateBody({ address }))).body).toEqual({ status: "manual_required", reason: "lookup_unavailable" });
        expect(regridCalls).toEqual([]);
        expect(logs.some((l) => l.level === "error" && l.event === "regrid_global_cap")).toBe(true);
        // Cached addresses and the manual path still price.
        expect((await post(estimate, estimateBody())).body.status).toBe("priced");
      } finally {
        await db.asCompany(delta.id, (q) => q.query("DELETE FROM usage_meters"));
      }
    });

    it("meters concurrent lookups without losing a count", async () => {
      const before = (await usage(alpha)).regrid_lookups;
      const addresses = Array.from({ length: 6 }, () => newAddress());
      const results = await Promise.all(addresses.map((address) => post(estimate, estimateBody({ address }))));
      expect(results.map((r) => r.body.status)).toEqual(Array(6).fill("priced"));
      expect((await usage(alpha)).regrid_lookups).toBe(before + 6);
    });

    it("answers 404 for an unknown company and 400 for a service it does not sell or a bad body", async () => {
      expect((await post(estimate, estimateBody({ company: "nobody" }))).status).toBe(404);
      const service = await post(estimate, estimateBody({ address: newAddress(), service: "aerate" }));
      expect([service.status, service.body.error.fields]).toEqual([400, { service: "not offered" }]);
      expect(regridCalls).toEqual([]);

      const bad = await post(estimate, estimateBody({ address: "x", extra: 1 }));
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("invalid_request");
      expect(read(await estimate(event({}))).status).toBe(400);
    });
  });

  describe("adjust", () => {
    const adjustBody = (token: string, adjust = "smaller") => ({ token, adjust, turnstile: "t", embedOrigin: null });

    it("re-prices once, keeps the original estimate, and refuses a second adjustment", async () => {
      const address = newAddress();
      const first = await post(estimate, estimateBody({ address }));
      const { status, body } = await post(estimate, adjustBody(first.body.token));
      expect(status).toBe(200);
      // 6,400 x 0.75 = 4,800 sqft: $43.20 of labor, so the $45.00 minimum applies.
      expect(body).toMatchObject({
        status: "priced",
        grassSqft: 4800,
        origin: "regrid_adjusted",
        canAdjust: false,
        county: "Centre",
        quote: { subtotalCents: 4500, taxCents: 270, totalCents: 4770 },
      });
      expect(body.assumptions.at(-1)).toBe("Adjusted smaller at your request.");
      expect(EstimateResponse.safeParse(body).success).toBe(true);

      const [quote] = await rows(alpha, "SELECT grass_sqft, original_grass_sqft, origin, total_cents FROM quotes WHERE address_text = $1", [address]);
      expect(quote).toEqual({ grass_sqft: 4800, original_grass_sqft: 6400, origin: "regrid_adjusted", total_cents: 4770 });

      const second = await post(estimate, adjustBody(body.token, "larger"));
      expect([second.status, second.body.error.code]).toEqual([409, "conflict"]);
      expect(regridCalls).toEqual([address]);
    });

    it("re-prices from the quote's pinned version and tax rate, not the current ones", async () => {
      const echo = await db.seedCompany("echo");
      const first = await post(estimate, estimateBody({ company: "echo", address: newAddress() }));
      // A new version, twice the price, is published after the first estimate.
      await db.asCompany(echo.id, async (q) => {
        const v = await q.query<{ id: string }>(
          "INSERT INTO pricing_versions (company_id, version, min_charge_cents) VALUES ($1, 2, 9000) RETURNING id",
          [echo.id],
        );
        const s = await q.query<{ id: string }>(
          "INSERT INTO services (version_id, company_id, code, name, taxable) VALUES ($1, $2, 'mow', 'Mowing', true) RETURNING id",
          [v.rows[0]!.id, echo.id],
        );
        await q.query(
          `INSERT INTO pricing_tiers (version_id, company_id, service_id, region_group, min_sqft, max_sqft, price_per_sqft_microcents)
           VALUES ($1, $2, $3, 'core', 0, 20000, 1500000)`,
          [v.rows[0]!.id, echo.id, s.rows[0]!.id],
        );
        await q.query("UPDATE pricing_versions SET published_at = now() WHERE id = $1", [v.rows[0]!.id]);
      });
      const adjusted = await post(estimate, adjustBody(first.body.token, "larger"));
      // 8,000 sqft x $0.0075 from version 1.
      expect(adjusted.body.quote).toMatchObject({ subtotalCents: 6000, totalCents: 6360 });
      // A new estimate uses the new version.
      const fresh = await post(estimate, estimateBody({ company: "echo", address: newAddress() }));
      expect(fresh.body.quote.subtotalCents).toBe(9600);
    });

    it("does not adjust a manual estimate, and rejects a bad or expired token", async () => {
      const manual = await post(estimate, estimateBody({ address: "1 Manual Way", manual: { zip: "16801", size: { kind: "sqft", sqft: 5000 } } }));
      expect((await post(estimate, adjustBody(manual.body.token))).status).toBe(409);

      const forged = await post(estimate, adjustBody(`${manual.body.token}x`));
      expect([forged.status, forged.body.error.code]).toEqual([400, "token_invalid"]);

      const old = createTokenCodec("test-secret-test-secret-test-secret", () => new Date("2026-01-01T00:00:00Z"));
      const expired = await post(estimate, adjustBody(old.sign({ quoteId: alpha.id, company: "alpha" })));
      expect([expired.status, expired.body.error.code]).toEqual([410, "token_expired"]);
    });

    it("cannot reach another company's quote with a token that names the wrong company", async () => {
      const first = await post(estimate, estimateBody({ address: newAddress() }));
      const quoteId = deps.tokens.verify(first.body.token).quoteId;
      const crossed = await post(estimate, adjustBody(deps.tokens.sign({ quoteId, company: "charlie" })));
      expect([crossed.status, crossed.body.error.code]).toEqual([410, "token_expired"]);
    });
  });
});

describe("POST /submit", () => {
  const contact = (n: number) => ({ name: "Pat Homeowner", phone: `814-555-${String(1000 + n)}`, email: `pat${n}@example.com` });
  const priced = async (company = "alpha") => {
    const address = newAddress();
    const res = await post(estimate, estimateBody({ company, address }));
    return { address, token: res.body.token as string, quoteId: deps.tokens.verify(res.body.token).quoteId };
  };
  const submitBody = (token: string, n: number, over: Record<string, unknown> = {}) => ({
    token,
    contact: contact(n),
    turnstile: "ts-token",
    embedOrigin: null,
    ...over,
  });
  const leadsOf = (quoteId: string) =>
    rows<{ id: string; name: string; notified_at: Date | null; sms_sent_at: Date | null }>(
      alpha,
      "SELECT id, name, notified_at, sms_sent_at FROM leads WHERE quote_id = $1",
      [quoteId],
    );

  it("stores the lead, marks the quote submitted and alerts the company by email", async () => {
    const quote = await priced();
    const { status, body } = await post(submit, submitBody(quote.token, 1));
    expect([status, body]).toEqual([200, { status: "submitted", quoteId: quote.quoteId }]);

    const [lead] = await leadsOf(quote.quoteId);
    expect(lead).toMatchObject({ name: "Pat Homeowner", notified_at: expect.any(Date), sms_sent_at: null });
    const [row] = await rows(alpha, "SELECT status FROM quotes WHERE id = $1", [quote.quoteId]);
    expect(row).toEqual({ status: "submitted" });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.targets).toEqual({ email: "owner@alpha.example", phone: "+18145550100", smsAllowed: true });
    expect(alerts[0]!.alert).toMatchObject({
      companyName: "alpha lawn",
      leadId: lead!.id,
      contact: contact(1),
      addressText: quote.address,
      county: "Centre",
      grassSqft: 6400,
      taxCents: 288,
      totalCents: 5088,
    });
  });

  it("answers a repeated submit the same way without a second lead or alert", async () => {
    const quote = await priced();
    await post(submit, submitBody(quote.token, 2));
    const again = await post(submit, submitBody(quote.token, 2));
    expect([again.status, again.body]).toEqual([200, { status: "submitted", quoteId: quote.quoteId }]);
    expect(await leadsOf(quote.quoteId)).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it("keeps a second lead from the same contact that day, but does not alert twice", async () => {
    await post(submit, submitBody((await priced()).token, 3));
    const second = await priced();
    // The same phone, written differently, and no email this time.
    await post(submit, submitBody(second.token, 3, { contact: { name: "Pat", phone: "(814) 555-1003" } }));
    const [lead] = await leadsOf(second.quoteId);
    expect(lead).toMatchObject({ name: "Pat", notified_at: null });
    expect(alerts).toHaveLength(1);
  });

  it("records an SMS alert, and stops offering SMS after 30 in a day", async () => {
    smsGoesOut = true;
    const quote = await priced();
    await post(submit, submitBody(quote.token, 4));
    expect((await leadsOf(quote.quoteId))[0]!.sms_sent_at).toBeInstanceOf(Date);

    await db.asCompany(alpha.id, (q) => q.query("UPDATE leads SET sms_sent_at = now()"));
    const filler = await rows<{ n: number }>(alpha, "SELECT count(*)::int AS n FROM leads WHERE sms_sent_at IS NOT NULL");
    // Top up to the cap with quotes and leads of their own.
    for (let i = filler[0]!.n; i < 30; i++) {
      const q = await priced();
      await post(submit, submitBody(q.token, 100 + i));
    }
    alerts = [];
    const capped = await priced();
    await post(submit, submitBody(capped.token, 5));
    expect(alerts[0]!.targets.smsAllowed).toBe(false);
    expect((await leadsOf(capped.quoteId))[0]).toMatchObject({ notified_at: expect.any(Date), sms_sent_at: null });
  });

  it("stores the lead even when no alert could be sent", async () => {
    const quiet = await db.seedCompany("foxtrot");
    await db.asCompany(quiet.id, (q) => q.query("UPDATE companies SET alert_email = NULL, alert_phone = NULL"));
    const res = await post(estimate, estimateBody({ company: "foxtrot", address: newAddress() }));
    expect((await post(submit, submitBody(res.body.token, 6))).status).toBe(200);
    const leads = await rows<{ notified_at: Date | null }>(quiet, "SELECT notified_at FROM leads");
    expect(leads).toEqual([{ notified_at: null }]);
  });

  it("swallows a honeypot hit: a success answer, no lead, no alert", async () => {
    const quote = await priced();
    const { status, body } = await post(submit, submitBody(quote.token, 7, { website: "http://spam.example" }));
    expect([status, body.status]).toEqual([200, "submitted"]);
    expect(await leadsOf(quote.quoteId)).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("refuses a failed Turnstile check, a forged token, a foreign origin and a bad contact", async () => {
    const quote = await priced();

    turnstile = "failed";
    const ts = await post(submit, submitBody(quote.token, 8));
    expect([ts.status, ts.body.error.code]).toEqual([403, "turnstile_failed"]);
    turnstile = "ok";

    const forged = await post(submit, submitBody(`x${quote.token}`, 8));
    expect([forged.status, forged.body.error.code]).toEqual([400, "token_invalid"]);

    const origin = await post(submit, submitBody(quote.token, 8, { embedOrigin: "https://evil.example" }));
    expect([origin.status, origin.body.error.code]).toEqual([403, "origin_not_allowed"]);

    const noContact = await post(submit, submitBody(quote.token, 8, { contact: { name: "Pat" } }));
    expect([noContact.status, noContact.body.error.code]).toEqual([400, "invalid_request"]);

    expect(await leadsOf(quote.quoteId)).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("still takes the lead while Turnstile is down", async () => {
    const quote = await priced();
    turnstile = "unavailable";
    expect((await post(submit, submitBody(quote.token, 9))).status).toBe(200);
    expect(await leadsOf(quote.quoteId)).toHaveLength(1);
  });
});

describe("GET /profile/{company}", () => {
  const get = async (company: string) =>
    read(await createProfileHandler({ withPublic: db.withPublic })(event({ routeKey: "GET /profile/{company}", company })));

  it("returns the name, the published services and the allowed origins, and nothing else", async () => {
    await db.asCompany(alpha.id, (q) =>
      q.query("UPDATE companies SET theme = $2 WHERE id = $1", [alpha.id, { color: "#116633", logoKey: "javascript:alert(1)" }]),
    );
    const { status, body } = await get("alpha");
    expect(status).toBe(200);
    expect(body).toEqual({
      slug: "alpha",
      name: "alpha lawn",
      // A logo key that is not one of ours is dropped.
      theme: { color: "#116633" },
      services: [{ code: "mow", name: "Mowing", season: "growing" }],
      allowedOrigins: ["https://joeslawn.com"],
    });
    // No rate, phone, alert address, quota or region.
    expect(JSON.stringify(body)).not.toMatch(/814|owner@|quota|16801|core|750/);
  });

  it("answers 404 for an unknown or malformed slug", async () => {
    for (const slug of ["nobody", "Not A Slug", ""]) {
      const { status, body } = await get(slug);
      expect(status, slug).toBe(404);
      expect(body.error.code).toBe("not_found");
    }
  });
});

describe("logs", () => {
  it("carry quote and lead ids, never an address, a name, a phone or an email", async () => {
    const address = "77 Private Dr, State College, PA 16801";
    parcels.set(address, { kind: "match", parcel: { ...HOME_PARCEL, regridId: "private" } });
    const res = await post(estimate, estimateBody({ address }));
    await post(submit, {
      token: res.body.token,
      contact: { name: "Secret Person", phone: "814-555-7777", email: "secret@example.com" },
      turnstile: "t",
      embedOrigin: null,
    });
    const text = JSON.stringify(logs);
    expect(logs.map((l) => l.event)).toEqual(["estimate_priced", "lead_created"]);
    for (const pii of ["Private", "Secret", "7777", "secret@", "203.0.113.7"]) {
      expect(text, pii).not.toContain(pii);
    }
  });
});

describe("what app_public can do after step 4", () => {
  it("executes exactly these functions, all SECURITY DEFINER, owned by app_definer, with a pinned search_path", async () => {
    const res = await db.owner.query<{ name: string; prosecdef: boolean; owner: string; proconfig: string[] | null }>(
      `SELECT p.proname AS name, p.prosecdef, p.proowner::regrole::text AS owner, p.proconfig
       FROM pg_proc p
       WHERE p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
         AND has_function_privilege('app_public', p.oid, 'EXECUTE')
       ORDER BY 1`,
    );
    expect(res.rows.map((r) => r.name)).toEqual([
      "company_allowed_origins",
      "counties_for_zip",
      "county_for_zip",
      "estimate_apply_adjustment",
      "estimate_context",
      "estimate_insert_quote",
      "estimate_pricing_input",
      "estimate_quote_for_adjust",
      "lead_mark_notified",
      "parcel_cache_put",
      "regrid_reserve_lookup",
      "submit_lead",
    ]);
    for (const fn of res.rows) {
      expect(fn, fn.name).toMatchObject({ prosecdef: true, owner: "app_definer", proconfig: ["search_path=pg_catalog, public"] });
    }
  });

  it("still has no privilege on any table or column, and cannot call the helpers", async () => {
    const tables = await db.owner.query(
      `SELECT c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
         AND (has_table_privilege('app_public', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
              OR has_any_column_privilege('app_public', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))`,
    );
    expect(tables.rows).toEqual([]);
    for (const sql of [
      "SELECT 1 FROM quotes",
      "SELECT 1 FROM parcel_cache",
      "SELECT pricing_slice(gen_random_uuid(), 'mow', 'core')",
      "SELECT usage_month()",
    ]) {
      await expect(db.withPublic("alpha", (tx) => tx.query(sql)), sql).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("gets from a pricing function only the tiers of the service and region asked for", async () => {
    const slice = await db.withPublic("alpha", async (tx) => {
      const res = await tx.query<{ r: { tiers: unknown[]; region_group: string } }>(
        "SELECT estimate_pricing_input('alpha', 'mow', '16801', 'PA', 'Centre') AS r",
      );
      const r: unknown = res.rows[0]!.r;
      // jsonb is text over the Data API.
      return (typeof r === "string" ? JSON.parse(r) : r) as { tiers: unknown[]; region_group: string };
    });
    expect(slice.region_group).toBe("core");
    expect(slice.tiers).toHaveLength(2);
    expect(JSON.stringify(slice)).not.toContain("1000000");
  });

  it("keeps the functions' writes inside the company the slug names", async () => {
    // A version of alpha's cannot price a quote for charlie.
    await expect(
      db.withPublic("charlie", (tx) =>
        tx.query("SELECT estimate_insert_quote('charlie', $1::jsonb)", [JSON.stringify({ version_id: alpha.versionId })]),
      ),
    ).rejects.toMatchObject({ code: "P0002" });
  });
});

describe("the monthly allowance", () => {
  it("counts estimates priced, so a trial ends without any lookup being made", async () => {
    const echo = await db.seedCompany("trial-co", { quota: 2 });
    const drawn = (n: number) =>
      post(estimate, estimateBody({ company: "trial-co", address: `${n} Trial Ct, State College, PA 16801`, manual: { zip: "16801", size: { kind: "drawn", sqft: 6000 } } }));
    expect((await drawn(1)).body.status).toBe("priced");
    expect((await drawn(2)).body.status).toBe("priced");
    const third = await drawn(3);
    expect([third.status, third.body.error.code]).toEqual([429, "quota_exceeded"]);
    expect(await usage(echo)).toEqual({ regrid_lookups: 0, quotes: 2 });
    expect(regridCalls).toEqual([]);
  });
});

describe("POST /estimate with AWS Monetization", () => {
  let answer: Entitlement;
  let asked: string[];
  let metered: string[];

  beforeEach(() => {
    answer = "allow";
    asked = [];
    metered = [];
    deps.billing = {
      entitlement: async (company) => {
        asked.push(company);
        return answer;
      },
      estimatePriced: async (company) => void metered.push(company),
      page: async () => "https://billing.example/page",
    };
  });
  afterAll(() => {
    deps.billing = null;
  });

  const manual = (company: string) => estimateBody({ company, manual: { zip: "16801", size: { kind: "sqft", sqft: 5000 } } });

  it("lets a subscribed company price past its database allowance, and counts each estimate", async () => {
    // bravo has no database allowance at all.
    const res = await post(estimate, manual("bravo"));
    expect(res.body.status).toBe("priced");
    expect(asked).toEqual(["bravo"]);
    expect(metered).toEqual(["bravo"]);
  });

  it("refuses a company whose plan is used up, whatever its database allowance, and counts nothing", async () => {
    answer = "deny";
    const res = await post(estimate, manual("alpha"));
    expect([res.status, res.body.error.code]).toEqual([429, "quota_exceeded"]);
    expect(metered).toEqual([]);
  });

  it("falls back to the database allowance for a company with no subscription", async () => {
    answer = "none";
    expect((await post(estimate, manual("alpha"))).body.status).toBe("priced");
    const refused = await post(estimate, manual("bravo"));
    expect([refused.status, refused.body.error.code]).toEqual([429, "quota_exceeded"]);
    expect(metered).toEqual(["alpha"]);
  });

  it("counts an estimate once: an adjustment and an answer other than a price count nothing", async () => {
    const priced = await post(estimate, estimateBody({ address: newAddress() }));
    expect(priced.body.canAdjust).toBe(true);
    const adjusted = await post(estimate, { token: priced.body.token, adjust: "larger", turnstile: "ts-token", embedOrigin: null });
    expect(adjusted.body.status).toBe("priced");
    const outside = await post(estimate, estimateBody({ address: "5 State St, Harrisburg, PA 17101" }));
    expect(outside.body.status).toBe("call_us");
    expect(metered).toEqual(["alpha"]);
  });
});
