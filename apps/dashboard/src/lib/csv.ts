// A small RFC 4180 reader: quoted fields, doubled quotes, commas and line
// breaks inside quotes, CRLF or LF, an optional byte-order mark.

export type CsvResult = { ok: true; rows: string[][] } | { ok: false; line: number; problem: string };

export function parseCsv(input: string): CsvResult {
  const text = input.startsWith("﻿") ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let quoteLine = 1;

  const endRow = () => {
    row.push(field);
    field = "";
    // A blank line is not a record.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
      quoteLine = line;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
    } else field += ch;
  }
  if (quoted) return { ok: false, line: quoteLine, problem: "A quoted value is never closed" };
  if (field !== "" || row.length > 0) endRow();
  return { ok: true, rows };
}
