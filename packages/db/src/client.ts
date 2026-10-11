/** A query result, reduced to what both drivers can supply. */
export type QueryResult<R> = { rows: R[]; rowCount: number };

/** A handle that is only valid inside one transaction. */
export interface DbTx {
  /** Positional parameters, written `$1`, `$2`, … in the SQL. */
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

/**
 * The only way application code reaches the database. There is deliberately no
 * query method outside a transaction: `app.company_id` is transaction-scoped,
 * so a statement outside one would run with no company.
 */
export interface DbClient {
  /** Commits if `fn` resolves, rolls back if it throws. */
  transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
}
