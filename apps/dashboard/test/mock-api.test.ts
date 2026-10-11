// The mock company-api must behave as the contract and the design say the real
// one will, or the dashboard is built against a fiction.

import { Lead, LeadList, PreviewQuoteResponse, PricingVersion, PricingVersionDiff, PricingVersionList, errorResponse } from "@lq/api-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { encodeMockToken } from "@/lib/auth/mock-token";
import { handleMockRequest } from "@/mock/handlers";
import { MOCK_OWNER_SUB, resetStore } from "@/mock/store";

const token = (sub = MOCK_OWNER_SUB, exp = Date.now() / 1000 + 600) => `Bearer ${encodeMockToken({ sub, email: "o@example.com", "cognito:groups": ["owner"], exp })}`;

function call(method: string, path: string, body?: unknown, authorization: string | null = token()) {
  const [pathname, search = ""] = path.split("?");
  return handleMockRequest({ method, path: pathname!, query: new URLSearchParams(search), authorization, body });
}

const errorCode = (response: { body: unknown }) => errorResponse.parse(response.body).error.code;

beforeEach(resetStore);

describe("authentication", () => {
  it("refuses a missing, expired or non-member token", () => {
    expect(call("GET", "/company", undefined, null).status).toBe(401);
    const expired = call("GET", "/company", undefined, token(MOCK_OWNER_SUB, Date.now() / 1000 - 1));
    expect([expired.status, errorCode(expired)]).toEqual([401, "token_expired"]);
    expect(call("GET", "/company", undefined, token("someone-else")).status).toBe(403);
  });

  it("serves only the owner routes", () => {
    expect(call("POST", "/estimate", {}).status).toBe(404);
    expect(call("GET", "/nope").status).toBe(404);
  });
});

describe("sign-up", () => {
  it("gives a login with no company one, once, and nothing before that", () => {
    const fresh = token("mock-sub-new@example.com");
    expect(call("GET", "/company", undefined, fresh).status).toBe(403);
    expect(call("POST", "/company", { name: "  " }, fresh).status).toBe(400);
    expect(call("POST", "/company", { name: "Happy Valley Mowing" }, null).status).toBe(401);

    const created = call("POST", "/company", { name: "Happy Valley Mowing" }, fresh);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Happy Valley Mowing" });
    expect(call("GET", "/company", undefined, fresh).status).toBe(200);

    const again = call("POST", "/company", { name: "Another" }, fresh);
    expect([again.status, errorCode(again)]).toEqual([409, "conflict"]);
    // The seeded owner already has theirs.
    expect(call("POST", "/company", { name: "Another" }).status).toBe(409);
  });
});

describe("pricing versions", () => {
  const versions = () => PricingVersionList.parse(call("GET", "/pricing-versions").body).versions;
  const current = () => versions().find((v) => v.version === 2)!;

  it("copies, edits, diffs and publishes a draft", () => {
    const draft = PricingVersion.parse(call("POST", "/pricing-versions", { copyFrom: current().id }).body);
    expect(draft.version).toBe(3);
    expect(draft.publishedAt).toBeNull();

    const same = PricingVersionDiff.parse(call("GET", `/pricing-versions/${draft.id}/diff`).body);
    expect(same.identical).toBe(true);

    const content = structuredClone(draft.content);
    content.minChargeCents = 5000;
    content.services[2]!.taxable = true;
    content.tiers[0]!.flatPriceCents = 4800;
    content.tiers.pop();
    expect(call("PUT", `/pricing-versions/${draft.id}`, content).status).toBe(200);

    const diff = PricingVersionDiff.parse(call("GET", `/pricing-versions/${draft.id}/diff`).body);
    expect(diff.identical).toBe(false);
    expect(diff.minChargeCents).toEqual({ from: 4500, to: 5000 });
    expect(diff.services.changed.map((c) => [c.from.taxable, c.to.taxable])).toEqual([[false, true]]);
    expect(diff.tiers.changed).toHaveLength(1);
    expect(diff.tiers.removed).toHaveLength(1);

    expect(call("POST", `/pricing-versions/${draft.id}/publish`, {}).status).toBe(400);
    const published = PricingVersion.parse(call("POST", `/pricing-versions/${draft.id}/publish`, { confirm: true }).body);
    expect(published.publishedAt).not.toBeNull();
  });

  it("never changes a published version", () => {
    const published = PricingVersion.parse(call("GET", `/pricing-versions/${current().id}`).body);
    const put = call("PUT", `/pricing-versions/${published.id}`, published.content);
    expect([put.status, errorCode(put)]).toEqual([409, "version_published"]);
    const again = call("POST", `/pricing-versions/${published.id}/publish`, { confirm: true });
    expect([again.status, errorCode(again)]).toEqual([409, "version_published"]);
  });

  it("rejects overlapping tiers, as the database will", () => {
    const draft = PricingVersion.parse(call("POST", "/pricing-versions", { copyFrom: current().id }).body);
    const content = structuredClone(draft.content);
    content.tiers[1]!.minSqft = 4000;
    const put = call("PUT", `/pricing-versions/${draft.id}`, content);
    expect([put.status, errorCode(put)]).toEqual([400, "invalid_request"]);
  });

  it("rolls back by copying an old version and publishing the copy", () => {
    const old = versions().find((v) => v.version === 1)!;
    const copy = PricingVersion.parse(call("POST", "/pricing-versions", { copyFrom: old.id }).body);
    const diff = PricingVersionDiff.parse(call("GET", `/pricing-versions/${copy.id}/diff`).body);
    expect(diff.minChargeCents).toEqual({ from: 4500, to: 4000 });
    call("POST", `/pricing-versions/${copy.id}/publish`, { confirm: true });
    const next = PricingVersion.parse(call("POST", "/pricing-versions", { copyFrom: copy.id }).body);
    expect(PricingVersionDiff.parse(call("GET", `/pricing-versions/${next.id}/diff`).body).identical).toBe(true);
  });

  it("previews with packages/pricing: the design's worked example", () => {
    const preview = (body: object) => PreviewQuoteResponse.parse(call("POST", `/pricing-versions/${current().id}/preview`, body).body);
    const base = { serviceCode: "mow", grassSqft: 6400, regionGroup: "core", county: "Centre" };

    // 6,400 sq ft at $7.50 per 1,000 is $48.00; Centre County 6% is $2.88.
    expect(preview(base)).toMatchObject({ status: "priced", quote: { subtotalCents: 4800, taxRateBps: 600, taxCents: 288, totalCents: 5088 } });
    expect(preview({ ...base, county: "Allegheny" })).toMatchObject({ quote: { taxRateBps: 700 } });
    expect(preview({ ...base, county: "Philadelphia" })).toMatchObject({ quote: { taxRateBps: 800 } });

    // Tax applies to the taxable line only; lines stay separate.
    const withLeaves = preview({ ...base, addOnCodes: ["leaf_raking"] });
    expect(withLeaves).toMatchObject({ status: "priced", quote: { subtotalCents: 16800, taxableSubtotalCents: 4800, taxCents: 288, totalCents: 17088 } });
    if (withLeaves.status === "priced") expect(withLeaves.quote.lines.map((l) => l.taxable)).toEqual([true, false]);

    expect(preview({ ...base, grassSqft: 50_000 })).toEqual({ status: "no_price", reason: "no_tier", serviceCode: "mow" });
    expect(preview({ ...base, serviceCode: "snow_push" })).toEqual({ status: "no_price", reason: "unknown_service", serviceCode: "snow_push" });
    // No default tax rate (R4).
    expect(preview({ ...base, county: "Atlantis" })).toEqual({ status: "no_price", reason: "unknown_county" });
  });
});

describe("leads", () => {
  it("pages by cursor and filters by status", () => {
    const first = LeadList.parse(call("GET", "/leads").body);
    expect(first.leads).toHaveLength(25);
    const second = LeadList.parse(call("GET", `/leads?cursor=${first.nextCursor}`).body);
    expect(second.leads).toHaveLength(7);
    expect(second.nextCursor).toBeNull();
    const declined = LeadList.parse(call("GET", "/leads?status=declined&limit=100").body);
    expect(declined.leads.length).toBeGreaterThan(0);
    expect(declined.leads.every((l) => l.status === "declined")).toBe(true);
    expect(call("GET", "/leads?limit=1000").status).toBe(400);
  });

  it("decides a lead once", () => {
    const lead = LeadList.parse(call("GET", "/leads?status=submitted").body).leads[0]!;
    const adjusted = Lead.parse(call("POST", `/leads/${lead.id}/decision`, { action: "adjust", adjustedTotalCents: 9900 }).body);
    expect([adjusted.status, adjusted.adjustedTotalCents]).toEqual(["accepted", 9900]);

    const again = call("POST", `/leads/${lead.id}/decision`, { action: "decline" });
    expect([again.status, errorCode(again)]).toEqual([409, "lead_already_decided"]);
    expect(Lead.parse(call("GET", `/leads/${lead.id}`).body)).toEqual(adjusted);
  });
});

describe("company", () => {
  it("validates theme and origins with the contract", () => {
    expect(call("PATCH", "/company", { theme: { color: "red" } }).status).toBe(400);
    expect(call("PATCH", "/company", { allowedOrigins: ["https://example.com/path"] }).status).toBe(400);
    expect(call("PATCH", "/company", { id: "00000000-0000-4000-8000-000000000009" }).status).toBe(400);
    expect(call("PATCH", "/company", { allowedOrigins: ["https://example.com"], theme: { color: "#123abc" } }).status).toBe(200);
  });
});

describe("billing", () => {
  it("links to a hosted plan page or portal, for the two pages only", () => {
    expect(call("POST", "/billing/session", { page: "plans" }).body).toEqual({ url: "https://billing.mock.invalid/plans" });
    expect(call("POST", "/billing/session", { page: "portal" }).body).toEqual({ url: "https://billing.mock.invalid/portal" });
    const other = call("POST", "/billing/session", { page: "admin" });
    expect([other.status, errorCode(other)]).toEqual([400, "invalid_request"]);
    expect(call("POST", "/billing/session", { page: "plans" }, null).status).toBe(401);
  });
});
