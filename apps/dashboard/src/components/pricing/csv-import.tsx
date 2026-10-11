"use client";

import type { Tier } from "@lq/api-contract";
import { Fragment, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { MAX_CSV_BYTES, MAX_TIERS, TIER_CSV_COLUMNS, TIER_CSV_TEMPLATE, parseTiersCsv, type CsvProblem } from "@/lib/tiers-csv";
import { findOverlaps } from "@/lib/tiers";
import { TableScroll } from "../ui";

type Props = {
  serviceCodes: string[];
  /** The draft's tiers as they stand, when they are all valid; used to check an "add" import against them. */
  existingTiers: Tier[] | null;
  onImport: (tiers: Tier[], mode: "replace" | "append") => void;
};

const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(TIER_CSV_TEMPLATE)}`;

/**
 * CSV import of tiers (§11): a native file input with a label, progress in a
 * live region, and problems as a table of row, column and problem that takes
 * focus. The file goes into the draft on screen; nothing is saved until the
 * owner saves the draft.
 */
export function CsvImport({ serviceCodes, existingTiers, onImport }: Props) {
  const [mode, setMode] = useState<"replace" | "append">("replace");
  const [status, setStatus] = useState("");
  const [problems, setProblems] = useState<{ file: string; list: CsvProblem[] } | null>(null);
  const problemsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (problems) problemsRef.current?.focus();
  }, [problems]);

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setProblems(null);
    setStatus(`Reading ${file.name}…`);

    const fail = (list: CsvProblem[]) => {
      setProblems({ file: file.name, list });
      setStatus(`${file.name} was not imported: ${list.length} ${list.length === 1 ? "problem" : "problems"} to fix. Nothing in the draft changed.`);
    };

    try {
      if (file.size > MAX_CSV_BYTES) {
        fail([{ row: null, column: null, problem: "The file is larger than 1 MB" }]);
        return;
      }
      const result = parseTiersCsv(await file.text(), serviceCodes);
      if (!result.ok) {
        fail(result.problems);
        return;
      }
      if (mode === "append" && existingTiers) {
        const combined = [...existingTiers, ...result.tiers];
        if (combined.length > MAX_TIERS) {
          fail([{ row: null, column: null, problem: `With the tiers already in the draft this makes ${combined.length}; the most a version can hold is ${MAX_TIERS}` }]);
          return;
        }
        // Rows were already checked against each other; these are clashes with tiers in the draft.
        const clashes = findOverlaps(combined).filter(([a, b]) => a < existingTiers.length && b >= existingTiers.length);
        if (clashes.length > 0) {
          fail(
            clashes.map(([a, b]) => ({
              row: b - existingTiers.length + 2,
              column: "min_sqft",
              problem: `This range overlaps tier ${a + 1} already in the draft for the same service and region group`,
            })),
          );
          return;
        }
      }
      onImport(result.tiers, mode);
      const count = `${result.tiers.length} ${result.tiers.length === 1 ? "tier" : "tiers"}`;
      setStatus(
        mode === "replace"
          ? `Imported ${count} from ${file.name}, replacing the tiers in the draft. Save the draft to keep them.`
          : `Added ${count} from ${file.name} to the draft. Save the draft to keep them.`,
      );
    } catch {
      fail([{ row: null, column: null, problem: "The file could not be read" }]);
    } finally {
      // So choosing the same file again, once fixed, is still a change.
      input.value = "";
    }
  }

  return (
    <section className="card" aria-labelledby="csv-heading">
      <h2 id="csv-heading">Import tiers from a CSV file</h2>
      <p className="muted">
        Columns:{" "}
        {TIER_CSV_COLUMNS.map((column, i) => (
          <Fragment key={column}>
            {i > 0 && ", "}
            <code>{column}</code>
          </Fragment>
        ))}
        . Give each
        row either a price per 1,000 sq ft or a flat price, in dollars. A tier covers lawns over <code>min_sqft</code>, up to and including{" "}
        <code>max_sqft</code>.{" "}
        <a className="link" href={TEMPLATE_HREF} download="tier-template.csv">
          Download a template
        </a>
        .
      </p>
      <RadioGroup className="radio-group" value={mode} onChange={(value) => setMode(value as "replace" | "append")}>
        <Label>What should the file do?</Label>
        <Radio className="radio" value="replace">
          Replace all tiers in the draft
        </Radio>
        <Radio className="radio" value="append">
          Add to the tiers in the draft
        </Radio>
      </RadioGroup>
      <div className="field">
        <label htmlFor="csv-file">CSV file of tiers</label>
        <input id="csv-file" className="file-input" type="file" accept=".csv,text/csv" onChange={onFile} aria-describedby="csv-status" />
      </div>
      <p id="csv-status" role="status" aria-live="polite" className="csv-status">
        {status}
      </p>
      {problems && (
        <div ref={problemsRef} tabIndex={-1} className="error-summary" aria-labelledby="csv-problems-heading">
          <h3 id="csv-problems-heading">
            {problems.list.length === 1 ? "1 problem" : `${problems.list.length} problems`} in {problems.file}
          </h3>
          <TableScroll label={`Problems in ${problems.file}`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Column</th>
                  <th scope="col">Problem</th>
                </tr>
              </thead>
              <tbody>
                {problems.list.map((p, i) => (
                  <tr key={i}>
                    <td>{p.row ?? "Whole file"}</td>
                    <td>{p.column ? <code>{p.column}</code> : "—"}</td>
                    <td>{p.problem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </div>
      )}
    </section>
  );
}
