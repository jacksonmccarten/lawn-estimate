// A throwaway database built from the migrations, with the real application
// roles, as in packages/db/test/rls.test.ts. The handlers under test reach it
// only through withPublic (as app_public) and withCompany (as app_rw).

import { randomBytes, randomUUID } from "node:crypto";
import {
  createWithCompany,
  createWithPublic,
  createWithSignup,
  pgClientForTests,
  type Claims,
  type WithCompany,
  type WithPublic,
  type WithSignup,
} from "@lq/db";
import pg from "pg";
// Not part of the package's public surface; the suite needs it to build the schema.
import { migrate } from "../../../packages/db/src/migrate.js";
import type { HttpEvent, HttpResult } from "../src/http.js";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://app_owner:app_owner@localhost:54320/lawnquote";
// The same password the RLS suite sets, so the two can share a cluster.
const APP_PASSWORD = "local-test-only";

export type TestCompany = { id: string; slug: string; claims: Claims; versionId: string };

export type TestDb = {
  owner: pg.Client;
  withPublic: WithPublic;
  withCompany: WithCompany;
  signUp: WithSignup;
  /** Runs statements as the owner with app.company_id set (FORCE binds the owner too). */
  asCompany<T>(companyId: string, fn: (q: pg.Client) => Promise<T>): Promise<T>;
  seedCompany(slug: string, options?: { quota?: number; allowedOrigins?: string[] }): Promise<TestCompany>;
  close(): Promise<void>;
};

function urlFor(user: string, password: string, database: string): string {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

export async function createTestDb(): Promise<TestDb> {
  const admin = new URL(ADMIN_URL);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(admin.hostname)) {
    throw new Error(`refusing to run against ${admin.hostname}; this suite creates and drops a database`);
  }
  const dbName = `lq_lambdas_${randomBytes(6).toString("hex")}`;
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const owner = new pg.Client({ connectionString: urlFor(admin.username, admin.password, dbName) });
  await owner.connect();
  await migrate(owner);
  await owner.query(`ALTER ROLE app_rw LOGIN PASSWORD '${APP_PASSWORD}'`);
  await owner.query(`ALTER ROLE app_public LOGIN PASSWORD '${APP_PASSWORD}'`);

  const rwPool = new pg.Pool({ connectionString: urlFor("app_rw", APP_PASSWORD, dbName), max: 4 });
  const anonPool = new pg.Pool({ connectionString: urlFor("app_public", APP_PASSWORD, dbName), max: 4 });

  const asCompany: TestDb["asCompany"] = async (companyId, fn) => {
    await owner.query("BEGIN");
    try {
      await owner.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
      const result = await fn(owner);
      await owner.query("COMMIT");
      return result;
    } catch (err) {
      await owner.query("ROLLBACK");
      throw err;
    }
  };

  return {
    owner,
    withPublic: createWithPublic(pgClientForTests(anonPool)),
    withCompany: createWithCompany(pgClientForTests(rwPool)),
    signUp: createWithSignup(pgClientForTests(rwPool)),
    asCompany,

    // The worked example of design section 8: mowing in State College (16801,
    // Centre County), core region, $45.00 minimum, 0.70 coverage.
    async seedCompany(slug, options = {}) {
      const id = randomUUID();
      const sub = `sub-${slug}`;
      const versionId = await asCompany(id, async (q) => {
        await q.query(
          `INSERT INTO companies (id, slug, name, phone, alert_email, alert_phone, regrid_lookup_quota, allowed_origins)
           VALUES ($1, $2, $3, '814-555-0100', $4, '+18145550100', $5, $6)`,
          [id, slug, `${slug} lawn`, `owner@${slug}.example`, options.quota ?? 100, options.allowedOrigins ?? []],
        );
        await q.query("INSERT INTO company_members (cognito_sub, company_id) VALUES ($1, $2)", [sub, id]);
        await q.query(
          `INSERT INTO service_regions (company_id, kind, value, tier_group) VALUES
             ($1, 'zip', '16801', 'core'), ($1, 'zip', '15085', 'outer'), ($1, 'county', 'Philadelphia', 'outer')`,
          [id],
        );
        const version = await q.query<{ id: string }>(
          "INSERT INTO pricing_versions (company_id, version, min_charge_cents, coverage_factor) VALUES ($1, 1, 4500, 0.70) RETURNING id",
          [id],
        );
        const v = version.rows[0]!.id;
        const service = await q.query<{ id: string }>(
          "INSERT INTO services (version_id, company_id, code, name, taxable) VALUES ($1, $2, 'mow', 'Mowing', true) RETURNING id",
          [v, id],
        );
        const tier = (group: string, min: number, max: number, microcents: number) =>
          q.query(
            `INSERT INTO pricing_tiers (version_id, company_id, service_id, region_group, min_sqft, max_sqft, price_per_sqft_microcents)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [v, id, service.rows[0]!.id, group, min, max, microcents],
          );
        await tier("core", 0, 5000, 900_000);
        await tier("core", 5000, 10_000, 750_000);
        await tier("outer", 0, 60_000, 1_000_000);
        await q.query("UPDATE pricing_versions SET published_at = now() WHERE id = $1", [v]);
        return v;
      });
      return { id, slug, claims: { sub }, versionId };
    },

    async close() {
      await Promise.all([rwPool.end(), anonPool.end(), owner.end()]);
      // A backend can outlive its client's end() for a moment, and the owner
      // may not terminate another role's backend: wait for it instead.
      for (let attempt = 1; ; attempt++) {
        try {
          await root.query(`DROP DATABASE IF EXISTS ${dbName}`);
          break;
        } catch (err) {
          if (attempt === 20) throw err;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      await root.end();
    },
  };
}

/** An API Gateway HTTP API event, as far as the handlers read one. */
export function event(options: {
  routeKey?: string;
  body?: unknown;
  sub?: string;
  groups?: string;
  /** The login's address, as a verified claim; `emailVerified: false` leaves it unverified. */
  email?: string;
  emailVerified?: boolean;
  id?: string;
  company?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  ip?: string;
}): HttpEvent {
  return {
    routeKey: options.routeKey ?? "POST /",
    headers: options.headers ?? {},
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    isBase64Encoded: false,
    pathParameters:
      options.id !== undefined ? { id: options.id } : options.company !== undefined ? { company: options.company } : undefined,
    queryStringParameters: options.query,
    requestContext: {
      http: { sourceIp: options.ip ?? "203.0.113.7" },
      ...(options.sub
        ? {
            authorizer: {
              jwt: {
                claims: {
                  sub: options.sub,
                  ...(options.groups ? { "cognito:groups": options.groups } : {}),
                  ...(options.email ? { email: options.email, email_verified: String(options.emailVerified ?? true) } : {}),
                },
              },
            },
          }
        : {}),
    },
  } as unknown as HttpEvent;
}

export function read<T = any>(result: HttpResult): { status: number; body: T } {
  return { status: result.statusCode ?? 200, body: JSON.parse(result.body ?? "null") as T };
}
