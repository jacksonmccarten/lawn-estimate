// The pricing-version routes: drafts are edited, published once, and then
// immutable (the database triggers raise 55000, answered as 409
// version_published). Rollback is "create a draft from an old version, then
// publish it".

import type {
  PreviewQuoteRequest,
  PreviewQuoteResponse,
  PricingVersion,
  PricingVersionContent,
  PricingVersionDiff,
  PricingVersionList,
  PricingVersionSummary,
  Service,
  Tier,
} from "@lq/api-contract";
import type { DbTx } from "@lq/db";
import { priceQuote } from "@lq/pricing";
import { HttpError } from "../http.js";
import { isoTimestamp } from "./company.js";

type VersionRow = {
  id: string;
  version: number;
  min_charge_cents: number;
  coverage_factor: number;
  published_at: string | null;
  created_at: string;
};

const VERSION_COLUMNS = `id, version, min_charge_cents, coverage_factor::float8 AS coverage_factor,
  ${isoTimestamp("published_at")} AS published_at, ${isoTimestamp("created_at")} AS created_at`;

const summary = (v: VersionRow): PricingVersionSummary => ({
  id: v.id,
  version: v.version,
  publishedAt: v.published_at,
  createdAt: v.created_at,
});

const notFound = () => new HttpError("not_found", "no such pricing version");
const published = () => new HttpError("version_published", "a published pricing version cannot be changed");

export async function listVersions(tx: DbTx): Promise<PricingVersionList> {
  const res = await tx.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM pricing_versions ORDER BY version DESC`);
  return { versions: res.rows.map(summary) };
}

async function loadContent(tx: DbTx, v: VersionRow): Promise<PricingVersionContent> {
  const services = await tx.query<Service>(
    "SELECT code, name, taxable, season FROM services WHERE version_id = $1 ORDER BY code",
    [v.id],
  );
  const tiers = await tx.query<Tier>(
    `SELECT s.code AS "serviceCode", t.region_group AS "regionGroup", t.min_sqft AS "minSqft", t.max_sqft AS "maxSqft",
            t.price_per_sqft_microcents AS "pricePerSqftMicrocents", t.flat_price_cents AS "flatPriceCents"
     FROM pricing_tiers t JOIN services s ON s.id = t.service_id
     WHERE t.version_id = $1
     ORDER BY s.code, t.region_group, t.min_sqft`,
    [v.id],
  );
  return {
    minChargeCents: v.min_charge_cents,
    coverageFactor: v.coverage_factor,
    services: services.rows,
    tiers: tiers.rows,
  };
}

async function findRow(tx: DbTx, id: string, lock = false): Promise<VersionRow> {
  const res = await tx.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM pricing_versions WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  if (!res.rows[0]) throw notFound();
  return res.rows[0];
}

export async function getVersion(tx: DbTx, id: string): Promise<PricingVersion> {
  const row = await findRow(tx, id);
  return { ...summary(row), content: await loadContent(tx, row) };
}

async function writeContent(tx: DbTx, companyId: string, id: string, content: PricingVersionContent): Promise<void> {
  await tx.query("UPDATE pricing_versions SET min_charge_cents = $2, coverage_factor = $3 WHERE id = $1", [
    id,
    content.minChargeCents,
    content.coverageFactor,
  ]);
  await tx.query("DELETE FROM pricing_tiers WHERE version_id = $1", [id]);
  await tx.query("DELETE FROM services WHERE version_id = $1", [id]);
  await tx.query(
    `INSERT INTO services (version_id, company_id, code, name, taxable, season)
     SELECT $1::uuid, $2::uuid, x.code, x.name, x.taxable, x.season
     FROM jsonb_to_recordset($3::jsonb) AS x(code text, name text, taxable boolean, season text)`,
    [id, companyId, JSON.stringify(content.services)],
  );
  await tx.query(
    `INSERT INTO pricing_tiers (version_id, company_id, service_id, region_group, min_sqft, max_sqft,
                                price_per_sqft_microcents, flat_price_cents)
     SELECT $1::uuid, $2::uuid, s.id, x."regionGroup", x."minSqft", x."maxSqft", x."pricePerSqftMicrocents", x."flatPriceCents"
     FROM jsonb_to_recordset($3::jsonb) AS x("serviceCode" text, "regionGroup" text, "minSqft" integer,
                                             "maxSqft" integer, "pricePerSqftMicrocents" integer, "flatPriceCents" integer)
     JOIN services s ON s.version_id = $1::uuid AND s.code = x."serviceCode"`,
    [id, companyId, JSON.stringify(content.tiers)],
  );
}

/** A new draft, numbered after the company's latest version; optionally a copy of one. */
export async function createVersion(tx: DbTx, companyId: string, copyFrom: string | undefined): Promise<PricingVersion> {
  const source = copyFrom === undefined ? null : await getVersion(tx, copyFrom);
  // Two drafts created at once collide on (company_id, version): 23505, a 409.
  const res = await tx.query<{ id: string }>(
    `INSERT INTO pricing_versions (company_id, version)
     SELECT $1::uuid, COALESCE(max(version), 0) + 1 FROM pricing_versions
     RETURNING id`,
    [companyId],
  );
  const id = res.rows[0]!.id;
  if (source) await writeContent(tx, companyId, id, source.content);
  else {
    // A draft from nothing starts with mowing, from the state's catalog with its
    // taxable flag (R1), so there is a service to price. The owner adds the rest.
    await tx.query(
      `INSERT INTO services (version_id, company_id, code, name, taxable, season)
       SELECT $1::uuid, $2::uuid, code, name, taxable, season FROM service_catalog WHERE state = 'PA' AND code = 'mow'`,
      [id, companyId],
    );
  }
  return getVersion(tx, id);
}

export async function replaceVersion(
  tx: DbTx,
  companyId: string,
  id: string,
  content: PricingVersionContent,
): Promise<PricingVersion> {
  const row = await findRow(tx, id, true);
  if (row.published_at !== null) throw published();
  await writeContent(tx, companyId, id, content);
  return getVersion(tx, id);
}

export async function publishVersion(tx: DbTx, id: string): Promise<PricingVersion> {
  const row = await findRow(tx, id, true);
  if (row.published_at !== null) throw published();
  const content = await loadContent(tx, row);
  // Publishing replaces what homeowners are quoted from; an empty version would switch the widget off.
  if (content.services.length === 0 || content.tiers.length === 0) {
    throw new HttpError("invalid_request", "a version needs at least one service and one tier to be published");
  }
  await tx.query("UPDATE pricing_versions SET published_at = now() WHERE id = $1", [id]);
  return getVersion(tx, id);
}

const serviceKey = (s: Service) => s.code;
const tierKey = (t: Tier) => `${t.serviceCode}|${t.regionGroup}|${t.minSqft}|${t.maxSqft}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffList<T>(from: readonly T[], to: readonly T[], key: (item: T) => string) {
  const before = new Map(from.map((item) => [key(item), item]));
  const after = new Map(to.map((item) => [key(item), item]));
  return {
    added: to.filter((item) => !before.has(key(item))),
    removed: from.filter((item) => !after.has(key(item))),
    changed: to.flatMap((item) => {
      const old = before.get(key(item));
      return old !== undefined && !same(old, item) ? [{ from: old, to: item }] : [];
    }),
  };
}

/** A draft against the published version it would replace. Pure; exported for the tests. */
export function diffVersions(
  draft: PricingVersion,
  current: PricingVersion | null,
): PricingVersionDiff {
  const from = current?.content ?? { minChargeCents: 0, coverageFactor: 0, services: [], tiers: [] };
  const to = draft.content;
  const services = diffList(from.services, to.services, serviceKey);
  const tiers = diffList(from.tiers, to.tiers, tierKey);
  // With nothing published there is no "from" to show for the two scalars.
  const scalar = <T>(a: T, b: T) => (current !== null && a !== b ? { from: a, to: b } : null);
  const minChargeCents = scalar(from.minChargeCents, to.minChargeCents);
  const coverageFactor = scalar(from.coverageFactor, to.coverageFactor);
  const lists = [services.added, services.removed, services.changed, tiers.added, tiers.removed, tiers.changed];
  return {
    draftId: draft.id,
    publishedId: current?.id ?? null,
    identical: current !== null && !minChargeCents && !coverageFactor && lists.every((l) => l.length === 0),
    minChargeCents,
    coverageFactor,
    services,
    tiers,
  };
}

export async function diffVersion(tx: DbTx, id: string): Promise<PricingVersionDiff> {
  const draft = await getVersion(tx, id);
  if (draft.publishedAt !== null) throw new HttpError("conflict", "only a draft has a diff");
  const current = await tx.query<{ id: string }>(
    "SELECT id FROM pricing_versions WHERE published_at IS NOT NULL ORDER BY version DESC LIMIT 1",
  );
  return diffVersions(draft, current.rows[0] ? await getVersion(tx, current.rows[0].id) : null);
}

/** "Preview a quote": the same packages/pricing the estimate Lambda runs, on a draft or a published version. */
export async function previewQuote(tx: DbTx, id: string, req: PreviewQuoteRequest): Promise<PreviewQuoteResponse> {
  const version = await getVersion(tx, id);
  const rate = await tx.query<{ bps: number }>(
    `SELECT round(rate * 10000)::integer AS bps FROM tax_rates
     WHERE state = 'PA' AND lower(county) = lower($1) AND effective_from <= current_date
     ORDER BY effective_from DESC LIMIT 1`,
    [req.county],
  );
  // No rate on file is an answer, never a default rate (R4).
  if (!rate.rows[0]) return { status: "no_price", reason: "unknown_county" };

  if (new Set([req.serviceCode, ...(req.addOnCodes ?? [])]).size !== 1 + (req.addOnCodes?.length ?? 0)) {
    throw new HttpError("invalid_request", "a service is requested twice", { addOnCodes: "duplicate" });
  }
  const result = priceQuote({
    version: { id: version.id, minChargeCents: version.content.minChargeCents, services: version.content.services, tiers: version.content.tiers },
    serviceCode: req.serviceCode,
    ...(req.addOnCodes ? { addOnCodes: req.addOnCodes } : {}),
    grassSqft: req.grassSqft,
    regionGroup: req.regionGroup,
    taxRateBps: rate.rows[0].bps,
  });
  if (!result.ok) return { status: "no_price", reason: result.reason, serviceCode: result.serviceCode };
  const { versionId: _versionId, ...quote } = result.quote;
  return { status: "priced", quote };
}
