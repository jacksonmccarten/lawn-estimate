// GET/PATCH /company, GET/PUT /regions, GET /usage. Every statement runs
// inside withCompany, so RLS has already narrowed each table to the caller's
// company; the WHERE clauses name no company unless a row count depends on it.

import type { Company, Regions, UpdateCompanyRequest, Usage, ZipsNear, ZipsNearQuery } from "@lq/api-contract";
import type { DbTx } from "@lq/db";
import { fromJson, HttpError } from "../http.js";

/** A timestamptz as an ISO string, the same from either driver. */
export const isoTimestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function getCompany(tx: DbTx): Promise<Company> {
  const res = await tx.query<{
    id: string;
    slug: string;
    name: string;
    hic_no: string | null;
    allowed_origins: unknown;
    theme: unknown;
  }>("SELECT id, slug, name, hic_no, to_jsonb(allowed_origins) AS allowed_origins, theme FROM companies");
  const row = res.rows[0];
  if (!row) throw new HttpError("not_found", "no such company");
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    hicNo: row.hic_no,
    allowedOrigins: fromJson<string[]>(row.allowed_origins),
    theme: fromJson<Company["theme"]>(row.theme),
  };
}

export async function updateCompany(tx: DbTx, companyId: string, patch: UpdateCompanyRequest): Promise<Company> {
  // Origins compare case-insensitively; store them the way a browser reports them.
  const origins = patch.allowedOrigins && [...new Set(patch.allowedOrigins.map((o) => o.toLowerCase()))];
  const res = await tx.query(
    `UPDATE companies SET
       name = COALESCE($2, name),
       hic_no = CASE WHEN $3 THEN $4 ELSE hic_no END,
       allowed_origins = CASE WHEN $5::jsonb IS NULL THEN allowed_origins
                              ELSE ARRAY(SELECT jsonb_array_elements_text($5::jsonb)) END,
       theme = COALESCE($6::jsonb, theme)
     WHERE id = $1`,
    [
      companyId,
      patch.name ?? null,
      patch.hicNo !== undefined,
      patch.hicNo ?? null,
      origins ? JSON.stringify(origins) : null,
      patch.theme ? JSON.stringify(patch.theme) : null,
    ],
  );
  // An update that RLS filters out changes nothing and raises nothing.
  if (res.rowCount !== 1) throw new HttpError("not_found", "no such company");
  return getCompany(tx);
}

export async function getRegions(tx: DbTx): Promise<Regions> {
  const res = await tx.query<{ kind: "zip" | "county"; value: string; tier_group: string }>(
    "SELECT kind, value, tier_group FROM service_regions ORDER BY kind, value",
  );
  return { regions: res.rows.map((r) => ({ kind: r.kind, value: r.value, tierGroup: r.tier_group })) };
}

/** PUT replaces the whole list. */
export async function replaceRegions(tx: DbTx, companyId: string, body: Regions): Promise<Regions> {
  const seen = new Set<string>();
  body.regions.forEach((r, i) => {
    const key = `${r.kind}:${r.value.toLowerCase()}`;
    if (seen.has(key)) throw new HttpError("invalid_request", "a region is listed twice", { [`regions.${i}.value`]: "duplicate" });
    if (r.kind === "zip" && !/^[0-9]{5}$/.test(r.value)) {
      throw new HttpError("invalid_request", "a zip region is five digits", { [`regions.${i}.value`]: "not a zip" });
    }
    seen.add(key);
  });
  await tx.query("DELETE FROM service_regions WHERE company_id = $1", [companyId]);
  await tx.query(
    `INSERT INTO service_regions (company_id, kind, value, tier_group)
     SELECT $1::uuid, x.kind, x.value, x."tierGroup"
     FROM jsonb_to_recordset($2::jsonb) AS x(kind text, value text, "tierGroup" text)`,
    [companyId, JSON.stringify(body.regions)],
  );
  return getRegions(tx);
}

/**
 * The zips whose centre points lie within `miles` of the centre of `zip`,
 * nearest first. Great-circle distance on a sphere of the Earth's mean
 * radius (3,958.8 miles), which is exact to well under a mile at this scale.
 */
export async function zipsNear(tx: DbTx, query: ZipsNearQuery): Promise<ZipsNear> {
  const res = await tx.query<{ zip: string }>(
    `SELECT z.zip
     FROM zip_centroid c
     CROSS JOIN LATERAL (
       SELECT z.zip,
              2 * 3958.8 * asin(sqrt(
                power(sin(radians(z.lat - c.lat) / 2), 2)
                + cos(radians(c.lat)) * cos(radians(z.lat)) * power(sin(radians(z.lng - c.lng) / 2), 2))) AS miles
       FROM zip_centroid z
     ) z
     WHERE c.zip = $1 AND z.miles <= $2
     ORDER BY z.miles, z.zip`,
    [query.zip, query.miles],
  );
  // The centre is always within range of itself, so no row means no such zip.
  if (res.rows.length === 0) throw new HttpError("invalid_request", "that zip code is not one we have a location for", { zip: "unknown zip" });
  return { zip: query.zip, miles: query.miles, zips: res.rows.map((r) => r.zip) };
}

export async function getUsage(tx: DbTx): Promise<Usage> {
  const res = await tx.query<{ month: string; regrid_lookups: number; quotes: number; quota: number }>(
    `SELECT to_char(usage_month(), 'YYYY-MM-DD') AS month,
            COALESCE(u.regrid_lookups, 0) AS regrid_lookups,
            COALESCE(u.quotes, 0) AS quotes,
            c.regrid_lookup_quota AS quota
     FROM companies c
     LEFT JOIN usage_meters u ON u.company_id = c.id AND u.month = usage_month()`,
  );
  const row = res.rows[0];
  if (!row) throw new HttpError("not_found", "no such company");
  return { month: row.month, regridLookups: row.regrid_lookups, quotes: row.quotes, regridLookupQuota: row.quota };
}
