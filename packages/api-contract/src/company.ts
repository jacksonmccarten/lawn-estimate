// The company-api routes: the dashboard's calls, behind the Cognito JWT
// authorizer. The company is never in a request; it comes from the caller's
// claims (withCompany). These responses may carry rates: the caller owns them.

import { z } from "zod";
import {
  Cents,
  CompanySlug,
  Origin,
  QuoteOrigin,
  QuoteStatus,
  QuoteTotals,
  RegionGroup,
  ServiceCode,
  Sqft,
  Theme,
  Uuid,
  Zip,
} from "./common.js";

const Timestamp = z.iso.datetime({ offset: true });

// ---- GET /company, PATCH /company
// Both carry allowedOrigins (who may embed the widget) and theme.

export const Company = z.strictObject({
  id: Uuid,
  slug: CompanySlug,
  name: z.string().min(1).max(120),
  hicNo: z.string().max(40).nullable(),
  allowedOrigins: z.array(Origin).max(20),
  theme: Theme,
});
export type Company = z.infer<typeof Company>;

export const UpdateCompanyRequest = Company.pick({ name: true, hicNo: true, allowedOrigins: true, theme: true }).partial();
export type UpdateCompanyRequest = z.infer<typeof UpdateCompanyRequest>;

// ---- POST /company

/**
 * A new login's first call: it makes their company. The slug is derived from
 * the name by the server. A login that already has a company gets 409.
 */
export const CreateCompanyRequest = z.strictObject({ name: z.string().trim().min(1).max(120) });
export type CreateCompanyRequest = z.infer<typeof CreateCompanyRequest>;

// ---- GET /regions, PUT /regions

export const ServiceRegion = z.strictObject({
  kind: z.enum(["zip", "county"]),
  value: z.string().min(1).max(60),
  tierGroup: RegionGroup,
});
export type ServiceRegion = z.infer<typeof ServiceRegion>;

/** PUT replaces the whole list. */
export const Regions = z.strictObject({ regions: z.array(ServiceRegion).max(2000) });
export type Regions = z.infer<typeof Regions>;

// ---- GET /zips-near

/**
 * The zip codes within a distance of a zip code, for describing part of a
 * service area as a range around a place. Distances are between the zips'
 * centre points, in miles.
 */
export const ZipsNearQuery = z.strictObject({
  zip: Zip,
  miles: z.coerce.number().min(1).max(100),
});
export type ZipsNearQuery = z.infer<typeof ZipsNearQuery>;

/** Nearest first; the centre zip itself is the first. */
export const ZipsNear = z.strictObject({ zip: Zip, miles: z.number(), zips: z.array(Zip) });
export type ZipsNear = z.infer<typeof ZipsNear>;

// ---- pricing versions

export const Service = z.strictObject({
  code: ServiceCode,
  name: z.string().min(1).max(120),
  /** Required on every service; no default (R1). */
  taxable: z.boolean(),
  season: z.enum(["growing", "winter"]),
});
export type Service = z.infer<typeof Service>;

/** Covers minSqft < area <= maxSqft at exactly one of the two prices. */
export const Tier = z
  .strictObject({
    serviceCode: ServiceCode,
    regionGroup: RegionGroup,
    minSqft: Sqft,
    maxSqft: Sqft,
    pricePerSqftMicrocents: z.int().nonnegative().nullable(),
    flatPriceCents: Cents.nullable(),
  })
  .refine((t) => t.maxSqft > t.minSqft, { message: "maxSqft must be greater than minSqft", path: ["maxSqft"] })
  .refine((t) => (t.pricePerSqftMicrocents === null) !== (t.flatPriceCents === null), {
    message: "set exactly one of pricePerSqftMicrocents and flatPriceCents",
    path: ["flatPriceCents"],
  });
export type Tier = z.infer<typeof Tier>;

/** What an owner edits. A tier must name a service in the same version. */
export const PricingVersionContent = z
  .strictObject({
    minChargeCents: Cents,
    coverageFactor: z.number().gt(0).lte(1),
    services: z.array(Service).max(100),
    tiers: z.array(Tier).max(5000),
  })
  .superRefine((v, ctx) => {
    const codes = new Set<string>();
    v.services.forEach((s, i) => {
      if (codes.has(s.code)) ctx.addIssue({ code: "custom", message: "duplicate service code", path: ["services", i, "code"] });
      codes.add(s.code);
    });
    v.tiers.forEach((t, i) => {
      if (!codes.has(t.serviceCode)) {
        ctx.addIssue({ code: "custom", message: "no service with this code in the version", path: ["tiers", i, "serviceCode"] });
      }
    });
  });
export type PricingVersionContent = z.infer<typeof PricingVersionContent>;

export const PricingVersionSummary = z.strictObject({
  id: Uuid,
  version: z.int().positive(),
  /** Null while a draft. Once set the version is immutable. */
  publishedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type PricingVersionSummary = z.infer<typeof PricingVersionSummary>;

/** GET /pricing-versions */
export const PricingVersionList = z.strictObject({ versions: z.array(PricingVersionSummary) });
export type PricingVersionList = z.infer<typeof PricingVersionList>;

/** GET /pricing-versions/{id}, and the response of create, replace and publish. */
export const PricingVersion = PricingVersionSummary.extend({ content: PricingVersionContent });
export type PricingVersion = z.infer<typeof PricingVersion>;

/** POST /pricing-versions: a new draft, empty or copied from a version (rollback is copy, then publish). */
export const CreatePricingVersionRequest = z.strictObject({ copyFrom: Uuid.optional() });
export type CreatePricingVersionRequest = z.infer<typeof CreatePricingVersionRequest>;

/** PUT /pricing-versions/{id}: replaces a draft's content. 409 version_published otherwise. */
export const ReplacePricingVersionRequest = PricingVersionContent;
export type ReplacePricingVersionRequest = PricingVersionContent;

/** POST /pricing-versions/{id}/publish. `confirm` backs the two-step confirmation in the UI. */
export const PublishPricingVersionRequest = z.strictObject({ confirm: z.literal(true) });
export type PublishPricingVersionRequest = z.infer<typeof PublishPricingVersionRequest>;

const change = <T extends z.ZodType>(value: T) => z.strictObject({ from: value, to: value });

/**
 * GET /pricing-versions/{id}/diff: a draft against the company's current
 * published version, for the confirmation step before publishing. A service
 * is matched by code; a tier by service, region group and sqft range, so a
 * tier whose range moved shows as one removed and one added.
 */
export const PricingVersionDiff = z.strictObject({
  draftId: Uuid,
  /** Null when nothing is published yet; everything is then `added`. */
  publishedId: Uuid.nullable(),
  /** True when publishing would change nothing. */
  identical: z.boolean(),
  /** Null when unchanged. */
  minChargeCents: change(Cents).nullable(),
  coverageFactor: change(z.number().gt(0).lte(1)).nullable(),
  services: z.strictObject({
    added: z.array(Service),
    removed: z.array(Service),
    /** Includes a changed `taxable` flag, which changes what homeowners are charged. */
    changed: z.array(change(Service)),
  }),
  tiers: z.strictObject({
    added: z.array(Tier),
    removed: z.array(Tier),
    changed: z.array(change(Tier)),
  }),
});
export type PricingVersionDiff = z.infer<typeof PricingVersionDiff>;

/** POST /pricing-versions/{id}/preview: runs packages/pricing on a draft or published version. */
export const PreviewQuoteRequest = z.strictObject({
  serviceCode: ServiceCode,
  addOnCodes: z.array(ServiceCode).max(20).optional(),
  grassSqft: Sqft,
  regionGroup: RegionGroup,
  county: z.string().min(1).max(60),
});
export type PreviewQuoteRequest = z.infer<typeof PreviewQuoteRequest>;

export const PreviewQuoteResponse = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("priced"), quote: QuoteTotals }),
  z.strictObject({ status: z.literal("no_price"), reason: z.enum(["unknown_service", "no_tier", "unknown_county"]), serviceCode: ServiceCode.optional() }),
]);
export type PreviewQuoteResponse = z.infer<typeof PreviewQuoteResponse>;

// ---- leads

/** A submitted quote with its contact. Contact details are PII: never logged. */
export const Lead = z.strictObject({
  id: Uuid,
  quoteId: Uuid,
  status: QuoteStatus.exclude(["priced"]),
  createdAt: Timestamp,
  contact: z.strictObject({ name: z.string(), phone: z.string().nullable(), email: z.string().nullable() }),
  addressText: z.string(),
  county: z.string(),
  origin: QuoteOrigin,
  parcelSqft: Sqft.nullable(),
  footprintSqft: Sqft.nullable(),
  grassSqft: Sqft,
  quote: QuoteTotals,
  pricingVersionId: Uuid,
  /** The operator's own total when accepting, if it differs from the estimate. */
  adjustedTotalCents: Cents.nullable(),
});
export type Lead = z.infer<typeof Lead>;

/** GET /leads */
export const ListLeadsQuery = z.strictObject({
  status: QuoteStatus.exclude(["priced"]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListLeadsQuery = z.infer<typeof ListLeadsQuery>;

export const LeadList = z.strictObject({ leads: z.array(Lead), nextCursor: z.string().nullable() });
export type LeadList = z.infer<typeof LeadList>;

/**
 * POST /leads/{id}/decision: the operator's decision on a submitted lead.
 * `accept` takes the estimate as quoted; `adjust` accepts at the operator's
 * own total; `decline` turns it down. The response is the lead, with status
 * `accepted` or `declined` and `adjustedTotalCents` set only after `adjust`.
 * A lead is decided once: a second call, whatever its action, is refused with
 * 409 `lead_already_decided` and changes nothing.
 */
export const LeadDecisionRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept") }),
  z.strictObject({ action: z.literal("adjust"), adjustedTotalCents: Cents }),
  z.strictObject({ action: z.literal("decline") }),
]);
export type LeadDecisionRequest = z.infer<typeof LeadDecisionRequest>;

// ---- GET /usage

export const Usage = z.strictObject({
  /** First day of the month, e.g. 2026-10-01. */
  month: z.iso.date(),
  regridLookups: z.int().nonnegative(),
  quotes: z.int().nonnegative(),
  regridLookupQuota: z.int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;
