"use client";

// Service areas: where a company works. Each is a region group, which is
// what pricing tiers are written for. A new area is every zip code within a
// distance of an address; adding or removing one saves at once, so it is in
// Pricing's region group list straight away.

import type { Regions } from "@lq/api-contract";
import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-aria-components";
import { useApi } from "@/components/auth-provider";
import { BusyButton, LoadError, Loading, PageHeading, SelectField, TextInput, useToast } from "@/components/ui";
import { ApiError, describeError } from "@/lib/api";
import { PA_COUNTIES } from "@/lib/pa-counties";
import { addArea, describeArea, groupName, removeArea, toAreas, toRegions, type ServiceArea } from "@/lib/service-area";
import { useLoad } from "@/lib/use-load";

/** The API's bounds on a distance, in miles. */
const MIN_MILES = 1;
const MAX_MILES = 100;

type Errors = { name?: string; street?: string; city?: string; state?: string; zip?: string; miles?: string };

function AreaEditor({ initial, onSaved }: { initial: Regions; onSaved: (regions: Regions) => void }) {
  const api = useApi();
  const toast = useToast();
  const [areas, setAreas] = useState<ServiceArea[]>(() => toAreas(initial.regions));

  // The new-area form.
  const [name, setName] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("PA");
  const [zip, setZip] = useState("");
  const [miles, setMiles] = useState("15");
  const [errors, setErrors] = useState<Errors>({});
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const refs = {
    name: useRef<HTMLInputElement>(null),
    street: useRef<HTMLInputElement>(null),
    city: useRef<HTMLInputElement>(null),
    state: useRef<HTMLInputElement>(null),
    zip: useRef<HTMLInputElement>(null),
    miles: useRef<HTMLInputElement>(null),
  };

  // Removing one.
  const [toRemove, setToRemove] = useState("");
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [status, setStatus] = useState("");
  const listHeadingRef = useRef<HTMLHeadingElement>(null);

  /** Saves the list and shows what the server now holds. */
  async function save(next: ServiceArea[]): Promise<void> {
    const result = await api.replaceRegions({ regions: toRegions(next) });
    setAreas(toAreas(result.regions));
    onSaved(result);
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (adding) return;
    setAddError(null);
    setStatus("");
    const group = groupName(name);
    const distance = Number(miles.trim());
    const problems: Errors = {};
    if (!group) problems.name = "Give the area a name, like Near the shop.";
    else if (areas.some((a) => a.group === group)) problems.name = "You already have a service area with this name. Choose a different one.";
    if (street.trim().length < 3) problems.street = "Enter the street address at the centre of the area.";
    if (city.trim().length < 2) problems.city = "Enter the city or town.";
    if (!/^[A-Za-z]{2}$/.test(state.trim())) problems.state = "Enter the state as two letters, like PA.";
    if (!/^[0-9]{5}$/.test(zip.trim())) problems.zip = "Enter the five-digit zip code.";
    if (!(distance >= MIN_MILES && distance <= MAX_MILES)) problems.miles = `Enter a distance from ${MIN_MILES} to ${MAX_MILES} miles.`;
    setErrors(problems);
    const first = (["name", "street", "city", "state", "zip", "miles"] as const).find((field) => problems[field]);
    if (first) return refs[first].current?.focus();

    setAdding(true);
    try {
      const near = await api.zipsNear({ zip: zip.trim(), miles: distance });
      const result = addArea(areas, group, near.zips);
      if (result.added === 0) {
        setAddError("Every zip code within that distance is already in another of your service areas, so there is nothing to add.");
        return;
      }
      await save(result.areas);
      const count = `${result.added} zip code${result.added === 1 ? "" : "s"}`;
      setStatus(
        `Added ${group}: ${count} within ${distance} miles of ${zip.trim()}.${result.skipped > 0 ? ` ${result.skipped} more were already in another service area and stay there.` : ""} It is now a region group in Pricing.`,
      );
      toast(`Service area ${group} added.`);
      setName("");
      setStreet("");
      setCity("");
      setZip("");
      listHeadingRef.current?.focus();
    } catch (error) {
      if (error instanceof ApiError && error.code === "invalid_request" && error.fields?.zip) {
        setErrors({ zip: "We don’t have a location for that zip code. Check it; service areas are in Pennsylvania." });
        refs.zip.current?.focus();
      } else setAddError(describeError(error));
    } finally {
      setAdding(false);
    }
  }

  async function remove() {
    if (removing || !toRemove) return;
    setRemoveError(null);
    setStatus("");
    setRemoving(true);
    try {
      await save(removeArea(areas, toRemove));
      setStatus(`Removed ${toRemove}. Homeowners there are now asked to call, unless another service area covers them.`);
      toast(`Service area ${toRemove} removed.`);
      setToRemove("");
      listHeadingRef.current?.focus();
    } catch (error) {
      setRemoveError(describeError(error));
    } finally {
      setRemoving(false);
    }
  }

  const label = name.trim() ? `Add ${name.trim()}` : "Add service area";

  return (
    <div className="stack">
      <section className="card" aria-labelledby="areas-heading">
        <h2 id="areas-heading" ref={listHeadingRef} tabIndex={-1}>
          Your service areas
        </h2>
        <p className="muted">
          Homeowners inside a service area can get an online estimate; anyone else is asked to call you. Each area is a region group in{" "}
          <Link className="link" href="/pricing">
            Pricing
          </Link>
          , where you give it its own tiers. Where two overlap, a zip-code area’s prices are used.
        </p>
        {areas.length === 0 ? (
          <p>You have no service areas, so every homeowner is asked to call. Create one below.</p>
        ) : (
          <ul className="area-list">
            {areas.map((area) => (
              <li key={area.group}>
                <span>
                  <strong>{area.group}</strong>
                  <span className="muted"> · {describeArea(area, PA_COUNTIES.length)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p role="status" className="muted">
          {status}
        </p>

        {areas.length > 0 && (
          <div className="area-remove">
            <h3>Remove a service area</h3>
            <div className="field-row">
              <SelectField
                id="area-remove"
                label="Service area to remove"
                value={toRemove}
                onChange={setToRemove}
                options={areas.map((a) => ({ id: a.group, label: `${a.group} (${describeArea(a, PA_COUNTIES.length)})` }))}
                placeholder="Choose a service area…"
              />
            </div>
            {removeError && (
              <p role="alert" className="inline-error">
                {removeError}
              </p>
            )}
            <div className="form-actions">
              <BusyButton className="btn" onPress={() => void remove()} isBusy={removing} isDisabled={!toRemove}>
                {toRemove ? `Remove ${toRemove}` : "Remove"}
              </BusyButton>
            </div>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="new-area-heading">
        <h2 id="new-area-heading">Create a new service area</h2>
        <p className="muted">
          Name the area and give the address at its centre. The area is every zip code within the distance you choose, measured from the centre of
          the address’s zip code.
        </p>
        <form onSubmit={add} noValidate className="area-form">
          <TextInput
            id="area-name"
            label="Area name"
            description="Becomes the region group you choose on pricing tiers."
            value={name}
            onChange={setName}
            inputRef={refs.name}
            error={errors.name}
          />
          <fieldset className="address-fields">
            <legend>Centre address</legend>
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
            label="Distance from the centre, in miles"
            inputMode="decimal"
            value={miles}
            onChange={setMiles}
            inputRef={refs.miles}
            error={errors.miles}
            className="narrow"
          />
          {addError && (
            <p role="alert" className="inline-error">
              {addError}
            </p>
          )}
          <div className="form-actions">
            <BusyButton type="submit" className="btn primary" isBusy={adding}>
              {label}
            </BusyButton>
          </div>
        </form>
      </section>
    </div>
  );
}

export default function ServiceAreaPage() {
  const api = useApi();
  const { state, reload, set } = useLoad(() => api.getRegions(), [api]);
  return (
    <>
      <PageHeading title="Service area" />
      {state.status === "loading" && <Loading what="service areas" />}
      {state.status === "error" && <LoadError message={state.message} onRetry={reload} />}
      {state.status === "ready" && <AreaEditor initial={state.data} onSaved={set} />}
    </>
  );
}
