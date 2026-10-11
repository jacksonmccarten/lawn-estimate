// The wrong-tenant test. It builds a throwaway database from the migrations,
// loads three companies, then connects as the real application roles, through
// the same withCompany() the Lambdas use, and proves that no company can see
// or change another's rows. It must pass before any feature merges.

import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWithCompany,
  createWithPublic,
  NotAdminError,
  NotAMemberError,
  PgDbClient,
  pgClientForTests,
  type DbClient,
  UnknownCompanyError,
  WrongRoleError,
  type Claims,
  type DbTx,
  type WithCompany,
  type WithPublic,
} from "../src/index.js";
import { migrate } from "../src/migrate.js";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://app_owner:app_owner@localhost:54320/lawnquote";
const APP_PASSWORD = "local-test-only";

// Every company-scoped table and the column that names its company.
const SCOPED = [
  ["companies", "id"],
  ["company_members", "company_id"],
  ["service_regions", "company_id"],
  ["pricing_versions", "company_id"],
  ["services", "company_id"],
  ["pricing_tiers", "company_id"],
  ["quotes", "company_id"],
  ["leads", "company_id"],
  ["usage_meters", "company_id"],
  ["admin_access_log", "company_id"],
] as const;
// app_rw may only insert into admin_access_log, so it cannot be counted as app_rw.
const READABLE = SCOPED.filter(([table]) => table !== "admin_access_log");
const GLOBAL = ["parcel_cache", "tax_rates", "service_catalog", "zip_county", "zip_county_parts", "zip_centroid"] as const;

const DENIED = "42501"; // RLS violation or missing privilege
const FK_VIOLATION = "23503";
const IMMUTABLE = "55000"; // raised by the pricing immutability triggers
const ALREADY_DECIDED = "LQ001"; // raised when a decided lead is decided again; the API's 409

type Company = {
  id: string;
  claims: Claims;
  regionId: string;
  publishedVersionId: string;
  publishedServiceId: string;
  publishedTierId: string;
  draftVersionId: string;
  draftServiceId: string;
  draftTierId: string;
  quoteId: string;
  leadId: string;
  openQuoteId: string; // priced, no lead yet
};

const dbName = `lq_test_${randomBytes(6).toString("hex")}`;
let root: pg.Client; // owner, maintenance database
let owner: pg.Client; // owner, test database: migrations and fixtures only
let rwPool: pg.Pool;
let anonPool: pg.Pool;
let rw: DbClient; // logged in as app_rw
let anon: DbClient; // logged in as app_public
let withCompany: WithCompany;
let withPublic: WithPublic;
let a: Company;
let b: Company;
let c: Company; // the only company whose rows a test changes

const adminClaims: Claims = { sub: "sub-staff", groups: ["admin"] };

function urlFor(user: string, password: string, database: string): string {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

async function count(db: DbTx, table: string, where = "true", params: unknown[] = []): Promise<number> {
  const res = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return res.rows[0]!.n;
}

/** Runs one statement as a company and returns the SQLSTATE it failed with, or "ok". */
function sqlState(claims: Claims, sql: string, params: unknown[]): Promise<string | undefined> {
  return withCompany(claims, (tx) => tx.query(sql, params)).then(
    () => "ok",
    (err: { code?: string }) => err.code,
  );
}

/** admin_access_log rows for a company, read as the owner (app_rw cannot). */
async function accessLog(companyId: string): Promise<{ admin_sub: string }[]> {
  await owner.query("BEGIN");
  await owner.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
  const res = await owner.query<{ admin_sub: string }>("SELECT admin_sub FROM admin_access_log ORDER BY at");
  await owner.query("ROLLBACK");
  return res.rows;
}

async function insertId(sql: string, params: unknown[]): Promise<string> {
  const res = await owner.query<{ id: string }>(`${sql} RETURNING id`, params);
  return res.rows[0]!.id;
}

// The owner is bound by FORCE ROW LEVEL SECURITY like everyone else, so the
// fixtures set app.company_id too.
async function seedCompany(slug: string): Promise<Company> {
  const id = randomUUID();
  const sub = `sub-${slug}`;
  await owner.query("BEGIN");
  await owner.query("SELECT set_config('app.company_id', $1, true)", [id]);
  await owner.query(
    "INSERT INTO companies (id, slug, name, hic_no, theme, stripe_customer_id) VALUES ($1, $2, $3, 'PA999999', $4, 'cus_secret')",
    [id, slug, `${slug} lawn`, { color: "#116633" }],
  );
  await owner.query("INSERT INTO company_members (cognito_sub, company_id) VALUES ($1, $2)", [sub, id]);
  const regionId = await insertId(
    "INSERT INTO service_regions (company_id, kind, value, tier_group) VALUES ($1, 'zip', '16801', 'tiergroup-core')",
    [id],
  );

  const version = async (n: number) => {
    const versionId = await insertId(
      "INSERT INTO pricing_versions (company_id, version, min_charge_cents) VALUES ($1, $2, 4512)",
      [id, n],
    );
    const serviceId = await insertId(
      "INSERT INTO services (version_id, company_id, code, name, taxable) VALUES ($1, $2, 'mow', $3, true)",
      [versionId, id, `Mowing v${n}`],
    );
    const tierId = await insertId(
      `INSERT INTO pricing_tiers (version_id, company_id, service_id, region_group, min_sqft, max_sqft, price_per_sqft_microcents)
       VALUES ($1, $2, $3, 'tiergroup-core', 5000, 10000, 754321)`,
      [versionId, id, serviceId],
    );
    return { versionId, serviceId, tierId };
  };
  const published = await version(1);
  await owner.query("UPDATE pricing_versions SET published_at = now() WHERE id = $1", [published.versionId]);
  const draft = await version(2);

  const quote = () =>
    insertId(
      `INSERT INTO quotes (company_id, version_id, address_text, county, region_group, grass_sqft, origin,
                           line_items, tax_rate, tax_cents, total_cents, regrid_parcel_id)
       VALUES ($1, $2, '1 Test St', 'Centre', 'tiergroup-core', 6400, 'regrid', $3, 0.06, 288, 5088, 'parcel-1')`,
      [id, published.versionId, JSON.stringify([{ code: "mow", amount_cents: 4800, taxable: true }])],
    );
  const quoteId = await quote();
  const openQuoteId = await quote();
  const leadId = await insertId(
    "INSERT INTO leads (quote_id, company_id, name, email) VALUES ($1, $2, 'Pat', 'pat@example.com')",
    [quoteId, id],
  );
  await owner.query("INSERT INTO usage_meters (company_id, month, regrid_lookups, quotes) VALUES ($1, '2026-10-01', 1, 1)", [
    id,
  ]);
  await owner.query("COMMIT");

  return {
    id,
    claims: { sub },
    regionId,
    publishedVersionId: published.versionId,
    publishedServiceId: published.serviceId,
    publishedTierId: published.tierId,
    draftVersionId: draft.versionId,
    draftServiceId: draft.serviceId,
    draftTierId: draft.tierId,
    quoteId,
    leadId,
    openQuoteId,
  };
}

beforeAll(async () => {
  // This suite creates and drops a database and resets role passwords.
  const admin = new URL(ADMIN_URL);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(admin.hostname) && process.env.RLS_TEST_ALLOW_REMOTE !== "1") {
    throw new Error(`refusing to run the RLS suite against ${admin.hostname}; it is meant for a local or CI database`);
  }

  root = await connect(ADMIN_URL);
  await root.query(`CREATE DATABASE ${dbName}`);
  owner = await connect(urlFor(admin.username, admin.password, dbName));
  await migrate(owner);
  await owner.query(`ALTER ROLE app_rw LOGIN PASSWORD '${APP_PASSWORD}'`);
  await owner.query(`ALTER ROLE app_public LOGIN PASSWORD '${APP_PASSWORD}'`);

  a = await seedCompany("alpha");
  b = await seedCompany("bravo");
  c = await seedCompany("charlie");

  // One connection each, so "the next transaction on the same connection" is literal.
  rwPool = new pg.Pool({ connectionString: urlFor("app_rw", APP_PASSWORD, dbName), max: 1 });
  anonPool = new pg.Pool({ connectionString: urlFor("app_public", APP_PASSWORD, dbName), max: 1 });
  rw = pgClientForTests(rwPool);
  anon = pgClientForTests(anonPool);
  withCompany = createWithCompany(rw);
  withPublic = createWithPublic(anon);
}, 60_000);

afterAll(async () => {
  await Promise.all([rwPool?.end(), anonPool?.end(), owner?.end()]);
  await root?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await root?.end();
});

describe("catalog", () => {
  it("forces RLS on every table that has a company_id column, and on companies", async () => {
    const res = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
         AND (c.relname = 'companies' OR EXISTS (
           SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped))
       ORDER BY c.relname`,
    );
    // A new company-scoped table that is missing from SCOPED fails here.
    expect(res.rows.map((r) => r.relname)).toEqual(SCOPED.map(([t]) => t).sort());
    for (const row of res.rows) {
      expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("gives no role a way around RLS, the owner included", async () => {
    const roles = await owner.query(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
       WHERE rolname IN ('app_rw', 'app_public', 'app_definer', current_user) ORDER BY rolname`,
    );
    expect(roles.rows).toHaveLength(4);
    for (const role of roles.rows) {
      expect(role, role.rolname).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }
    const owned = await owner.query(
      `SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
       WHERE c.relkind IN ('r', 'p') AND r.rolname IN ('app_rw', 'app_public', 'app_definer')`,
    );
    expect(owned.rows).toEqual([]);
  });

  it("binds the table owner too (FORCE)", async () => {
    for (const [table] of SCOPED) {
      const res = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(res.rows[0]!.n, table).toBe(0);
    }
  });

  it("has no foreign key into parcel_cache, so it can be truncated under live quotes", async () => {
    const fks = await owner.query(
      "SELECT conname FROM pg_constraint WHERE contype = 'f' AND confrelid = 'parcel_cache'::regclass",
    );
    expect(fks.rows).toEqual([]);

    await owner.query("INSERT INTO parcel_cache (address_norm, regrid_id) VALUES ('1 test st', 'parcel-1')");
    await owner.query("TRUNCATE parcel_cache");
    expect(await withCompany(a.claims, (tx) => count(tx, "quotes", "regrid_parcel_id = 'parcel-1'"))).toBe(2);
  });
});

describe("withCompany", () => {
  it("resolves the company from the caller's sub", async () => {
    expect(await withCompany(a.claims, async (_tx, companyId) => companyId)).toBe(a.id);
    expect(await withCompany(b.claims, async (_tx, companyId) => companyId)).toBe(b.id);
  });

  it("refuses a sub that belongs to no company, before running anything", async () => {
    let ran = false;
    await expect(
      withCompany({ sub: "sub-nobody" }, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);
    expect(ran).toBe(false);
  });

  it("lets the admin group act as a named company, and records it", async () => {
    const before = (await accessLog(b.id)).length;
    await withCompany(
      adminClaims,
      async (tx, companyId) => {
        expect(companyId).toBe(b.id);
        expect(await count(tx, "leads")).toBe(1);
        expect(await count(tx, "leads", "company_id <> $1", [b.id])).toBe(0);
      },
      { asCompanyId: b.id },
    );
    const log = await accessLog(b.id);
    expect(log).toHaveLength(before + 1);
    expect(log.at(-1)).toEqual({ admin_sub: adminClaims.sub });
    expect(await accessLog(a.id)).toEqual([]);
  });

  it("keeps the audit row when the admin's callback throws", async () => {
    const before = (await accessLog(c.id)).length;
    await expect(
      withCompany(
        adminClaims,
        async () => {
          throw new Error("boom");
        },
        { asCompanyId: c.id },
      ),
    ).rejects.toThrow("boom");
    expect(await accessLog(c.id)).toHaveLength(before + 1);
  });

  it("refuses a non-admin who passes asCompanyId, runs nothing and records nothing", async () => {
    // Refused even for their own company, never silently given their own rows.
    const attempts: [Claims, string][] = [
      [a.claims, b.id],
      [{ sub: a.claims.sub, groups: ["owner"] }, b.id],
      [{ sub: a.claims.sub, groups: [] }, a.id],
      [{ sub: "sub-nobody", groups: ["administrators"] }, b.id],
    ];
    const before = [(await accessLog(a.id)).length, (await accessLog(b.id)).length];
    for (const [claims, target] of attempts) {
      let ran = false;
      await expect(
        withCompany(
          claims,
          async () => {
            ran = true;
          },
          { asCompanyId: target },
        ),
      ).rejects.toBeInstanceOf(NotAdminError);
      expect(ran).toBe(false);
    }
    expect([(await accessLog(a.id)).length, (await accessLog(b.id)).length]).toEqual(before);
  });

  it("refuses an admin naming a company that does not exist, before running anything", async () => {
    let ran = false;
    const run = withCompany(
      adminClaims,
      async () => {
        ran = true;
      },
      { asCompanyId: randomUUID() },
    );
    await expect(run).rejects.toMatchObject({ code: FK_VIOLATION });
    expect(ran).toBe(false);
  });

  it("writes no audit row for an ordinary member", async () => {
    const before = (await accessLog(a.id)).length;
    await withCompany(a.claims, (tx) => count(tx, "leads"));
    expect(await accessLog(a.id)).toHaveLength(before);
  });

  it("gives app_rw insert-only access to the audit log", async () => {
    for (const sql of [
      "SELECT 1 FROM admin_access_log",
      "UPDATE admin_access_log SET admin_sub = 'x'",
      "DELETE FROM admin_access_log",
      "TRUNCATE admin_access_log",
    ]) {
      expect(await sqlState(b.claims, sql, []), sql).toBe(DENIED);
    }
    // And a company cannot plant a row in another company's log.
    expect(
      await sqlState(b.claims, "INSERT INTO admin_access_log (company_id, admin_sub) VALUES ($1, 'forged')", [a.id]),
    ).toBe(DENIED);
  });

  it("resolves membership through a function that takes only the sub", async () => {
    const res = await owner.query(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args, p.provolatile, p.prosecdef,
              p.prorettype::regtype::text AS returns, r.rolname AS owner, p.proconfig
       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.proname = 'company_id_for_sub'`,
    );
    // Exactly one overload: no variant that accepts a company_id can exist beside it.
    expect(res.rows).toEqual([
      {
        args: "p_sub text",
        provolatile: "s", // STABLE
        prosecdef: true,
        returns: "uuid",
        owner: "app_definer",
        proconfig: ["search_path=pg_catalog, public"],
      },
    ]);
  });

  it("rolls back when the callback throws and commits when it returns", async () => {
    await expect(
      withCompany(c.claims, async (tx) => {
        await tx.query("UPDATE companies SET name = 'changed' WHERE id = $1", [c.id]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withCompany(c.claims, (tx) => count(tx, "companies", "name = 'changed'"))).toBe(0);

    await withCompany(c.claims, (tx) => tx.query("UPDATE companies SET name = 'charlie lawn co' WHERE id = $1", [c.id]));
    expect(await withCompany(c.claims, (tx) => count(tx, "companies", "name = 'charlie lawn co'"))).toBe(1);
  });

  it("does not carry the company into the next transaction on the same connection", async () => {
    expect(await withCompany(a.claims, (tx) => count(tx, "leads"))).toBe(1);
    // The setting now reads back as '' rather than NULL; that must mean no rows, not an error.
    await rw.transaction(async (tx) => {
      expect(await count(tx, "leads")).toBe(0);
      expect(await count(tx, "companies")).toBe(0);
    });
  });

});

describe("app_rw tenant isolation", () => {
  const expected: Record<string, number> = { pricing_versions: 2, services: 2, pricing_tiers: 2, quotes: 2 };

  it("sees its own company's rows", async () => {
    await withCompany(a.claims, async (tx) => {
      for (const [table, col] of READABLE) {
        expect(await count(tx, table), table).toBe(expected[table] ?? 1);
        expect(await count(tx, table, `${col} <> $1`, [a.id]), table).toBe(0);
      }
    });
  });

  it("sees zero rows of another company with the wrong app.company_id", async () => {
    await withCompany(b.claims, async (tx) => {
      for (const [table, col] of READABLE) {
        expect(await count(tx, table, `${col} = $1`, [a.id]), table).toBe(0);
      }
      expect(await count(tx, "quotes", "id = $1", [a.quoteId])).toBe(0);
      expect(await count(tx, "leads", "id = $1", [a.leadId])).toBe(0);
      expect(await count(tx, "pricing_tiers", "id = $1", [a.publishedTierId])).toBe(0);
    });
  });

  it("sees zero rows when code skips withCompany, or sets a company that does not exist", async () => {
    await rw.transaction(async (tx) => {
      for (const [table] of READABLE) expect(await count(tx, table), table).toBe(0);
    });
    await rw.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.company_id', $1, true)", [randomUUID()]);
      for (const [table] of READABLE) expect(await count(tx, table), table).toBe(0);
    });
  });

  it("cannot update or delete another company's rows", async () => {
    await withCompany(b.claims, async (tx) => {
      const writes: [string, unknown[]][] = [
        ["UPDATE companies SET name = 'x' WHERE id = $1", [a.id]],
        ["UPDATE quotes SET status = 'expired' WHERE id = $1", [a.quoteId]],
        ["UPDATE leads SET decision = 'declined' WHERE id = $1", [a.leadId]],
        ["UPDATE usage_meters SET quotes = 0 WHERE company_id = $1", [a.id]],
        ["UPDATE pricing_versions SET min_charge_cents = 0 WHERE id = $1", [a.draftVersionId]],
        ["UPDATE pricing_versions SET min_charge_cents = 0 WHERE id = $1", [a.publishedVersionId]],
        ["UPDATE pricing_tiers SET max_sqft = 99999 WHERE id = $1", [a.draftTierId]],
        ["DELETE FROM services WHERE id = $1", [a.draftServiceId]],
        ["DELETE FROM service_regions WHERE id = $1", [a.regionId]],
        ["DELETE FROM company_members WHERE cognito_sub = $1", [a.claims.sub]],
      ];
      for (const [sql, params] of writes) {
        expect((await tx.query(sql, params)).rowCount, sql).toBe(0);
      }
    });
    // And nothing of alpha's moved.
    await withCompany(a.claims, async (tx) => {
      expect(await count(tx, "companies", "name = 'alpha lawn'")).toBe(1);
      expect(await count(tx, "service_regions")).toBe(1);
      expect(await count(tx, "services")).toBe(2);
    });
  });

  it("cannot insert a row for another company", async () => {
    const inserts: [string, unknown[]][] = [
      ["INSERT INTO company_members (cognito_sub, company_id) VALUES ('intruder', $1)", [a.id]],
      ["INSERT INTO service_regions (company_id, kind, value, tier_group) VALUES ($1, 'zip', '19103', 'core')", [a.id]],
      ["INSERT INTO pricing_versions (company_id, version) VALUES ($1, 99)", [a.id]],
      ["INSERT INTO leads (quote_id, company_id, name, email) VALUES ($1, $2, 'x', 'x@example.com')", [a.openQuoteId, a.id]],
      ["INSERT INTO usage_meters (company_id, month) VALUES ($1, '2026-11-01')", [a.id]],
      ["UPDATE quotes SET company_id = $1 WHERE id = $2", [a.id, b.quoteId]],
    ];
    for (const [sql, params] of inserts) {
      expect(await sqlState(b.claims, sql, params), sql).toBe(DENIED);
    }
  });

  it("cannot attach its own row to another company's parent", async () => {
    // company_id passes the tenant check; the draft check or the composite foreign key rejects the parent.
    const inserts: [string, unknown[]][] = [
      ["INSERT INTO leads (quote_id, company_id, name, email) VALUES ($1, $2, 'x', 'x@example.com')", [a.openQuoteId, b.id]],
      ["INSERT INTO services (version_id, company_id, code, name, taxable) VALUES ($1, $2, 'x', 'x', true)", [a.draftVersionId, b.id]],
      [
        `INSERT INTO pricing_tiers (version_id, company_id, service_id, region_group, min_sqft, max_sqft, flat_price_cents)
         VALUES ($1, $2, $3, 'core', 0, 1000, 4500)`,
        [b.draftVersionId, b.id, a.draftServiceId],
      ],
    ];
    for (const [sql, params] of inserts) {
      expect([DENIED, FK_VIOLATION], sql).toContain(await sqlState(b.claims, sql, params));
    }
  });

  it("cannot switch RLS off, change the policies' function, or become the definer role", async () => {
    for (const sql of [
      "ALTER TABLE leads DISABLE ROW LEVEL SECURITY",
      "DROP POLICY leads_company ON leads",
      "CREATE OR REPLACE FUNCTION current_company_id() RETURNS uuid LANGUAGE sql RETURN NULL::uuid",
      "SET ROLE app_definer",
    ]) {
      await expect(rw.transaction((tx) => tx.query(sql)), sql).rejects.toMatchObject({ code: DENIED });
    }
  });
});

describe("published pricing versions are immutable", () => {
  const tierInsert = `INSERT INTO pricing_tiers (version_id, company_id, service_id, region_group, min_sqft, max_sqft, flat_price_cents)
                      VALUES ($1, $2, $3, 'tiergroup-core', 0, 5000, 4500)`;

  it("raises on every change to a published version, its services and its tiers", async () => {
    const writes: [string, unknown[]][] = [
      ["UPDATE pricing_versions SET min_charge_cents = 1 WHERE id = $1", [a.publishedVersionId]],
      ["UPDATE pricing_versions SET published_at = NULL WHERE id = $1", [a.publishedVersionId]],
      ["UPDATE pricing_versions SET published_at = now() WHERE id = $1", [a.publishedVersionId]],
      ["UPDATE services SET taxable = false WHERE id = $1", [a.publishedServiceId]],
      ["DELETE FROM services WHERE id = $1", [a.publishedServiceId]],
      ["INSERT INTO services (version_id, company_id, code, name, taxable) VALUES ($1, $2, 'edge', 'Edging', true)", [a.publishedVersionId, a.id]],
      ["UPDATE pricing_tiers SET price_per_sqft_microcents = 1 WHERE id = $1", [a.publishedTierId]],
      ["DELETE FROM pricing_tiers WHERE id = $1", [a.publishedTierId]],
      [tierInsert, [a.publishedVersionId, a.id, a.publishedServiceId]],
      // Moving a draft row into a published version is a change to that version too.
      ["UPDATE services SET version_id = $1 WHERE id = $2", [a.publishedVersionId, a.draftServiceId]],
    ];
    for (const [sql, params] of writes) {
      expect(await sqlState(a.claims, sql, params), sql).toBe(IMMUTABLE);
    }
  });

  it("holds for the table owner as well", async () => {
    await owner.query("BEGIN");
    await owner.query("SELECT set_config('app.company_id', $1, true)", [a.id]);
    await expect(
      owner.query("UPDATE pricing_versions SET min_charge_cents = 1 WHERE id = $1", [a.publishedVersionId]),
    ).rejects.toMatchObject({ code: IMMUTABLE });
    await owner.query("ROLLBACK");
  });

  it("cannot insert a version that is already published", async () => {
    expect(
      await sqlState(a.claims, "INSERT INTO pricing_versions (company_id, version, published_at) VALUES ($1, 3, now())", [a.id]),
    ).toBe(DENIED);
  });

  it("lets a draft be edited and published, after which it is immutable", async () => {
    await withCompany(c.claims, async (tx) => {
      expect((await tx.query("UPDATE pricing_tiers SET max_sqft = 12000 WHERE id = $1", [c.draftTierId])).rowCount).toBe(1);
      expect((await tx.query(tierInsert, [c.draftVersionId, c.id, c.draftServiceId])).rowCount).toBe(1);
      expect((await tx.query("UPDATE pricing_versions SET published_at = now() WHERE id = $1", [c.draftVersionId])).rowCount).toBe(1);
    });
    expect(await sqlState(c.claims, "UPDATE pricing_tiers SET max_sqft = 13000 WHERE id = $1", [c.draftTierId])).toBe(IMMUTABLE);
    expect(await sqlState(c.claims, "UPDATE pricing_versions SET min_charge_cents = 1 WHERE id = $1", [c.draftVersionId])).toBe(IMMUTABLE);
  });
});

describe("a lead is decided once (409 lead_already_decided)", () => {
  const decide = (claims: Claims, leadId: string, decision: string, adjusted: number | null = null) =>
    sqlState(claims, "UPDATE leads SET decision = $2, adjusted_total_cents = $3 WHERE id = $1", [leadId, decision, adjusted]);
  const lead = (claims: Claims) =>
    withCompany(claims, async (tx) => (await tx.query("SELECT decision, adjusted_total_cents, notified_at FROM leads")).rows[0]!);

  it("accepts the first decision and refuses every later one, leaving the lead unchanged", async () => {
    expect(await decide(c.claims, c.leadId, "accepted", 5500)).toBe("ok");
    for (const [decision, adjusted] of [
      ["declined", null],
      ["accepted", null],
      ["accepted", 6000],
    ] as const) {
      expect(await decide(c.claims, c.leadId, decision, adjusted), `${decision} ${adjusted}`).toBe(ALREADY_DECIDED);
    }
    expect(await sqlState(c.claims, "UPDATE leads SET decision = NULL WHERE id = $1", [c.leadId])).toBe(ALREADY_DECIDED);
    expect(await lead(c.claims)).toMatchObject({ decision: "accepted", adjusted_total_cents: 5500 });
  });

  it("still lets a decided lead be marked as notified", async () => {
    expect(await sqlState(c.claims, "UPDATE leads SET notified_at = now() WHERE id = $1", [c.leadId])).toBe("ok");
    expect((await lead(c.claims)).notified_at).not.toBeNull();
  });

  it("lets only one of two simultaneous decisions through", async () => {
    // Two connections, so the second UPDATE really waits on the first's row lock.
    const pool = new pg.Pool({ connectionString: urlFor("app_rw", APP_PASSWORD, dbName), max: 2 });
    const twoAtOnce = createWithCompany(new PgDbClient(pool));
    const attempt = (decision: string) =>
      twoAtOnce(b.claims, async (tx) => {
        await tx.query("UPDATE leads SET decision = $2 WHERE id = $1", [b.leadId, decision]);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }).then(
        () => "ok",
        (err: { code?: string }) => err.code,
      );
    const results = await Promise.all([attempt("accepted"), attempt("declined")]);
    await pool.end();
    expect(results.sort()).toEqual([ALREADY_DECIDED, "ok"].sort());
  });

  it("holds for the table owner, and keeps an adjusted total off a declined lead", async () => {
    await owner.query("BEGIN");
    await owner.query("SELECT set_config('app.company_id', $1, true)", [c.id]);
    await expect(owner.query("UPDATE leads SET decision = 'declined' WHERE id = $1", [c.leadId])).rejects.toMatchObject({
      code: ALREADY_DECIDED,
    });
    await owner.query("ROLLBACK");
    expect(await decide(a.claims, a.leadId, "declined", 5500)).toBe("23514");
    expect(await lead(a.claims)).toMatchObject({ decision: null, adjusted_total_cents: null });
  });
});

describe("withPublic", () => {
  it("hands the callback the company its slug names", async () => {
    const company = await withPublic("alpha", async (_tx, c) => c);
    expect(company).toEqual({
      companyId: a.id,
      slug: "alpha",
      name: "alpha lawn",
      theme: { color: "#116633" },
      services: [{ code: "mow", name: "Mowing v1", season: "growing" }],
      regions: [{ kind: "zip", value: "16801" }],
    });
  });

  it("refuses an unknown or malformed slug before running anything", async () => {
    for (const slug of ["nobody", "", "Alpha", "alpha lawn", "alpha'; DROP TABLE leads; --", a.id.toUpperCase()]) {
      let ran = false;
      await expect(
        withPublic(slug, async () => {
          ran = true;
        }),
        slug,
      ).rejects.toBeInstanceOf(UnknownCompanyError);
      expect(ran, slug).toBe(false);
    }
  });

  it("refuses to run on a connection that is not app_public", async () => {
    let ran = false;
    await expect(
      createWithPublic(rw)("alpha", async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(WrongRoleError);
    expect(ran).toBe(false);
  });

  it("gives the callback no way to read or write a table", async () => {
    for (const table of [...SCOPED.map(([t]) => t), ...GLOBAL]) {
      for (const sql of [`SELECT 1 FROM ${table}`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
        await expect(withPublic("alpha", (tx) => tx.query(sql)), sql).rejects.toMatchObject({ code: DENIED });
      }
    }
    // Setting a company does not help: the role has no table privileges for RLS to widen.
    await expect(
      withPublic("alpha", async (tx, company) => {
        await tx.query("SELECT set_config('app.company_id', $1, true)", [company.companyId]);
        return tx.query("SELECT 1 FROM leads");
      }),
    ).rejects.toMatchObject({ code: DENIED });
  });
});

describe("app_public", () => {
  // Rows as node-postgres shapes them, whichever driver ran the query: the
  // Data API's returns json and array columns as text.
  const parsed = <R>(row: R): R =>
    Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" && /^[[{]/.test(v) ? JSON.parse(v) : v]),
    ) as R;
  const anonQuery = <R>(sql: string, params?: unknown[]) =>
    anon.transaction(async (tx) => {
      const res = await tx.query<R>(sql, params);
      return { ...res, rows: res.rows.map(parsed) };
    });

  it("has no table grants: not on a table, not on a column, not through a role", async () => {
    const tables = await owner.query<{ relname: string; any_table: boolean; any_column: boolean }>(
      `SELECT c.relname,
              has_table_privilege('app_public', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS any_table,
              has_any_column_privilege('app_public', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES') AS any_column
       FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
       ORDER BY c.relname`,
    );
    // Every table in the schema, the migration bookkeeping included.
    expect(tables.rows.map((r) => r.relname)).toEqual(
      [...SCOPED.map(([t]) => t), ...GLOBAL, "schema_migrations"].sort(),
    );
    for (const row of tables.rows) {
      expect(row, row.relname).toMatchObject({ any_table: false, any_column: false });
    }

    // Its one relation privilege is SELECT on the view.
    const relations = await owner.query(
      `SELECT c.relname, c.relkind::text
       FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
         AND (has_table_privilege('app_public', c.oid, 'SELECT')
              OR has_any_column_privilege('app_public', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))`,
    );
    expect(relations.rows).toEqual([{ relname: "public_company_profile", relkind: "v" }]);
    const viewWrites = await owner.query<{ can: boolean }>(
      "SELECT has_table_privilege('app_public', 'public_company_profile', 'INSERT, UPDATE, DELETE, TRUNCATE') AS can",
    );
    expect(viewWrites.rows[0]!.can).toBe(false);

    const memberships = await owner.query(
      "SELECT roleid::regrole::text FROM pg_auth_members WHERE member = 'app_public'::regrole",
    );
    expect(memberships.rows).toEqual([]);
  });

  it("can execute only SECURITY DEFINER functions owned by app_definer", async () => {
    // Our own functions; the btree_gist extension's operators are excluded.
    const res = await owner.query<{ name: string; prosecdef: boolean; owner: string }>(
      `SELECT p.proname AS name, p.prosecdef, p.proowner::regrole::text AS owner
       FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
         AND has_function_privilege('app_public', p.oid, 'EXECUTE')`,
    );
    for (const fn of res.rows) {
      expect(fn, fn.name).toMatchObject({ prosecdef: true, owner: "app_definer" });
    }
    // The zip lookups (step 2.5), the estimate and submit functions (step 4)
    // and the allowed origins of the public profile; helpers are not on the list.
    expect(res.rows.map((fn) => fn.name).sort()).toEqual([
      "company_allowed_origins",
      "counties_for_zip",
      "county_for_zip",
      "estimate_apply_adjustment",
      "estimate_context",
      "estimate_insert_quote",
      "estimate_pricing_input",
      "estimate_quote_for_adjust",
      "lead_mark_notified",
      "parcel_cache_put",
      "regrid_reserve_lookup",
      "submit_lead",
    ]);

    for (const sql of [
      "SELECT current_company_id()",
      "SELECT company_id_for_sub('sub-alpha')",
      "SELECT usage_month()",
      "SELECT origin_allowed(NULL, NULL)",
      "SELECT pricing_slice(NULL, NULL, NULL)",
      // Signing up is for a signed-in login, through app_rw.
      "SELECT create_company_for_sub('sub-x', 'X', NULL)",
    ]) {
      await expect(anonQuery(sql), sql).rejects.toMatchObject({ code: DENIED });
    }
  });

  it("reads a company's allowed origins by slug, and nothing for an unknown slug", async () => {
    const res = await anonQuery<{ known: string[] | null; unknown: string[] | null }>(
      "SELECT company_allowed_origins('alpha') AS known, company_allowed_origins('nobody') AS unknown",
    );
    expect(res.rows[0]).toEqual({ known: [], unknown: null });
  });

  it("reads the public profile of every company", async () => {
    const res = await anonQuery<{ slug: string; services: unknown; regions: unknown }>(
      "SELECT * FROM public_company_profile ORDER BY slug",
    );
    expect(res.rows.map((r) => r.slug)).toEqual(["alpha", "bravo", "charlie"]);
    // Services come from the published version only; alpha's draft is not public.
    expect(res.rows[0]!.services).toEqual([{ code: "mow", name: "Mowing v1", season: "growing" }]);
    expect(res.rows[0]!.regions).toEqual([{ kind: "zip", value: "16801" }]);
  });

  it("never returns a pricing column, by name or by value", async () => {
    const res = await anonQuery<Record<string, unknown>>("SELECT * FROM public_company_profile");

    // Every key at every depth is on the allowlist.
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          walk(v);
        }
      }
    };
    walk(res.rows);
    expect([...keys].sort()).toEqual(
      ["code", "color", "company_id", "kind", "name", "regions", "season", "services", "slug", "theme", "value"].sort(),
    );

    // The fixtures use distinctive values for everything that must stay private.
    // Without the ids: a random uuid can happen to contain one of these digit runs.
    const text = JSON.stringify(res.rows.map(({ company_id: _id, ...rest }) => rest));
    for (const secret of ["754321", "4512", "tiergroup-core", "taxable", "0.7", "PA999999", "cus_secret"]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("is built from an allowlist of columns and never touches pricing_tiers", async () => {
    // What the view reads, including joins and filters. Adding a column to the view fails here.
    const res = await owner.query<{ col: string }>(
      `SELECT table_name || '.' || column_name AS col
       FROM information_schema.view_column_usage
       WHERE view_schema = 'public' AND view_name = 'public_company_profile'
       ORDER BY 1`,
    );
    expect(res.rows.map((r) => r.col)).toEqual([
      "companies.id",
      "companies.name",
      "companies.slug",
      "companies.theme",
      "pricing_versions.company_id",
      "pricing_versions.id",
      "pricing_versions.published_at",
      "pricing_versions.version",
      "service_regions.company_id",
      "service_regions.kind",
      "service_regions.value",
      "services.code",
      "services.name",
      "services.season",
      "services.version_id",
    ]);
  });

  it("is denied every table and the membership lookup", async () => {
    for (const table of [...SCOPED.map(([t]) => t), ...GLOBAL]) {
      await expect(anonQuery(`SELECT 1 FROM ${table}`), table).rejects.toMatchObject({ code: DENIED });
    }
    await expect(anonQuery("SELECT company_id_for_sub($1)", [a.claims.sub])).rejects.toMatchObject({ code: DENIED });
  });
});

describe("zip to county", () => {
  const countyForZip = (zip: unknown) =>
    withPublic("alpha", async (tx) => (await tx.query<{ county: string | null }>("SELECT county_for_zip($1) AS county", [zip])).rows[0]!.county);

  it.each([
    ["16801", "Centre"],
    ["15213", "Allegheny"],
    ["19103", "Philadelphia"],
    ["17101", "Dauphin"],
    ["16365", "Warren"],
  ])("resolves %s to %s County for app_public", async (zip, county) => {
    expect(await countyForZip(zip)).toBe(county);
  });

  it.each([["00000"], ["10001"], ["1680"], ["168011"], ["16801-1234"], [" 16801"], [""], [null], ["16801' OR '1'='1"]])(
    "returns null for %j, never a guess",
    async (zip) => {
      expect(await countyForZip(zip)).toBeNull();
    },
  );

  type Candidate = { county: string; is_primary: boolean; tax_rate_bps: number | null };
  const countiesForZip = (zip: unknown) =>
    withPublic("alpha", async (tx) => (await tx.query<Candidate>("SELECT * FROM counties_for_zip($1)", [zip])).rows);

  it("lists every candidate county of a zip with its rate, primary first", async () => {
    expect(await countiesForZip("16801")).toEqual([{ county: "Centre", is_primary: true, tax_rate_bps: 600 }]);
    // Straddles Allegheny (7%) and Westmoreland (6%).
    expect(await countiesForZip("15085")).toEqual([
      { county: "Westmoreland", is_primary: true, tax_rate_bps: 600 },
      { county: "Allegheny", is_primary: false, tax_rate_bps: 700 },
    ]);
    // Straddles Philadelphia (8%) and Montgomery (6%).
    const northwest = await countiesForZip("19128");
    expect(northwest.map((c) => [c.county, c.tax_rate_bps]).sort()).toEqual([["Montgomery", 600], ["Philadelphia", 800]]);
    // Two counties, one rate: nothing for the homeowner to choose.
    const sameRate = await countiesForZip("15012");
    expect(sameRate.length).toBeGreaterThan(1);
    expect(new Set(sameRate.map((c) => c.tax_rate_bps))).toEqual(new Set([600]));
  });

  it("agrees with county_for_zip on the primary county, for every zip", async () => {
    expect(await withCompany(a.claims, (tx) => count(tx, "zip_county_parts"))).toBe(2245);
    const res = await withCompany(a.claims, (tx) =>
      tx.query<{ zips: number; with_primary: number; mixed: number }>(
        `SELECT count(*)::int AS zips,
                count(*) FILTER (WHERE has_primary)::int AS with_primary,
                count(*) FILTER (WHERE rates > 1)::int AS mixed
         FROM (SELECT z.zip, bool_or(p.county = z.county) AS has_primary, count(DISTINCT t.rate) AS rates
               FROM zip_county z
               LEFT JOIN zip_county_parts p ON p.zip = z.zip
               LEFT JOIN tax_rates t ON t.state = p.state AND t.county = p.county
               GROUP BY z.zip) per_zip`,
      ),
    );
    // 30 Pennsylvania zips are where county_required can come back.
    expect(res.rows[0]).toEqual({ zips: 1833, with_primary: 1833, mixed: 30 });
  });

  it("returns no candidates for an unknown or malformed zip", async () => {
    for (const zip of ["00000", "1508", "15085-1234", "", null, "15085' OR '1'='1"]) {
      expect(await countiesForZip(zip), String(zip)).toEqual([]);
    }
  });

  it("is one function that takes only the zip", async () => {
    const res = await owner.query(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args, p.provolatile, p.prosecdef,
              p.prorettype::regtype::text AS returns, p.proowner::regrole::text AS owner, p.proconfig
       FROM pg_proc p WHERE p.proname = 'county_for_zip'`,
    );
    expect(res.rows).toEqual([
      { args: "p_zip text", provolatile: "s", prosecdef: true, returns: "text", owner: "app_definer", proconfig: ["search_path=pg_catalog, public"] },
    ]);
  });

  it("has one row per zip, and every county it names has a tax rate", async () => {
    const stats = await owner.query<{ zips: number; counties: number; malformed: number }>(
      `SELECT count(*)::int AS zips, count(DISTINCT county)::int AS counties,
              count(*) FILTER (WHERE zip !~ '^[0-9]{5}$' OR state <> 'PA')::int AS malformed
       FROM zip_county`,
    );
    expect(stats.rows[0]).toEqual({ zips: 1833, counties: 67, malformed: 0 });
    // A zip that resolves to a county with no rate would price at nothing.
    const orphans = await owner.query(
      `SELECT DISTINCT z.county FROM zip_county z
       WHERE NOT EXISTS (SELECT 1 FROM tax_rates t WHERE t.state = z.state AND t.county = z.county)`,
    );
    expect(orphans.rows).toEqual([]);
    const unreachable = await owner.query(
      `SELECT t.county FROM tax_rates t
       WHERE t.state = 'PA' AND NOT EXISTS (SELECT 1 FROM zip_county z WHERE z.state = t.state AND z.county = t.county)`,
    );
    expect(unreachable.rows).toEqual([]);
  });

  it("has one candidates function, taking only the zip", async () => {
    const res = await owner.query(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args, p.provolatile, p.prosecdef,
              p.proowner::regrole::text AS owner, p.proconfig
       FROM pg_proc p WHERE p.proname = 'counties_for_zip'`,
    );
    expect(res.rows).toEqual([
      { args: "p_zip text", provolatile: "s", prosecdef: true, owner: "app_definer", proconfig: ["search_path=pg_catalog, public"] },
    ]);
    await expect(withPublic("alpha", (tx) => tx.query("SELECT 1 FROM zip_county_parts"))).rejects.toMatchObject({ code: DENIED });
    await expect(withPublic("alpha", (tx) => tx.query("SELECT 1 FROM tax_rates"))).rejects.toMatchObject({ code: DENIED });
  });

  it("is readable by app_rw as a table, and only through the function by app_public", async () => {
    expect(await withCompany(a.claims, (tx) => count(tx, "zip_county", "zip = '16801'"))).toBe(1);
    expect(await sqlState(a.claims, "UPDATE zip_county SET county = 'Allegheny' WHERE zip = '16801'", [])).toBe(DENIED);
    await expect(withPublic("alpha", (tx) => tx.query("SELECT 1 FROM zip_county"))).rejects.toMatchObject({ code: DENIED });
  });
});

describe("Pennsylvania seeds", () => {
  it("has a tax rate for all 67 counties: 6%, Allegheny 7%, Philadelphia 8%", async () => {
    const res = await owner.query<{ county: string; rate: string }>("SELECT county, rate FROM tax_rates WHERE state = 'PA'");
    expect(res.rows).toHaveLength(67);
    const other = res.rows.filter((r) => !["Allegheny", "Philadelphia"].includes(r.county));
    expect(new Set(other.map((r) => Number(r.rate)))).toEqual(new Set([0.06]));
    expect(Number(res.rows.find((r) => r.county === "Allegheny")!.rate)).toBe(0.07);
    expect(Number(res.rows.find((r) => r.county === "Philadelphia")!.rate)).toBe(0.08);
  });

  it("flags services per 61 Pa. Code § 55.6 and leaves snow out", async () => {
    const res = await owner.query<{ code: string; taxable: boolean }>("SELECT code, taxable FROM service_catalog WHERE state = 'PA'");
    const flags = Object.fromEntries(res.rows.map((r) => [r.code, r.taxable]));
    expect(flags).toMatchObject({
      mow: true,
      fertilize: true,
      aerate: true,
      lawn_treatment: true,
      shrub_trim_with_lawn: true,
      shrub_trim: false,
      new_lawn: false,
      tree_work: false,
      landscape_design: false,
      bed_maintenance: false,
      leaf_raking: false,
    });
    expect(Object.keys(flags).filter((code) => code.includes("snow"))).toEqual([]);
  });
});
