// The mock company-api: every `auth: "owner"` route in packages/api-contract,
// answered from the in-memory store. Requests are validated with the contract's
// schemas and every response is parsed with them before it leaves, so the mock
// cannot drift from the contract. As in the real API, no request names the
// company: it comes from the caller's `sub` through company_members.

import {
  BillingSessionRequest,
  CreateCompanyRequest,
  CreatePricingVersionRequest,
  ErrorResponse,
  LeadDecisionRequest,
  ListLeadsQuery,
  PreviewQuoteRequest,
  PublishPricingVersionRequest,
  Questionnaire,
  RADIUS_REGION_GROUP,
  Regions,
  ServiceRadius,
  ReplacePricingVersionRequest,
  UpdateCompanyRequest,
  ZipsNearQuery,
  routes,
  type ErrorCode,
  type PricingVersion,
} from "@lq/api-contract";
import { priceQuote } from "@lq/pricing";
import type { z } from "zod";
import { decodeMockToken } from "@/lib/auth/mock-token";
import { findOverlaps } from "@/lib/tiers";
import { diffVersions } from "./diff";
import { CATALOG_DEFAULTS, ZIP_CENTRES, getStore, taxRateBpsFor, type Store } from "./store";

export type MockResponse = { status: number; body: unknown };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) fields[issue.path.join(".") || "(body)"] = issue.message;
  throw new HttpError(400, "invalid_request", "the request does not match the contract", fields);
}

/** The caller's sub. `member: false` is for the one route a login with no company may call. */
function authenticate(store: Store, authorization: string | null, member = true): string {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  const claims = token ? decodeMockToken(token) : null;
  if (!claims) throw new HttpError(401, "unauthenticated", "no valid token");
  if (claims.exp * 1000 <= Date.now()) throw new HttpError(401, "token_expired", "the token has expired");
  // Membership is resolved from the sub, never from anything the caller can write.
  if (member && !store.members.has(claims.sub)) throw new HttpError(403, "forbidden", "not a member of any company");
  return claims.sub;
}

const currentPublished = (store: Store): PricingVersion | null =>
  store.versions
    .filter((v) => v.publishedAt !== null)
    .sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!))[0] ?? null;

function findVersion(store: Store, id: string): PricingVersion {
  const version = store.versions.find((v) => v.id === id);
  if (!version) throw new HttpError(404, "not_found", "no such pricing version");
  return version;
}

const summary = ({ content: _content, ...rest }: PricingVersion) => rest;

type Handler = (ctx: { store: Store; id: string; query: URLSearchParams; body: unknown; sub: string }) => { schema: z.ZodType; value: unknown };

const handlers: Record<Exclude<keyof typeof routes, "estimate" | "submit" | "getProfile" | "sendContact">, Handler> = {
  getCompany: ({ store }) => ({ schema: routes.getCompany.response, value: store.company }),

  updateCompany: ({ store, body }) => {
    const patch = parse(UpdateCompanyRequest, body);
    store.company = { ...store.company, ...patch };
    return { schema: routes.updateCompany.response, value: store.company };
  },

  // The mock holds one company: a new login is given it, under the name they chose.
  createCompany: ({ store, body, sub }) => {
    const { name } = parse(CreateCompanyRequest, body);
    if (store.members.has(sub)) throw new HttpError(409, "conflict", "this login already has a company");
    store.members.set(sub, store.company.id);
    store.company = { ...store.company, name };
    return { schema: routes.createCompany.response, value: store.company };
  },

  getRegions: ({ store }) => ({ schema: routes.getRegions.response, value: { regions: store.regions } }),

  replaceRegions: ({ store, body }) => {
    store.regions = parse(Regions, body).regions;
    return { schema: routes.replaceRegions.response, value: { regions: store.regions } };
  },

  getQuestionnaire: ({ store }) => ({ schema: routes.getQuestionnaire.response, value: { questions: store.questions } }),

  replaceQuestionnaire: ({ store, body }) => {
    store.questions = parse(Questionnaire, body).questions;
    return { schema: routes.replaceQuestionnaire.response, value: { questions: store.questions } };
  },

  // Great-circle miles between centre points, as the real route measures.
  getServiceArea: ({ store }) => ({
    schema: routes.getServiceArea.response,
    value: { radius: store.serviceRadius, zipCount: store.regions.filter((r) => r.kind === "zip").length },
  }),

  replaceServiceArea: ({ store, body }) => {
    const radius = parse(ServiceRadius, body);
    const zips = zipsWithin(radius.zip, radius.miles);
    store.regions = zips.map((value) => ({ kind: "zip", value, tierGroup: RADIUS_REGION_GROUP }));
    store.serviceRadius = radius;
    return { schema: routes.replaceServiceArea.response, value: { radius, zipCount: zips.length } };
  },

  getZipsNear: ({ query }) => {
    const { zip, miles } = parse(ZipsNearQuery, Object.fromEntries(query));
    return { schema: routes.getZipsNear.response, value: { zip, miles, zips: zipsWithin(zip, miles) } };
  },

  listPricingVersions: ({ store }) => ({
    schema: routes.listPricingVersions.response,
    value: { versions: [...store.versions].sort((a, b) => b.version - a.version).map(summary) },
  }),

  createPricingVersion: ({ store, body }) => {
    const { copyFrom } = parse(CreatePricingVersionRequest, body);
    const source = copyFrom ? findVersion(store, copyFrom) : null;
    const version: PricingVersion = {
      id: crypto.randomUUID(),
      version: Math.max(0, ...store.versions.map((v) => v.version)) + 1,
      createdAt: new Date().toISOString(),
      publishedAt: null,
      content: source ? structuredClone(source.content) : { minChargeCents: 0, coverageFactor: 0.7, services: structuredClone(CATALOG_DEFAULTS.slice(0, 1)), tiers: [] },
    };
    store.versions.push(version);
    return { schema: routes.createPricingVersion.response, value: version };
  },

  getPricingVersion: ({ store, id }) => ({ schema: routes.getPricingVersion.response, value: findVersion(store, id) }),

  replacePricingVersion: ({ store, id, body }) => {
    const version = findVersion(store, id);
    if (version.publishedAt !== null) throw new HttpError(409, "version_published", "a published version cannot be changed");
    const content = parse(ReplacePricingVersionRequest, body);
    // The exclusion constraint on pricing_tiers.
    const overlaps = findOverlaps(content.tiers);
    if (overlaps.length > 0) {
      const fields = Object.fromEntries(overlaps.map(([a, b]) => [`tiers.${b}.minSqft`, `overlaps tiers.${a}`]));
      throw new HttpError(400, "invalid_request", "tier ranges overlap", fields);
    }
    version.content = content;
    return { schema: routes.replacePricingVersion.response, value: version };
  },

  publishPricingVersion: ({ store, id, body }) => {
    const version = findVersion(store, id);
    parse(PublishPricingVersionRequest, body);
    if (version.publishedAt !== null) throw new HttpError(409, "version_published", "this version is already published");
    version.publishedAt = new Date().toISOString();
    return { schema: routes.publishPricingVersion.response, value: version };
  },

  diffPricingVersion: ({ store, id }) => {
    const version = findVersion(store, id);
    if (version.publishedAt !== null) throw new HttpError(409, "version_published", "only a draft has a diff");
    return { schema: routes.diffPricingVersion.response, value: diffVersions(version, currentPublished(store)) };
  },

  previewQuote: ({ store, id, body }) => {
    const version = findVersion(store, id);
    const request = parse(PreviewQuoteRequest, body);
    const schema = routes.previewQuote.response;
    const taxRateBps = taxRateBpsFor(request.county);
    // No default rate, ever (R4).
    if (taxRateBps === null) return { schema, value: { status: "no_price", reason: "unknown_county" } };
    if (new Set([request.serviceCode, ...(request.addOnCodes ?? [])]).size !== 1 + (request.addOnCodes?.length ?? 0)) {
      throw new HttpError(400, "invalid_request", "a service is requested twice", { addOnCodes: "repeats a service" });
    }
    // The same package the estimate Lambda will run.
    const result = priceQuote({
      version: { id: version.id, ...version.content },
      serviceCode: request.serviceCode,
      addOnCodes: request.addOnCodes,
      grassSqft: request.grassSqft,
      regionGroup: request.regionGroup,
      taxRateBps,
    });
    if (!result.ok) return { schema, value: { status: "no_price", reason: result.reason, serviceCode: result.serviceCode } };
    const { versionId: _versionId, ...quote } = result.quote;
    return { schema, value: { status: "priced", quote } };
  },

  listLeads: ({ store, query }) => {
    const { status, cursor, limit } = parse(ListLeadsQuery, Object.fromEntries(query));
    const offset = cursor === undefined ? 0 : Number(/^o(\d+)$/.exec(cursor)?.[1] ?? NaN);
    if (Number.isNaN(offset)) throw new HttpError(400, "invalid_request", "unknown cursor", { cursor: "not a cursor from this API" });
    const matching = store.leads
      .filter((l) => status === undefined || l.status === status)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
      schema: routes.listLeads.response,
      value: { leads: matching.slice(offset, offset + limit), nextCursor: offset + limit < matching.length ? `o${offset + limit}` : null },
    };
  },

  getLead: ({ store, id }) => {
    const lead = store.leads.find((l) => l.id === id);
    if (!lead) throw new HttpError(404, "not_found", "no such lead");
    return { schema: routes.getLead.response, value: lead };
  },

  decideLead: ({ store, id, body }) => {
    const lead = store.leads.find((l) => l.id === id);
    if (!lead) throw new HttpError(404, "not_found", "no such lead");
    const decision = parse(LeadDecisionRequest, body);
    // A lead is decided once (the LQ001 trigger).
    if (lead.status === "accepted" || lead.status === "declined") throw new HttpError(409, "lead_already_decided", "this lead already has a decision");
    if (lead.status !== "submitted") throw new HttpError(409, "conflict", "this lead can no longer be decided");
    lead.status = decision.action === "decline" ? "declined" : "accepted";
    lead.adjustedTotalCents = decision.action === "adjust" ? decision.adjustedTotalCents : null;
    return { schema: routes.decideLead.response, value: lead };
  },

  getUsage: ({ store }) => ({ schema: routes.getUsage.response, value: store.usage }),

  // AWS Monetization hosts the real pages; the mock's link goes nowhere, and tests stop it there.
  createBillingSession: ({ body }) => {
    const { page } = parse(BillingSessionRequest, body);
    return { schema: routes.createBillingSession.response, value: { url: `https://billing.mock.invalid/${page}` } };
  },
};

function match(method: string, path: string): { name: keyof typeof handlers; id: string } | null {
  for (const [name, route] of Object.entries(routes)) {
    if (route.auth !== "owner" || route.method !== method) continue;
    const pattern = new RegExp(`^${route.path.replace("{id}", "([^/]+)")}$`);
    const found = pattern.exec(path);
    if (found) return { name: name as keyof typeof handlers, id: found[1] ?? "" };
  }
  return null;
}

const errorBody = (code: ErrorCode, message: string, fields?: Record<string, string>) =>
  ErrorResponse.parse({ error: { code, message, ...(fields ? { fields } : {}) } });

export function handleMockRequest(request: { method: string; path: string; query: URLSearchParams; authorization: string | null; body: unknown }): MockResponse {
  try {
    const store = getStore();
    const found = match(request.method, request.path);
    if (!found) throw new HttpError(404, "not_found", "no such route");
    const sub = authenticate(store, request.authorization, found.name !== "createCompany");
    const { schema, value } = handlers[found.name]({ store, id: found.id, query: request.query, body: request.body, sub });
    return { status: found.name === "createCompany" ? 201 : 200, body: schema.parse(value) };
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, body: errorBody(error.code, error.message, error.fields) };
    // No request content in the log: lead routes carry PII.
    console.error("mock company-api failed", error instanceof Error ? error.name : "unknown");
    return { status: 500, body: errorBody("internal", "internal error") };
  }
}

/** Great-circle miles between centre points, as the real route measures; nearest first. */
function zipsWithin(zip: string, miles: number): string[] {
  const centre = ZIP_CENTRES[zip];
  if (!centre) throw new HttpError(400, "invalid_request", "that zip code is not one we have a location for", { zip: "unknown zip" });
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const distance = ([lat, lng]: readonly [number, number]) =>
    2 * 3958.8 * Math.asin(Math.sqrt(Math.sin(rad(lat - centre[0]) / 2) ** 2 + Math.cos(rad(centre[0])) * Math.cos(rad(lat)) * Math.sin(rad(lng - centre[1]) / 2) ** 2));
  return Object.entries(ZIP_CENTRES)
    .map(([z, at]) => [z, distance(at)] as const)
    .filter(([, d]) => d <= miles)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([z]) => z);
}
