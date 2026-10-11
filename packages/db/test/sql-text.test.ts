import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interpolate, literal, MAX_STATEMENT_CHARS, splitStatements } from "../src/sql-text.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

describe("literal", () => {
  it("writes each kind of value as node-postgres would send it, in quotes", () => {
    expect(literal("Centre")).toBe("'Centre'");
    expect(literal(600)).toBe("'600'");
    expect(literal(0.07)).toBe("'0.07'");
    expect(literal(12n)).toBe("'12'");
    expect(literal(true)).toBe("'true'");
    expect(literal(false)).toBe("'false'");
    expect(literal(null)).toBe("NULL");
    expect(literal(undefined)).toBe("NULL");
    expect(literal(new Date("2026-10-10T12:00:00.000Z"))).toBe("'2026-10-10T12:00:00.000Z'");
    expect(literal({ color: "#116633" })).toBe(`'{"color":"#116633"}'`);
  });

  it("doubles a single quote, the only character that can end the literal", () => {
    expect(literal("O'Brien")).toBe("'O''Brien'");
    expect(literal("'; DROP TABLE leads; --")).toBe("'''; DROP TABLE leads; --'");
    expect(literal("''")).toBe("''''''");
    // Backslashes and dollar signs mean nothing in a standard string.
    expect(literal("a\\'b")).toBe("'a\\''b'");
    expect(literal("$1 $$ $tag$")).toBe("'$1 $$ $tag$'");
    expect(literal(`{"note":"it's"}`)).toBe(`'{"note":"it''s"}'`);
  });

  it("writes arrays as array literals, with their own escaping inside the SQL one", () => {
    expect(literal([])).toBe("'{}'");
    expect(literal(["https://a.example", "https://b.example"])).toBe(`'{"https://a.example","https://b.example"}'`);
    expect(literal(['say "hi"', "back\\slash", "it's", null])).toBe(`'{"say \\"hi\\"","back\\\\slash","it''s",NULL}'`);
    expect(literal([[1, 2], [3]])).toBe(`'{{"1","2"},{"3"}}'`);
  });

  it("refuses what cannot be a literal", () => {
    expect(() => literal("a\0b")).toThrow(/NUL/);
    expect(() => literal(Number.NaN)).toThrow(/finite/);
    expect(() => literal(Symbol("x"))).toThrow();
    expect(() => literal(new Uint8Array([1]))).toThrow(/binary/);
  });
});

describe("interpolate", () => {
  it("replaces each parameter, any number of times, in any order", () => {
    expect(interpolate("SELECT $2, $1, $2", ["a", 1])).toBe("SELECT '1', 'a', '1'");
    expect(interpolate("SELECT $10", [0, 1, 2, 3, 4, 5, 6, 7, 8, "ten"])).toBe("SELECT 'ten'");
    expect(interpolate("SELECT 1")).toBe("SELECT 1");
  });

  it("leaves a $n alone inside a string, an identifier, a dollar-quoted body or a comment", () => {
    const sql = `SELECT '$1', "$1", $1 -- $1\n, $fn$ $1 $fn$, $$ $1 $$ /* $1 */ , E'\\'$1'`;
    expect(interpolate(sql, ["x"])).toBe(sql.replace(', $1 --', ", 'x' --"));
  });

  it("is not fooled by a value that looks like SQL or like a parameter", () => {
    expect(interpolate("SELECT $1, $2", ["$2", "' OR 1=1"])).toBe("SELECT '$2', ''' OR 1=1'");
  });

  it("refuses a parameter the statement was not given", () => {
    expect(() => interpolate("SELECT $2", ["only one"])).toThrow(/\$2/);
    expect(() => interpolate("SELECT $0", ["x"])).toThrow();
  });
});

describe("splitStatements", () => {
  it("splits at semicolons outside quotes, bodies and comments, and drops comments between statements", () => {
    const sql = `-- header; not a statement
CREATE TABLE a (x text DEFAULT ';');
/* block; comment */
CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1; PERFORM 2;
END
$$;
DO $do$ BEGIN RAISE NOTICE 'a;b'; END $do$;

`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^-- header; not a statement\nCREATE TABLE a/);
    expect(statements[1]).toContain("PERFORM 1; PERFORM 2;");
    expect(statements[2]).toMatch(/^DO \$do\$/);
  });

  it("cuts a long multi-row INSERT into several under the limit, losing no row", () => {
    const rows = Array.from({ length: 4000 }, (_, i) => `('${String(i).padStart(5, "0")}', 'PA', 'O''Hara, (County)')`);
    const sql = `INSERT INTO zip_county (zip, state, county) VALUES\n  ${rows.join(",\n  ")};`;
    const statements = splitStatements(sql);
    expect(statements.length).toBeGreaterThan(1);
    for (const statement of statements) {
      expect(statement.length).toBeLessThanOrEqual(MAX_STATEMENT_CHARS);
      expect(statement).toMatch(/^INSERT INTO zip_county \(zip, state, county\) VALUES \('/);
    }
    expect(statements.join("\n").match(/'PA'/g)).toHaveLength(4000);
  });

  it("refuses what it cannot split safely", () => {
    expect(() => splitStatements(`SELECT '${"x".repeat(MAX_STATEMENT_CHARS)}'`)).toThrow(/not a plain INSERT/);
    expect(() => splitStatements("CREATE FUNCTION f() RETURNS int BEGIN ATOMIC SELECT 1; END;")).toThrow(/BEGIN ATOMIC/);
    expect(() => splitStatements("SELECT 'unterminated")).toThrow(/unterminated/);
  });

  it("handles every migration in the repository", async () => {
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const statements = splitStatements(await readFile(MIGRATIONS + file, "utf8"));
      expect(statements.length, file).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement.length, file).toBeLessThanOrEqual(MAX_STATEMENT_CHARS);
        // No statement uses a bound parameter, so running one needs none.
        expect(() => interpolate(statement), file).not.toThrow();
      }
    }
  });
});
