"use client";

// The questions homeowners answer alongside drawing their lawn. One list per
// company, saved as a whole; not part of a pricing version, since answers
// never change a price. Reordering is by buttons, not dragging (2.5.7).

import { Questionnaire, type Question } from "@lq/api-contract";
import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, FieldError, Label, Text, TextArea, TextField } from "react-aria-components";
import { describeError } from "@/lib/api";
import type { FieldError as FormError } from "@/lib/pricing-form";
import { useLoad } from "@/lib/use-load";
import { useApi } from "./auth-provider";
import { BusyButton, ErrorSummary, LoadError, Loading, SelectField, TextInput, useToast } from "./ui";

type Row = { id: string; text: string; kind: Question["kind"]; options: string; required: boolean };

const KIND_OPTIONS = [
  { id: "yes_no", label: "Yes / No" },
  { id: "choice", label: "Multiple choice" },
];

const fieldId = (id: string, field: "text" | "kind" | "options") => `question-${id}-${field}`;

const toRows = (questions: readonly Question[]): Row[] =>
  questions.map((q) => ({ id: q.id, text: q.text, kind: q.kind, options: q.options.join("\n"), required: q.required }));

const optionsOf = (row: Row) =>
  row.kind === "choice"
    ? row.options
        .split("\n")
        .map((o) => o.trim())
        .filter(Boolean)
    : [];

/** The rows as the contract's questionnaire, or every problem named by its field. */
function fromRows(rows: readonly Row[]): { ok: true; value: Questionnaire } | { ok: false; errors: FormError[] } {
  const errors: FormError[] = [];
  rows.forEach((row, i) => {
    const label = `Question ${i + 1}`;
    const text = row.text.trim();
    if (!text) errors.push({ fieldId: fieldId(row.id, "text"), label, message: "Enter the question" });
    else if (text.length > 200) errors.push({ fieldId: fieldId(row.id, "text"), label, message: "Use 200 characters or fewer" });
    const options = optionsOf(row);
    if (row.kind === "choice") {
      if (options.length < 2) errors.push({ fieldId: fieldId(row.id, "options"), label: `${label}, answers`, message: "Give at least 2 answers, one per line" });
      else if (options.length > 8) errors.push({ fieldId: fieldId(row.id, "options"), label: `${label}, answers`, message: "Give 8 answers at most" });
      else if (options.some((o) => o.length > 80)) errors.push({ fieldId: fieldId(row.id, "options"), label: `${label}, answers`, message: "Keep each answer to 80 characters or fewer" });
      else if (new Set(options.map((o) => o.toLowerCase())).size !== options.length)
        errors.push({ fieldId: fieldId(row.id, "options"), label: `${label}, answers`, message: "Each answer must be different" });
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  const parsed = Questionnaire.safeParse({ questions: rows.map((r) => ({ id: r.id, text: r.text.trim(), kind: r.kind, options: optionsOf(r), required: r.required })) });
  if (!parsed.success) return { ok: false, errors: [{ fieldId: "add-question", label: "Questions", message: parsed.error.issues[0]?.message ?? "Check the questions" }] };
  return { ok: true, value: parsed.data };
}

const MAX_QUESTIONS = 20;

function Editor({ initial, onSaved }: { initial: Questionnaire; onSaved: (q: Questionnaire) => void }) {
  const api = useApi();
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>(() => toRows(initial.questions));
  const [saved, setSaved] = useState<Row[]>(rows);
  const [errors, setErrors] = useState<FormError[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [rowStatus, setRowStatus] = useState("");
  const summaryRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<string | null>(null);

  const dirty = JSON.stringify(rows) !== JSON.stringify(saved);

  useEffect(() => {
    if (focusAfter.current) {
      document.getElementById(focusAfter.current)?.focus();
      focusAfter.current = null;
    }
  }, [rows]);

  const update = (id: string, patch: Partial<Row>) => setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  function move(index: number, by: -1 | 1) {
    const to = index + by;
    if (to < 0 || to >= rows.length) {
      setRowStatus(by < 0 ? `Question ${index + 1} is already first.` : `Question ${index + 1} is already last.`);
      return;
    }
    setRows((current) => {
      const next = [...current];
      [next[index], next[to]] = [next[to]!, next[index]!];
      return next;
    });
    setRowStatus(`Question moved to position ${to + 1} of ${rows.length}.`);
  }

  function remove(index: number) {
    setRows((current) => current.filter((_, i) => i !== index));
    setRowStatus(`Question ${index + 1} removed.`);
    addRef.current?.focus();
  }

  async function save() {
    if (saving) return;
    setSaveError(null);
    setStatus("");
    const result = fromRows(rows);
    if (!result.ok) {
      setErrors(result.errors);
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      const stored = await api.replaceQuestionnaire(result.value);
      const next = toRows(stored.questions);
      setRows(next);
      setSaved(next);
      onSaved(stored);
      setStatus(`Questions saved. Homeowners now see ${stored.questions.length === 0 ? "no questions" : `${stored.questions.length} question${stored.questions.length === 1 ? "" : "s"}`}.`);
      toast("Questions saved.");
    } catch (error) {
      setSaveError(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  const errorAt = (id: string) => errors.find((e) => e.fieldId === id)?.message;

  return (
    <div className="stack">
      <ErrorSummary errors={errors} summaryRef={summaryRef} title={errors.length === 1 ? "1 question needs fixing, so nothing was saved" : `${errors.length} problems to fix, so nothing was saved`} />
      {rows.length === 0 && <p className="muted">No questions. Homeowners go straight from their drawing to their estimate.</p>}
      <ol className="question-list">
        {rows.map((row, index) => {
          const n = index + 1;
          return (
            <li key={row.id} className="question-item">
              <fieldset className="question-fields">
                <legend>Question {n}</legend>
                <TextInput id={fieldId(row.id, "text")} label={`Question ${n}`} hideLabel value={row.text} onChange={(text) => update(row.id, { text })} error={errorAt(fieldId(row.id, "text"))} />
                <div className="field-row">
                  <SelectField
                    id={fieldId(row.id, "kind")}
                    label={`Question ${n} answer type`}
                    value={row.kind}
                    onChange={(kind) => update(row.id, { kind: kind as Row["kind"] })}
                    options={KIND_OPTIONS}
                  />
                  <Checkbox className="checkbox question-required" isSelected={row.required} onChange={(required) => update(row.id, { required })}>
                    <span className="checkbox-box" aria-hidden="true" />
                    Question {n} required
                  </Checkbox>
                </div>
                {row.kind === "choice" && (
                  <TextField
                    id={fieldId(row.id, "options")}
                    className="field"
                    value={row.options}
                    onChange={(options) => update(row.id, { options })}
                    isInvalid={!!errorAt(fieldId(row.id, "options"))}
                    validationBehavior="aria"
                  >
                    <Label>Question {n} answers, one per line</Label>
                    <TextArea className="input textarea" rows={4} />
                    <Text slot="description" className="hint">
                      Between 2 and 8 answers for the homeowner to choose from.
                    </Text>
                    <FieldError className="field-error">{errorAt(fieldId(row.id, "options"))}</FieldError>
                  </TextField>
                )}
              </fieldset>
              <div className="row-actions">
                <Button className="btn quiet" aria-label={`Move question ${n} up`} onPress={() => move(index, -1)}>
                  <span aria-hidden="true">↑</span>
                </Button>
                <Button className="btn quiet" aria-label={`Move question ${n} down`} onPress={() => move(index, 1)}>
                  <span aria-hidden="true">↓</span>
                </Button>
                <Button className="btn quiet" aria-label={`Delete question ${n}`} onPress={() => remove(index)}>
                  Delete
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <p role="status" className="visually-hidden">
        {rowStatus}
      </p>
      <div className="form-actions">
        <Button
          id="add-question"
          ref={addRef}
          className="btn"
          isDisabled={rows.length >= MAX_QUESTIONS}
          onPress={() => {
            const id = crypto.randomUUID();
            focusAfter.current = fieldId(id, "text");
            setRows((current) => [...current, { id, text: "", kind: "yes_no", options: "", required: true }]);
          }}
        >
          Add question
        </Button>
        <BusyButton className="btn primary" onPress={() => void save()} isBusy={saving}>
          Save questions
        </BusyButton>
      </div>
      {rows.length >= MAX_QUESTIONS && <p className="muted">You can ask up to {MAX_QUESTIONS} questions.</p>}
      <p role="status" className="muted">
        {dirty ? "You have unsaved changes to your questions." : status}
      </p>
      {saveError && (
        <p role="alert" className="inline-error">
          {saveError}
        </p>
      )}
    </div>
  );
}

export function QuestionnaireEditor() {
  const api = useApi();
  const { state, reload, set } = useLoad(() => api.getQuestionnaire(), [api]);
  return (
    <section className="card" aria-labelledby="questions-heading">
      <h2 id="questions-heading">Customer questions</h2>
      <p className="muted">
        Homeowners answer these when they request an instant mowing quote, and you see their answers with the lead. Answers don&rsquo;t change the
        price.
      </p>
      {state.status === "loading" && <Loading what="questions" />}
      {state.status === "error" && <LoadError message={state.message} onRetry={reload} />}
      {state.status === "ready" && <Editor initial={state.data} onSaved={set} />}
    </section>
  );
}
