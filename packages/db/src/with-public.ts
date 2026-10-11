import type { DbClient, DbTx } from "./client.js";

/** A company as an anonymous visitor may see it: a row of public_company_profile. */
export type PublicCompany = {
  companyId: string;
  slug: string;
  name: string;
  theme: Record<string, unknown>;
  services: { code: string; name: string; season: string }[];
  regions: { kind: string; value: string }[];
};

export class UnknownCompanyError extends Error {
  constructor() {
    super("no company has this slug");
    this.name = "UnknownCompanyError";
  }
}

export class WrongRoleError extends Error {
  constructor(role: string) {
    super(`withPublic must run as app_public, not ${role}`);
    this.name = "WrongRoleError";
  }
}

export type WithPublic = <T>(
  companySlug: string,
  fn: (tx: DbTx, company: PublicCompany) => Promise<T>,
) => Promise<T>;

// Same shape as the CHECK on companies.slug.
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The three jsonb columns arrive parsed from node-postgres and as text from the Data API.
type ProfileRow = {
  role: string;
  company_id: string | null;
  slug: string;
  name: string;
  theme: unknown;
  services: unknown;
  regions: unknown;
};

const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

/**
 * Returns `withPublic(companySlug, fn)`, the database entry point for the
 * anonymous routes. `db` must be connected as app_public, with credentials of
 * its own: that role has no table privileges, so inside `fn` the only things
 * that work are reading public_company_profile and calling the SECURITY
 * DEFINER functions granted to it. The slug comes from the request and is
 * validated here; `fn` receives the company it names.
 */
export function createWithPublic(db: DbClient): WithPublic {
  return async (companySlug, fn) => {
    if (!SLUG.test(companySlug)) throw new UnknownCompanyError();
    return db.transaction(async (tx) => {
      const res = await tx.query<ProfileRow>(
        `SELECT current_user::text AS role, p.*
         FROM (SELECT 1) AS one
         LEFT JOIN public_company_profile p ON p.slug = $1`,
        [companySlug],
      );
      const row = res.rows[0]!;
      // Guards against being handed the app_rw client by mistake.
      if (row.role !== "app_public") throw new WrongRoleError(row.role);
      if (!row.company_id) throw new UnknownCompanyError();
      return fn(tx, {
        companyId: row.company_id,
        slug: row.slug,
        name: row.name,
        theme: json<PublicCompany["theme"]>(row.theme),
        services: json<PublicCompany["services"]>(row.services),
        regions: json<PublicCompany["regions"]>(row.regions),
      });
    });
  };
}
