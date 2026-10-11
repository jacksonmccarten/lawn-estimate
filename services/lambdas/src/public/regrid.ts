// The Regrid Parcel API client: one address in, at most one parcel out.
// This is the only code that calls Regrid. Every call is metered first
// (regrid_reserve_lookup) and its result cached (parcel_cache_put).

import { SQFT_PER_ACRE } from "./grass.js";

export type Parcel = {
  regridId: string;
  parcelSqft: number | null;
  /** Null when the response carries no footprint for this parcel. */
  footprintSqft: number | null;
  /** Two-letter state, upper case. */
  state: string | null;
  /** County name without the word "County". */
  county: string | null;
  zip: string | null;
};

export type RegridResult =
  | { kind: "match"; parcel: Parcel }
  | { kind: "no_match" }
  /** More than one parcel fits equally well. We never pick one. */
  | { kind: "ambiguous" }
  /** Timeout, network failure, or any status but 200. */
  | { kind: "unavailable" };

export type RegridLookup = (address: string) => Promise<RegridResult>;

type Feature = {
  properties?: {
    ll_uuid?: unknown;
    score?: unknown;
    fields?: Record<string, unknown>;
  };
};
type Building = { properties?: { ed_bldg_footprint_sqft?: unknown; ll_uuids?: unknown } };
type AddressResponse = {
  parcels?: { features?: Feature[] };
  /** Present only when the matched building footprints add-on is licensed. */
  buildings?: { features?: Building[] };
};

const number = (value: unknown): number | null => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function toParcel(feature: Feature, regridId: string, buildings: Building[] | undefined): Parcel {
  const fields = feature.properties?.fields ?? {};
  const sqft = number(fields.ll_gissqft);
  const acres = number(fields.ll_gisacre);
  const mine = buildings?.filter((b) => {
    const owners = b.properties?.ll_uuids;
    return Array.isArray(owners) && owners.includes(regridId);
  });
  const zip = text(fields.szip)?.match(/^[0-9]{5}/)?.[0] ?? null;
  return {
    regridId,
    parcelSqft: sqft !== null ? Math.round(sqft) : acres !== null ? Math.round(acres * SQFT_PER_ACRE) : null,
    footprintSqft: mine?.length
      ? Math.round(mine.reduce((sum, b) => sum + (number(b.properties?.ed_bldg_footprint_sqft) ?? 0), 0))
      : null,
    state: text(fields.state2)?.toUpperCase() ?? null,
    county: text(fields.county)?.replace(/\s+county$/i, "") ?? null,
    zip,
  };
}

/** Reads a v2 address response. Exported for the tests. */
export function parseAddressResponse(body: AddressResponse): RegridResult {
  const byId = new Map<string, Feature>();
  for (const feature of body.parcels?.features ?? []) {
    const id = text(feature.properties?.ll_uuid) ?? text(feature.properties?.fields?.ll_uuid);
    if (id && !byId.has(id)) byId.set(id, feature);
  }
  let candidates = [...byId.entries()];
  if (candidates.length === 0) return { kind: "no_match" };

  // Regrid scores its matches. One parcel alone at the top score is its
  // answer; a tie, or several parcels with no scores, is not ours to break.
  if (candidates.length > 1 && candidates.every(([, f]) => typeof f.properties?.score === "number")) {
    const top = Math.max(...candidates.map(([, f]) => f.properties!.score as number));
    candidates = candidates.filter(([, f]) => f.properties!.score === top);
  }
  if (candidates.length > 1) return { kind: "ambiguous" };

  const [regridId, feature] = candidates[0]!;
  return { kind: "match", parcel: toParcel(feature, regridId, body.buildings?.features) };
}

export function createRegridLookup(options: {
  token: string;
  /** The sandbox and production share a host; the token decides which. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): RegridLookup {
  const { token, baseUrl = "https://app.regrid.com", fetch: doFetch = fetch, timeoutMs = 5000 } = options;
  return async (address) => {
    const url = new URL("/api/v2/parcels/address", baseUrl);
    url.searchParams.set("query", address);
    url.searchParams.set("limit", "5");
    url.searchParams.set("token", token);
    try {
      // The URL holds the address and the token: it is never logged.
      const res = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 200) return { kind: "unavailable" };
      return parseAddressResponse((await res.json()) as AddressResponse);
    } catch {
      return { kind: "unavailable" };
    }
  };
}
