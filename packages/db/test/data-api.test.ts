// The Data API path without the Data API: the client against a fake
// transport, and the statement-by-statement migration runner against a real
// database, compared with the schema the ordinary runner builds.

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataApiDbClient, DataApiError, type DataApiTransport } from "../src/data-api-client.js";
import { InterpolatingPgClient } from "../src/interpolating-pg-client.js";
import { migrateStatements } from "../src/migrate-statements.js";
import { migrate } from "../src/migrate.js";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://app_owner:app_owner@localhost:54320/lawnquote";
const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const config = { resourceArn: "arn:cluster", secretArn: "arn:secret", database: "lawnquote" };

/** A transport that records what it is asked and answers from a script. */
function fake(answer: (sql: string) => { rows?: unknown[]; updated?: number } | Error = () => ({})) {
  const calls: string[] = [];
  let beginFailures: Error[] = [];
  const transport: DataApiTransport = {
    async begin() {
      const failure = beginFailures.shift();
      if (failure) throw failure;
      calls.push("BEGIN");
      return "tx-1";
    },
    async execute(_id, sql) {
      calls.push(sql);
      if (sql.includes("standard_conforming_strings")) return { rows: JSON.stringify([{ scs: "on" }]), updated: 0 };
      const result = answer(sql);
      if (result instanceof Error) throw result;
      return { rows: result.rows === undefined ? undefined : JSON.stringify(result.rows), updated: result.updated ?? 0 };
    },
    async commit() {
      calls.push("COMMIT");
    },
    async rollback() {
      calls.push("ROLLBACK");
    },
  };
  return { calls, transport, failBegin: (...errors: Error[]) => (beginFailures = errors) };
}

describe("DataApiDbClient", () => {
  it("runs a transaction, with parameters written in as literals", async () => {
    const { calls, transport } = fake(() => ({ rows: [{ id: "q1", line_items: '[{"a":1}]' }] }));
    const db = new DataApiDbClient(config, transport);
    const result = await db.transaction(async (tx) => {
      const res = await tx.query<{ id: string; line_items: string }>("SELECT * FROM quotes WHERE id = $1 AND name = $2", ["q1", "O'Brien"]);
      return res;
    });
    // jsonb arrives as text; callers parse it.
    expect(result).toEqual({ rows: [{ id: "q1", line_items: '[{"a":1}]' }], rowCount: 1 });
    expect(calls).toEqual([
      "BEGIN",
      "SELECT current_setting('standard_conforming_strings') AS scs",
      "SELECT * FROM quotes WHERE id = 'q1' AND name = 'O''Brien'",
      "COMMIT",
    ]);
  });

  it("checks standard_conforming_strings once per client, and refuses to run with it off", async () => {
    const { calls, transport } = fake();
    const db = new DataApiDbClient(config, transport);
    await db.transaction((tx) => tx.query("SELECT 1"));
    await db.transaction((tx) => tx.query("SELECT 2"));
    expect(calls.filter((c) => c.includes("standard_conforming_strings"))).toHaveLength(1);

    const off: DataApiTransport = { ...transport, execute: async () => ({ rows: JSON.stringify([{ scs: "off" }]), updated: 0 }) };
    await expect(new DataApiDbClient(config, off).transaction((tx) => tx.query("SELECT 1"))).rejects.toThrow(/standard_conforming_strings/);
  });

  it("reports the rows a write changed when it returns none", async () => {
    const { transport } = fake(() => ({ updated: 3 }));
    const res = await new DataApiDbClient(config, transport).transaction((tx) => tx.query("UPDATE quotes SET status = 'expired'"));
    expect(res).toEqual({ rows: [], rowCount: 3 });
  });

  it("rolls back and rethrows what the callback throws, unchanged", async () => {
    const { calls, transport } = fake();
    class Refused extends Error {}
    const thrown = new Refused("no");
    await expect(
      new DataApiDbClient(config, transport).transaction(async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(calls.at(-1)).toBe("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("puts a database error's SQLSTATE in `code`, where the handlers look for it", async () => {
    const { calls, transport } = fake(() => Object.assign(new Error('ERROR: duplicate key value violates unique constraint "x"; SQLState: 23505'), { name: "DatabaseErrorException" }));
    const failure = await new DataApiDbClient(config, transport).transaction((tx) => tx.query("INSERT INTO t VALUES (1)")).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DataApiError);
    expect(failure).toMatchObject({ code: "23505", name: "DataApiError" });
    expect(calls.at(-1)).toBe("ROLLBACK");

    const custom = fake(() => new Error("ERROR: this lead already has a decision; SQLState: LQ001"));
    await expect(new DataApiDbClient(config, custom.transport).transaction((tx) => tx.query("UPDATE leads SET x = 1"))).rejects.toMatchObject({ code: "LQ001" });
  });

  it("waits for a cluster that is waking from auto-pause", async () => {
    const { calls, transport, failBegin } = fake();
    failBegin(Object.assign(new Error("resuming"), { name: "DatabaseResumingException" }));
    await new DataApiDbClient(config, transport).transaction((tx) => tx.query("SELECT 1"));
    expect(calls[0]).toBe("BEGIN");

    failBegin(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    await expect(new DataApiDbClient(config, transport).transaction((tx) => tx.query("SELECT 1"))).rejects.toBeInstanceOf(DataApiError);
  }, 15_000);

  it("refuses a statement over the Data API's size limit before sending it", async () => {
    const { transport } = fake();
    await expect(new DataApiDbClient(config, transport).transaction((tx) => tx.query("SELECT $1", ["x".repeat(70_000)]))).rejects.toThrow(/size limit/);
  });
});

describe("migrateStatements", () => {
  const admin = new URL(ADMIN_URL);
  const names = [`lq_split_${randomBytes(6).toString("hex")}`, `lq_whole_${randomBytes(6).toString("hex")}`];
  let root: pg.Client;
  const urlFor = (database: string) => Object.assign(new URL(ADMIN_URL), { pathname: `/${database}` }).toString();

  // Everything the migrations create, as text that must be the same however they were run.
  const FINGERPRINT = `
    SELECT 'table ' || c.relname || ' ' || c.relrowsecurity || c.relforcerowsecurity || ' ' || c.relowner::regrole AS item
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v')
    UNION ALL SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || COALESCE(column_default, '')
      FROM information_schema.columns WHERE table_schema = 'public'
    UNION ALL SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace
    UNION ALL SELECT 'function ' || p.proname || ' ' || p.prosecdef || ' ' || p.proowner::regrole || ' ' || md5(pg_get_functiondef(p.oid))
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    UNION ALL SELECT 'policy ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' ' || COALESCE(qual, '') || ' ' || COALESCE(with_check, '')
      FROM pg_policies WHERE schemaname = 'public'
    UNION ALL SELECT 'grant ' || table_name || ' ' || grantee || ' ' || privilege_type FROM information_schema.table_privileges WHERE table_schema = 'public'
    UNION ALL SELECT 'colgrant ' || table_name || '.' || column_name || ' ' || grantee || ' ' || privilege_type FROM information_schema.column_privileges WHERE table_schema = 'public'
    UNION ALL SELECT 'rows tax_rates ' || count(*) || ' ' || md5(string_agg(t::text, ',' ORDER BY t::text)) FROM tax_rates t
    UNION ALL SELECT 'rows zip_county ' || count(*) || ' ' || md5(string_agg(t::text, ',' ORDER BY t::text)) FROM zip_county t
    UNION ALL SELECT 'rows zip_county_parts ' || count(*) || ' ' || md5(string_agg(t::text, ',' ORDER BY t::text)) FROM zip_county_parts t
    UNION ALL SELECT 'rows service_catalog ' || count(*) || ' ' || md5(string_agg(t::text, ',' ORDER BY t::text)) FROM service_catalog t
    ORDER BY 1`;

  beforeAll(async () => {
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(admin.hostname)) throw new Error("this suite creates and drops databases; local only");
    root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    for (const name of names) await root.query(`CREATE DATABASE ${name}`);
  }, 60_000);

  afterAll(async () => {
    for (const name of names) await root?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await root?.end();
  });

  it("builds the same schema and seed data as the ordinary runner, one statement at a time", async () => {
    const [split, whole] = names as [string, string];

    const pool = new pg.Pool({ connectionString: urlFor(split), max: 1 });
    const applied = await migrateStatements(new InterpolatingPgClient(pool), MIGRATIONS);
    // A second run finds nothing to do.
    expect(await migrateStatements(new InterpolatingPgClient(pool), MIGRATIONS)).toEqual([]);

    const client = new pg.Client({ connectionString: urlFor(whole) });
    await client.connect();
    expect(applied).toEqual(await migrate(client));

    const fingerprint = async (q: { query: (sql: string) => Promise<{ rows: { item: string }[] }> }) => (await q.query(FINGERPRINT)).rows.map((r) => r.item);
    const [a, b] = [await fingerprint(pool), await fingerprint(client)];
    expect(a.length).toBeGreaterThan(200);
    expect(a).toEqual(b);

    await pool.end();
    await client.end();
  }, 120_000);
});
