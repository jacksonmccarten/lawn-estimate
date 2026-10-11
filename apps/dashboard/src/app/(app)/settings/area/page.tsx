"use client";

// Service area: the business address and how many miles around it the
// company works. Saving stores both and makes the zip codes within that
// distance of the address's zip code the company's service area; homeowners
// anywhere else are asked to call. The tax county still comes from each
// homeowner's own zip code.

import type { ServiceAreaSettings } from "@lq/api-contract";
import { useRef, useState, type FormEvent, type RefObject } from "react";
import { useApi } from "@/components/auth-provider";
import { BusyButton, LoadError, Loading, PageHeading, TextInput, useToast } from "@/components/ui";
import { ApiError, describeError } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

/** The API's bounds on a radius, in miles. */
const MIN_MILES = 1;
const MAX_MILES = 100;

type Field = "street" | "city" | "state" | "zip" | "miles";
type Errors = Partial<Record<Field, string>>;

function describe(settings: ServiceAreaSettings): string {
  if (!settings.radius) return "No service area set yet.";
  const { street, city, state, zip, miles } = settings.radius;
  const zips = `${settings.zipCount} zip code${settings.zipCount === 1 ? "" : "s"}`;
  return `Within ${miles} miles of ${street}, ${city}, ${state} ${zip}: ${zips}.`;
}

function RadiusEditor({ initial, onSaved }: { initial: ServiceAreaSettings; onSaved: (settings: ServiceAreaSettings) => void }) {
  const api = useApi();
  const toast = useToast();
  const [saved, setSaved] = useState(initial);
  const [street, setStreet] = useState(initial.radius?.street ?? "");
  const [city, setCity] = useState(initial.radius?.city ?? "");
  const [state, setState] = useState(initial.radius?.state ?? "PA");
  const [zip, setZip] = useState(initial.radius?.zip ?? "");
  const [miles, setMiles] = useState(initial.radius ? String(initial.radius.miles) : "15");
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const refs: Record<Field, RefObject<HTMLInputElement | null>> = {
    street: useRef<HTMLInputElement>(null),
    city: useRef<HTMLInputElement>(null),
    state: useRef<HTMLInputElement>(null),
    zip: useRef<HTMLInputElement>(null),
    miles: useRef<HTMLInputElement>(null),
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaveError(null);
    setStatus("");
    const distance = Number(miles.trim());
    const problems: Errors = {};
    if (street.trim().length < 3) problems.street = "Enter your business’s street address.";
    if (city.trim().length < 2) problems.city = "Enter the city or town.";
    if (!/^[A-Za-z]{2}$/.test(state.trim())) problems.state = "Enter the state as two letters, like PA.";
    if (!/^[0-9]{5}$/.test(zip.trim())) problems.zip = "Enter the five-digit zip code.";
    if (!(distance >= MIN_MILES && distance <= MAX_MILES)) problems.miles = `Enter a distance from ${MIN_MILES} to ${MAX_MILES} miles.`;
    setErrors(problems);
    const first = (["street", "city", "state", "zip", "miles"] as const).find((field) => problems[field]);
    if (first) return refs[first].current?.focus();

    setSaving(true);
    try {
      const result = await api.replaceServiceArea({ street: street.trim(), city: city.trim(), state: state.trim(), zip: zip.trim(), miles: distance });
      setSaved(result);
      onSaved(result);
      setStatus(`Saved. ${describe(result)}`);
      toast("Service area saved.");
    } catch (error) {
      if (error instanceof ApiError && error.code === "invalid_request" && error.fields?.zip) {
        setErrors({ zip: "We don’t have a location for that zip code. Check it; service areas are in Pennsylvania." });
        refs.zip.current?.focus();
      } else setSaveError(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card" aria-labelledby="radius-heading">
      <h2 id="radius-heading">Where you work</h2>
      <p className="muted">
        Homeowners within your service radius get an instant estimate; anyone farther away is asked to call you. The distance is measured from
        the centre of your zip code to the centre of theirs.
      </p>
      <p className="current-area">
        <strong>Now:</strong> {describe(saved)}
      </p>
      <form onSubmit={save} noValidate className="area-form">
        <fieldset className="address-fields">
          <legend>Business address</legend>
          <TextInput id="area-street" label="Street address" autoComplete="address-line1" value={street} onChange={setStreet} inputRef={refs.street} error={errors.street} />
          <div className="field-row">
            <TextInput id="area-city" label="City" autoComplete="address-level2" value={city} onChange={setCity} inputRef={refs.city} error={errors.city} />
            <TextInput id="area-state" label="State" autoComplete="address-level1" value={state} onChange={setState} inputRef={refs.state} error={errors.state} className="narrow" />
            <TextInput
              id="area-zip"
              label="Zip code"
              inputMode="numeric"
              autoComplete="postal-code"
              value={zip}
              onChange={setZip}
              inputRef={refs.zip}
              error={errors.zip}
              className="narrow"
            />
          </div>
        </fieldset>
        <TextInput
          id="area-miles"
          label="Service radius, in miles"
          description="How far from your business you’ll travel, like 15, 25 or 50."
          inputMode="decimal"
          value={miles}
          onChange={setMiles}
          inputRef={refs.miles}
          error={errors.miles}
          className="narrow"
        />
        {saveError && (
          <p role="alert" className="inline-error">
            {saveError}
          </p>
        )}
        <p role="status" className="muted">
          {status}
        </p>
        <div className="form-actions">
          <BusyButton type="submit" className="btn primary" isBusy={saving}>
            Save service area
          </BusyButton>
        </div>
      </form>
    </section>
  );
}

export default function ServiceAreaPage() {
  const api = useApi();
  const { state, reload, set } = useLoad(() => api.getServiceArea(), [api]);
  return (
    <>
      <PageHeading title="Service area" />
      {state.status === "loading" && <Loading what="service area" />}
      {state.status === "error" && <LoadError message={state.message} onRetry={reload} />}
      {state.status === "ready" && <RadiusEditor initial={state.data} onSaved={set} />}
    </>
  );
}
