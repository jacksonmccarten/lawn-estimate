// Lambda entry point for database migrations. No route reaches it: it is
// invoked by hand after a deploy (`aws lambda invoke`), and is the only
// function that holds the schema owner's login.
//
// It applies the migrations that have not run, one statement at a time over
// the Data API, then lets the two application roles log in with the
// passwords in their own secrets. The migrations create those roles NOLOGIN;
// each environment enables them out of band, and this is that step.
//
// Environment: DB_RESOURCE_ARN, DB_NAME, DB_OWNER_SECRET_ARN,
// DB_RW_SECRET_ARN, DB_PUBLIC_SECRET_ARN, and MIGRATIONS_DIR (the layer the
// .sql files are shipped in).

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DataApiDbClient, literal, migrateStatements } from "@lq/db";
import { log } from "../log.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The roles the Lambdas log in as, and the secret each one's login is kept in. */
const LOGINS = [
  ["app_rw", "DB_RW_SECRET_ARN"],
  ["app_public", "DB_PUBLIC_SECRET_ARN"],
] as const;

export async function handler(): Promise<{ applied: string[]; logins: string[] }> {
  const owner = new DataApiDbClient({
    resourceArn: required("DB_RESOURCE_ARN"),
    secretArn: required("DB_OWNER_SECRET_ARN"),
    database: required("DB_NAME"),
  });
  const applied = await migrateStatements(owner, required("MIGRATIONS_DIR"));
  log("info", "migrated", { applied: applied.length });

  const secrets = new SecretsManagerClient({});
  for (const [role, variable] of LOGINS) {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: required(variable) }));
    const login = JSON.parse(res.SecretString ?? "{}") as { username?: unknown; password?: unknown };
    if (login.username !== role || typeof login.password !== "string" || login.password === "") {
      throw new Error(`the secret in ${variable} is not a login for ${role}`);
    }
    // ALTER ROLE takes no bound parameter; the password is written as a literal.
    const password = login.password;
    await owner.transaction((tx) => tx.query(`ALTER ROLE ${role} LOGIN PASSWORD ${literal(password)}`));
  }
  return { applied, logins: LOGINS.map(([role]) => role) };
}
