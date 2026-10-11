"use client";

// A draft's prices: lawn-size categories, each with one flat rate. The
// homeowner's lawn area picks the category; the price is its rate, never
// square feet times a rate.

import type { PricingVersion } from "@lq/api-contract";
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from "react";
import { Button } from "react-aria-components";
import { ApiError, describeError } from "@/lib/api";
import { fieldId, fromForm, newKey, rangeLabel, sameForm, toForm, type CategoryRow, type FieldError, type PricingForm } from "@/lib/pricing-form";
import { parseWholeNumber } from "@/lib/money";
import { DRAFT_KEY_PREFIX, useApi } from "../auth-provider";
import { BusyButton, ErrorSummary, TableScroll, TextInput, useToast } from "../ui";
import { PublishDialog } from "./publish-dialog";

type Action =
  | { type: "load"; form: PricingForm }
  | { type: "add"; key: string }
  | { type: "remove"; key: string }
  | { type: "update"; key: string; patch: Partial<CategoryRow> };

function reducer(form: PricingForm, action: Action): PricingForm {
  switch (action.type) {
    case "load":
      return action.form;
    case "add": {
      // A new category goes above the open-ended last one, starting where the one before it ends.
      const rows = form.categories;
      const beforeLast = rows.length >= 2 ? parseWholeNumber(rows[rows.length - 2]!.upTo) : 0;
      const row: CategoryRow = { key: action.key, upTo: beforeLast !== null ? String(beforeLast + 2_500) : "", price: "" };
      return { categories: rows.length === 0 ? [row] : [...rows.slice(0, -1), row, rows[rows.length - 1]!] };
    }
    case "remove":
      return { categories: form.categories.filter((c) => c.key !== action.key) };
    case "update":
      return { categories: form.categories.map((c) => (c.key === action.key ? { ...c, ...action.patch } : c)) };
  }
}

type RowErrors = Record<string, string | undefined>;
const NO_ERRORS: RowErrors = {};

const CategoryRowEditor = memo(function CategoryRowEditor({
  row,
  index,
  from,
  last,
  errors,
  dispatch,
  onRemove,
}: {
  row: CategoryRow;
  index: number;
  /** Where this category starts: the end of the one above, or 0. */
  from: number;
  last: boolean;
  errors: RowErrors;
  dispatch: Dispatch<Action>;
  onRemove: (key: string, label: string) => void;
}) {
  const n = index + 1;
  const update = (patch: Partial<CategoryRow>) => dispatch({ type: "update", key: row.key, patch });
  const upTo = parseWholeNumber(row.upTo);
  return (
    <tr>
      <th scope="row">{rangeLabel(from, last ? null : upTo !== null && upTo > from ? upTo : null)}</th>
      <td>
        {last ? (
          <span className="muted">and up</span>
        ) : (
          <TextInput
            id={fieldId.category(row.key, "max")}
            label={`Category ${n}, up to and including, in square feet`}
            hideLabel
            inputMode="numeric"
            value={row.upTo}
            onChange={(value) => update({ upTo: value })}
            error={errors.max}
            className="short num"
          />
        )}
      </td>
      <td>
        <TextInput
          id={fieldId.category(row.key, "price")}
          label={`Category ${n}, flat rate in dollars`}
          hideLabel
          inputMode="decimal"
          value={row.price}
          onChange={(price) => update({ price })}
          error={errors.price}
          className="short num"
        />
      </td>
      <td>
        <Button className="btn quiet" onPress={() => onRemove(row.key, `Category ${n}`)} aria-label={`Remove category ${n}`}>
          Remove
        </Button>
      </td>
    </tr>
  );
});

/** Groups field errors by row key, with stable objects so unchanged rows do not re-render. */
function useRowErrors(errors: FieldError[]): Map<string, RowErrors> {
  return useMemo(() => {
    const byRow = new Map<string, RowErrors>();
    for (const error of errors) {
      const match = /^category-(.+)-([a-z]+)$/.exec(error.fieldId);
      if (!match) continue;
      const row = byRow.get(match[1]!) ?? {};
      row[match[2]!] ??= error.message;
      byRow.set(match[1]!, row);
    }
    return byRow;
  }, [errors]);
}

function readWorkingCopy(id: string, baseline: PricingForm): PricingForm | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY_PREFIX + id);
    if (!raw) return null;
    const stored = JSON.parse(raw) as PricingForm;
    if (!Array.isArray(stored.categories)) return null;
    // Row keys are only unique within a page load.
    const form = { categories: stored.categories.map((c) => ({ upTo: String(c.upTo ?? ""), price: String(c.price ?? ""), key: newKey() })) };
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
  const addRef = useRef<HTMLButtonElement>(null);

  // The region groups of the company's service area: the same flat rates are written for each.
  const [regionGroups, setRegionGroups] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getRegions().then(
      ({ regions }) => !cancelled && setRegionGroups([...new Set(regions.map((r) => r.tierGroup))]),
      // Without them, the groups the version already prices.
      () => !cancelled && setRegionGroups([...new Set(version.content.tiers.map((t) => t.regionGroup))]),
    );
    return () => {
      cancelled = true;
    };
  }, [api, version.content.tiers]);

  const dirty = useMemo(() => !sameForm(form, baseline), [form, baseline]);
  // A version from before flat rates (or a new one showing the example categories) needs saving even when nothing was typed.
  const parsed = useMemo(() => (regionGroups ? fromForm(form, version.content, regionGroups) : null), [form, version.content, regionGroups]);
  const unsaved = dirty || (parsed?.ok === true && JSON.stringify(parsed.content) !== JSON.stringify(version.content));

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
    if (saving || !regionGroups) return false;
    const result = fromForm(form, version.content, regionGroups);
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
      setSaveStatus(`Draft saved at ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`);
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
  }, [api, form, onSaved, regionGroups, saving, toast, version.content, version.id]);

  const ensureSaved = useCallback(async () => (unsaved || errors.length > 0 ? save() : true), [unsaved, errors.length, save]);

  const remove = useCallback((key: string, label: string) => {
    dispatch({ type: "remove", key });
    setRowStatus(`${label} removed.`);
    // Its row is gone; the "add" button below the table is the nearest stable place.
    addRef.current?.focus();
  }, []);

  const rowErrors = useRowErrors(errors);
  // Where each category starts: the end of the one above it.
  const starts = useMemo(() => {
    let from = 0;
    return form.categories.map((row) => {
      const start = from;
      const upTo = parseWholeNumber(row.upTo);
      if (upTo !== null && upTo > from) from = upTo;
      return start;
    });
  }, [form.categories]);

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

      <section className="card" aria-labelledby="categories-heading">
        <h2 id="categories-heading">Lawn mowing prices</h2>
        <p className="muted">
          Each lawn size category has one flat rate. The homeowner&rsquo;s outlined lawn area picks the category, and the quote is that rate. Each
          category starts just above the one before it, so there are no gaps or overlaps; the last one covers every larger lawn.
        </p>
        <TableScroll label="Lawn size categories table">
          <table className="table editor-table">
            <thead>
              <tr>
                <th scope="col">Lawn size category</th>
                <th scope="col">Up to, sq ft</th>
                <th scope="col">Flat rate, $</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {form.categories.map((row, index) => (
                <CategoryRowEditor
                  key={row.key}
                  row={row}
                  index={index}
                  from={starts[index]!}
                  last={index === form.categories.length - 1}
                  errors={rowErrors.get(row.key) ?? NO_ERRORS}
                  dispatch={dispatch}
                  onRemove={remove}
                />
              ))}
            </tbody>
          </table>
        </TableScroll>
        {form.categories.length === 0 && <p className="muted">No categories yet. Add one to start pricing.</p>}
        <Button
          id="add-category"
          ref={addRef}
          className="btn"
          onPress={() => {
            const key = newKey();
            focusField.current = fieldId.category(key, form.categories.length === 0 ? "price" : "max");
            dispatch({ type: "add", key });
          }}
        >
          Add category
        </Button>
        <p role="status" className="visually-hidden">
          {rowStatus}
        </p>
      </section>

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
          {unsaved ? "You have unsaved changes." : saveStatus || "No unsaved changes."}
        </p>
        {serverError && (
          <p role="alert" className="inline-error">
            {serverError}
          </p>
        )}
      </section>

      <PublishDialog version={version} isOpen={publishOpen} onClose={() => setPublishOpen(false)} onPublished={onPublished} />
    </div>
  );
}
