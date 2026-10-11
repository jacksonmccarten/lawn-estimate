// The widget's screens. Each takes the heading ref the Widget focuses when
// the screen appears, and reports what the homeowner did; none of them calls
// the API or keeps anything the Widget needs to remember.

import type { Contact, EstimateResponse, ManualSize } from "@lq/api-contract";
import { useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { formatBps, formatCents, formatSqft, telHref, type AddressParts } from "../lib/format";
import { Button, ErrorSummary, errorFor, RadioGroup, TextField, type FieldError } from "./ui";

export type Priced = Extract<EstimateResponse, { status: "priced" }>;
export type ManualReason = Extract<EstimateResponse, { status: "manual_required" }>["reason"];
/** Why the lot-size form is shown: the server's reason, or one of the aerial photo's. */
export type ManualWhy = ManualReason | "no_photo" | "chosen";
export type CallReason = Extract<EstimateResponse, { status: "call_us" }>["reason"];
export type Adjust = "smaller" | "larger";
export type CompanyView = { slug: string; name: string; services: { code: string; name: string }[] };

type HeadingRef = Ref<HTMLHeadingElement>;

/** Runs `validate`; on failure shows the errors and moves focus to the summary. */
function useFormErrors() {
  const [errors, setErrors] = useState<FieldError[]>([]);
  const summaryRef = useRef<HTMLDivElement>(null);
  function check(found: FieldError[]): boolean {
    setErrors(found);
    if (found.length > 0) requestAnimationFrame(() => summaryRef.current?.focus());
    return found.length === 0;
  }
  return { errors, summaryRef, check };
}

function AddressLine({ address, onChange }: { address: string; onChange(): void }) {
  return (
    <p className="lq-address">
      <span>
        <span className="lq-sr">Property address: </span>
        {address}
      </span>
      <Button variant="link" onClick={onChange}>
        Change address
      </Button>
    </p>
  );
}

// ---- Address and service

type AddressScreenProps = {
  headingRef: HeadingRef;
  company: CompanyView;
  parts: AddressParts;
  service: string;
  busy: boolean;
  alert: ReactNode;
  onParts(parts: AddressParts): void;
  onService(code: string): void;
  onSubmit(): void;
  /** The next screen is the aerial photo, not the estimate. */
  toPhoto: boolean;
};

export function AddressScreen({ headingRef, ...props }: AddressScreenProps) {
  const { errors, summaryRef, check } = useFormErrors();
  const { company } = props;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (props.busy) return;
    const found: FieldError[] = [];
    const { street, city, state, zip } = props.parts;
    if (street.trim().length < 3) found.push({ field: "lq-street", message: "Enter the street address of the property." });
    else if (street.trim().length > 150) found.push({ field: "lq-street", message: "Shorten the street address to 150 characters or fewer." });
    if (city.trim().length < 2) found.push({ field: "lq-city", message: "Enter the city or town." });
    else if (city.trim().length > 80) found.push({ field: "lq-city", message: "Shorten the city to 80 characters or fewer." });
    if (!/^[A-Za-z]{2}$/.test(state.trim())) found.push({ field: "lq-state", message: "Enter the state as two letters, like PA." });
    if (!/^[0-9]{5}$/.test(zip.trim())) found.push({ field: "lq-zip", message: "Enter the five-digit zip code." });
    if (check(found)) props.onSubmit();
  }

  return (
    <form onSubmit={submit} noValidate>
      <h1 ref={headingRef} tabIndex={-1} className="lq-h1">
        Get an instant lawn estimate
      </h1>
      <ErrorSummary errors={errors} summaryRef={summaryRef} />
      {company.services.length > 1 ? (
        <RadioGroup
          id="lq-service"
          legend="Service"
          options={company.services.map((s) => ({ value: s.code, label: s.name }))}
          value={props.service}
          onChange={props.onService}
        />
      ) : (
        <p className="lq-lead">{company.services[0]?.name}</p>
      )}
      {/* One box for each part, each named for the browser so it can fill in a saved address. */}
      <fieldset className="lq-fieldset lq-address-fields">
        <legend className="lq-label">Property address</legend>
        <TextField
          id="lq-street"
          label="Street address"
          type="text"
          autoComplete="address-line1"
          value={props.parts.street}
          onChange={(event) => props.onParts({ ...props.parts, street: event.target.value })}
          error={errorFor(errors, "lq-street")}
        />
        <TextField
          id="lq-city"
          label="City"
          type="text"
          autoComplete="address-level2"
          value={props.parts.city}
          onChange={(event) => props.onParts({ ...props.parts, city: event.target.value })}
          error={errorFor(errors, "lq-city")}
        />
        <div className="lq-field-pair">
          <TextField
            id="lq-state"
            label="State"
            type="text"
            autoComplete="address-level1"
            autoCapitalize="characters"
            maxLength={2}
            value={props.parts.state}
            onChange={(event) => props.onParts({ ...props.parts, state: event.target.value })}
            error={errorFor(errors, "lq-state")}
          />
          <TextField
            id="lq-zip"
            label="Zip code"
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={5}
            value={props.parts.zip}
            onChange={(event) => props.onParts({ ...props.parts, zip: event.target.value })}
            error={errorFor(errors, "lq-zip")}
          />
        </div>
      </fieldset>
      {props.alert}
      <Button type="submit" busy={props.busy} busyLabel={props.toPhoto ? "Finding your property…" : "Getting your estimate…"}>
        {props.toPhoto ? "Find my property" : "Get my estimate"}
      </Button>
    </form>
  );
}

// ---- Estimate and lead form

function taxLabel(est: Priced): string {
  const { quote, county } = est;
  const where = `${county} County, ${formatBps(quote.taxRateBps)}`;
  if (quote.taxableSubtotalCents === 0) return `Sales tax (${where}): no taxable services`;
  if (quote.taxableSubtotalCents === quote.subtotalCents) return `Sales tax (${where})`;
  return `Sales tax (${where}) on ${formatCents(quote.taxableSubtotalCents)} of taxable services`;
}

function assumptionsLine(est: Priced): string {
  const parts: string[] = [];
  // R21: never show the lot size without saying where it comes from.
  if (est.parcelSqft !== null) parts.push(`Lot size ${formatSqft(est.parcelSqft)}, from county tax records, not a survey.`);
  else if (est.origin === "drawn") parts.push("From the lawn you outlined.");
  else parts.push(est.origin === "manual" ? "From the lawn area you entered." : "From the lot size you chose.");
  for (const assumption of est.assumptions) {
    const text = assumption.trim();
    if (text) parts.push(text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : "."));
  }
  return parts.join(" ");
}

const CHIPS: { key: Adjust | "right"; label: string }[] = [
  { key: "smaller", label: "Smaller" },
  { key: "right", label: "About right" },
  { key: "larger", label: "Larger" },
];

type EstimateScreenProps = {
  headingRef: HeadingRef;
  company: CompanyView;
  address: string;
  estimate: Priced;
  /** The one adjustment already made, if any. */
  adjusted: Adjust | null;
  busy: "adjust" | "submit" | null;
  adjustAlert: ReactNode;
  requestAlert: ReactNode;
  onAdjust(adjust: Adjust): void;
  onChangeAddress(): void;
  onRequest(contact: Contact, honeypot: string): void;
};

export function EstimateScreen({ headingRef, ...props }: EstimateScreenProps) {
  const { company, estimate: est, adjusted } = props;
  const { quote } = est;
  const fromParcel = est.origin === "regrid" || est.origin === "regrid_adjusted";
  const locked = !est.canAdjust;

  return (
    <>
      <h1 ref={headingRef} tabIndex={-1} className="lq-h1">
        Your estimate
      </h1>
      <AddressLine address={props.address} onChange={props.onChangeAddress} />

      {/* Polite, so an adjustment is announced without stealing focus from the chips. */}
      <div className="lq-price" aria-live="polite" aria-atomic="true">
        <p className="lq-price-label">Estimated total</p>
        <p className="lq-price-amount">{formatCents(quote.totalCents)}</p>
        <p className="lq-price-basis">For about {formatSqft(est.grassSqft)} of lawn.</p>
      </div>
      <p className="lq-assumptions">{assumptionsLine(est)}</p>

      {fromParcel && (
        <div className="lq-adjust" role="group" aria-labelledby="lq-adjust-label" aria-describedby="lq-adjust-hint">
          <p id="lq-adjust-label" className="lq-label">
            Does that lawn size look right?
          </p>
          <div className="lq-chips">
            {CHIPS.map((chip) => {
              const pressed = (adjusted ?? "right") === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  className="lq-chip"
                  aria-pressed={pressed}
                  aria-disabled={locked || props.busy !== null || undefined}
                  onClick={() => {
                    if (!locked && props.busy === null && chip.key !== "right") props.onAdjust(chip.key);
                  }}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
          <p id="lq-adjust-hint" className="lq-hint">
            {locked
              ? `The size has been adjusted once. ${company.name} will confirm it.`
              : "You can adjust the size once."}
          </p>
          {props.adjustAlert}
        </div>
      )}

      {/* R3: one row per line, each saying whether it is taxed; never one bundled price. */}
      <table className="lq-lines">
        <caption className="lq-sr">Estimate breakdown</caption>
        <thead className="lq-sr">
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {quote.lines.map((line) => (
            <tr key={line.serviceCode}>
              <th scope="row">
                {line.name}
                <span className="lq-tag">{line.taxable ? "Taxable" : "Not taxable"}</span>
              </th>
              <td>{formatCents(line.amountCents)}</td>
            </tr>
          ))}
          <tr className="lq-lines-rule">
            <th scope="row">Subtotal</th>
            <td>{formatCents(quote.subtotalCents)}</td>
          </tr>
          <tr>
            <th scope="row">{taxLabel(est)}</th>
            <td>{formatCents(quote.taxCents)}</td>
          </tr>
          <tr className="lq-lines-total">
            <th scope="row">Estimated total</th>
            <td>{formatCents(quote.totalCents)}</td>
          </tr>
        </tbody>
      </table>

      {/* R6 and section 7 of the compliance document: an estimate, not a contract. */}
      <p className="lq-disclaimer">
        {fromParcel
          ? `This is an estimate from a parcel-based measurement of your yard, using ${company.name}'s published rates.`
          : est.origin === "drawn"
            ? `This is an estimate from the lawn you outlined on an aerial photo, using ${company.name}'s published rates.`
            : `This is an estimate from the lot size you gave, using ${company.name}'s published rates.`}{" "}
        {company.name} confirms the final price before work begins.
      </p>

      <LeadForm
        companyName={company.name}
        busy={props.busy === "submit"}
        blocked={props.busy !== null}
        alert={props.requestAlert}
        onRequest={props.onRequest}
      />

      {/* R17 */}
      {fromParcel && <p className="lq-credit">Parcel data © Regrid</p>}
    </>
  );
}

const PHONE = /^\+?[0-9 ().-]{7,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type LeadFormProps = {
  companyName: string;
  busy: boolean;
  blocked: boolean;
  alert: ReactNode;
  onRequest(contact: Contact, honeypot: string): void;
};

function LeadForm({ companyName, busy, blocked, alert, onRequest }: LeadFormProps) {
  const { errors, summaryRef, check } = useFormErrors();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [honeypot, setHoneypot] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    const contact = { name: name.trim(), phone: phone.trim(), email: email.trim() };
    const found: FieldError[] = [];
    if (!contact.name) found.push({ field: "lq-name", message: "Enter your name." });
    else if (contact.name.length > 120) found.push({ field: "lq-name", message: "Shorten your name to 120 characters or fewer." });
    if (!contact.phone && !contact.email) {
      found.push({ field: "lq-phone", message: "Enter a phone number or an email address." });
    }
    if (contact.phone && !PHONE.test(contact.phone)) {
      found.push({ field: "lq-phone", message: "Enter a phone number with its area code, like 717-555-0100." });
    }
    if (contact.email && (!EMAIL.test(contact.email) || contact.email.length > 254)) {
      found.push({ field: "lq-email", message: "Enter an email address like name@example.com." });
    }
    if (!check(found)) return;
    onRequest(
      { name: contact.name, ...(contact.phone ? { phone: contact.phone } : {}), ...(contact.email ? { email: contact.email } : {}) },
      honeypot,
    );
  }

  return (
    <form onSubmit={submit} noValidate className="lq-lead-form">
      <h2 className="lq-h2">Request service</h2>
      <p className="lq-hint">
        {companyName} will contact you to confirm the price. Give a phone number, an email address, or both.
      </p>
      <ErrorSummary errors={errors} summaryRef={summaryRef} />
      <TextField
        id="lq-name"
        label="Name"
        type="text"
        autoComplete="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        error={errorFor(errors, "lq-name")}
      />
      <TextField
        id="lq-phone"
        label="Phone"
        type="tel"
        autoComplete="tel"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        error={errorFor(errors, "lq-phone")}
      />
      <TextField
        id="lq-email"
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={errorFor(errors, "lq-email")}
      />
      {/* Honeypot: off screen, out of the tab order and hidden from assistive technology. */}
      <div className="lq-hp" aria-hidden="true">
        <label htmlFor="lq-website">Website</label>
        <input
          id="lq-website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(event) => setHoneypot(event.target.value)}
        />
      </div>
      {alert}
      <Button type="submit" busy={blocked} busyLabel={busy ? "Sending your request…" : undefined}>
        Request service
      </Button>
    </form>
  );
}

// ---- Manual path

const MANUAL_INTRO: Record<ManualWhy, string> = {
  no_photo: "We couldn't find that address on the map.",
  chosen: "",
  no_match: "We couldn't find that address in county records.",
  ambiguous_match: "We found more than one property at that address.",
  parcel_over_two_acres: "That property is over two acres, so we need to know how much of it is lawn.",
  lookup_unavailable: "Instant lookup isn't available right now.",
  unknown_county: "We couldn't tell which county that property is in.",
};

type SizeChoice = "quarter_acre" | "half_acre" | "one_acre" | "two_plus_acres" | "sqft";

const SIZE_OPTIONS: { value: SizeChoice; label: string }[] = [
  { value: "quarter_acre", label: "About ¼ acre" },
  { value: "half_acre", label: "About ½ acre" },
  { value: "one_acre", label: "About 1 acre" },
  { value: "two_plus_acres", label: "2 acres or more" },
  { value: "sqft", label: "I know the lawn area in square feet" },
];

type ManualScreenProps = {
  headingRef: HeadingRef;
  reason: ManualWhy;
  address: string;
  initialZip: string;
  initialSize: ManualSize | null;
  busy: boolean;
  alert: ReactNode;
  onChangeAddress(): void;
  onSubmit(zip: string, size: ManualSize): void;
};

export function ManualScreen({ headingRef, ...props }: ManualScreenProps) {
  const { errors, summaryRef, check } = useFormErrors();
  const [zip, setZip] = useState(props.initialZip);
  const initial = props.initialSize;
  // An outlined area belongs to the photo screen and is not offered again here.
  const [choice, setChoice] = useState<SizeChoice | null>(
    initial?.kind === "sqft" ? "sqft" : initial?.kind === "bucket" ? initial.bucket : null,
  );
  const [sqft, setSqft] = useState(initial?.kind === "sqft" ? String(initial.sqft) : "");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (props.busy) return;
    const found: FieldError[] = [];
    const cleanZip = zip.trim();
    if (!/^[0-9]{5}$/.test(cleanZip)) found.push({ field: "lq-zip", message: "Enter the property's five-digit zip code." });
    const area = Number(sqft.replace(/,/g, "").trim());
    if (choice === null) {
      found.push({ field: "lq-size", message: "Choose the lot size." });
    } else if (choice === "sqft" && !(Number.isInteger(area) && area >= 100 && area <= 2_000_000)) {
      found.push({ field: "lq-sqft", message: "Enter the lawn area as a whole number from 100 to 2,000,000 square feet." });
    }
    if (!check(found) || choice === null) return;
    props.onSubmit(cleanZip, choice === "sqft" ? { kind: "sqft", sqft: area } : { kind: "bucket", bucket: choice });
  }

  return (
    <form onSubmit={submit} noValidate>
      <h1 ref={headingRef} tabIndex={-1} className="lq-h1">
        Tell us about the lawn
      </h1>
      <p className="lq-lead">
        {[MANUAL_INTRO[props.reason], "Give us the zip code and the lot size and we'll estimate from those."].filter(Boolean).join(" ")}
      </p>
      <AddressLine address={props.address} onChange={props.onChangeAddress} />
      <ErrorSummary errors={errors} summaryRef={summaryRef} />
      <TextField
        id="lq-zip"
        label="Zip code"
        hint="Sales tax depends on where the property is."
        type="text"
        inputMode="numeric"
        autoComplete="postal-code"
        maxLength={5}
        value={zip}
        onChange={(event) => setZip(event.target.value)}
        error={errorFor(errors, "lq-zip")}
      />
      <RadioGroup
        id="lq-size"
        legend="Lot size"
        options={SIZE_OPTIONS}
        value={choice}
        onChange={(value) => setChoice(value)}
        error={errorFor(errors, "lq-size")}
      />
      {choice === "sqft" && (
        <TextField
          id="lq-sqft"
          label="Lawn area in square feet"
          type="text"
          inputMode="numeric"
          value={sqft}
          onChange={(event) => setSqft(event.target.value)}
          error={errorFor(errors, "lq-sqft")}
        />
      )}
      {props.alert}
      <Button type="submit" busy={props.busy} busyLabel="Getting your estimate…">
        Get my estimate
      </Button>
    </form>
  );
}

// ---- County chooser

type CountyScreenProps = {
  headingRef: HeadingRef;
  zip: string;
  candidates: string[];
  busy: boolean;
  alert: ReactNode;
  onBack(): void;
  onSubmit(county: string): void;
};

export function CountyScreen({ headingRef, ...props }: CountyScreenProps) {
  const { errors, summaryRef, check } = useFormErrors();
  const [county, setCounty] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (props.busy) return;
    if (!check(county === null ? [{ field: "lq-county", message: "Choose the county the property is in." }] : [])) return;
    if (county !== null) props.onSubmit(county);
  }

  return (
    <form onSubmit={submit} noValidate>
      <h1 ref={headingRef} tabIndex={-1} className="lq-h1">
        Which county is the property in?
      </h1>
      <p className="lq-lead">
        Zip code {props.zip} covers more than one county, and sales tax depends on the county.
      </p>
      <ErrorSummary errors={errors} summaryRef={summaryRef} />
      <RadioGroup
        id="lq-county"
        legend="County"
        options={props.candidates.map((c) => ({ value: c, label: `${c} County` }))}
        value={county}
        onChange={setCounty}
        error={errorFor(errors, "lq-county")}
      />
      {props.alert}
      <div className="lq-actions">
        <Button type="submit" busy={props.busy} busyLabel="Getting your estimate…">
          Continue
        </Button>
        <Button variant="secondary" onClick={props.onBack}>
          Back
        </Button>
      </div>
    </form>
  );
}

// ---- Call us, and confirmation

const CALL_INTRO: Record<CallReason, (company: string) => string> = {
  outside_service_area: (company) => `${company} doesn't offer online estimates for that address.`,
  no_price_for_size: (company) => `${company} prices lawns of that size individually.`,
  unknown_county: () => "We couldn't work out the sales tax county for that zip code, so we can't show an accurate estimate.",
};

type CallScreenProps = { headingRef: HeadingRef; companyName: string; reason: CallReason; phone: string | null; onRestart(): void };

export function CallScreen({ headingRef, companyName, reason, phone, onRestart }: CallScreenProps) {
  const href = phone ? telHref(phone) : null;
  return (
    <>
      <h1 ref={headingRef} tabIndex={-1} className="lq-h1">
        Please call for a quote
      </h1>
      <p className="lq-lead">{CALL_INTRO[reason](companyName)}</p>
      {phone && href ? (
        <a className="lq-button lq-button-primary" href={href}>
          Call {phone}
        </a>
      ) : (
        <p className="lq-lead">Contact {companyName} directly for a quote.</p>
      )}
      <Button variant="secondary" onClick={onRestart}>
        Try another address
      </Button>
    </>
  );
}

export function DoneScreen({ headingRef, companyName, quoteId }: { headingRef: HeadingRef; companyName: string; quoteId: string }) {
  return (
    <>
      <h1 ref={headingRef} tabIndex={-1} className="lq-h1">
        Request sent
      </h1>
      <p className="lq-lead">
        {companyName} has your request and will contact you to confirm the price and a start date. Nothing is booked or owed
        until then.
      </p>
      <p className="lq-hint">Reference {quoteId.slice(0, 8)}</p>
    </>
  );
}
