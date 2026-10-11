import type { DbClient, DbTx } from "./client.js";

/**
 * Claims from a Cognito JWT that API Gateway has already verified. Never build
 * this from a request body, a header the caller controls, or a custom attribute.
 */
export type Claims = {
  sub: string;
  /** `cognito:groups` */
  groups?: readonly string[];
};

export class NotAMemberError extends Error {
  constructor() {
    super("this user does not belong to a company");
    this.name = "NotAMemberError";
  }
}

export class NotAdminError extends Error {
  constructor() {
    super("only the admin group may act as another company");
    this.name = "NotAdminError";
  }
}

export type WithCompany = <T>(
  claims: Claims,
  fn: (tx: DbTx, companyId: string) => Promise<T>,
  /** Admin group only: the company to act as. Rejected for anyone else, and always audited. */
  options?: { asCompanyId?: string },
) => Promise<T>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns `withCompany(claims, fn)`: one transaction with `app.company_id` set,
 * so RLS limits every statement in `fn` to one company. The company comes from
 * company_members by the caller's sub. Members of the `admin` group may name a
 * company instead, which writes a row to admin_access_log first. This is the
 * only database entry point.
 */
export function createWithCompany(db: DbClient): WithCompany {
  const setCompany = (tx: DbTx, companyId: string) =>
    tx.query("SELECT set_config('app.company_id', $1, true)", [companyId]);

  return async (claims, fn, options) => {
    const asCompanyId = options?.asCompanyId;
    if (asCompanyId !== undefined) {
      if (!claims.groups?.includes("admin")) throw new NotAdminError();
      if (!UUID.test(asCompanyId)) throw new TypeError("asCompanyId is not a uuid");
      // Committed on its own, before fn runs: the record must survive a
      // rollback of fn, and if it cannot be written fn never starts. The
      // foreign key also rejects a company that does not exist.
      await db.transaction(async (tx) => {
        await setCompany(tx, asCompanyId);
        await tx.query("INSERT INTO admin_access_log (company_id, admin_sub) VALUES ($1, $2)", [asCompanyId, claims.sub]);
      });
      return db.transaction(async (tx) => {
        await setCompany(tx, asCompanyId);
        return fn(tx, asCompanyId);
      });
    }

    return db.transaction(async (tx) => {
      const res = await tx.query<{ company_id: string | null }>("SELECT company_id_for_sub($1) AS company_id", [claims.sub]);
      const companyId = res.rows[0]?.company_id;
      if (!companyId) throw new NotAMemberError();
      await setCompany(tx, companyId);
      return fn(tx, companyId);
    });
  };
}
