import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DbClient } from "./client.js";
import { splitStatements } from "./sql-text.js";

/**
 * `migrate` for a driver that runs one statement at a time (the Data API):
 * applies every migration in `dir` that has not run yet, in filename order,
 * each file's statements in one transaction. Returns the names it applied.
 * `db` must be connected as the schema's owner.
 */
export async function migrateStatements(db: DbClient, dir: string): Promise<string[]> {
  const done = await db.transaction(async (tx) => {
    await tx.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const res = await tx.query<{ name: string }>("SELECT name FROM schema_migrations");
    return new Set(res.rows.map((r) => r.name));
  });
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const statements = splitStatements(await readFile(join(dir, file), "utf8"));
    try {
      await db.transaction(async (tx) => {
        for (const statement of statements) await tx.query(statement);
        await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      });
    } catch (err) {
      throw new Error(`migration ${file} failed`, { cause: err });
    }
    applied.push(file);
  }
  return applied;
}
