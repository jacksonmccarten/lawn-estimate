// The company-api routes against a real database, as app_rw through
// withCompany. Every response is checked against its contract schema, and
// one company's caller never sees or changes another's rows.

import { routes } from "@lq/api-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BillingPage } from "../src/billing.js";
import { createCompanyApi } from "../src/company/api.js";
import { createEstimateHandler } from "../src/public/estimate.js";
import { createSubmitHandler } from "../src/public/submit.js";
import { createTokenCodec } from "../src/public/token.js";
import { createTestDb, event, read, type TestCompany, type TestDb } from "./harness.js";

let db: TestDb;
let alpha: TestCompany;
let bravo: TestCompany;
let api: ReturnType<typeof createCompanyApi>;
let leadIds: string[]; // alpha's, oldest first

type Call = { body?: unknown; id?: string; query?: Record<string, string>; headers?: Record<string, string>; groups?: string };
const call = async (company: TestCompany | null, routeKey: string, options: Call = {}) =>
  read(await api(event({ routeKey, ...(company ? { sub: company.claims.sub } : {}), ...options })));

const tier = (minSqft: number, maxSqft: number, rate: number, regionGroup = "core") => ({
  serviceCode: "mow",
  regionGroup,
  minSqft,
  maxSqft,
  pricePerSqftMicrocents: rate,
  flatPriceCents: null,
});

beforeAll(async () => {
  db = await createTestDb();
  alpha = await db.seedCompany("alpha");
  bravo = await db.seedCompany("bravo");
  api = createCompanyApi({ withCompany: db.withCompany, signUp: db.signUp, billing: null, dashboardOrigin: "https://app.example.com" });

  // Three leads for alpha, made the way homeowners make them.
  const tokens = createTokenCodec("test-secret-test-secret-test-secret");
  const deps = {
    withPublic: db.withPublic,
    turnstile: async () => "ok" as const,
    regrid: async () => ({
      kind: "match" as const,
      parcel: { regridId: "p", parcelSqft: 11_200, footprintSqft: 2_100, state: "PA", county: "Centre", zip: "16801" },
    }),
    tokens,
    notifier: { leadCreated: async () => ({ email: false, sms: false }) },
    billing: null,
    ipHashSalt: "pepper",
    widgetOrigin: null,
    log: () => {},
  };
  const estimate = createEstimateHandler(deps);
  const submit = createSubmitHandler(deps);
  leadIds = [];
  for (let i = 0; i < 3; i++) {
    const priced = read(
      await estimate(event({ body: { company: "alpha", address: `${i} Main St, State College, PA 16801`, service: "mow", turnstile: "t", embedOrigin: null } })),
    );
    await submit(event({ body: { token: priced.body.token, contact: { name: `Lead ${i}`, email: `lead${i}@example.com` }, turnstile: "t", embedOrigin: null } }));
    const rows = await db.asCompany(alpha.id, (q) =>
      q.query<{ id: string }>("SELECT id FROM leads WHERE quote_id = $1", [tokens.verify(priced.body.token).quoteId]),
    );
    leadIds.push(rows.rows[0]!.id);
  }
}, 120_000);

afterAll(() => db?.close());

describe("who is calling", () => {
  it("needs verified claims, and a sub that belongs to a company", async () => {
    const anonymous = await call(null, "GET /company");
    expect([anonymous.status, anonymous.body.error.code]).toEqual([401, "unauthenticated"]);
    const stranger = read(await api(event({ routeKey: "GET /company", sub: "sub-nobody" })));
    expect([stranger.status, stranger.body.error.code]).toEqual([403, "forbidden"]);
  });

  it("lets the admin group act as a named company, audited, and nobody else", async () => {
    const headers = { "x-act-as-company": alpha.id };
    const staff = read(await api(event({ routeKey: "GET /company", sub: "sub-staff", groups: "[admin]", headers })));
    expect([staff.status, staff.body.slug]).toEqual([200, "alpha"]);
    const log = await db.asCompany(alpha.id, (q) => q.query("SELECT admin_sub FROM admin_access_log"));
    expect(log.rows).toEqual([{ admin_sub: "sub-staff" }]);

    const owner = await call(bravo, "GET /company", { headers });
    expect([owner.status, owner.body.error.code]).toEqual([403, "forbidden"]);
    const junk = read(await api(event({ routeKey: "GET /company", sub: "sub-staff", groups: "[admin]", headers: { "x-act-as-company": "alpha" } })));
    expect(junk.status).toBe(400);
  });

  it("answers 404 for a route it does not have", async () => {
    expect((await call(alpha, "DELETE /company")).status).toBe(404);
  });
});

describe("/company, /regions, /usage", () => {
  it("returns the caller's company, without its private columns", async () => {
    const { status, body } = await call(alpha, "GET /company");
    expect(status).toBe(200);
    expect(body).toEqual({ id: alpha.id, slug: "alpha", name: "alpha lawn", hicNo: null, allowedOrigins: [], theme: {} });
    expect(routes.getCompany.response.safeParse(body).success).toBe(true);
  });

  it("updates only the fields sent, and validates theming", async () => {
    const { body } = await call(alpha, "PATCH /company", {
      body: { hicNo: "PA123456", allowedOrigins: ["https://JoesLawn.com", "https://joeslawn.com"], theme: { color: "#116633" } },
    });
    expect(body).toMatchObject({ name: "alpha lawn", hicNo: "PA123456", allowedOrigins: ["https://joeslawn.com"], theme: { color: "#116633" } });
    const cleared = await call(alpha, "PATCH /company", { body: { hicNo: null, name: "Alpha Lawn Care" } });
    expect(cleared.body).toMatchObject({ name: "Alpha Lawn Care", hicNo: null, allowedOrigins: ["https://joeslawn.com"] });

    for (const bad of [
      { theme: { color: "red" } },
      { theme: { color: "#116633", css: "body{}" } },
      { theme: { logoKey: "https://evil.example/logo.png" } },
      { allowedOrigins: ["https://joeslawn.com/path"] },
      { slug: "other" },
      { regridLookupQuota: 100000 },
    ]) {
      const res = await call(alpha, "PATCH /company", { body: bad });
      expect([res.status, res.body.error.code], JSON.stringify(bad)).toEqual([400, "invalid_request"]);
    }
    // Bravo was not touched.
    expect((await call(bravo, "GET /company")).body).toMatchObject({ name: "bravo lawn", allowedOrigins: [] });
  });

  it("replaces the region list as a whole", async () => {
    const regions = [
      { kind: "county", value: "Centre", tierGroup: "outer" },
      { kind: "zip", value: "16801", tierGroup: "core" },
      { kind: "zip", value: "16803", tierGroup: "core" },
    ];
    const { status, body } = await call(bravo, "PUT /regions", { body: { regions } });
    expect([status, body]).toEqual([200, { regions }]);
    expect((await call(bravo, "GET /regions")).body).toEqual({ regions });
    // Alpha's regions are its own.
    expect((await call(alpha, "GET /regions")).body.regions).toHaveLength(3);

    for (const bad of [[regions[1], regions[1]], [{ kind: "zip", value: "1680", tierGroup: "core" }]]) {
      expect((await call(bravo, "PUT /regions", { body: { regions: bad } })).status).toBe(400);
    }
    expect((await call(bravo, "GET /regions")).body).toEqual({ regions });
  });

  it("reports this month's usage against the quota", async () => {
    const { body } = await call(alpha, "GET /usage");
    expect(body).toEqual({ month: expect.stringMatching(/^\d{4}-\d\d-01$/), regridLookups: 3, quotes: 3, regridLookupQuota: 100 });
    expect((await call(bravo, "GET /usage")).body).toMatchObject({ regridLookups: 0, quotes: 0 });
  });
});

describe("/pricing-versions", () => {
  let draftId: string;

  it("lists versions and returns one with its content", async () => {
    const list = await call(alpha, "GET /pricing-versions");
    expect(list.body.versions).toEqual([{ id: alpha.versionId, version: 1, publishedAt: expect.any(String), createdAt: expect.any(String) }]);
    expect(routes.listPricingVersions.response.safeParse(list.body).success).toBe(true);

    const { body } = await call(alpha, "GET /pricing-versions/{id}", { id: alpha.versionId });
    expect(body.content).toEqual({
      minChargeCents: 4500,
      coverageFactor: 0.7,
      services: [{ code: "mow", name: "Mowing", taxable: true, season: "growing" }],
      tiers: [tier(0, 5000, 900_000), tier(5000, 10_000, 750_000), tier(0, 60_000, 1_000_000, "outer")],
    });
  });

  it("creates a draft as a copy, numbered after the latest version", async () => {
    const { status, body } = await call(alpha, "POST /pricing-versions", { body: { copyFrom: alpha.versionId } });
    expect(status).toBe(201);
    expect(body).toMatchObject({ version: 2, publishedAt: null });
    const source = await call(alpha, "GET /pricing-versions/{id}", { id: alpha.versionId });
    expect(body.content).toEqual(source.body.content);
    draftId = body.id;

    const empty = await call(bravo, "POST /pricing-versions", { body: {} });
    // Not quite empty: mowing, from the catalog, so there is a service to add tiers to.
    expect(empty.body).toMatchObject({
      version: 2,
      content: { minChargeCents: 0, coverageFactor: 0.7, services: [{ code: "mow", name: "Mowing, trimming and edging", taxable: true, season: "growing" }], tiers: [] },
    });
    // Another company's version cannot be copied.
    expect((await call(bravo, "POST /pricing-versions", { body: { copyFrom: alpha.versionId } })).status).toBe(404);
  });

  const edited = () => ({
    minChargeCents: 5000,
    coverageFactor: 0.65,
    services: [
      { code: "mow", name: "Mowing", taxable: true, season: "growing" },
      { code: "leaf_raking", name: "Leaf raking", taxable: false, season: "growing" },
    ],
    tiers: [
      tier(0, 5000, 950_000),
      tier(5000, 10_000, 750_000),
      { serviceCode: "leaf_raking", regionGroup: "core", minSqft: 0, maxSqft: 20_000, pricePerSqftMicrocents: null, flatPriceCents: 3000 },
    ],
  });

  it("replaces a draft's content, and rejects content the schema or the database refuses", async () => {
    const { status, body } = await call(alpha, "PUT /pricing-versions/{id}", { id: draftId, body: edited() });
    expect(status).toBe(200);
    expect(body.content).toEqual({ ...edited(), services: [...edited().services].reverse(), tiers: [edited().tiers[2], edited().tiers[0], edited().tiers[1]] });

    const overlap = { ...edited(), tiers: [tier(0, 5000, 1), tier(4000, 9000, 1)] };
    const res = await call(alpha, "PUT /pricing-versions/{id}", { id: draftId, body: overlap });
    expect([res.status, res.body.error.code]).toEqual([400, "invalid_request"]);
    const orphan = { ...edited(), tiers: [{ ...tier(0, 5000, 1), serviceCode: "aerate" }] };
    expect((await call(alpha, "PUT /pricing-versions/{id}", { id: draftId, body: orphan })).status).toBe(400);
    // A refused replace leaves the draft as it was.
    expect((await call(alpha, "GET /pricing-versions/{id}", { id: draftId })).body.content.minChargeCents).toBe(5000);
  });

  it("diffs the draft against the published version", async () => {
    const { status, body } = await call(alpha, "GET /pricing-versions/{id}/diff", { id: draftId });
    expect(status).toBe(200);
    expect(routes.diffPricingVersion.response.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      draftId,
      publishedId: alpha.versionId,
      identical: false,
      minChargeCents: { from: 4500, to: 5000 },
      coverageFactor: { from: 0.7, to: 0.65 },
    });
    expect(body.services.added.map((s: { code: string }) => s.code)).toEqual(["leaf_raking"]);
    expect(body.tiers.changed).toEqual([{ from: tier(0, 5000, 900_000), to: tier(0, 5000, 950_000) }]);
    expect(body.tiers.removed).toEqual([tier(0, 60_000, 1_000_000, "outer")]);
    expect((await call(alpha, "GET /pricing-versions/{id}/diff", { id: alpha.versionId })).status).toBe(409);
  });

  it("previews a quote with the same engine, each service on its own line", async () => {
    const preview = (body: Record<string, unknown>, id = draftId) =>
      call(alpha, "POST /pricing-versions/{id}/preview", { id, body: { serviceCode: "mow", grassSqft: 6400, regionGroup: "core", county: "Centre", ...body } });

    // The published version gives the worked example.
    expect((await preview({}, alpha.versionId)).body).toMatchObject({ status: "priced", quote: { subtotalCents: 4800, taxCents: 288, totalCents: 5088 } });
    // The draft, with a non-taxable add-on: tax on the taxable line only.
    const withAddOn = await preview({ addOnCodes: ["leaf_raking"], county: "allegheny" });
    expect(withAddOn.body.quote).toEqual({
      lines: [
        { serviceCode: "mow", name: "Mowing", amountCents: 5000, taxable: true },
        { serviceCode: "leaf_raking", name: "Leaf raking", amountCents: 3000, taxable: false },
      ],
      subtotalCents: 8000,
      taxableSubtotalCents: 5000,
      taxRateBps: 700,
      taxCents: 350,
      totalCents: 8350,
    });

    expect((await preview({ county: "Nowhere" })).body).toEqual({ status: "no_price", reason: "unknown_county" });
    expect((await preview({ grassSqft: 50_000 })).body).toEqual({ status: "no_price", reason: "no_tier", serviceCode: "mow" });
    expect((await preview({ serviceCode: "aerate" })).body).toEqual({ status: "no_price", reason: "unknown_service", serviceCode: "aerate" });
    expect((await preview({ addOnCodes: ["mow"] })).status).toBe(400);
  });

  it("publishes once with confirmation; the version is then immutable", async () => {
    expect((await call(alpha, "POST /pricing-versions/{id}/publish", { id: draftId, body: {} })).status).toBe(400);
    const { status, body } = await call(alpha, "POST /pricing-versions/{id}/publish", { id: draftId, body: { confirm: true } });
    expect(status).toBe(200);
    expect(body.publishedAt).toEqual(expect.any(String));

    for (const [routeKey, payload] of [
      ["PUT /pricing-versions/{id}", edited()],
      ["POST /pricing-versions/{id}/publish", { confirm: true }],
    ] as const) {
      const res = await call(alpha, routeKey, { id: draftId, body: payload });
      expect([res.status, res.body.error.code], routeKey).toEqual([409, "version_published"]);
    }
    // The trigger is what holds it, whatever the handler checks.
    await expect(
      db.withCompany(alpha.claims, (tx) => tx.query("UPDATE pricing_versions SET min_charge_cents = 1 WHERE id = $1", [draftId])),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("will not publish an empty version", async () => {
    const empty = await call(alpha, "POST /pricing-versions", { body: {} });
    const res = await call(alpha, "POST /pricing-versions/{id}/publish", { id: empty.body.id, body: { confirm: true } });
    expect([res.status, res.body.error.code]).toEqual([400, "invalid_request"]);
  });

  it("hides another company's versions from every route", async () => {
    for (const [routeKey, body] of [
      ["GET /pricing-versions/{id}", undefined],
      ["PUT /pricing-versions/{id}", edited()],
      ["POST /pricing-versions/{id}/publish", { confirm: true }],
      ["GET /pricing-versions/{id}/diff", undefined],
      ["POST /pricing-versions/{id}/preview", { serviceCode: "mow", grassSqft: 6400, regionGroup: "core", county: "Centre" }],
    ] as const) {
      const res = await call(bravo, routeKey, { id: alpha.versionId, ...(body ? { body } : {}) });
      expect([res.status, res.body.error.code], routeKey).toEqual([404, "not_found"]);
    }
    expect((await call(alpha, "GET /pricing-versions/{id}", { id: "not-a-uuid" })).status).toBe(404);
  });
});

describe("/leads", () => {
  it("lists leads newest first, with the quote as it was priced", async () => {
    const { status, body } = await call(alpha, "GET /leads");
    expect(status).toBe(200);
    expect(routes.listLeads.response.safeParse(body).success).toBe(true);
    expect(body.nextCursor).toBeNull();
    expect(body.leads.map((l: { id: string }) => l.id)).toEqual([...leadIds].reverse());
    expect(body.leads[2]).toMatchObject({
      status: "submitted",
      contact: { name: "Lead 0", phone: null, email: "lead0@example.com" },
      addressText: "0 Main St, State College, PA 16801",
      county: "Centre",
      origin: "regrid",
      parcelSqft: 11_200,
      footprintSqft: 2_100,
      grassSqft: 6400,
      quote: {
        lines: [{ serviceCode: "mow", name: "Mowing", amountCents: 4800, taxable: true }],
        subtotalCents: 4800,
        taxableSubtotalCents: 4800,
        taxRateBps: 600,
        taxCents: 288,
        totalCents: 5088,
      },
      pricingVersionId: alpha.versionId,
      adjustedTotalCents: null,
    });
  });

  it("pages with a cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: { leads: { id: string }[]; nextCursor: string | null } } = await call(alpha, "GET /leads", {
        query: { limit: "2", ...(cursor ? { cursor } : {}) },
      });
      seen.push(...page.body.leads.map((l) => l.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...leadIds].reverse());
    expect((await call(alpha, "GET /leads", { query: { cursor: "garbage" } })).status).toBe(400);
    expect((await call(alpha, "GET /leads", { query: { limit: "500" } })).status).toBe(400);
  });

  it("decides a lead once: accept, adjust or decline, then 409 lead_already_decided", async () => {
    const [first, second, third] = leadIds as [string, string, string];
    const decide = (id: string, body: unknown, company = alpha) => call(company, "POST /leads/{id}/decision", { id, body });

    expect((await decide(first, { action: "accept" })).body).toMatchObject({ id: first, status: "accepted", adjustedTotalCents: null });
    expect((await decide(second, { action: "adjust", adjustedTotalCents: 5500 })).body).toMatchObject({ status: "accepted", adjustedTotalCents: 5500 });
    expect((await decide(third, { action: "decline" })).body).toMatchObject({ status: "declined", adjustedTotalCents: null });

    for (const action of [{ action: "decline" }, { action: "accept" }, { action: "adjust", adjustedTotalCents: 1 }]) {
      const again = await decide(first, action);
      expect([again.status, again.body.error.code]).toEqual([409, "lead_already_decided"]);
    }
    expect((await call(alpha, "GET /leads/{id}", { id: first })).body).toMatchObject({ status: "accepted", adjustedTotalCents: null });
    expect((await decide(first, { action: "adjust" })).status).toBe(400);

    const accepted = await call(alpha, "GET /leads", { query: { status: "accepted" } });
    expect(accepted.body.leads.map((l: { id: string }) => l.id)).toEqual([second, first]);
  });

  it("maps the database's own refusal (LQ001) to the same 409", async () => {
    // What the second of two simultaneous decisions runs into.
    await expect(
      db.withCompany(alpha.claims, (tx) => tx.query("UPDATE leads SET decision = 'declined' WHERE id = $1", [leadIds[0]])),
    ).rejects.toMatchObject({ code: "LQ001" });
  });

  it("shows another company no leads, by list, by id or by decision", async () => {
    expect((await call(bravo, "GET /leads")).body).toEqual({ leads: [], nextCursor: null });
    for (const routeKey of ["GET /leads/{id}", "POST /leads/{id}/decision"]) {
      const res = await call(bravo, routeKey, { id: leadIds[0]!, body: { action: "decline" } });
      expect([res.status, res.body.error.code], routeKey).toEqual([404, "not_found"]);
    }
  });
});

describe("POST /company (sign-up)", () => {
  const newLogin = (sub: string, over: { email?: string; emailVerified?: boolean } = {}) => ({ sub, email: `${sub}@example.com`, ...over });
  const post = async (login: ReturnType<typeof newLogin> | null, body: unknown) =>
    read(await api(event({ routeKey: "POST /company", body, ...(login ?? {}) })));
  const get = async (sub: string, routeKey: string) => read(await api(event({ routeKey, sub })));

  it("makes the new login's company: a slug from the name, a trial allowance, Pennsylvania as its area, no pricing", async () => {
    const login = newLogin("sub-signup-1");
    // Before: a login with no company can read nothing.
    expect((await get(login.sub, "GET /company")).status).toBe(403);

    const { status, body } = await post(login, { name: "  Green & Tidy Lawns, LLC " });
    expect(status).toBe(201);
    expect(body).toMatchObject({ slug: "green-tidy-lawns-llc", name: "Green & Tidy Lawns, LLC", hicNo: null, allowedOrigins: [], theme: {} });

    // Now withCompany finds them, and their own routes work.
    expect((await get(login.sub, "GET /company")).body.id).toBe(body.id);
    const regions = await get(login.sub, "GET /regions");
    expect(regions.body.regions).toHaveLength(67);
    expect(regions.body.regions[0]).toMatchObject({ kind: "county", tierGroup: "standard" });
    expect((await get(login.sub, "GET /pricing-versions")).body.versions).toEqual([]);

    const [row] = await db.asCompany(body.id, async (q) => (await q.query("SELECT alert_email, regrid_lookup_quota FROM companies")).rows);
    expect(row).toEqual({ alert_email: "sub-signup-1@example.com", regrid_lookup_quota: 50 });
  });

  it("gives a second company of the same name its own slug", async () => {
    const { status, body } = await post(newLogin("sub-signup-2"), { name: "Green & Tidy Lawns, LLC" });
    expect(status).toBe(201);
    expect(body.slug).toBe("green-tidy-lawns-llc-2");
    // A name with nothing a slug can use still gets one.
    expect((await post(newLogin("sub-signup-3"), { name: "!!!" })).body.slug).toBe("company");
  });

  it("is refused for a login that already has a company, and changes nothing", async () => {
    const again = await post(newLogin("sub-signup-1"), { name: "Another" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("conflict");
    expect((await get("sub-signup-1", "GET /company")).body.name).toBe("Green & Tidy Lawns, LLC");
    // An existing owner cannot make a second company either.
    expect((await post({ sub: alpha.claims.sub, email: "owner@alpha.example" }, { name: "Second" })).status).toBe(409);
  });

  it("needs a sign-in, a verified address and a name", async () => {
    expect((await post(null, { name: "No Login" })).status).toBe(401);
    expect((await post(newLogin("sub-signup-4", { emailVerified: false }), { name: "Unverified" })).status).toBe(403);
    expect((await post({ sub: "sub-signup-5" } as never, { name: "No Email" })).status).toBe(403);
    for (const body of [{}, { name: "   " }, { name: "x".repeat(121) }, { name: "Ok", slug: "mine" }]) {
      expect((await post(newLogin("sub-signup-6"), body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await get("sub-signup-6", "GET /company")).status).toBe(403);
  });

  it("leaves every other company as it was", async () => {
    expect((await call(alpha, "GET /company")).body.slug).toBe("alpha");
    expect((await call(bravo, "GET /regions")).body.regions).toHaveLength(3);
  });
});

describe("GET /zips-near", () => {
  const near = (query: Record<string, string>) => call(alpha, "GET /zips-near", { query });

  it("lists the zip codes whose centres are within the distance, nearest first", async () => {
    const five = await near({ zip: "16801", miles: "5" });
    expect(five.status).toBe(200);
    expect(five.body).toMatchObject({ zip: "16801", miles: 5 });
    // State College's own zips, and nothing from Pittsburgh or Philadelphia.
    expect(five.body.zips[0]).toBe("16801");
    expect(five.body.zips).toContain("16803");
    expect(five.body.zips).not.toContain("15217");
    expect(five.body.zips).not.toContain("19103");

    const one = await near({ zip: "16801", miles: "1" });
    expect(one.body.zips).toEqual(["16801"]);
    // A wider circle holds the narrower one.
    const fifty = await near({ zip: "16801", miles: "50" });
    expect(fifty.body.zips.length).toBeGreaterThan(five.body.zips.length);
    expect(fifty.body.zips.slice(0, five.body.zips.length)).toEqual(five.body.zips);
    // Pittsburgh is about 115 miles from State College, Philadelphia about 160.
    expect((await near({ zip: "16801", miles: "100" })).body.zips).not.toContain("15217");
  });

  it("refuses an unknown zip code, a distance out of range and a missing sign-in", async () => {
    const unknown = await near({ zip: "00000", miles: "5" });
    expect([unknown.status, unknown.body.error.code, unknown.body.error.fields]).toEqual([400, "invalid_request", { zip: "unknown zip" }]);
    for (const query of [{ zip: "16801", miles: "0" }, { zip: "16801", miles: "101" }, { zip: "1680", miles: "5" }, { zip: "16801" }, { zip: "16801", miles: "5", extra: "1" }]) {
      expect((await near(query as Record<string, string>)).status, JSON.stringify(query)).toBe(400);
    }
    expect((await call(null, "GET /zips-near", { query: { zip: "16801", miles: "5" } })).status).toBe(401);
  });
});

describe("/questionnaire", () => {
  const yesNo = (id: string, text: string, required = true) => ({ id, text, kind: "yes_no", options: [], required });

  it("starts every company with the five example questions", async () => {
    const { status, body } = await call(alpha, "GET /questionnaire");
    expect(status).toBe(200);
    expect(body.questions.map((q: { text: string }) => q.text)).toEqual([
      "Do you have any gates narrower than 60 inches?",
      "Does your property have any steep hills?",
      "Does your property have a swimming pool?",
      "Are there any obstacles that could make mowing difficult?",
      "Is your backyard accessible to standard lawn mowing equipment?",
    ]);
    expect(body.questions.every((q: { kind: string; required: boolean }) => q.kind === "yes_no" && q.required)).toBe(true);
  });

  it("replaces the list as a whole, in order, for the caller's company only", async () => {
    const questions = [
      { id: "0f8a7b1c-1111-4c2d-8e3f-000000000002", text: "How tall is the grass now?", kind: "choice", options: ["Under 4 inches", "4 to 8 inches", "Over 8 inches"], required: false },
      yesNo("0f8a7b1c-1111-4c2d-8e3f-000000000001", "Do you have a dog?"),
    ];
    const { status, body } = await call(bravo, "PUT /questionnaire", { body: { questions } });
    expect([status, body]).toEqual([200, { questions }]);
    expect((await call(bravo, "GET /questionnaire")).body).toEqual({ questions });
    expect((await call(alpha, "GET /questionnaire")).body.questions).toHaveLength(5);
    // An empty questionnaire is allowed: homeowners are asked nothing.
    expect((await call(bravo, "PUT /questionnaire", { body: { questions: [] } })).body).toEqual({ questions: [] });
  });

  it("refuses a malformed question and changes nothing", async () => {
    const before = (await call(alpha, "GET /questionnaire")).body;
    const id = "0f8a7b1c-1111-4c2d-8e3f-000000000003";
    for (const bad of [
      [{ ...yesNo(id, "Pool?"), options: ["Yes"] }],
      [{ id, text: "Grass?", kind: "choice", options: ["Short"], required: true }],
      [{ id, text: "Grass?", kind: "choice", options: ["Short", "short"], required: true }],
      [yesNo(id, "")],
      [yesNo(id, "A"), yesNo(id, "B")],
      [yesNo("not-a-uuid", "Pool?")],
      Array.from({ length: 21 }, (_, i) => yesNo(`0f8a7b1c-1111-4c2d-8e3f-${String(i).padStart(12, "0")}`, `Q${i}`)),
    ]) {
      const res = await call(alpha, "PUT /questionnaire", { body: { questions: bad } });
      expect([res.status, res.body.error.code], JSON.stringify(bad).slice(0, 80)).toEqual([400, "invalid_request"]);
    }
    expect((await call(alpha, "GET /questionnaire")).body).toEqual(before);
    expect((await call(null, "GET /questionnaire")).status).toBe(401);
  });
});

describe("/service-area", () => {
  const home = { street: "123 College Ave", city: "State College", state: "pa", zip: "16801", miles: 5 };

  it("is unset until the owner gives an address and radius", async () => {
    const { status, body } = await call(bravo, "GET /service-area");
    expect(status).toBe(200);
    expect(body.radius).toBeNull();
  });

  it("stores the address and radius, and makes the zips within it the only regions", async () => {
    const { status, body } = await call(bravo, "PUT /service-area", { body: home });
    expect(status).toBe(200);
    expect(body.radius).toEqual({ ...home, state: "PA" });
    const within = (await call(bravo, "GET /zips-near", { query: { zip: "16801", miles: "5" } })).body.zips as string[];
    expect(body.zipCount).toBe(within.length);
    const regions = (await call(bravo, "GET /regions")).body.regions as { kind: string; value: string; tierGroup: string }[];
    expect(regions.map((r) => r.value).sort()).toEqual([...within].sort());
    expect(new Set(regions.map((r) => `${r.kind}:${r.tierGroup}`))).toEqual(new Set(["zip:standard"]));
    expect((await call(bravo, "GET /service-area")).body).toEqual(body);

    // A wider radius replaces the area; alpha's is untouched.
    const wider = await call(bravo, "PUT /service-area", { body: { ...home, miles: 25.04 } });
    expect(wider.body.radius.miles).toBe(25);
    expect(wider.body.zipCount).toBeGreaterThan(body.zipCount);
    expect((await call(alpha, "GET /service-area")).body.radius).toBeNull();
    expect((await call(alpha, "GET /regions")).body.regions).toHaveLength(3);
  });

  it("refuses an unknown zip, a radius out of range or a short address, and changes nothing", async () => {
    const before = (await call(bravo, "GET /service-area")).body;
    for (const bad of [
      { ...home, zip: "00000" },
      { ...home, miles: 0 },
      { ...home, miles: 101 },
      { ...home, street: "x" },
      { ...home, state: "Penn" },
    ]) {
      const res = await call(bravo, "PUT /service-area", { body: bad });
      expect([res.status, res.body.error.code], JSON.stringify(bad)).toEqual([400, "invalid_request"]);
    }
    expect((await call(bravo, "GET /service-area")).body).toEqual(before);
    expect((await call(null, "GET /service-area")).status).toBe(401);
  });
});

describe("POST /billing/session", () => {
  it("answers 503 when AWS Monetization is not configured", async () => {
    const res = await call(alpha, "POST /billing/session", { body: { page: "plans" } });
    expect([res.status, res.body.error.code]).toEqual([503, "billing_unavailable"]);
  });

  it("links the caller's own company to a hosted page that returns to the dashboard", async () => {
    const asked: { company: string; page: BillingPage; returnUrl: string }[] = [];
    let down = false;
    const billed = createCompanyApi({
      withCompany: db.withCompany,
      signUp: db.signUp,
      dashboardOrigin: "https://app.example.com",
      billing: {
        entitlement: async () => "none",
        estimatePriced: async () => {},
        page: async (company, page, returnUrl) => {
          if (down) throw new Error("ThrottlingException");
          asked.push({ company, page, returnUrl });
          return `https://billing.example/${page}#token=t`;
        },
      },
    });
    const post = async (company: TestCompany, body: unknown) =>
      read(await billed(event({ routeKey: "POST /billing/session", sub: company.claims.sub, body })));

    const plans = await post(alpha, { page: "plans" });
    expect([plans.status, plans.body]).toEqual([200, { url: "https://billing.example/plans#token=t" }]);
    expect(routes.createBillingSession.response.safeParse(plans.body).success).toBe(true);
    expect((await post(bravo, { page: "portal" })).body).toEqual({ url: "https://billing.example/portal#token=t" });
    expect(asked).toEqual([
      { company: "alpha", page: "plans", returnUrl: "https://app.example.com/billing" },
      { company: "bravo", page: "portal", returnUrl: "https://app.example.com/billing" },
    ]);

    const bad = await post(alpha, { page: "plans", returnUrl: "https://evil.example" });
    expect([bad.status, bad.body.error.code]).toEqual([400, "invalid_request"]);
    down = true;
    const failed = await post(alpha, { page: "portal" });
    expect([failed.status, failed.body.error.code]).toEqual([503, "billing_unavailable"]);
  });
});
