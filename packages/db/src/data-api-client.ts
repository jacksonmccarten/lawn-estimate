import type { DbClient, DbTx, QueryResult } from "./client.js";
import { interpolate, MAX_STATEMENT_CHARS } from "./sql-text.js";

export type DataApiConfig = {
  resourceArn: string;
  /** Secrets Manager ARN for the login to run as (app_rw, app_public, or the owner for migrations). */
  secretArn: string;
  database: string;
};

/** The four Data API calls this client makes, so a test can stand in for the service. */
export type DataApiTransport = {
  begin(): Promise<string>;
  /** `rows` is the Data API's `formattedRecords` (a JSON array of objects), when the statement returns any. */
  execute(transactionId: string, sql: string): Promise<{ rows: string | undefined; updated: number }>;
  commit(transactionId: string): Promise<void>;
  rollback(transactionId: string): Promise<void>;
};

/** A database error with its SQLSTATE in `code`, where node-postgres puts it. */
export class DataApiError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DataApiError";
  }
}

/** How long to keep asking a cluster that is waking from auto-pause. */
const RESUME_WAIT_MS = 25_000;
const RESUME_RETRY_MS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Data API reports a database error's SQLSTATE in the message text. */
function sqlState(err: unknown): string | undefined {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" ? /SQLState:\s*([0-9A-Z]{5})/i.exec(message)?.[1] : undefined;
}

function wrap(err: unknown): DataApiError {
  if (err instanceof DataApiError) return err;
  const message = (err as { message?: unknown } | null)?.message;
  return new DataApiError(typeof message === "string" ? message : "the Data API call failed", sqlState(err), { cause: err });
}

async function sdkTransport(config: DataApiConfig): Promise<DataApiTransport> {
  // Loaded on first use: local runs and tests never need the SDK.
  const sdk = await import("@aws-sdk/client-rds-data");
  // The cluster's own region, from its ARN: the caller's default may be another.
  const client = new sdk.RDSDataClient({ region: config.resourceArn.split(":")[3] || undefined });
  const target = { resourceArn: config.resourceArn, secretArn: config.secretArn };
  return {
    async begin() {
      const res = await client.send(new sdk.BeginTransactionCommand({ ...target, database: config.database }));
      if (!res.transactionId) throw new Error("the Data API returned no transaction id");
      return res.transactionId;
    },
    async execute(transactionId, sql) {
      const res = await client.send(new sdk.ExecuteStatementCommand({ ...target, transactionId, sql, formatRecordsAs: "JSON" }));
      return { rows: res.formattedRecords, updated: res.numberOfRecordsUpdated ?? 0 };
    },
    async commit(transactionId) {
      await client.send(new sdk.CommitTransactionCommand({ ...target, transactionId }));
    },
    async rollback(transactionId) {
      await client.send(new sdk.RollbackTransactionCommand({ ...target, transactionId }));
    },
  };
}

/**
 * DbClient over the RDS Data API, for the Lambdas, which sit outside the VPC.
 *
 * Parameters are written into the statement as untyped literals (see
 * sql-text.ts for why, and for why that is safe), so the SQL the handlers
 * were written and tested against over node-postgres means the same here.
 * Rows come back as the Data API formats them: json and jsonb columns as
 * text, which callers already parse with `fromJson`.
 */
export class DataApiDbClient implements DbClient {
  private transport: Promise<DataApiTransport> | undefined;
  private checked: Promise<void> | undefined;

  constructor(
    readonly config: DataApiConfig,
    transport?: DataApiTransport,
  ) {
    if (transport) this.transport = Promise.resolve(transport);
  }

  private async begin(api: DataApiTransport): Promise<string> {
    const deadline = Date.now() + RESUME_WAIT_MS;
    for (;;) {
      try {
        return await api.begin();
      } catch (err) {
        // A cluster paused at 0 ACU takes some seconds to answer its first call.
        const resuming = (err as { name?: unknown } | null)?.name === "DatabaseResumingException";
        if (!resuming || Date.now() + RESUME_RETRY_MS > deadline) throw wrap(err);
        await sleep(RESUME_RETRY_MS);
      }
    }
  }

  /** Literals are only safe with standard_conforming_strings on; refuse to run otherwise. Once per client. */
  private check(api: DataApiTransport, transactionId: string): Promise<void> {
    this.checked ??= (async () => {
      const res = await api.execute(transactionId, "SELECT current_setting('standard_conforming_strings') AS scs");
      const rows = JSON.parse(res.rows ?? "[]") as { scs?: unknown }[];
      if (rows[0]?.scs !== "on") throw new DataApiError("standard_conforming_strings must be on", undefined);
    })();
    // A failed check is tried again by the next transaction rather than remembered.
    this.checked.catch(() => (this.checked = undefined));
    return this.checked;
  }

  async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    const api = await (this.transport ??= sdkTransport(this.config));
    const transactionId = await this.begin(api);
    const tx: DbTx = {
      async query<R>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
        const text = interpolate(sql, params);
        if (text.length > MAX_STATEMENT_CHARS) throw new DataApiError("the statement is over the Data API's size limit", undefined);
        try {
          const res = await api.execute(transactionId, text);
          const rows = res.rows === undefined ? [] : (JSON.parse(res.rows) as R[]);
          return { rows, rowCount: rows.length > 0 ? rows.length : res.updated };
        } catch (err) {
          throw wrap(err);
        }
      },
    };
    try {
      await this.check(api, transactionId);
      const result = await fn(tx);
      await api.commit(transactionId);
      return result;
    } catch (err) {
      await api.rollback(transactionId).catch(() => {});
      throw err instanceof Error && !(err as { $metadata?: unknown }).$metadata ? err : wrap(err);
    }
  }
}
