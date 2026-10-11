"use client";

import type { Lead } from "@lq/api-contract";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Button, Link } from "react-aria-components";
import { useApi } from "@/components/auth-provider";
import { LoadError, Loading, PageHeading, StatusChip, TableScroll, leadStatusLabel } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { useLoad } from "@/lib/use-load";

const PAGE_SIZE = 25;
const STATUSES = ["submitted", "accepted", "declined", "expired"] as const;
type Status = (typeof STATUSES)[number];

type SortKey = "received" | "name" | "total" | "status";
type Sort = { key: SortKey; direction: "ascending" | "descending" };

/** What the operator will be paid if the lead goes ahead: their own total when they set one. */
const leadTotal = (lead: Lead) => lead.adjustedTotalCents ?? lead.quote.totalCents;

const comparators: Record<SortKey, (a: Lead, b: Lead) => number> = {
  received: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  name: (a, b) => a.contact.name.localeCompare(b.contact.name),
  total: (a, b) => leadTotal(a) - leadTotal(b),
  status: (a, b) => leadStatusLabel(a.status).localeCompare(leadStatusLabel(b.status)),
};

function href(status: Status | null, trail: string[]): string {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (trail.length > 0) query.set("trail", trail.join(","));
  return query.size > 0 ? `/leads?${query}` : "/leads";
}

function Inbox() {
  const api = useApi();
  const params = useSearchParams();
  const statusParam = params.get("status");
  const status = (STATUSES as readonly string[]).includes(statusParam ?? "") ? (statusParam as Status) : null;
  // The API pages by cursor. The cursors of the pages already passed are kept
  // in the URL, so "Previous" is a link and a page can be bookmarked.
  const trailParam = params.get("trail") ?? "";
  const trail = useMemo(() => (trailParam ? trailParam.split(",") : []), [trailParam]);
  const page = trail.length + 1;
  const cursor = trail[trail.length - 1];

  const { state, reload } = useLoad(() => api.listLeads({ status: status ?? undefined, cursor, limit: PAGE_SIZE }), [api, status, cursor]);
  const [sort, setSort] = useState<Sort>({ key: "received", direction: "descending" });

  const rows = useMemo(() => {
    if (state.status !== "ready") return [];
    const sorted = [...state.data.leads].sort(comparators[sort.key]);
    return sort.direction === "descending" ? sorted.reverse() : sorted;
  }, [state, sort]);

  const sortHeader = (key: SortKey, label: string, className?: string) => {
    const active = sort.key === key;
    return (
      <th scope="col" aria-sort={active ? sort.direction : undefined} className={className}>
        <Button
          className="sort-button"
          onPress={() => setSort({ key, direction: active && sort.direction === "ascending" ? "descending" : "ascending" })}
        >
          {label}
          <span aria-hidden="true" className="sort-mark">
            {active ? (sort.direction === "ascending" ? "▲" : "▼") : "↕"}
          </span>
        </Button>
      </th>
    );
  };

  const filterName = status ? leadStatusLabel(status).toLowerCase() : "all";

  return (
    <>
      <PageHeading title="Leads" />
      <nav aria-label="Filter leads by status">
        <ul className="filter-list">
          <li>
            <Link className="filter-link" href={href(null, [])} aria-current={status === null ? "true" : undefined}>
              All
            </Link>
          </li>
          {STATUSES.map((s) => (
            <li key={s}>
              <Link className="filter-link" href={href(s, [])} aria-current={status === s ? "true" : undefined}>
                {leadStatusLabel(s)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {state.status === "loading" && <Loading what="leads" />}
      {state.status === "error" && <LoadError message={state.message} onRetry={reload} />}
      {state.status === "ready" && (
        <>
          <p role="status" className="muted">
            {rows.length === 0
              ? `No ${status ? `${filterName} ` : ""}leads${page > 1 ? " on this page" : " yet"}.`
              : `Page ${page}: ${rows.length} ${status ? `${filterName} ` : ""}${rows.length === 1 ? "lead" : "leads"}, sorted by ${sort.key}, ${sort.direction}.`}
          </p>
          {rows.length > 0 && (
            <TableScroll label="Leads table">
              <table className="table">
                <caption>Newest first unless sorted. Sorting applies to the leads on this page.</caption>
                <thead>
                  <tr>
                    {sortHeader("received", "Received")}
                    {sortHeader("name", "Name")}
                    <th scope="col">Property</th>
                    <th scope="col">Services</th>
                    {sortHeader("total", "Total", "num")}
                    {sortHeader("status", "Status")}
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((lead) => (
                    <tr key={lead.id}>
                      <td>
                        <time dateTime={lead.createdAt}>{formatDateTime(lead.createdAt)}</time>
                      </td>
                      <th scope="row">{lead.contact.name}</th>
                      <td>{lead.addressText}</td>
                      <td>{lead.quote.lines.map((line) => line.name).join(", ")}</td>
                      <td className="num">
                        {formatCents(leadTotal(lead))}
                        {lead.adjustedTotalCents !== null && <span className="muted"> (your total)</span>}
                      </td>
                      <td>
                        <StatusChip kind={lead.status} />
                      </td>
                      <td>
                        <Link className="link" href={`/leads/${lead.id}`} aria-label={`Review lead from ${lead.contact.name}, ${formatDateTime(lead.createdAt)}`}>
                          Review
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
          <nav aria-label="Pagination" className="pagination">
            {page > 1 ? (
              <Link className="link" href={href(status, trail.slice(0, -1))}>
                Previous page
              </Link>
            ) : (
              <span className="muted">Previous page</span>
            )}
            <span aria-current="page">Page {page}</span>
            {state.data.nextCursor ? (
              <Link className="link" href={href(status, [...trail, state.data.nextCursor])}>
                Next page
              </Link>
            ) : (
              <span className="muted">Next page</span>
            )}
          </nav>
        </>
      )}
    </>
  );
}

export default function LeadsPage() {
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}
