// The parts that need no database: the grass formula, address handling, the
// quote token, the Regrid and Turnstile clients (with a fake fetch; no test
// calls either service), the version diff and the alert text.

import type { PricingVersion } from "@lq/api-contract";
import { describe, expect, it } from "vitest";
import { createBilling, type MonetizationClient } from "../src/billing.js";
import { claimsFrom } from "../src/company/api.js";
import { diffVersions } from "../src/company/pricing-versions.js";
import { HttpError } from "../src/http.js";
import {
  adjustGrass,
  grassFromManual,
  grassFromParcel,
  normalizeAddress,
  round100,
  zipFromAddress,
} from "../src/public/grass.js";
import { createContactHandler, renderContactEmail } from "../src/public/contact.js";
import { createNotifier, renderLeadEmail, renderLeadSms, type LeadAlert } from "../src/public/notify.js";
import { createRegridLookup, parseAddressResponse } from "../src/public/regrid.js";
import { isHoneypotHit } from "../src/public/submit.js";
import { createTokenCodec, TOKEN_TTL_SECONDS } from "../src/public/token.js";
import { createTurnstile } from "../src/public/turnstile.js";
import { event, read } from "./harness.js";

const fakeFetch = (status: number, body: unknown, seen?: { url?: string; body?: string }) =>
  (async (url: URL | string, init?: RequestInit) => {
    if (seen) {
      seen.url = String(url);
      seen.body = String(init?.body ?? "");
    }
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

describe("grass estimate (design section 6)", () => {
  it("matches the worked example: (11,200 - 2,100) x 0.70 rounds to 6,400", () => {
    expect(grassFromParcel(11_200, 2_100, 70).grassSqft).toBe(6_400);
  });

  it("rounds to the nearest 100, half up, and never goes below zero", () => {
    expect([round100(6_349), round100(6_350), round100(49), round100(0)]).toEqual([6_300, 6_400, 0, 0]);
    expect(grassFromParcel(1_000, 5_000, 70).grassSqft).toBe(0);
  });

  it("takes 0.10 off the coverage factor when there is no footprint, and says so", () => {
    const estimate = grassFromParcel(10_000, null, 70);
    expect(estimate.grassSqft).toBe(6_000);
    expect(estimate.assumptions).toContain("Includes the house footprint.");
    // A footprint of zero is data: nothing to subtract, no penalty.
    expect(grassFromParcel(10_000, 0, 70).grassSqft).toBe(7_000);
  });

  it("labels the lot size as a tax record, not a survey (R21)", () => {
    expect(grassFromParcel(10_000, 2_000, 70).assumptions[0]).toMatch(/county tax records, not a survey/);
  });

  it("counts all of what the homeowner gave: a lot size, a typed area or an outline", () => {
    // A quarter acre is 10,890 sq ft and two acres 87,120: the whole lot, with nothing taken off.
    expect(grassFromManual({ kind: "bucket", bucket: "quarter_acre" })).toMatchObject({
      grassSqft: 10_900,
      origin: "bucket",
      assumptions: ["Based on the lot size you chose.", "Counts the whole lot, house and driveway included."],
    });
    expect(grassFromManual({ kind: "bucket", bucket: "half_acre" }).grassSqft).toBe(21_800);
    expect(grassFromManual({ kind: "bucket", bucket: "two_plus_acres" }).grassSqft).toBe(87_100);
    expect(grassFromManual({ kind: "sqft", sqft: 4_449 })).toMatchObject({ grassSqft: 4_400, origin: "manual" });
    expect(grassFromManual({ kind: "drawn", sqft: 6_449 })).toMatchObject({ grassSqft: 6_400, origin: "drawn" });
  });

  it("adjusts by x0.75 or x1.25", () => {
    expect([adjustGrass(6_400, "smaller"), adjustGrass(6_400, "larger")]).toEqual([4_800, 8_000]);
  });
});

describe("addresses", () => {
  it("normalizes case, punctuation and spacing into one cache key", () => {
    expect(normalizeAddress("  123 Main St.,  State College, PA 16801 ")).toBe("123 main st state college pa 16801");
    expect(normalizeAddress("123 MAIN ST STATE COLLEGE PA 16801")).toBe("123 main st state college pa 16801");
  });

  it("finds the zip, and does not mistake a house number for one", () => {
    expect(zipFromAddress("123 Main St, State College, PA 16801")).toBe("16801");
    expect(zipFromAddress("123 Main St, State College, PA 16801-1234")).toBe("16801");
    expect(zipFromAddress("12345 Main St, Pittsburgh, PA 15085")).toBe("15085");
    expect(zipFromAddress("12345 Main St, Pittsburgh")).toBeNull();
    expect(zipFromAddress("123 Main St")).toBeNull();
    expect(zipFromAddress("123 Main St 168011")).toBeNull();
  });
});

describe("quote token", () => {
  const secret = "s".repeat(32);
  const claims = { quoteId: "3b241101-e2bb-4255-8caf-4136c566a962", company: "joes-lawn" };
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return (err as HttpError).code;
    }
    return "ok";
  };

  it("round-trips, and says nothing but the quote and its company", () => {
    const codec = createTokenCodec(secret);
    const token = codec.sign(claims);
    expect(codec.verify(token)).toEqual(claims);
    const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString());
    expect(Object.keys(payload).sort()).toEqual(["c", "exp", "q", "v"]);
  });

  it("rejects a changed payload, another secret and garbage", () => {
    const codec = createTokenCodec(secret);
    const [body, signature] = codec.sign(claims).split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ v: 1, q: claims.quoteId, c: "other-lawn", exp: 9_999_999_999 })).toString("base64url");
    expect(code(() => codec.verify(`${forged}.${signature}`))).toBe("token_invalid");
    expect(code(() => createTokenCodec("t".repeat(32)).verify(`${body}.${signature}`))).toBe("token_invalid");
    for (const junk of ["", "abc", "a.b.c", `${body}.`, `.${signature}`]) {
      expect(code(() => codec.verify(junk)), junk).toBe("token_invalid");
    }
  });

  it("expires with the quote, after 7 days", () => {
    let now = new Date("2026-10-10T00:00:00Z");
    const codec = createTokenCodec(secret, () => now);
    const token = codec.sign(claims);
    now = new Date(now.getTime() + (TOKEN_TTL_SECONDS - 1) * 1000);
    expect(codec.verify(token)).toEqual(claims);
    now = new Date(now.getTime() + 1000);
    expect(code(() => codec.verify(token))).toBe("token_expired");
  });

  it("refuses a short secret", () => {
    expect(() => createTokenCodec("short")).toThrow();
  });
});

describe("Regrid client", () => {
  const feature = (id: string, fields: Record<string, unknown>, score?: number) => ({
    type: "Feature",
    properties: { ll_uuid: id, fields, ...(score === undefined ? {} : { score }) },
  });
  const centre = { ll_gissqft: 11_200.4, county: "Centre", state2: "pa", szip: "16801-1234" };

  it("reads one parcel with its matched building footprints", () => {
    const result = parseAddressResponse({
      parcels: { features: [feature("p1", centre)] },
      buildings: {
        features: [
          { properties: { ed_bldg_footprint_sqft: 1_800, ll_uuids: ["p1"] } },
          { properties: { ed_bldg_footprint_sqft: 300, ll_uuids: ["p1", "p9"] } },
          { properties: { ed_bldg_footprint_sqft: 5_000, ll_uuids: ["p9"] } },
        ],
      },
    });
    expect(result).toEqual({
      kind: "match",
      parcel: { regridId: "p1", parcelSqft: 11_200, footprintSqft: 2_100, state: "PA", county: "Centre", zip: "16801" },
    });
  });

  it("has no footprint without the add-on, and falls back to acres x 43,560", () => {
    const result = parseAddressResponse({ parcels: { features: [feature("p1", { ll_gisacre: 0.5, county: "Centre County", state2: "PA" })] } });
    expect(result).toMatchObject({ kind: "match", parcel: { parcelSqft: 21_780, footprintSqft: null, county: "Centre", zip: null } });
  });

  it("answers no_match for nothing, and never picks between tied parcels", () => {
    expect(parseAddressResponse({ parcels: { features: [] } })).toEqual({ kind: "no_match" });
    expect(parseAddressResponse({})).toEqual({ kind: "no_match" });
    expect(parseAddressResponse({ parcels: { features: [feature("p1", centre), feature("p2", centre)] } })).toEqual({ kind: "ambiguous" });
    expect(parseAddressResponse({ parcels: { features: [feature("p1", centre, 90), feature("p2", centre, 90)] } })).toEqual({ kind: "ambiguous" });
    // The same parcel twice is one parcel; one parcel alone at the top score is Regrid's answer.
    expect(parseAddressResponse({ parcels: { features: [feature("p1", centre), feature("p1", centre)] } }).kind).toBe("match");
    expect(parseAddressResponse({ parcels: { features: [feature("p1", centre, 70), feature("p2", centre, 98)] } })).toMatchObject({
      kind: "match",
      parcel: { regridId: "p2" },
    });
  });

  it("calls the v2 address endpoint with the token, and reports anything but 200 as unavailable", async () => {
    const seen: { url?: string } = {};
    const lookup = createRegridLookup({ token: "tok", fetch: fakeFetch(200, { parcels: { features: [feature("p1", centre)] } }, seen) });
    expect((await lookup("123 Main St, State College, PA 16801")).kind).toBe("match");
    const url = new URL(seen.url!);
    expect(url.origin + url.pathname).toBe("https://app.regrid.com/api/v2/parcels/address");
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: "123 Main St, State College, PA 16801", limit: "5", token: "tok" });

    for (const status of [401, 429, 500]) {
      expect(await createRegridLookup({ token: "tok", fetch: fakeFetch(status, {}) })("x")).toEqual({ kind: "unavailable" });
    }
    const down = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await createRegridLookup({ token: "tok", fetch: down })("x")).toEqual({ kind: "unavailable" });
  });
});

describe("Turnstile", () => {
  it("passes a verified token, with the secret and the caller's IP", async () => {
    const seen: { url?: string; body?: string } = {};
    const verify = createTurnstile({ secret: "sec", fetch: fakeFetch(200, { success: true }, seen) });
    expect(await verify("tok", "203.0.113.7")).toBe("ok");
    expect(seen.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(Object.fromEntries(new URLSearchParams(seen.body))).toEqual({ secret: "sec", response: "tok", remoteip: "203.0.113.7" });
  });

  it("fails a rejected token, and tells an outage apart from a rejection", async () => {
    const verdict = (status: number, body: unknown) => createTurnstile({ secret: "sec", fetch: fakeFetch(status, body) })("tok", null);
    expect(await verdict(200, { success: false, "error-codes": ["invalid-input-response"] })).toBe("failed");
    expect(await verdict(200, { success: false, "error-codes": ["timeout-or-duplicate"] })).toBe("failed");
    expect(await verdict(200, {})).toBe("failed");
    expect(await verdict(200, { success: false, "error-codes": ["internal-error"] })).toBe("unavailable");
    expect(await verdict(503, {})).toBe("unavailable");
  });
});

describe("lead alerts", () => {
  const alert: LeadAlert = {
    companyName: "Joe's Lawn",
    leadId: "lead-1",
    contact: { name: "Pat Homeowner", phone: "814-555-0199", email: "pat@example.com" },
    addressText: "123 Main St, State College, PA 16801",
    county: "Centre",
    grassSqft: 6_400,
    lines: [
      { serviceCode: "mow", name: "Mowing", amountCents: 4_800, taxable: true },
      { serviceCode: "leaf_raking", name: "Leaf raking", amountCents: 3_000, taxable: false },
    ],
    taxCents: 288,
    totalCents: 8_088,
  };

  it("writes an email with each line stated separately, as an estimate", () => {
    const email = renderLeadEmail(alert, "https://app.example.com");
    expect(email.subject).toBe("New quote request: $80.88 estimate");
    expect(email.text).toContain("Mowing: $48.00\nLeaf raking: $30.00 (not taxable)\nSales tax: $2.88\nEstimated total: $80.88");
    expect(email.text).toContain("Phone: 814-555-0199");
    expect(email.text).toContain("an estimate the homeowner saw, not an accepted job");
    expect(email.text).toContain("https://app.example.com/leads/lead-1");
  });

  it("keeps the homeowner's details out of the SMS", () => {
    const sms = renderLeadSms(alert, "https://app.example.com");
    expect(sms).toBe("Joe's Lawn: new quote request, $80.88 estimate. https://app.example.com/leads/lead-1");
  });

  it("sends SMS only behind the flag, within the cap, and survives a failed send", async () => {
    const sent: string[] = [];
    const logs: unknown[] = [];
    const notifier = (smsEnabled: boolean, failEmail = false) =>
      createNotifier({
        sendEmail: async (m) => {
          if (failEmail) throw new Error(`SES rejected ${m.to}`);
          sent.push(`email:${m.to}`);
        },
        sendSms: async (m) => void sent.push(`sms:${m.to}`),
        smsEnabled,
        dashboardUrl: "https://app.example.com",
        log: (...args) => void logs.push(args),
      });
    const targets = { email: "owner@joes.example", phone: "+18145550100", smsAllowed: true };

    expect(await notifier(false).leadCreated(alert, targets)).toEqual({ email: true, sms: false });
    expect(await notifier(true).leadCreated(alert, targets)).toEqual({ email: true, sms: true });
    expect(await notifier(true).leadCreated(alert, { ...targets, smsAllowed: false })).toEqual({ email: true, sms: false });
    expect(await notifier(true).leadCreated(alert, { email: null, phone: null, smsAllowed: true })).toEqual({ email: false, sms: false });
    expect(sent).toEqual(["email:owner@joes.example", "email:owner@joes.example", "sms:+18145550100", "email:owner@joes.example"]);

    expect(await notifier(false, true).leadCreated(alert, targets)).toEqual({ email: false, sms: false });
    // The failure is logged by lead id, without the address it was sent to.
    expect(logs).toEqual([["error", "lead_alert_failed", { leadId: "lead-1", channel: "email" }]]);
  });
});

describe("request details", () => {
  it("spots a filled honeypot", () => {
    expect(isHoneypotHit({ website: "http://spam.example" })).toBe(true);
    expect([{ website: "" }, {}, null, { website: 1 }].map(isHoneypotHit)).toEqual([false, false, false, false]);
  });

  it("reads claims from the JWT authorizer only, in either group format", () => {
    expect(claimsFrom(event({ sub: "u1", groups: "[admin owner]" }))).toEqual({ sub: "u1", groups: ["admin", "owner"] });
    expect(claimsFrom(event({ sub: "u1" }))).toEqual({ sub: "u1", groups: [] });
    // No authorizer context: a sub in the body or a header counts for nothing.
    expect(() => claimsFrom(event({ body: { sub: "u1" }, headers: { sub: "u1" } }))).toThrow(HttpError);
  });
});

describe("pricing version diff", () => {
  const version = (id: string, content: PricingVersion["content"]): PricingVersion => ({
    id,
    version: 1,
    publishedAt: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    content,
  });
  const mow = { code: "mow", name: "Mowing", taxable: true, season: "growing" as const };
  const tier = (minSqft: number, maxSqft: number, rate: number) => ({
    serviceCode: "mow",
    regionGroup: "core",
    minSqft,
    maxSqft,
    pricePerSqftMicrocents: rate,
    flatPriceCents: null,
  });
  const base = { minChargeCents: 4_500, coverageFactor: 0.7, services: [mow], tiers: [tier(0, 5_000, 900_000), tier(5_000, 10_000, 750_000)] };

  it("is identical when publishing would change nothing", () => {
    const diff = diffVersions(version("d", base), version("p", base));
    expect(diff).toMatchObject({ draftId: "d", publishedId: "p", identical: true, minChargeCents: null, coverageFactor: null });
  });

  it("shows a changed taxable flag, a changed rate, and a moved tier as removed plus added", () => {
    const aerate = { code: "aerate", name: "Aerating", taxable: true, season: "growing" as const };
    const draft = {
      minChargeCents: 5_000,
      coverageFactor: 0.7,
      services: [{ ...mow, taxable: false }, aerate],
      tiers: [tier(0, 5_000, 950_000), tier(5_000, 12_000, 750_000)],
    };
    const diff = diffVersions(version("d", draft), version("p", base));
    expect(diff.identical).toBe(false);
    expect(diff.minChargeCents).toEqual({ from: 4_500, to: 5_000 });
    expect(diff.coverageFactor).toBeNull();
    expect(diff.services).toEqual({ added: [aerate], removed: [], changed: [{ from: mow, to: { ...mow, taxable: false } }] });
    expect(diff.tiers).toEqual({
      added: [tier(5_000, 12_000, 750_000)],
      removed: [tier(5_000, 10_000, 750_000)],
      changed: [{ from: tier(0, 5_000, 900_000), to: tier(0, 5_000, 950_000) }],
    });
  });

  it("lists everything as added when nothing is published yet", () => {
    const diff = diffVersions(version("d", base), null);
    expect(diff).toMatchObject({ publishedId: null, identical: false, minChargeCents: null, coverageFactor: null });
    expect(diff.services.added).toEqual([mow]);
    expect(diff.tiers.added).toHaveLength(2);
  });
});

describe("billing through AWS Monetization", () => {
  const deny = (code: string) => ({ decision: "DENY", reason: { category: "QUOTA", code } });
  const client = (decision: unknown, seen: unknown[] = []): MonetizationClient =>
    ({
      checkEntitlement: async (userId: string, options: unknown) => {
        seen.push([userId, options]);
        if (decision instanceof Error) throw decision;
        return decision;
      },
      putEvent: async (userId: string, event: unknown) => {
        seen.push([userId, event]);
        if (decision instanceof Error) throw decision;
        return {};
      },
      createPricingSession: async (userId: string, options: unknown) => (seen.push([userId, options]), { pricingUrl: "https://p.example/#t" }),
      createBillingPortalSession: async (userId: string, options: unknown) => (seen.push([userId, options]), { billingPortalUrl: "https://b.example/#t" }),
    }) as unknown as MonetizationClient;
  const quiet = () => {};

  it("reads the plan's decision on estimate_priced for the company", async () => {
    const seen: unknown[] = [];
    expect(await createBilling(client({ decision: "ALLOW", reason: { code: "WITHIN_QUOTA" } }, seen), quiet).entitlement("alpha")).toBe("allow");
    expect(seen).toEqual([["alpha", { eventType: "estimate_priced" }]]);
    expect(await createBilling(client(deny("QUOTA_EXCEEDED")), quiet).entitlement("alpha")).toBe("deny");
    expect(await createBilling(client(deny("BUDGET_EXCEEDED")), quiet).entitlement("alpha")).toBe("deny");
  });

  it("leaves an unsubscribed company, or a billing outage, to the database allowance", async () => {
    expect(await createBilling(client(deny("NO_SUBSCRIPTION")), quiet).entitlement("alpha")).toBe("none");
    expect(await createBilling(client(deny("SUBSCRIPTION_INACTIVE")), quiet).entitlement("alpha")).toBe("none");
    const logged: unknown[] = [];
    const billing = createBilling(client(new Error("boom")), (level, event, fields) => void logged.push([level, event, fields]));
    expect(await billing.entitlement("alpha")).toBe("none");
    // A failed count never fails the estimate.
    await expect(billing.estimatePriced("alpha")).resolves.toBeUndefined();
    expect(logged).toEqual([
      ["warn", "billing_unavailable", { op: "entitlement", company: "alpha", error: "Error" }],
      ["error", "billing_meter_failed", { company: "alpha", error: "Error" }],
    ]);
  });

  it("makes hosted-page links that return where it is told", async () => {
    const seen: unknown[] = [];
    const billing = createBilling(client(null, seen), quiet);
    expect(await billing.page("alpha", "plans", "https://app.example.com/billing")).toBe("https://p.example/#t");
    expect(await billing.page("alpha", "portal", "https://app.example.com/billing")).toBe("https://b.example/#t");
    const options = { returnUrl: "https://app.example.com/billing", refreshUrl: "https://app.example.com/billing", sessionDurationSeconds: 3600 };
    expect(seen).toEqual([["alpha", options], ["alpha", options]]);
  });
});

describe("POST /contact", () => {
  const SITE = "https://app.example.com";
  const good = { name: "Pat Doe", email: "pat@example.com", message: "Do you work with snow removal companies?", turnstile: "tok" };
  const setup = (options: { inbox?: boolean; turnstile?: "ok" | "failed" | "unavailable"; sendFails?: boolean } = {}) => {
    const sent: { to: string; subject: string; text: string }[] = [];
    const logs: { level: string; event: string; fields?: unknown }[] = [];
    const handler = createContactHandler({
      turnstile: async () => options.turnstile ?? "ok",
      inbox:
        options.inbox === false
          ? null
          : {
              to: "team@example.com",
              send: async (m) => {
                if (options.sendFails) throw new Error("ses down");
                sent.push(m);
              },
            },
      siteOrigin: SITE,
      log: (level, ev, fields) => logs.push({ level, event: ev, fields }),
    });
    const post = async (body: unknown, origin = SITE) => read(await handler(event({ routeKey: "POST /contact", body, headers: { origin } })));
    return { post, sent, logs };
  };

  it("emails the message to the team, and logs nothing of the visitor", async () => {
    const { post, sent, logs } = setup();
    expect(await post(good)).toEqual({ status: 200, body: { status: "sent" } });
    expect(sent).toEqual([{ to: "team@example.com", ...renderContactEmail(good) }]);
    expect(sent[0]!.text).toContain("From: Pat Doe <pat@example.com>");
    expect(JSON.stringify(logs)).not.toMatch(/Pat|pat@example|snow/);
  });

  it("says it is unavailable, never sent, when no inbox is configured or SES fails", async () => {
    for (const options of [{ inbox: false }, { sendFails: true }]) {
      const { post } = setup(options);
      const res = await post(good);
      expect([res.status, res.body.error.code]).toEqual([503, "contact_unavailable"]);
    }
  });

  it("refuses another origin, a failed Turnstile and bad input; a honeypot sends nothing", async () => {
    const { post, sent } = setup();
    expect((await post(good, "https://evil.example")).status).toBe(403);
    expect((await setup({ turnstile: "failed" }).post(good)).body.error.code).toBe("turnstile_failed");
    for (const bad of [{ ...good, email: "nope" }, { ...good, message: " " }, { ...good, name: "" }, { ...good, extra: 1 }]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect((await post({ ...good, website: "spam" })).status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});
