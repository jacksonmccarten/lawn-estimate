"use client";

import type { PricingVersion, PricingVersionContent, Tier } from "@lq/api-contract";
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from "react";
import { Button } from "react-aria-components";
import { ApiError, describeError } from "@/lib/api";
import { fieldId, fromForm, newKey, sameForm, tierToRow, toForm, type FieldError, type PricingForm, type ServiceRow, type TierRow } from "@/lib/pricing-form";
import { DRAFT_KEY_PREFIX, useApi } from "../auth-provider";
import { BusyButton, errorFor, ErrorSummary, SelectField, TableScroll, TextInput, useToast } from "../ui";
import { CsvImport } from "./csv-import";
import { PreviewQuote } from "./preview";
import { PublishDialog } from "./publish-dialog";

type Action =
  | { type: "load"; form: PricingForm }
  | { type: "set"; field: "minCharge"; value: string }
  | { type: "service/add"; key: string }
  | { type: "service/remove"; key: string }
  | { type: "service/update"; key: string; patch: Partial<ServiceRow> }
  | { type: "tier/add"; key: string; regionGroup: string }
  | { type: "tier/remove"; key: string }
  | { type: "tier/update"; key: string; patch: Partial<TierRow> }
  | { type: "tier/move"; key: string; by: -1 | 1 }
  | { type: "tiers/import"; rows: TierRow[]; mode: "replace" | "append" };

function reducer(form: PricingForm, action: Action): PricingForm {
  switch (action.type) {
    case "load":
      return action.form;
    case "set":
      return { ...form, [action.field]: action.value };
    case "service/add":
      return { ...form, services: [...form.services, { key: action.key, code: "", name: "", taxable: "", season: "growing" }] };
    case "service/remove":
      return { ...form, services: form.services.filter((s) => s.key !== action.key) };
    case "service/update": {
      const before = form.services.find((s) => s.key === action.key);
      const services = form.services.map((s) => (s.key === action.key ? { ...s, ...action.patch } : s));
      // Renaming a service's code carries its tiers along, unless another service shares the old code.
      const renamed = before && action.patch.code !== undefined && before.code !== "" && form.services.filter((s) => s.code === before.code).length === 1;
      const tiers = renamed ? form.tiers.map((t) => (t.serviceCode === before.code ? { ...t, serviceCode: action.patch.code! } : t)) : form.tiers;
      return { ...form, services, tiers };
    }
    case "tier/add": {
      const last = form.tiers[form.tiers.length - 1];
      // Start the next tier where the last one stopped, for the same service and region.
      const row: TierRow = {
        key: action.key,
        serviceCode: last?.serviceCode ?? form.services[0]?.code ?? "",
        regionGroup: last?.regionGroup ?? action.regionGroup,
        minSqft: last?.maxSqft ?? "0",
        maxSqft: "",
        priceKind: last?.priceKind ?? "per_sqft",
        price: "",
      };
      return { ...form, tiers: [...form.tiers, row] };
    }
    case "tier/remove":
      return { ...form, tiers: form.tiers.filter((t) => t.key !== action.key) };
    case "tier/update":
      return { ...form, tiers: form.tiers.map((t) => (t.key === action.key ? { ...t, ...action.patch } : t)) };
    case "tier/move": {
      const from = form.tiers.findIndex((t) => t.key === action.key);
      const to = from + action.by;
      if (from < 0 || to < 0 || to >= form.tiers.length) return form;
      const tiers = [...form.tiers];
      [tiers[from], tiers[to]] = [tiers[to]!, tiers[from]!];
      return { ...form, tiers };
    }
    case "tiers/import":
      return { ...form, tiers: action.mode === "replace" ? action.rows : [...form.tiers, ...action.rows] };
  }
}

const TAX_OPTIONS = [
  { id: "yes", label: "Taxable" },
  { id: "no", label: "Not taxable" },
];
const SEASON_OPTIONS = [
  { id: "growing", label: "Growing season" },
  { id: "winter", label: "Winter" },
];
const PRICE_KIND_OPTIONS = [
  { id: "per_sqft", label: "Per 1,000 sq ft" },
  { id: "flat", label: "Flat price" },
];

type RowErrors = Record<string, string | undefined>;

const ServiceRowEditor = memo(function ServiceRowEditor({
  row,
  index,
  errors,
  dispatch,
  onRemove,
}: {
  row: ServiceRow;
  index: number;
  errors: RowErrors;
  dispatch: Dispatch<Action>;
  onRemove: (key: string, label: string) => void;
}) {
  const n = index + 1;
  const update = (patch: Partial<ServiceRow>) => dispatch({ type: "service/update", key: row.key, patch });
  return (
    <tr>
      <th scope="row">{n}</th>
      <td>
        <TextInput id={fieldId.service(row.key, "name")} label={`Service ${n}, name`} hideLabel value={row.name} onChange={(name) => update({ name })} error={errors.name} />
      </td>
      <td>
        <TextInput
          id={fieldId.service(row.key, "code")}
          label={`Service ${n}, code`}
          hideLabel
          value={row.code}
          onChange={(code) => update({ code })}
          error={errors.code}
          className="code"
        />
      </td>
      <td>
        <SelectField
          id={fieldId.service(row.key, "taxable")}
          label={`Service ${n}, sales tax`}
          hideLabel
          value={row.taxable}
          onChange={(taxable) => update({ taxable: taxable as ServiceRow["taxable"] })}
          options={TAX_OPTIONS}
          error={errors.taxable}
        />
      </td>
      <td>
        <SelectField
          id={fieldId.service(row.key, "season")}
          label={`Service ${n}, season`}
          hideLabel
          value={row.season}
          onChange={(season) => update({ season: season as ServiceRow["season"] })}
          options={SEASON_OPTIONS}
        />
      </td>
      <td>
        <Button className="btn quiet" onPress={() => onRemove(row.key, `Service ${n}`)} aria-label={`Remove service ${n}${row.name ? `, ${row.name}` : ""}`}>
          Remove
        </Button>
      </td>
    </tr>
  );
});

const TierRowEditor = memo(function TierRowEditor({
  row,
  index,
  errors,
  services,
  regionGroups,
  dispatch,
  onRemove,
  onMove,
}: {
  row: TierRow;
  index: number;
  errors: RowErrors;
  services: ReadonlyArray<{ id: string; label: string }>;
  /** The company's region groups. Empty while they load, or if it has none: the group is then typed. */
  regionGroups: ReadonlyArray<{ id: string; label: string }>;
  dispatch: Dispatch<Action>;
  onRemove: (key: string, label: string) => void;
  onMove: (key: string, index: number, by: -1 | 1) => void;
}) {
  const n = index + 1;
  const update = (patch: Partial<TierRow>) => dispatch({ type: "tier/update", key: row.key, patch });
  return (
    <tr>
      <th scope="row">{n}</th>
      <td>
        <SelectField
          id={fieldId.tier(row.key, "service")}
          label={`Tier ${n}, service`}
          hideLabel
          value={row.serviceCode}
          onChange={(serviceCode) => update({ serviceCode })}
          options={services}
          error={errors.service}
        />
      </td>
      <td>
        {regionGroups.length > 0 ? (
          <SelectField
            id={fieldId.tier(row.key, "region")}
            label={`Tier ${n}, region group`}
            hideLabel
            value={row.regionGroup}
            onChange={(regionGroup) => update({ regionGroup })}
            // A group this tier already names stays choosable, even if no region uses it now.
            options={row.regionGroup && !regionGroups.some((g) => g.id === row.regionGroup) ? [...regionGroups, { id: row.regionGroup, label: `${row.regionGroup} (no region uses it)` }] : regionGroups}
            error={errors.region}
          />
        ) : (
          <TextInput
            id={fieldId.tier(row.key, "region")}
            label={`Tier ${n}, region group`}
            hideLabel
            value={row.regionGroup}
            onChange={(regionGroup) => update({ regionGroup })}
            error={errors.region}
            className="short"
          />
        )}
      </td>
      <td>
        <TextInput
          id={fieldId.tier(row.key, "min")}
          label={`Tier ${n}, lawn area over, in square feet`}
          hideLabel
          inputMode="numeric"
          value={row.minSqft}
          onChange={(minSqft) => update({ minSqft })}
          error={errors.min}
          className="short num"
        />
      </td>
      <td>
        <TextInput
          id={fieldId.tier(row.key, "max")}
          label={`Tier ${n}, lawn area up to and including, in square feet`}
          hideLabel
          inputMode="numeric"
          value={row.maxSqft}
          onChange={(maxSqft) => update({ maxSqft })}
          error={errors.max}
          className="short num"
        />
      </td>
      <td>
        <SelectField
          id={fieldId.tier(row.key, "kind")}
          label={`Tier ${n}, how it is priced`}
          hideLabel
          value={row.priceKind}
          onChange={(priceKind) => update({ priceKind: priceKind as TierRow["priceKind"] })}
          options={PRICE_KIND_OPTIONS}
        />
      </td>
      <td>
        <TextInput
          id={fieldId.tier(row.key, "price")}
          label={row.priceKind === "per_sqft" ? `Tier ${n}, price in dollars per 1,000 square feet` : `Tier ${n}, flat price in dollars`}
          hideLabel
          inputMode="decimal"
          value={row.price}
          onChange={(price) => update({ price })}
          error={errors.price}
          className="short num"
        />
      </td>
      <td>
        {/* Reordering by buttons, not dragging (2.5.7). They stay enabled so focus is never dropped at either end. */}
        <div className="row-actions">
          <Button className="btn quiet" aria-label={`Move tier ${n} up`} onPress={() => onMove(row.key, index, -1)}>
            <span aria-hidden="true">↑</span>
          </Button>
          <Button className="btn quiet" aria-label={`Move tier ${n} down`} onPress={() => onMove(row.key, index, 1)}>
            <span aria-hidden="true">↓</span>
          </Button>
          <Button className="btn quiet" onPress={() => onRemove(row.key, `Tier ${n}`)} aria-label={`Remove tier ${n}`}>
            Remove
          </Button>
        </div>
      </td>
    </tr>
  );
});

const NO_ERRORS: RowErrors = {};

/** Groups field errors by row key, with stable objects so unchanged rows do not re-render. */
function useRowErrors(errors: FieldError[], prefix: "service" | "tier"): Map<string, RowErrors> {
  return useMemo(() => {
    const byRow = new Map<string, RowErrors>();
    for (const error of errors) {
      const match = new RegExp(`^${prefix}-(.+)-([a-z]+)$`).exec(error.fieldId);
      if (!match) continue;
      const row = byRow.get(match[1]!) ?? {};
      row[match[2]!] ??= error.message;
      byRow.set(match[1]!, row);
    }
    return byRow;
  }, [errors, prefix]);
}

function readWorkingCopy(id: string, baseline: PricingForm): PricingForm | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY_PREFIX + id);
    if (!raw) return null;
    const stored = JSON.parse(raw) as PricingForm;
    if (!Array.isArray(stored.services) || !Array.isArray(stored.tiers)) return null;
    // Row keys are only unique within a page load.
    // The coverage factor is not edited: it is whatever the version holds, whatever an older working copy says.
    const form = {
      minCharge: stored.minCharge,
      coverageFactor: baseline.coverageFactor,
      services: stored.services.map((s) => ({ ...s, key: newKey() })),
      tiers: stored.tiers.map((t) => ({ ...t, key: newKey() })),
    };
    return sameForm(form, baseline) ? null : form;
  } catch {
    return null;
  }
}

type Props = {
  version: PricingVersion;
  onSaved: (version: PricingVersion) => void;
  onPublished: (version: PricingVersion) => void;
  /** Open the publish review straight away: the last step of a rollback. */
  reviewOnOpen: boolean;
};

export function PricingEditor({ version, onSaved, onPublished, reviewOnOpen }: Props) {
  const api = useApi();
  const toast = useToast();
  const [initial] = useState(() => {
    const baseline = toForm(version.content);
    const restored = readWorkingCopy(version.id, baseline);
    return { baseline, restored };
  });
  const [baseline, setBaseline] = useState(initial.baseline);
  const [form, dispatch] = useReducer(reducer, initial.restored ?? initial.baseline);
  const [restored, setRestored] = useState(initial.restored !== null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState("");
  const [publishOpen, setPublishOpen] = useState(reviewOnOpen);
  const summaryRef = useRef<HTMLDivElement>(null);
  const focusSummary = useRef(false);
  const focusField = useRef<string | null>(null);
  const addServiceRef = useRef<HTMLButtonElement>(null);
  const addTierRef = useRef<HTMLButtonElement>(null);

  // The region groups the company's service area is divided into; a tier's prices apply in one of them.
  const [regionGroups, setRegionGroups] = useState<ReadonlyArray<{ id: string; label: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    api.getRegions().then(
      ({ regions }) => {
        if (cancelled) return;
        const groups = [...new Set(regions.map((r) => r.tierGroup))].sort();
        setRegionGroups(groups.map((g) => ({ id: g, label: g })));
      },
      // Without them the group is typed, as before.
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const dirty = useMemo(() => !sameForm(form, baseline), [form, baseline]);

  // The working copy lives in the tab until it is saved, so a forced sign-out does not lose it (2.2.1).
  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(DRAFT_KEY_PREFIX + version.id, JSON.stringify(form));
      else sessionStorage.removeItem(DRAFT_KEY_PREFIX + version.id);
    } catch {
      // Without storage the working copy lasts as long as the page.
    }
  }, [dirty, form, version.id]);

  useEffect(() => {
    if (focusSummary.current) {
      focusSummary.current = false;
      summaryRef.current?.focus();
    }
  }, [errors]);

  useEffect(() => {
    if (focusField.current) {
      document.getElementById(focusField.current)?.focus();
      focusField.current = null;
    }
  }, [form]);

  const save = useCallback(async (): Promise<boolean> => {
    if (saving) return false;
    const result = fromForm(form);
    setServerError(null);
    if (!result.ok) {
      focusSummary.current = true;
      setErrors(result.errors);
      setSaveStatus("");
      return false;
    }
    setErrors([]);
    setSaving(true);
    try {
      const saved = await api.replacePricingVersion(version.id, result.content);
      setBaseline(form);
      setRestored(false);
      const message = `Draft saved at ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`;
      setSaveStatus(message);
      toast("Draft saved.");
      onSaved(saved);
      return true;
    } catch (error) {
      setSaveStatus("");
      setServerError(
        error instanceof ApiError && error.code === "invalid_request" && error.fields
          ? `The server didn’t accept the draft: ${Object.entries(error.fields).map(([field, problem]) => `${field} ${problem}`).join("; ")}.`
          : describeError(error),
      );
      return false;
    } finally {
      setSaving(false);
    }
  }, [api, form, onSaved, saving, toast, version.id]);

  const ensureSaved = useCallback(async () => (dirty || errors.length > 0 ? save() : true), [dirty, errors.length, save]);

  const removeRow = useCallback((kind: "service" | "tier") => (key: string, label: string) => {
    dispatch({ type: `${kind}/remove`, key });
    setRowStatus(`${label} removed.`);
    // Its row is gone; the "add" button below the table is the nearest stable place.
    (kind === "service" ? addServiceRef : addTierRef).current?.focus();
  }, []);
  const removeService = useMemo(() => removeRow("service"), [removeRow]);
  const removeTier = useMemo(() => removeRow("tier"), [removeRow]);

  const tierCount = form.tiers.length;
  const moveTier = useCallback(
    (key: string, index: number, by: -1 | 1) => {
      const to = index + by;
      if (to < 0 || to >= tierCount) {
        setRowStatus(by < 0 ? `Tier ${index + 1} is already first.` : `Tier ${index + 1} is already last.`);
        return;
      }
      dispatch({ type: "tier/move", key, by });
      setRowStatus(`Tier moved to position ${to + 1} of ${tierCount}.`);
    },
    [tierCount],
  );

  const serviceOptions = useMemo(
    () => form.services.filter((s) => s.code.trim() !== "").map((s) => ({ id: s.code.trim(), label: s.name.trim() ? `${s.name.trim()} (${s.code.trim()})` : s.code.trim() })),
    [form.services],
  );
  const serviceErrors = useRowErrors(errors, "service");
  const tierErrors = useRowErrors(errors, "tier");

  const parsed = useMemo(() => fromForm(form), [form]);
  const existingTiers: Tier[] | null = parsed.ok ? parsed.content.tiers : null;
  const savedContent: PricingVersionContent = version.content;

  const onImport = useCallback((tiers: Tier[], mode: "replace" | "append") => {
    dispatch({ type: "tiers/import", rows: tiers.map(tierToRow), mode });
    setErrors([]);
  }, []);

  return (
    <div className="stack">
      {restored && (
        <div role="status" className="notice">
          <p>Unsaved changes from earlier in this browser tab were restored. Save the draft to keep them.</p>
          <Button
            className="btn"
            onPress={() => {
              dispatch({ type: "load", form: baseline });
              setRestored(false);
              setErrors([]);
            }}
          >
            Discard them
          </Button>
        </div>
      )}
      <ErrorSummary errors={errors} summaryRef={summaryRef} title={errors.length === 1 ? "The draft has 1 problem, so it wasn’t saved" : `The draft has ${errors.length} problems, so it wasn’t saved`} />

      <section className="card" aria-labelledby="settings-heading">
        <h2 id="settings-heading">Settings</h2>
        <div className="field-row">
          <TextInput
            id={fieldId.minCharge}
            label="Minimum charge, in dollars"
            description="The least you charge for the quoted service, however small the lawn."
            inputMode="decimal"
            value={form.minCharge}
            onChange={(value) => dispatch({ type: "set", field: "minCharge", value })}
            error={errorFor(errors, fieldId.minCharge)}
            className="narrow"
          />
        </div>
      </section>

      <section className="card" aria-labelledby="services-heading">
        <h2 id="services-heading">Services</h2>
        <p className="muted">
          Choose for every service whether sales tax applies. Taxable and non-taxable services are always shown to homeowners as separate lines.
        </p>
        <TableScroll label="Services table">
          <table className="table editor-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Number</span>
                </th>
                <th scope="col">Name shown to homeowners</th>
                <th scope="col">Code (lowercase letters, digits, underscores)</th>
                <th scope="col">Sales tax</th>
                <th scope="col">Season</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {form.services.map((row, index) => (
                <ServiceRowEditor key={row.key} row={row} index={index} errors={serviceErrors.get(row.key) ?? NO_ERRORS} dispatch={dispatch} onRemove={removeService} />
              ))}
            </tbody>
          </table>
        </TableScroll>
        {form.services.length === 0 && <p className="muted">No services yet.</p>}
        <Button
          ref={addServiceRef}
          className="btn"
          onPress={() => {
            const key = newKey();
            focusField.current = fieldId.service(key, "name");
            dispatch({ type: "service/add", key });
          }}
        >
          Add service
        </Button>
      </section>

      <section className="card" aria-labelledby="tiers-heading">
        <h2 id="tiers-heading">Tiers</h2>
        <p className="muted">
          A tier prices one service for a range of lawn sizes: over the first number of square feet, up to and including the second. Price it per 1,000 square
          feet or as one flat amount. Ranges for the same service and region group can&rsquo;t overlap. A lawn no tier covers gets &ldquo;call us&rdquo; instead
          of a price.
        </p>
        <p className="muted">
          A region group is a part of your service area that shares one set of prices, so you can charge more where the drive is longer.{" "}
          {regionGroups.length === 1
            ? `Your whole service area is one group, “${regionGroups[0]!.label}”, so every tier uses it.`
            : regionGroups.length > 1
              ? `Yours are: ${regionGroups.map((g) => g.label).join(", ")}.`
              : ""}
        </p>
        <TableScroll label="Tiers table">
          <table className="table editor-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Number</span>
                </th>
                <th scope="col">Service</th>
                <th scope="col">Region group</th>
                <th scope="col">Over, sq ft</th>
                <th scope="col">Up to, sq ft</th>
                <th scope="col">Priced</th>
                <th scope="col">Price, $ per 1,000 sq ft or $ flat</th>
                <th scope="col">Order and removal</th>
              </tr>
            </thead>
            <tbody>
              {form.tiers.map((row, index) => (
                <TierRowEditor
                  key={row.key}
                  row={row}
                  index={index}
                  errors={tierErrors.get(row.key) ?? NO_ERRORS}
                  services={serviceOptions}
                  regionGroups={regionGroups}
                  dispatch={dispatch}
                  onRemove={removeTier}
                  onMove={moveTier}
                />
              ))}
            </tbody>
          </table>
        </TableScroll>
        {form.tiers.length === 0 && (
          <p className="muted">
            {form.services.some((s) => s.code.trim() !== "")
              ? "No tiers yet. Add one, or import a CSV file below."
              : "No tiers yet. Add a service above first: a tier prices one of your services."}
          </p>
        )}
        <Button
          ref={addTierRef}
          className="btn"
          onPress={() => {
            const key = newKey();
            focusField.current = fieldId.tier(key, "service");
            dispatch({ type: "tier/add", key, regionGroup: regionGroups[0]?.id ?? "" });
          }}
        >
          Add tier
        </Button>
        <p role="status" className="visually-hidden">
          {rowStatus}
        </p>
      </section>

      <CsvImport serviceCodes={serviceOptions.map((s) => s.id)} existingTiers={existingTiers} onImport={onImport} />

      <section className="card save-bar" aria-label="Save and publish">
        <div className="form-actions">
          <BusyButton className="btn primary" onPress={() => void save()} isBusy={saving}>
            Save draft
          </BusyButton>
          <Button
            className="btn"
            onPress={async () => {
              if (await ensureSaved()) setPublishOpen(true);
            }}
          >
            Review and publish&hellip;
          </Button>
        </div>
        {/* The lasting copy of the save result; the toast is the passing one. */}
        <p role="status" className="muted">
          {dirty ? "You have unsaved changes." : saveStatus || "No unsaved changes."}
        </p>
        {serverError && (
          <p role="alert" className="inline-error">
            {serverError}
          </p>
        )}
      </section>

      <PreviewQuote versionId={version.id} content={savedContent} beforePreview={ensureSaved} />

      <PublishDialog version={version} isOpen={publishOpen} onClose={() => setPublishOpen(false)} onPublished={onPublished} />
    </div>
  );
}
