// POST /estimate (design sections 5, 6 and 9).
//
// Order, cheapest first, and nothing reaches Regrid before all of it passed:
// contract validation, Turnstile, then one transaction for the origin
// allowlist, the company quota, the service and the service region.
//
// The database is reached only through withPublic. A Regrid call never
// happens inside a transaction: the gate, the metering and the pricing are
// separate, short ones.

import { EstimateRequest, EstimateResponse } from "@lq/api-contract";
import type { DbTx } from "@lq/db";
import { priceQuote, type Quote } from "@lq/pricing";
import type { z } from "zod";
import { HttpError, json, parseBody, respond, validate, type HttpEvent, type HttpResult } from "../http.js";
import * as db from "./db.js";
import { embedOriginRefused, hashIp, requireWidgetOrigin, type PublicDeps } from "./deps.js";
import { throughEdge } from "./edge.js";
import {
  adjustGrass,
  grassFromManual,
  grassFromParcel,
  MAX_FORMULA_PARCEL_SQFT,
  normalizeAddress,
  zipFromAddress,
} from "./grass.js";
import type { Parcel } from "./regrid.js";

type Request = z.infer<typeof EstimateRequest>;
type NewRequest = Exclude<Request, { token: string }>;
type AdjustRequest = Extract<Request, { token: string }>;
type Response = z.infer<typeof EstimateResponse>;
type ManualReason = Extract<Response, { status: "manual_required" }>["reason"];
type CallUsReason = Extract<Response, { status: "call_us" }>["reason"];

/** The launch market. Zips, and the counties they resolve to, are Pennsylvania's. */
const STATE = "PA";

const manualRequired = (reason: ManualReason): Response => ({ status: "manual_required", reason });
const callUs = (reason: CallUsReason, phone: string | null): Response => ({ status: "call_us", reason, phone });

/** What is known about one request once it is through the gate. */
type Ctx = {
  deps: PublicDeps;
  req: NewRequest;
  phone: string | null;
  turnstileOk: boolean;
  ipHash: string | null;
};

function price(slice: db.PricingSlice, grassSqft: number, regionGroup: string, taxRateBps: number): Quote | null {
  const result = priceQuote({
    version: {
      id: slice.versionId,
      minChargeCents: slice.minChargeCents,
      services: [slice.service],
      tiers: slice.tiers.map((t) => ({ ...t, serviceCode: slice.service.code, regionGroup })),
    },
    serviceCode: slice.service.code,
    grassSqft,
    regionGroup,
    taxRateBps,
  });
  // The slice holds the service, so the only failure left is "no tier for this size".
  return result.ok ? result.quote : null;
}

/** The contract's QuoteTotals: the engine's quote without the version id. */
function totals(quote: Quote) {
  const { versionId: _versionId, ...rest } = quote;
  return rest;
}

async function priceAndStore(
  tx: DbTx,
  ctx: Ctx,
  input: db.PricingInputRow,
  estimate: { grassSqft: number; assumptions: string[]; origin: "regrid" | "bucket" | "manual" | "drawn" },
  place: { zip: string | null; parcel: Parcel | null },
): Promise<Response> {
  const { deps, req } = ctx;
  // The gate checked the service; a version published in between can drop it.
  if (!input.slice) throw new HttpError("invalid_request", "the company does not offer this service", { service: "not offered" });
  if (input.regionGroup === null) return callUs("outside_service_area", ctx.phone);
  // Never a default rate (R4). The callers turn a missing rate into their own answer first.
  if (input.taxRateBps === null || input.county === null) throw new Error("pricing without a tax county");

  const quote = price(input.slice, estimate.grassSqft, input.regionGroup, input.taxRateBps);
  if (!quote) return callUs("no_price_for_size", ctx.phone);

  const quoteId = await db.insertQuote(tx, req.company, {
    version_id: quote.versionId,
    address_text: req.address,
    zip: place.zip,
    county: input.county,
    region_group: input.regionGroup,
    parcel_sqft: place.parcel?.parcelSqft ?? null,
    footprint_sqft: place.parcel?.footprintSqft ?? null,
    grass_sqft: estimate.grassSqft,
    origin: estimate.origin,
    line_items: quote.lines,
    tax_rate_bps: quote.taxRateBps,
    tax_cents: quote.taxCents,
    total_cents: quote.totalCents,
    regrid_parcel_id: place.parcel?.regridId ?? null,
    turnstile_ok: ctx.turnstileOk,
    ip_hash: ctx.ipHash,
    host_origin: req.embedOrigin,
  });
  deps.log("info", "estimate_priced", { quoteId, company: req.company, origin: estimate.origin });

  return {
    status: "priced",
    quote: totals(quote),
    token: deps.tokens.sign({ quoteId, company: req.company }),
    grassSqft: estimate.grassSqft,
    parcelSqft: place.parcel?.parcelSqft ?? null,
    origin: estimate.origin,
    county: input.county,
    assumptions: estimate.assumptions,
    canAdjust: estimate.origin === "regrid",
  };
}

/** A parcel, from the cache or fresh from Regrid, to a price or a reason there is none. */
async function priceParcel(tx: DbTx, ctx: Ctx, parcel: Parcel, addressZip: string | null): Promise<Response> {
  if (parcel.parcelSqft === null) return manualRequired("no_match");
  if (parcel.parcelSqft > MAX_FORMULA_PARCEL_SQFT) return manualRequired("parcel_over_two_acres");
  if (!parcel.state || !parcel.county) return manualRequired("unknown_county");

  const zip = parcel.zip ?? addressZip;
  const input = await db.pricingInput(tx, ctx.req.company, ctx.req.service, zip, parcel.state, parcel.county);
  // The parcel's county has no rate on file: the manual path's zip supplies one.
  if (input.taxRateBps === null) return manualRequired("unknown_county");

  const coverage = input.slice?.coverageHundredths ?? 0;
  const estimate = grassFromParcel(parcel.parcelSqft, parcel.footprintSqft, coverage);
  return priceAndStore(tx, ctx, input, { ...estimate, origin: "regrid" }, { zip, parcel });
}

/**
 * The manual path: a zip and a size from the homeowner. The tax county is the
 * cached parcel's when there is one with a rate on file, otherwise a county
 * of the zip: the homeowner's choice if the candidates' rates differ, the
 * primary county if they do not.
 */
async function priceManual(tx: DbTx, ctx: Ctx, cached: Parcel | null): Promise<Response> {
  const { req } = ctx;
  const manual = req.manual!;

  let input: db.PricingInputRow | null = null;
  if (cached?.state && cached.county) {
    const fromParcel = await db.pricingInput(tx, req.company, req.service, manual.zip, cached.state, cached.county);
    if (fromParcel.taxRateBps !== null) input = fromParcel;
  }

  if (!input) {
    const candidates = await db.countiesForZip(tx, manual.zip);
    if (candidates.length === 0) return callUs("unknown_county", ctx.phone);

    let county: string;
    if (manual.county !== undefined) {
      const chosen = candidates.find((c) => c.county.toLowerCase() === manual.county!.trim().toLowerCase());
      if (!chosen) {
        throw new HttpError("invalid_request", "the county is not one this zip lies in", { "manual.county": "not a county of this zip" });
      }
      county = chosen.county;
    } else if (new Set(candidates.map((c) => c.tax_rate_bps)).size > 1) {
      return { status: "county_required", zip: manual.zip, candidates: candidates.map((c) => c.county) };
    } else {
      county = candidates[0]!.county;
    }

    input = await db.pricingInput(tx, req.company, req.service, manual.zip, STATE, county);
    if (input.taxRateBps === null) return callUs("unknown_county", ctx.phone);
  }

  const estimate = grassFromManual(manual.size);
  return priceAndStore(tx, ctx, input, estimate, { zip: manual.zip, parcel: null });
}

async function fresh(deps: PublicDeps, req: NewRequest, turnstileOk: boolean, ip: string | null): Promise<Response> {
  const addressNorm = normalizeAddress(req.address);
  const addressZip = req.manual?.zip ?? zipFromAddress(req.address);
  const ctx: Ctx = { deps, req, phone: null, turnstileOk, ipHash: hashIp(deps.ipHashSalt, ip) };
  // The company's plan, asked before the transaction: it is a call to AWS Monetization.
  const entitlement = deps.billing ? await deps.billing.entitlement(req.company) : "none";

  // The gate, and everything that needs no Regrid call.
  const gated = await deps.withPublic(req.company, async (tx): Promise<Response | "lookup"> => {
    const gate = await db.estimateContext(tx, req.company, req.embedOrigin, req.service, addressNorm, addressZip);
    if (!gate.originAllowed) throw embedOriginRefused(deps, req.company);
    // A subscribed company's plan decides; without one, the database allowance does.
    if (entitlement === "deny" || (entitlement === "none" && !gate.quotaLeft)) throw quotaExceeded(deps, req.company);
    if (!gate.serviceOffered) {
      throw new HttpError("invalid_request", "the company does not offer this service", { service: "not offered" });
    }
    ctx.phone = gate.phone;
    // Refused before any Regrid call (section 6).
    if (gate.region === "out") return callUs("outside_service_area", gate.phone);
    if (req.manual) return priceManual(tx, ctx, gate.parcel);
    if (gate.parcel) return priceParcel(tx, ctx, gate.parcel, addressZip);
    return "lookup";
  });
  if (gated !== "lookup") return gated;

  // A cache miss. Regrid costs money, so an unverified request does not get there.
  if (!turnstileOk || !deps.regrid) return manualRequired("lookup_unavailable");

  const reservation = await deps.withPublic(req.company, (tx) => db.reserveLookup(tx, req.company));
  if (!reservation.allowed) {
    if (reservation.reason === "company_quota") throw quotaExceeded(deps, req.company);
    // The circuit breaker (R13): CloudWatch alarms on this line.
    deps.log("error", "regrid_global_cap", { lookups: reservation.global_lookups });
    return manualRequired("lookup_unavailable");
  }
  if (reservation.company_lookups === Math.ceil(reservation.company_quota * 0.8)) {
    deps.log("warn", "regrid_quota_80", { company: req.company, lookups: reservation.company_lookups });
  }
  if (reservation.global_lookups === Math.ceil(reservation.global_cap * 0.8)) {
    deps.log("warn", "regrid_global_80", { lookups: reservation.global_lookups });
  }

  const found = await deps.regrid(req.address);
  if (found.kind !== "match") {
    deps.log("info", "regrid_lookup", { company: req.company, result: found.kind });
    if (found.kind === "unavailable") return manualRequired("lookup_unavailable");
    return manualRequired(found.kind === "ambiguous" ? "ambiguous_match" : "no_match");
  }

  return deps.withPublic(req.company, async (tx) => {
    await db.parcelCachePut(tx, addressNorm, found.parcel);
    return priceParcel(tx, ctx, found.parcel, addressZip);
  });
}

function quotaExceeded(deps: PublicDeps, company: string): HttpError {
  deps.log("warn", "quota_exceeded", { company });
  return new HttpError("quota_exceeded", "the company has no estimates left this month");
}

/** The homeowner's one adjustment, re-priced from the quote's pinned version and tax rate. */
async function adjust(deps: PublicDeps, req: AdjustRequest): Promise<Response> {
  const claims = deps.tokens.verify(req.token);
  return deps.withPublic(claims.company, async (tx) => {
    const quote = await db.quoteForAdjust(tx, claims.company, claims.quoteId, req.embedOrigin);
    // Deleted after 7 days if never submitted.
    if (!quote) throw new HttpError("token_expired", "the quote no longer exists");
    if (!quote.originAllowed) throw embedOriginRefused(deps, claims.company);
    const used = () => new HttpError("conflict", "this quote can no longer be adjusted");
    if (quote.status !== "priced" || quote.origin !== "regrid" || !quote.slice) throw used();

    const grassSqft = adjustGrass(quote.grassSqft, req.adjust);
    const repriced = price(quote.slice, grassSqft, quote.regionGroup, quote.taxRateBps);
    if (!repriced) return callUs("no_price_for_size", quote.phone);

    const applied = await db.applyAdjustment(tx, claims.company, claims.quoteId, {
      grass_sqft: grassSqft,
      line_items: repriced.lines,
      tax_cents: repriced.taxCents,
      total_cents: repriced.totalCents,
    });
    if (!applied) throw used();
    deps.log("info", "estimate_adjusted", { quoteId: claims.quoteId, adjust: req.adjust });

    const { assumptions } = grassFromParcel(quote.parcelSqft ?? 0, quote.footprintSqft, quote.slice.coverageHundredths);
    return {
      status: "priced",
      quote: totals(repriced),
      token: req.token,
      grassSqft,
      parcelSqft: quote.parcelSqft,
      origin: "regrid_adjusted",
      county: quote.county,
      assumptions: [...assumptions, `Adjusted ${req.adjust} at your request.`],
      canAdjust: false,
    };
  });
}

export function createEstimateHandler(deps: PublicDeps) {
  return (event: HttpEvent): Promise<HttpResult> =>
    respond(async () => {
      const { ip } = throughEdge(deps.edge, event, deps.log);
      requireWidgetOrigin(deps, event);
      const req = validate(EstimateRequest, parseBody(event));

      const verdict = await deps.turnstile(req.turnstile, ip);
      if (verdict === "failed") throw new HttpError("turnstile_failed", "the Turnstile check failed");
      if (verdict === "unavailable") deps.log("warn", "turnstile_unavailable", { route: "estimate" });

      const body = "token" in req ? await adjust(deps, req) : await fresh(deps, req, verdict === "ok", ip);
      // A new estimate priced is what the company's plan counts; an adjustment re-prices one already counted.
      if (!("token" in req) && body.status === "priced" && deps.billing) await deps.billing.estimatePriced(req.company);
      // Strict schemas: a field the contract does not name cannot leave.
      return json(200, EstimateResponse.parse(body));
    });
}
