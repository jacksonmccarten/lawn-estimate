// The estimate and lead flow of docs/ENGINEERING_DESIGN.md section 5, as one
// in-memory state machine: no cookies, no storage, and the only thing carried
// between calls is the signed quote token.

import type { Contact, EstimateResponse, ManualEntry, ManualSize } from "@lq/api-contract";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createApi, type ApiFailure, type ApiResult } from "../lib/api";
import { createBridge } from "../lib/embed-bridge";
import { formatAddress, type AddressParts } from "../lib/format";
import { geocode, type LngLat } from "../lib/mapbox";
import { createTurnstile, type Turnstile } from "../lib/turnstile";
import { brandCssVars, type BrandTheme } from "../theme/brand";
import {
  AddressScreen,
  CallScreen,
  CountyScreen,
  DoneScreen,
  EstimateScreen,
  ManualScreen,
  type Adjust,
  type CallReason,
  type CompanyView,
  type ManualWhy,
  type Priced,
} from "./screens";
import { YardScreen } from "./YardScreen";

export type WidgetProps = {
  company: CompanyView & { logoUrl: string | null };
  brand: BrandTheme;
  allowedOrigins: string[];
  apiBase: string;
  turnstileSiteKey: string | null;
  /** A Mapbox public token. Null: no aerial photo, and the homeowner gives the lot size. */
  mapboxToken: string | null;
};

/** The property as the aerial photo screen needs it, kept so coming back to that screen restores the outline. */
type Yard = { center: LngLat; zip: string; rings: LngLat[][] };
// `zip` is the one the homeowner typed in the address.

type Step =
  | { kind: "address" }
  | { kind: "yard" }
  | { kind: "manual"; reason: ManualWhy; zip?: string; size?: ManualSize }
  | { kind: "county"; reason: ManualWhy; zip: string; size: ManualSize; candidates: string[] }
  | { kind: "estimate"; estimate: Priced; adjusted: Adjust | null }
  | { kind: "call"; reason: CallReason; phone: string | null }
  | { kind: "done"; quoteId: string };

type Busy = "locate" | "estimate" | "adjust" | "submit" | null;

const BUSY_STATUS: Record<Exclude<Busy, null>, string> = {
  locate: "Finding your property.",
  estimate: "Getting your estimate.",
  adjust: "Updating your estimate.",
  submit: "Sending your request.",
};

function failureMessage(failure: ApiFailure, companyName: string): string {
  switch (failure.code) {
    case "network":
      return "We couldn't reach the server. Check your connection and try again.";
    case "rate_limited":
      return "Too many requests just now. Wait a minute and try again.";
    case "quota_exceeded":
      return `Instant estimates are paused for ${companyName} right now. Please contact them directly.`;
    case "turnstile_failed":
      return "We couldn't confirm this request came from a person. Please try again.";
    case "origin_not_allowed":
      return `This quote form isn't set up for this website yet. Please contact ${companyName} directly.`;
    case "token_invalid":
    case "token_expired":
      return "That estimate has expired. Please start again.";
    case "invalid_request":
      return "Something in the form wasn't accepted. Check what you entered and try again.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}

export function Widget({ company, brand, allowedOrigins, apiBase, turnstileSiteKey, mapboxToken }: WidgetProps) {
  const [step, setStep] = useState<Step>({ kind: "address" });
  // The property's address, in the four boxes it is typed in. Pennsylvania is the launch market.
  const [parts, setParts] = useState<AddressParts>({ street: "", city: "", state: "PA", zip: "" });
  const address = formatAddress(parts);
  const [service, setService] = useState(company.services[0]?.code ?? "");
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<{ failure: ApiFailure; from: Exclude<Busy, null> } | null>(null);
  // Why the manual path was offered, kept so "Back" from the county question returns to the same explanation.
  const [manualReason, setManualReason] = useState<ManualWhy>("no_match");
  const [yard, setYard] = useState<Yard | null>(null);

  const rootRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const turnstile = useRef<Turnstile | null>(null);

  const api = useMemo(() => createApi(apiBase), [apiBase]);
  const bridge = useMemo(() => createBridge(allowedOrigins), [allowedOrigins]);

  useEffect(() => bridge.start(company.name), [bridge, company.name]);

  // The style attribute carries the brand colors in the server's markup; this
  // repeats them through the CSSOM for browsers whose CSP support lacks
  // style-src-attr and so ignore the attribute.
  useEffect(() => {
    for (const [name, value] of Object.entries(brandCssVars(brand))) rootRef.current?.style.setProperty(name, value);
  }, [brand]);

  // A new screen starts at its heading. Not on first paint: an embedded
  // widget must not pull focus away from the host page.
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step.kind]);

  /** Runs one public call with a fresh Turnstile token and the embed origin. */
  async function call<T>(
    kind: Exclude<Busy, null>,
    send: (common: { turnstile: string; embedOrigin: string | null }) => Promise<ApiResult<T>>,
  ): Promise<T | null> {
    if (busy) return null;
    setBusy(kind);
    setFailure(null);
    try {
      let common: { turnstile: string; embedOrigin: string | null };
      try {
        turnstile.current ??= createTurnstile(turnstileSiteKey, () => turnstileRef.current);
        const [token, embedOrigin] = await Promise.all([turnstile.current.token(), bridge.embedOrigin()]);
        common = { turnstile: token, embedOrigin };
      } catch {
        setFailure({ failure: { ok: false, code: "turnstile_failed" }, from: kind });
        return null;
      }
      const result = await send(common);
      if (result.ok) return result.data;
      setFailure({ failure: result, from: kind });
      // The token is gone; only a new estimate can follow.
      if (result.code === "token_invalid" || result.code === "token_expired") setStep({ kind: "address" });
      return null;
    } finally {
      setBusy(null);
    }
  }

  function show(response: EstimateResponse, manual: ManualEntry | undefined, adjusted: Adjust | null) {
    switch (response.status) {
      case "priced":
        setStep({ kind: "estimate", estimate: response, adjusted });
        break;
      case "manual_required":
        setManualReason(response.reason);
        setStep({ kind: "manual", reason: response.reason });
        break;
      case "county_required":
        // Only a manual request is answered this way; its size is kept so
        // the homeowner is not asked for it again.
        if (manual) {
          setStep({ kind: "county", reason: manualReason, zip: response.zip, size: manual.size, candidates: response.candidates });
        }
        else setFailure({ failure: { ok: false, code: "internal" }, from: "estimate" });
        break;
      case "call_us":
        setStep({ kind: "call", reason: response.reason, phone: response.phone });
        break;
    }
  }

  async function estimate(manual?: ManualEntry) {
    const response = await call("estimate", (common) =>
      api.estimate({ company: company.slug, address, service, ...(manual ? { manual } : {}), ...common }),
    );
    if (response) show(response, manual, null);
  }

  /** Shows the lot-size form for a reason of the widget's own. */
  function askLotSize(reason: ManualWhy) {
    setFailure(null);
    setManualReason(reason);
    setStep({ kind: "manual", reason });
  }

  /**
   * With a Mapbox token, the address leads to the aerial photo: the address
   * goes to Mapbox from this browser and only its position is used.
   * Without one the server is asked as before; when the address cannot be
   * found, the homeowner gives the lot size.
   */
  async function locate() {
    if (!mapboxToken) return estimate();
    if (busy) return;
    setBusy("locate");
    setFailure(null);
    const place = await geocode(address, mapboxToken);
    setBusy(null);
    if (!place) return askLotSize("no_photo");
    // The zip decides the tax county. It is the one typed, never one a geocoder suggests (R16).
    setYard({ center: place.center, zip: parts.zip.trim(), rings: [] });
    setStep({ kind: "yard" });
  }

  async function adjust(direction: Adjust) {
    if (step.kind !== "estimate") return;
    const token = step.estimate.token;
    const response = await call("adjust", (common) => api.estimate({ token, adjust: direction, ...common }));
    if (response) show(response, undefined, direction);
  }

  async function request(contact: Contact, honeypot: string) {
    if (step.kind !== "estimate") return;
    const token = step.estimate.token;
    const response = await call("submit", (common) =>
      api.submit({ token, contact, ...(honeypot ? { website: honeypot } : {}), ...common }),
    );
    if (response) {
      setStep({ kind: "done", quoteId: response.quoteId });
      bridge.submitted();
    }
  }

  function restart() {
    setFailure(null);
    setYard(null);
    setStep({ kind: "address" });
  }

  // Shown beside the control that was used, where the homeowner is looking.
  const alert = failure && (
    <p className="lq-alert" role="alert">
      {failureMessage(failure.failure, company.name)}
    </p>
  );

  return (
    <main className="lq" ref={rootRef} style={brandCssVars(brand) as CSSProperties}>
      <header className="lq-header">
        {/* Decorative: the name beside it is the text alternative. */}
        {company.logoUrl && <img className="lq-logo" src={company.logoUrl} alt="" width={40} height={40} />}
        <p className="lq-company">{company.name}</p>
      </header>

      <p className="lq-sr" role="status">
        {busy ? BUSY_STATUS[busy] : ""}
      </p>

      {/* A company that has signed up but published no prices yet has nothing to quote. */}
      {company.services.length === 0 && (
        <>
          <h1 className="lq-h1">Online estimates are coming soon</h1>
          <p className="lq-lead">{company.name} hasn&apos;t published prices here yet. Please contact them directly for a quote.</p>
        </>
      )}
      {step.kind === "address" && company.services.length > 0 && (
        <AddressScreen
          headingRef={headingRef}
          company={company}
          parts={parts}
          service={service}
          busy={busy !== null}
          alert={alert}
          onParts={setParts}
          onService={setService}
          onSubmit={() => void locate()}
          toPhoto={mapboxToken !== null}
        />
      )}
      {step.kind === "yard" && yard && mapboxToken && (
        <YardScreen
          headingRef={headingRef}
          address={address}
          token={mapboxToken}
          center={yard.center}
          initialRings={yard.rings}
          busy={busy !== null}
          alert={alert}
          onChangeAddress={restart}
          onUseLotSize={() => askLotSize("chosen")}
          onSubmit={(sqft, rings) => {
            setYard({ ...yard, rings });
            void estimate({ zip: yard.zip, size: { kind: "drawn", sqft } });
          }}
        />
      )}
      {step.kind === "manual" && (
        <ManualScreen
          headingRef={headingRef}
          reason={step.reason}
          address={address}
          initialZip={step.zip ?? parts.zip.trim()}
          initialSize={step.size ?? null}
          busy={busy !== null}
          alert={alert}
          onChangeAddress={restart}
          onSubmit={(zip, size) => void estimate({ zip, size })}
        />
      )}
      {step.kind === "county" && (
        <CountyScreen
          headingRef={headingRef}
          zip={step.zip}
          candidates={step.candidates}
          busy={busy !== null}
          alert={alert}
          onBack={() =>
            // An outlined lawn goes back to the photo, with the outline as it was left.
            setStep(step.size.kind === "drawn" && yard ? { kind: "yard" } : { kind: "manual", reason: step.reason, zip: step.zip, size: step.size })
          }
          onSubmit={(county) => void estimate({ zip: step.zip, size: step.size, county })}
        />
      )}
      {step.kind === "estimate" && (
        <EstimateScreen
          headingRef={headingRef}
          company={company}
          address={address}
          estimate={step.estimate}
          adjusted={step.adjusted}
          busy={busy === "adjust" || busy === "submit" ? busy : null}
          adjustAlert={failure?.from === "adjust" ? alert : null}
          requestAlert={failure?.from === "submit" ? alert : null}
          onAdjust={(direction) => void adjust(direction)}
          onChangeAddress={restart}
          onRequest={(contact, honeypot) => void request(contact, honeypot)}
        />
      )}
      {step.kind === "call" && (
        <CallScreen headingRef={headingRef} companyName={company.name} reason={step.reason} phone={step.phone} onRestart={restart} />
      )}
      {step.kind === "done" && <DoneScreen headingRef={headingRef} companyName={company.name} quoteId={step.quoteId} />}

      {/* Turnstile draws here only if it needs the visitor to do something. */}
      <div ref={turnstileRef} />
    </main>
  );
}
