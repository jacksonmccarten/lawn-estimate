// Typed calls to the SECURITY DEFINER functions of 0009_public_estimate_submit.sql.
// They are everything the public routes can do in the database: app_public
// has no table privileges. Every call runs inside withPublic.

import type { QuoteLine, QuoteOrigin } from "@lq/api-contract";
import type { DbTx } from "@lq/db";
import type { z } from "zod";
import { fromJson } from "../http.js";
import type { Parcel } from "./regrid.js";

type Origin = z.infer<typeof QuoteOrigin>;

/** Calls a function that returns jsonb. */
async function call<T>(tx: DbTx, sql: string, params: readonly unknown[]): Promise<T> {
  return fromJson<T>(await scalar<unknown>(tx, sql, params));
}

async function scalar<T>(tx: DbTx, sql: string, params: readonly unknown[]): Promise<T> {
  const res = await tx.query<{ r: T }>(`SELECT ${sql} AS r`, params);
  return res.rows[0]!.r;
}

type CachedParcel = {
  regrid_id: string;
  parcel_sqft: number | null;
  footprint_sqft: number | null;
  state: string | null;
  county: string | null;
  zip: string | null;
};

export type EstimateContext = {
  originAllowed: boolean;
  phone: string | null;
  serviceOffered: boolean;
  /** `unknown` when the address carried no zip to check. */
  region: "in" | "out" | "unknown";
  /** False once the company has used its Regrid lookups for the month. */
  quotaLeft: boolean;
  parcel: Parcel | null;
};

export async function estimateContext(
  tx: DbTx,
  slug: string,
  embedOrigin: string | null,
  service: string,
  addressNorm: string,
  zip: string | null,
): Promise<EstimateContext> {
  const r = await call<{
    origin_allowed: boolean;
    phone: string | null;
    service_offered: boolean;
    region: EstimateContext["region"];
    quota_left: boolean;
    parcel: CachedParcel | null;
  }>(tx, "estimate_context($1, $2, $3, $4, $5)", [slug, embedOrigin, service, addressNorm, zip]);
  return {
    originAllowed: r.origin_allowed,
    phone: r.phone,
    serviceOffered: r.service_offered,
    region: r.region,
    quotaLeft: r.quota_left,
    parcel: r.parcel && {
      regridId: r.parcel.regrid_id,
      parcelSqft: r.parcel.parcel_sqft,
      footprintSqft: r.parcel.footprint_sqft,
      state: r.parcel.state,
      county: r.parcel.county,
      zip: r.parcel.zip,
    },
  };
}

export type Reservation = {
  allowed: boolean;
  reason: "company_quota" | "global_cap" | null;
  company_lookups: number;
  company_quota: number;
  global_lookups: number;
  global_cap: number;
};

export function reserveLookup(tx: DbTx, slug: string): Promise<Reservation> {
  return call<Reservation>(tx, "regrid_reserve_lookup($1)", [slug]);
}

export async function parcelCachePut(tx: DbTx, addressNorm: string, p: Parcel): Promise<void> {
  await tx.query("SELECT parcel_cache_put($1, $2, $3, $4, $5, $6, $7)", [
    addressNorm,
    p.regridId,
    p.parcelSqft,
    p.footprintSqft,
    p.state,
    p.county,
    p.zip,
  ]);
}

type Slice = {
  version_id?: string;
  min_charge_cents?: number;
  coverage_hundredths?: number;
  service?: { code: string; name: string; taxable: boolean } | null;
  tiers?: { min_sqft: number; max_sqft: number; price_per_sqft_microcents: number | null; flat_price_cents: number | null }[];
};

/** One service of one pricing version in one region group, ready for packages/pricing. */
export type PricingSlice = {
  versionId: string;
  minChargeCents: number;
  coverageHundredths: number;
  service: { code: string; name: string; taxable: boolean };
  tiers: {
    minSqft: number;
    maxSqft: number;
    pricePerSqftMicrocents: number | null;
    flatPriceCents: number | null;
  }[];
};

/** Null when there is no published version or it does not sell the service. */
function toSlice(s: Slice): PricingSlice | null {
  if (!s.version_id || !s.service) return null;
  return {
    versionId: s.version_id,
    minChargeCents: s.min_charge_cents!,
    coverageHundredths: s.coverage_hundredths!,
    service: s.service,
    tiers: (s.tiers ?? []).map((t) => ({
      minSqft: t.min_sqft,
      maxSqft: t.max_sqft,
      pricePerSqftMicrocents: t.price_per_sqft_microcents,
      flatPriceCents: t.flat_price_cents,
    })),
  };
}

export type PricingInputRow = {
  slice: PricingSlice | null;
  /** Null when no region of the company covers the place. */
  regionGroup: string | null;
  /** The county as tax_rates spells it; null with no rate on file. */
  county: string | null;
  taxRateBps: number | null;
};

export async function pricingInput(
  tx: DbTx,
  slug: string,
  service: string,
  zip: string | null,
  state: string,
  county: string,
): Promise<PricingInputRow> {
  const r = await call<Slice & { region_group: string | null; county: string | null; tax_rate_bps: number | null }>(
    tx,
    "estimate_pricing_input($1, $2, $3, $4, $5)",
    [slug, service, zip, state, county],
  );
  return { slice: toSlice(r), regionGroup: r.region_group, county: r.county, taxRateBps: r.tax_rate_bps };
}

export type CountyCandidate = { county: string; is_primary: boolean; tax_rate_bps: number | null };

/** Every county the zip touches, primary first (0007). */
export async function countiesForZip(tx: DbTx, zip: string): Promise<CountyCandidate[]> {
  return (await tx.query<CountyCandidate>("SELECT * FROM counties_for_zip($1)", [zip])).rows;
}

export type NewQuote = {
  version_id: string;
  address_text: string;
  zip: string | null;
  county: string;
  region_group: string;
  parcel_sqft: number | null;
  footprint_sqft: number | null;
  grass_sqft: number;
  origin: Origin;
  line_items: QuoteLine[];
  tax_rate_bps: number;
  tax_cents: number;
  total_cents: number;
  regrid_parcel_id: string | null;
  turnstile_ok: boolean;
  ip_hash: string | null;
  host_origin: string | null;
};

export function insertQuote(tx: DbTx, slug: string, quote: NewQuote): Promise<string> {
  return scalar<string>(tx, "estimate_insert_quote($1, $2::jsonb)", [slug, JSON.stringify(quote)]);
}

export type AdjustableQuote = {
  slice: PricingSlice | null;
  originAllowed: boolean;
  phone: string | null;
  status: string;
  origin: Origin;
  grassSqft: number;
  parcelSqft: number | null;
  footprintSqft: number | null;
  county: string;
  regionGroup: string;
  taxRateBps: number;
};

export async function quoteForAdjust(
  tx: DbTx,
  slug: string,
  quoteId: string,
  embedOrigin: string | null,
): Promise<AdjustableQuote | null> {
  const r = await call<
    | (Slice & {
        origin_allowed: boolean;
        phone: string | null;
        status: string;
        origin: Origin;
        grass_sqft: number;
        parcel_sqft: number | null;
        footprint_sqft: number | null;
        county: string;
        region_group: string;
        tax_rate_bps: number;
      })
    | null
  >(tx, "estimate_quote_for_adjust($1, $2, $3)", [slug, quoteId, embedOrigin]);
  return (
    r && {
      slice: toSlice(r),
      originAllowed: r.origin_allowed,
      phone: r.phone,
      status: r.status,
      origin: r.origin,
      grassSqft: r.grass_sqft,
      parcelSqft: r.parcel_sqft,
      footprintSqft: r.footprint_sqft,
      county: r.county,
      regionGroup: r.region_group,
      taxRateBps: r.tax_rate_bps,
    }
  );
}

export function applyAdjustment(
  tx: DbTx,
  slug: string,
  quoteId: string,
  quote: Pick<NewQuote, "grass_sqft" | "line_items" | "tax_cents" | "total_cents">,
): Promise<boolean> {
  return scalar<boolean>(tx, "estimate_apply_adjustment($1, $2, $3::jsonb)", [slug, quoteId, JSON.stringify(quote)]);
}

export type SubmitResult =
  | { result: "origin_not_allowed" | "not_found" | "already_submitted" }
  | {
      result: "created";
      lead_id: string;
      notify: boolean;
      company_name: string;
      alert_email: string | null;
      alert_phone: string | null;
      sms_ok: boolean;
      address_text: string;
      county: string;
      grass_sqft: number;
      line_items: QuoteLine[];
      tax_cents: number;
      total_cents: number;
    };

export function submitLead(
  tx: DbTx,
  slug: string,
  quoteId: string,
  embedOrigin: string | null,
  contact: { name: string; phone?: string | undefined; email?: string | undefined },
): Promise<SubmitResult> {
  return call<SubmitResult>(tx, "submit_lead($1, $2, $3, $4, $5, $6)", [
    slug,
    quoteId,
    embedOrigin,
    contact.name,
    contact.phone ?? null,
    contact.email ?? null,
  ]);
}

export async function markNotified(tx: DbTx, slug: string, leadId: string, sms: boolean): Promise<void> {
  await tx.query("SELECT lead_mark_notified($1, $2, $3)", [slug, leadId, sms]);
}
