import type { Pool } from "pg";
import type { DbClient, DbTx } from "./client.js";
import { PgDbClient } from "./pg-client.js";
import { interpolate } from "./sql-text.js";

/**
 * A row as the Data API returns it, as far as that differs from
 * node-postgres in ways the handlers can meet: json and jsonb columns arrive
 * as text, not parsed, and a timestamp as text, not a Date. An array column
 * is also made text here, so a handler that selects one without `to_jsonb`
 * fails in the suite rather than in AWS.
 */
function asDataApiRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) out[key] = value.toISOString().replace("T", " ").replace("Z", "");
    else if (value !== null && typeof value === "object") out[key] = JSON.stringify(value);
    else out[key] = value;
  }
  return out;
}

/**
 * For tests: sends node-postgres the statement text the Data API client
 * would send, with every parameter written in as a literal and nothing
 * bound, and hands rows back in the Data API's shape. Running a suite
 * through this shows that its SQL means the same over the Data API as it
 * does with bound parameters, and that its code does not lean on
 * node-postgres parsing a column for it.
 */
export class InterpolatingPgClient implements DbClient {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    const conn = await this.pool.connect();
    const tx: DbTx = {
      async query<R>(sql: string, params?: readonly unknown[]) {
        const res = await conn.query(interpolate(sql, params));
        return { rows: (res.rows as Record<string, unknown>[]).map(asDataApiRow) as R[], rowCount: res.rowCount ?? 0 };
      },
    };
    try {
      await conn.query("BEGIN");
      const result = await fn(tx);
      await conn.query("COMMIT");
      return result;
    } catch (err) {
      await conn.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }
}

/**
 * The client a database suite should build: node-postgres with bound
 * parameters, or, when LQ_TEST_DRIVER is "data-api-sql", the same pool sent
 * the Data API's statement text. Each suite runs both ways.
 */
export function pgClientForTests(pool: Pool): DbClient {
  return process.env.LQ_TEST_DRIVER === "data-api-sql" ? new InterpolatingPgClient(pool) : new PgDbClient(pool);
}
