"use client";

import type { Lead, LeadDecisionRequest } from "@lq/api-contract";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Label, Link, Radio, RadioGroup } from "react-aria-components";
import { useApi } from "@/components/auth-provider";
import { QuoteLines } from "@/components/quote-lines";
import { ConfirmDialog, LoadError, Loading, PageHeading, StatusChip, TextInput, useToast } from "@/components/ui";
import { ApiError, describeError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { centsToInput, formatCents, formatSqft, parseDollars } from "@/lib/money";
import { useLoad } from "@/lib/use-load";

const ORIGIN_LABEL: Record<Lead["origin"], string> = {
  regrid: "Estimated from parcel records",
  regrid_adjusted: "Estimated from parcel records, then adjusted by the homeowner",
  bucket: "Lot size range chosen by the homeowner",
  manual: "Lot size entered by the homeowner",
  drawn: "Lawn outlined by the homeowner on an aerial photo",
};

type Action = LeadDecisionRequest["action"];

function Decision({ lead, onDecided, onStale }: { lead: Lead; onDecided: (lead: Lead) => void; onStale: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [action, setAction] = useState<Action | "">("");
  const [total, setTotal] = useState(centsToInput(lead.quote.totalCents));
  const [fieldError, setFieldError] = useState<{ action?: string; total?: string }>({});
  const [request, setRequest] = useState<LeadDecisionRequest | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const totalRef = useRef<HTMLInputElement>(null);

  function review(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    if (action === "") {
      setFieldError({ action: "Choose what to do with this lead" });
      return;
    }
    if (action === "adjust") {
      const cents = parseDollars(total);
      if (cents === null) {
        setFieldError({ total: "Enter a dollar amount, such as 65.00" });
        totalRef.current?.focus();
        return;
      }
      setFieldError({});
      setRequest({ action: "adjust", adjustedTotalCents: cents });
      return;
    }
    setFieldError({});
    setRequest({ action });
  }

  async function confirm() {
    if (!request) return;
    setPending(true);
    setFailure(null);
    try {
      const decided = await api.decideLead(lead.id, request);
      setRequest(null);
      toast(decided.status === "accepted" ? "Lead accepted." : "Lead declined.");
      onDecided(decided);
    } catch (error) {
      if (error instanceof ApiError && error.code === "lead_already_decided") {
        // Someone else decided it first; show what they chose.
        setRequest(null);
        onStale();
      } else {
        setFailure(describeError(error));
      }
    } finally {
      setPending(false);
    }
  }

  const summary =
    request?.action === "adjust"
      ? `Accept this lead at your total of ${formatCents(request.adjustedTotalCents)}?`
      : request?.action === "decline"
        ? "Decline this lead?"
        : `Accept this lead at the estimate of ${formatCents(lead.quote.totalCents)}?`;

  return (
    <section className="card" aria-labelledby="decision-heading">
      <h2 id="decision-heading">Your decision</h2>
      <form onSubmit={review} noValidate>
        <RadioGroup
          className="radio-group"
          value={action}
          onChange={(value) => {
            setAction(value as Action);
            setFieldError({});
          }}
          isInvalid={!!fieldError.action}
          validationBehavior="aria"
          aria-describedby={fieldError.action ? "decision-error" : undefined}
        >
          <Label>What do you want to do with this lead?</Label>
          <Radio className="radio" value="accept">
            Accept at the estimate, {formatCents(lead.quote.totalCents)}
          </Radio>
          <Radio className="radio" value="adjust">
            Accept at a different total
          </Radio>
          <Radio className="radio" value="decline">
            Decline
          </Radio>
        </RadioGroup>
        {fieldError.action && (
          <p id="decision-error" role="alert" className="field-error">
            {fieldError.action}
          </p>
        )}
        {action === "adjust" && (
          <TextInput
            label="Your total, in dollars, including any sales tax"
            description="What you will charge after seeing the property. The homeowner's estimate is not changed."
            inputMode="decimal"
            value={total}
            onChange={setTotal}
            error={fieldError.total}
            inputRef={totalRef}
            className="narrow"
          />
        )}
        <div className="form-actions">
          <Button type="submit" className="btn primary">
            Review decision
          </Button>
        </div>
      </form>
      <ConfirmDialog
        isOpen={request !== null}
        onClose={() => setRequest(null)}
        title={summary}
        confirmLabel={request?.action === "decline" ? "Decline lead" : "Accept lead"}
        danger={request?.action === "decline"}
        onConfirm={confirm}
        isPending={pending}
        error={failure}
      >
        <p>A lead is decided once. You won&rsquo;t be able to change this afterwards.</p>
      </ConfirmDialog>
    </section>
  );
}

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const { state, reload, set } = useLoad(() => api.getLead(id), [api, id]);
  const [notice, setNotice] = useState<string | null>(null);
  const lead = state.status === "ready" ? state.data : null;
  const noticeRef = useRef<HTMLParagraphElement>(null);

  // The decision form is gone once a lead is decided; put focus on the result.
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  return (
    <>
      <PageHeading title={lead ? `Lead from ${lead.contact.name}` : "Lead"}>
        <Link className="link" href="/leads">
          Back to all leads
        </Link>
      </PageHeading>
      {state.status === "loading" && <Loading what="lead" />}
      {state.status === "error" && <LoadError message={state.message} onRetry={reload} />}
      {/* The lasting copy of a decision's result; the toast is the passing one. */}
      {notice && (
        <p ref={noticeRef} tabIndex={-1} role="status" className="notice">
          {notice}
        </p>
      )}
      {lead && (
        <div className="stack">
          <section className="card" aria-labelledby="contact-heading">
            <h2 id="contact-heading">Contact and property</h2>
            <dl className="details">
              <dt>Status</dt>
              <dd>
                <StatusChip kind={lead.status} />
                {lead.status === "accepted" && (
                  <span> {lead.adjustedTotalCents !== null ? `at your total of ${formatCents(lead.adjustedTotalCents)}` : "at the estimate"}</span>
                )}
              </dd>
              <dt>Received</dt>
              <dd>
                <time dateTime={lead.createdAt}>{formatDateTime(lead.createdAt)}</time>
              </dd>
              <dt>Name</dt>
              <dd>{lead.contact.name}</dd>
              <dt>Phone</dt>
              <dd>{lead.contact.phone ? <a className="link" href={`tel:${lead.contact.phone}`}>{lead.contact.phone}</a> : "Not given"}</dd>
              <dt>Email</dt>
              <dd>{lead.contact.email ? <a className="link" href={`mailto:${lead.contact.email}`}>{lead.contact.email}</a> : "Not given"}</dd>
              <dt>Property</dt>
              <dd>{lead.addressText}</dd>
              <dt>Tax county</dt>
              <dd>{lead.county} County</dd>
              <dt>Lawn area used for the price</dt>
              <dd>
                {formatSqft(lead.grassSqft)}
                <span className="muted"> &middot; {ORIGIN_LABEL[lead.origin]}</span>
              </dd>
              {lead.parcelSqft !== null && (
                <>
                  <dt>Parcel</dt>
                  <dd>
                    {formatSqft(lead.parcelSqft)}
                    {lead.footprintSqft !== null && `, buildings ${formatSqft(lead.footprintSqft)}`}
                  </dd>
                </>
              )}
            </dl>
          </section>

          <section className="card" aria-labelledby="estimate-heading">
            <h2 id="estimate-heading">Estimate the homeowner saw</h2>
            <p className="muted">
              An estimate, not a contract. Priced with{" "}
              <Link className="link" href={`/pricing/${lead.pricingVersionId}`}>
                the pricing version in force at the time
              </Link>
              .
            </p>
            <QuoteLines quote={lead.quote} county={lead.county} caption="Line items" />
          </section>

          {lead.status === "submitted" ? (
            <Decision
              lead={lead}
              onDecided={(decided) => {
                set(decided);
                setNotice(decided.status === "accepted" ? "You accepted this lead." : "You declined this lead.");
              }}
              onStale={() => {
                setNotice("This lead was already decided, so your decision was not recorded. It is shown below as it stands.");
                reload();
              }}
            />
          ) : (
            <section className="card" aria-labelledby="decision-heading">
              <h2 id="decision-heading">Your decision</h2>
              <p>
                {lead.status === "expired"
                  ? "This lead expired before a decision was made."
                  : `This lead was ${lead.status}. A decision can’t be changed.`}
              </p>
            </section>
          )}
        </div>
      )}
    </>
  );
}
