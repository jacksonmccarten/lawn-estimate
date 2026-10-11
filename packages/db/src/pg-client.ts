import type { Pool } from "pg";
import type { DbClient, DbTx } from "./client.js";

/** DbClient over node-postgres. Used locally and in tests. */
export class PgDbClient implements DbClient {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    const conn = await this.pool.connect();
    const tx: DbTx = {
      async query<R>(sql: string, params?: readonly unknown[]) {
        const res = await conn.query(sql, params ? [...params] : undefined);
        return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
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
