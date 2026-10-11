import { z } from "zod";

export const Uuid = z.uuid();
export const Cents = z.int().nonnegative();
export const Sqft = z.int().nonnegative();

/** Same shape as the CHECK on companies.slug. */
export const CompanySlug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(63);
export const ServiceCode = z.string().regex(/^[a-z0-9_]+$/).max(40);
export const RegionGroup = z.string().min(1).max(40);
export const Zip = z.string().regex(/^[0-9]{5}$/);
export const County = z.string().min(1).max(60);

/** An origin exactly as a browser reports it: scheme, host, optional port, nothing after. */
export const Origin = z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i).max(255);

/** Company theming. Carried by GET/PATCH /company and by the public profile. */
export const Theme = z.strictObject({
  /** Applied only to elements where it passes contrast; never as text color. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Key of a logo in our S3 bucket, from a presigned upload. Never a URL. */
  logoKey: z.string().regex(/^logos\/[A-Za-z0-9/_-]+\.(png|jpg|webp)$/).max(200).optional(),
});
export type Theme = z.infer<typeof Theme>;

export const QuoteStatus = z.enum(["priced", "submitted", "accepted", "declined", "expired"]);
/**
 * Where the lawn area came from. `drawn`: the homeowner outlined the lawn on
 * an aerial photo. `bucket` and `manual`: a lot-size range or a typed area.
 * `regrid` and `regrid_adjusted` are parcel lookups, kept for quotes made
 * before the aerial photo replaced them.
 */
export const QuoteOrigin = z.enum(["regrid", "regrid_adjusted", "bucket", "manual", "drawn"]);

/**
 * One priced line. This is all the homeowner's browser ever learns about
 * pricing: an amount and whether tax applies, never a rate or a tier.
 */
export const QuoteLine = z.strictObject({
  serviceCode: ServiceCode,
  name: z.string(),
  amountCents: Cents,
  taxable: z.boolean(),
});
export type QuoteLine = z.infer<typeof QuoteLine>;

/** Line items and totals, as packages/pricing produces them. Lines are never merged (R3). */
export const QuoteTotals = z.strictObject({
  lines: z.array(QuoteLine).min(1),
  subtotalCents: Cents,
  taxableSubtotalCents: Cents,
  /** Basis points: 6% is 600. */
  taxRateBps: z.int().min(0).max(9999),
  taxCents: Cents,
  totalCents: Cents,
});
export type QuoteTotals = z.infer<typeof QuoteTotals>;

export const ErrorCode = z.enum([
  "invalid_request",
  "turnstile_failed",
  "origin_not_allowed",
  "quota_exceeded",
  "rate_limited",
  "token_invalid",
  "token_expired",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  /** A published pricing version cannot be changed. */
  "version_published",
  /** A lead is decided once. */
  "lead_already_decided",
  /** AWS Monetization is not configured, or did not answer. */
  "billing_unavailable",
  /** No inbox is configured for the website's contact form. */
  "contact_unavailable",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** The body of every non-2xx response. `message` is for logs and developers, not for display. */
export const ErrorResponse = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    message: z.string(),
    /** For invalid_request: which fields failed. */
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
