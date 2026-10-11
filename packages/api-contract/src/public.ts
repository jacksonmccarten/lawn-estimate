// The public routes of docs/ENGINEERING_DESIGN.md section 5. Anonymous.
// /estimate and /submit are called from the widget iframe and always carry a
// Turnstile token; the profile is read by the widget app's server.

import { z } from "zod";
import { CompanySlug, County, Origin, QuoteOrigin, QuoteTotals, ServiceCode, Sqft, Theme, Uuid, Zip } from "./common.js";

const Turnstile = z.string().min(1).max(2048);

/** The origin of the page embedding the widget; null on the hosted page. */
const EmbedOrigin = Origin.nullable();

/** The signed quote token returned by /estimate. Opaque to the client. */
const QuoteToken = z.string().min(1).max(2048);

/**
 * The size the homeowner gives (section 6): the area of the lawn they
 * outlined on the aerial photo, a lot-size bucket, or a typed area. The
 * browser measures the outline; the server prices the area it is sent.
 */
export const ManualSize = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("drawn"), sqft: Sqft.min(100).max(2_000_000) }),
  z.strictObject({ kind: z.literal("bucket"), bucket: z.enum(["quarter_acre", "half_acre", "one_acre", "two_plus_acres"]) }),
  z.strictObject({ kind: z.literal("sqft"), sqft: Sqft.min(100).max(2_000_000) }),
]);
export type ManualSize = z.infer<typeof ManualSize>;

/**
 * The manual path. The zip is required: with no parcel, it is what decides the
 * tax county. `county` is the homeowner's answer to a `county_required`
 * response and must be one of the candidates that response listed; it is
 * omitted on the first manual call.
 */
export const ManualEntry = z.strictObject({ zip: Zip, size: ManualSize, county: County.optional() });
export type ManualEntry = z.infer<typeof ManualEntry>;

// ---- POST /estimate

/** First call: an address and a service. `manual` is sent after a `manual_required` response. */
const EstimateNew = z.strictObject({
  company: CompanySlug,
  address: z.string().trim().min(5).max(300),
  service: ServiceCode,
  manual: ManualEntry.optional(),
  turnstile: Turnstile,
  embedOrigin: EmbedOrigin,
});

/** Second call: the homeowner's one "smaller" (x0.75) or "larger" (x1.25) adjustment. */
const EstimateAdjust = z.strictObject({
  token: QuoteToken,
  adjust: z.enum(["smaller", "larger"]),
  turnstile: Turnstile,
  embedOrigin: EmbedOrigin,
});

export const EstimateRequest = z.union([EstimateNew, EstimateAdjust]);
export type EstimateRequest = z.infer<typeof EstimateRequest>;

/** A price. Carries no rate, tier or region group. */
const EstimatePriced = z.strictObject({
  status: z.literal("priced"),
  quote: QuoteTotals,
  /** Send back on /submit, or on /estimate to adjust. */
  token: QuoteToken,
  grassSqft: Sqft,
  /** From county tax records, not a survey (R21). Null on the manual path. */
  parcelSqft: Sqft.nullable(),
  origin: QuoteOrigin,
  /** The county whose tax rate was applied, shown on the quote: the parcel's when known, otherwise the zip's primary county. */
  county: County,
  /** Shown under the price, e.g. "includes the house footprint". */
  assumptions: z.array(z.string()),
  /** False once the single adjustment has been used. */
  canAdjust: z.boolean(),
});

/**
 * No automatic price: show the manual path, then call again with `manual`.
 * `unknown_county` means the parcel gave no county with a tax rate on file;
 * the manual path's zip supplies one. Never priced at a default rate (R4).
 */
const EstimateManualRequired = z.strictObject({
  status: z.literal("manual_required"),
  reason: z.enum(["no_match", "ambiguous_match", "parcel_over_two_acres", "lookup_unavailable", "unknown_county"]),
});

/**
 * The zip of a manual request lies in counties with different tax rates, and
 * the request did not say which. Ask the homeowner to pick one of
 * `candidates`, then repeat the request with `manual.county` set. Rates are
 * not sent: the choice is where the property is, not what it costs.
 */
const EstimateCountyRequired = z.strictObject({
  status: z.literal("county_required"),
  zip: Zip,
  candidates: z.array(County).min(2),
});

/**
 * No price can be shown: the homeowner is asked to call the company. Here
 * `unknown_county` is the end of the road: the manual path's zip has no county
 * on file either.
 */
const EstimateCallUs = z.strictObject({
  status: z.literal("call_us"),
  reason: z.enum(["outside_service_area", "no_price_for_size", "unknown_county"]),
  phone: z.string().nullable(),
});

export const EstimateResponse = z.discriminatedUnion("status", [
  EstimatePriced,
  EstimateManualRequired,
  EstimateCountyRequired,
  EstimateCallUs,
]);
export type EstimateResponse = z.infer<typeof EstimateResponse>;

// ---- POST /submit

export const Contact = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().regex(/^\+?[0-9 ().-]{7,20}$/).optional(),
    email: z.email().max(254).optional(),
  })
  .refine((c) => c.phone !== undefined || c.email !== undefined, {
    message: "a phone number or an email address is required",
    path: ["phone"],
  });
export type Contact = z.infer<typeof Contact>;

export const SubmitRequest = z.strictObject({
  token: QuoteToken,
  contact: Contact,
  turnstile: Turnstile,
  embedOrigin: EmbedOrigin,
  /** Honeypot: hidden from people, so anything in it marks a bot. */
  website: z.string().max(0).optional(),
});
export type SubmitRequest = z.infer<typeof SubmitRequest>;

export const SubmitResponse = z.strictObject({
  status: z.literal("submitted"),
  quoteId: Uuid,
});
export type SubmitResponse = z.infer<typeof SubmitResponse>;

// ---- POST /contact

/**
 * The public website's contact form, from the dashboard's own origin. The
 * message is emailed to the InstaQuotesAI team; nothing is stored.
 */
export const ContactRequest = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  message: z.string().trim().min(1).max(4000),
  turnstile: Turnstile,
  /** Honeypot: hidden from people, so anything in it marks a bot. */
  website: z.string().max(0).optional(),
});
export type ContactRequest = z.infer<typeof ContactRequest>;

export const ContactResponse = z.strictObject({ status: z.literal("sent") });
export type ContactResponse = z.infer<typeof ContactResponse>;

// ---- GET /profile/{company}

/**
 * What the widget page is rendered from: the company's name, theme and the
 * services of its published pricing version, and the origins that may embed
 * it (the page's frame-ancestors). No rate, tier, region or contact detail.
 */
export const PublicProfile = z.strictObject({
  slug: CompanySlug,
  name: z.string(),
  theme: Theme,
  services: z.array(z.strictObject({ code: ServiceCode, name: z.string(), season: z.enum(["growing", "winter"]) })),
  allowedOrigins: z.array(Origin),
});
export type PublicProfile = z.infer<typeof PublicProfile>;
