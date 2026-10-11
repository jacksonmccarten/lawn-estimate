// SQL as text, for the RDS Data API, which differs from node-postgres in two
// ways that matter here:
//
// 1. Its bind parameters are typed (a string arrives as varchar, a number as
//    bigint), so Postgres no longer infers a parameter's type from where it
//    is used, and `id = $1` fails for a uuid column. A quoted literal is
//    untyped, exactly as a node-postgres parameter is, so `interpolate`
//    writes each parameter into the statement as one. Every statement then
//    means the same over either driver, with no cast to remember.
// 2. It runs one statement per call, of at most 65,536 characters, so a
//    migration file is split into its statements and a long multi-row INSERT
//    into several.
//
// Writing values into SQL is only safe if nothing in a value can end the
// literal. With standard_conforming_strings on (the default since PostgreSQL
// 9.1; the Data API client checks it before its first statement and refuses
// to run otherwise) a single quote is the only character that can, and it is
// doubled.

/** The Data API's limit on one statement, with room to spare. */
export const MAX_STATEMENT_CHARS = 60_000;

type Segment = { code: boolean; text: string };

/**
 * A statement cut into code and everything a `$1` or a `;` must be ignored
 * in: string literals, quoted identifiers, dollar-quoted bodies, comments.
 */
function segments(sql: string): Segment[] {
  const out: Segment[] = [];
  let code = "";
  let i = 0;
  const flush = () => {
    if (code) out.push({ code: true, text: code });
    code = "";
  };
  const quoted = (end: number) => {
    flush();
    out.push({ code: false, text: sql.slice(i, end) });
    i = end;
  };

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      quoted(end === -1 ? sql.length : end);
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated comment in SQL");
      quoted(end + 2);
    } else if (ch === "'" || ch === '"') {
      // E'...' strings take backslash escapes; plain ones do not.
      const escapes = ch === "'" && /[eE]$/.test(code) && !/[A-Za-z0-9_][eE]$/.test(code);
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error("unterminated quote in SQL");
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      quoted(j + 1);
    } else if (ch === "$") {
      // $$ or $tag$ opens a dollar-quoted body; $1 is a parameter and stays code.
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) throw new Error("unterminated dollar quote in SQL");
        quoted(end + tag[0].length);
      } else {
        code += ch;
        i++;
      }
    } else {
      code += ch;
      i++;
    }
  }
  flush();
  return out;
}

function quote(text: string): string {
  if (text.includes("\0")) throw new Error("a SQL value may not contain a NUL character");
  return `'${text.replace(/'/g, "''")}'`;
}

/** An element of a Postgres array literal, as node-postgres writes one. */
function arrayElement(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (Array.isArray(value)) return `{${value.map(arrayElement).join(",")}}`;
  return `"${plain(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A value as the text node-postgres would send for it. */
function plain(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    case "number":
      if (!Number.isFinite(value)) throw new Error("a SQL value must be a finite number");
      return String(value);
    case "object":
      if (value instanceof Date) return value.toISOString();
      if (Array.isArray(value)) return `{${value.map(arrayElement).join(",")}}`;
      if (value instanceof Uint8Array) throw new Error("binary SQL values are not supported");
      return JSON.stringify(value);
    default:
      throw new Error(`a ${typeof value} cannot be a SQL value`);
  }
}

/**
 * A value as an untyped SQL literal: Postgres gives it the type its place in
 * the statement calls for, as it does for a node-postgres parameter. Arrays
 * become array literals and other objects JSON, also as node-postgres does.
 */
export function literal(value: unknown): string {
  return value === null || value === undefined ? "NULL" : quote(plain(value));
}

/** The statement with each `$n` replaced by the literal of `params[n - 1]`. */
export function interpolate(sql: string, params: readonly unknown[] = []): string {
  return segments(sql)
    .map((segment) =>
      segment.code
        ? segment.text.replace(/\$(\d+)/g, (_, digits: string) => {
            const index = Number(digits);
            if (index < 1 || index > params.length) throw new Error(`the statement uses $${index} but has ${params.length} parameters`);
            return literal(params[index - 1]);
          })
        : segment.text,
    )
    .join("");
}

/** Splits code segments at a character found outside quotes, comments and parentheses. */
function splitTopLevel(parts: Segment[], separator: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (const part of parts) {
    if (!part.code) {
      current += part.text;
      continue;
    }
    for (const ch of part.text) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === separator && depth === 0) {
        out.push(current);
        current = "";
      } else current += ch;
    }
  }
  out.push(current);
  return out;
}

const hasCode = (statement: string) => segments(statement).some((s) => s.code && s.text.trim() !== "");

/**
 * One multi-row INSERT as several, each under the limit. Only the plain
 * shape is taken apart: `INSERT INTO t (...) VALUES (...), (...)`.
 */
function splitInsert(statement: string): string[] {
  const parts = segments(statement);
  const text = parts.map((p) => (p.code ? p.text : " ".repeat(p.text.length))).join("");
  const values = /\bVALUES\b/i.exec(text);
  if (!values || !/^\s*INSERT\s+INTO\b/i.test(text)) {
    throw new Error(`a statement of ${statement.length} characters is over the Data API's limit and is not a plain INSERT`);
  }
  const head = statement.slice(0, values.index + values[0].length);
  const rows = splitTopLevel(segments(statement.slice(head.length)), ",").map((row) => row.trim());
  if (rows.some((row) => !row.startsWith("(") || !row.endsWith(")"))) {
    throw new Error("a long INSERT may hold only parenthesized rows after VALUES");
  }
  const out: string[] = [];
  let batch: string[] = [];
  let size = head.length;
  for (const row of rows) {
    if (batch.length > 0 && size + row.length + 2 > MAX_STATEMENT_CHARS) {
      out.push(`${head} ${batch.join(", ")}`);
      batch = [];
      size = head.length;
    }
    batch.push(row);
    size += row.length + 2;
  }
  out.push(`${head} ${batch.join(", ")}`);
  return out;
}

/**
 * A migration file as the statements to run, in order, each small enough for
 * the Data API. Comments between statements are dropped; a function body in
 * dollar quotes stays whole.
 */
export function splitStatements(sql: string): string[] {
  const parts = segments(sql);
  // A SQL-standard function body has semicolons of its own, which this splitter does not follow.
  if (parts.some((p) => p.code && /\bBEGIN\s+ATOMIC\b/i.test(p.text))) throw new Error("BEGIN ATOMIC bodies are not supported; use RETURN or a dollar-quoted body");
  return splitTopLevel(parts, ";")
    .map((statement) => statement.trim())
    .filter(hasCode)
    .flatMap((statement) => (statement.length > MAX_STATEMENT_CHARS ? splitInsert(statement) : [statement]));
}
