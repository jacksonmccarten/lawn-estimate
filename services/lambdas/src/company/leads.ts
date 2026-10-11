// GET /leads, GET /leads/{id}, POST /leads/{id}/decision. Leads hold contact
// details: nothing here logs a row.

import type { Lead, LeadDecisionRequest, LeadList, ListLeadsQuery, QuoteLine } from "@lq/api-contract";
import type { DbTx } from "@lq/db";
import { fromJson, HttpError } from "../http.js";
import { isoTimestamp } from "./company.js";

type LeadRow = {
  id: string;
  quote_id: string;
  status: Lead["status"];
  created_at: string;
  /** created_at at full precision, for the cursor. */
  cursor_at: string;
  name: string;
  phone: string | null;
  email: string | null;
  decision: string | null;
  address_text: string;
  county: string;
  origin: Lead["origin"];
  parcel_sqft: number | null;
  footprint_sqft: number | null;
  grass_sqft: number;
  line_items: unknown;
  tax_rate_bps: number;
  tax_cents: number;
  total_cents: number;
  version_id: string;
  adjusted_total_cents: number | null;
};

const SELECT_LEAD = `
  SELECT l.id, l.quote_id, q.status, ${isoTimestamp("l.created_at")} AS created_at, l.created_at::text AS cursor_at,
         l.name, l.phone, l.email, l.decision, q.address_text, q.county, q.origin, q.parcel_sqft, q.footprint_sqft,
         q.grass_sqft, q.line_items, round(q.tax_rate * 10000)::integer AS tax_rate_bps, q.tax_cents,
         q.total_cents, q.version_id, l.adjusted_total_cents
  FROM leads l JOIN quotes q ON q.id = l.quote_id`;

function toLead(row: LeadRow): Lead {
  const lines = fromJson<QuoteLine[]>(row.line_items);
  const sum = (ls: QuoteLine[]) => ls.reduce((total, l) => total + l.amountCents, 0);
  return {
    id: row.id,
    quoteId: row.quote_id,
    status: row.status,
    createdAt: row.created_at,
    contact: { name: row.name, phone: row.phone, email: row.email },
    addressText: row.address_text,
    county: row.county,
    origin: row.origin,
    parcelSqft: row.parcel_sqft,
    footprintSqft: row.footprint_sqft,
    grassSqft: row.grass_sqft,
    // Stored per line (R2, R3); the subtotals are sums of what is stored.
    quote: {
      lines,
      subtotalCents: sum(lines),
      taxableSubtotalCents: sum(lines.filter((l) => l.taxable)),
      taxRateBps: row.tax_rate_bps,
      taxCents: row.tax_cents,
      totalCents: row.total_cents,
    },
    pricingVersionId: row.version_id,
    adjustedTotalCents: row.adjusted_total_cents,
  };
}

const notFound = () => new HttpError("not_found", "no such lead");

// A timestamptz as PostgreSQL prints it.
const CURSOR_AT = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?[+-]\d\d(:\d\d)?$/;

function decodeCursor(cursor: string): [at: string, id: string] {
  const [at, id, ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!at || !id || rest.length || !CURSOR_AT.test(at) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new HttpError("invalid_request", "the cursor is not valid", { cursor: "invalid" });
  }
  return [at, id];
}

/** Newest first, keyset-paged on (created_at, id). */
export async function listLeads(tx: DbTx, query: ListLeadsQuery): Promise<LeadList> {
  const [at, id] = query.cursor === undefined ? [null, null] : decodeCursor(query.cursor);
  const res = await tx.query<LeadRow>(
    `${SELECT_LEAD}
     WHERE ($1::text IS NULL OR q.status = $1)
       AND ($2::timestamptz IS NULL OR (l.created_at, l.id) < ($2::timestamptz, $3::uuid))
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $4`,
    [query.status ?? null, at, id, query.limit + 1],
  );
  const page = res.rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    leads: page.map(toLead),
    nextCursor:
      res.rows.length > query.limit && last ? Buffer.from(`${last.cursor_at}|${last.id}`).toString("base64url") : null,
  };
}

export async function getLead(tx: DbTx, id: string): Promise<Lead> {
  const res = await tx.query<LeadRow>(`${SELECT_LEAD} WHERE l.id = $1`, [id]);
  if (!res.rows[0]) throw notFound();
  return toLead(res.rows[0]);
}

/**
 * The operator's decision, made once. The check here gives the clean answer;
 * the trigger on leads (LQ001, also answered 409 lead_already_decided) is
 * what settles two operators deciding at the same moment.
 */
export async function decideLead(tx: DbTx, id: string, decision: LeadDecisionRequest): Promise<Lead> {
  const res = await tx.query<LeadRow>(`${SELECT_LEAD} WHERE l.id = $1 FOR UPDATE OF l`, [id]);
  const row = res.rows[0];
  if (!row) throw notFound();
  if (row.decision !== null) throw new HttpError("lead_already_decided", "this lead already has a decision");
  if (row.status !== "submitted") throw new HttpError("conflict", `a lead that is ${row.status} cannot be decided`);

  const status = decision.action === "decline" ? "declined" : "accepted";
  await tx.query("UPDATE leads SET decision = $2, adjusted_total_cents = $3 WHERE id = $1", [
    id,
    status,
    decision.action === "adjust" ? decision.adjustedTotalCents : null,
  ]);
  const quote = await tx.query("UPDATE quotes SET status = $2 WHERE id = $1 AND status = 'submitted'", [row.quote_id, status]);
  if (quote.rowCount !== 1) throw new HttpError("conflict", "the quote changed while it was being decided");
  return getLead(tx, id);
}
