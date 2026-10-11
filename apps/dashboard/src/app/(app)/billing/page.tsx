"use client";

import type { BillingSessionRequest } from "@lq/api-contract";
import { useState } from "react";
import { useApi } from "@/components/auth-provider";
import { BusyButton, LoadError, Loading, PageHeading } from "@/components/ui";
import { describeError } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

type Page = BillingSessionRequest["page"];

/** "2026-10-01" → "October 2026". */
const monthName = (month: string) =>
  new Date(`${month}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export default function BillingPage() {
  const api = useApi();
  const { state, reload } = useLoad(() => api.getUsage(), [api]);
  const [opening, setOpening] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The plan pages are hosted by AWS Monetization; the link is made for this company when asked for.
  async function open(page: Page) {
    if (opening) return;
    setOpening(page);
    setError(null);
    try {
      const { url } = await api.createBillingSession({ page });
      window.location.assign(url);
    } catch (e) {
      setError(describeError(e));
      setOpening(null);
    }
  }

  return (
    <>
      <PageHeading title="Billing" />
      <section className="card prose" aria-labelledby="plan-heading">
        <h2 id="plan-heading">Your plan</h2>
        <p>
          A new company starts on the free Trial, which prices 5 estimates a month. The Standard plan prices as many as your customers ask for: pay
          $20 a month, or $200 for a full year. When a month&rsquo;s estimates run out, the widget tells homeowners that instant estimates are paused
          until the next month.
        </p>
        <p>
          Plans, payment and invoices are handled by AWS Monetization. Both buttons take you to its pages, which bring you back here when you&rsquo;re
          done.
        </p>
        <div className="row-actions">
          <BusyButton className="btn primary" isBusy={opening === "plans"} onPress={() => open("plans")}>
            See plans and prices
          </BusyButton>
          <BusyButton className="btn" isBusy={opening === "portal"} onPress={() => open("portal")}>
            Manage subscription and invoices
          </BusyButton>
        </div>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <p role="status" className="visually-hidden">
          {opening ? "Opening the billing page…" : ""}
        </p>
      </section>

      <section className="card" aria-labelledby="usage-heading">
        <h2 id="usage-heading">This month</h2>
        {state.status === "loading" && <Loading what="this month’s estimates" />}
        {state.status === "error" && <LoadError message={state.message} onRetry={reload} />}
        {state.status === "ready" && (
          <p>
            {state.data.quotes.toLocaleString("en-US")} {state.data.quotes === 1 ? "estimate" : "estimates"} priced in {monthName(state.data.month)}.
          </p>
        )}
      </section>
    </>
  );
}
