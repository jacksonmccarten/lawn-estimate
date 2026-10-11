import type { DbClient } from "./client.js";

/**
 * Claims from a Cognito JWT that API Gateway has already verified, for a
 * login that has no company yet. As with `Claims`, never build this from
 * anything the caller controls.
 */
export type SignupClaims = {
  sub: string;
  /** The login's verified address; lead alerts start out going here. */
  email: string | null;
};

export type WithSignup = (claims: SignupClaims, company: { name: string }) => Promise<string>;

/**
 * Returns `signUp(claims, company)`, the third database entry point, beside
 * withCompany and withPublic: it makes the caller's own company, once, and
 * returns its id. A login with no company cannot use withCompany (there is
 * no company to scope the transaction to), so this runs one statement and
 * nothing else: a SECURITY DEFINER function that creates the company, the
 * membership and a starting service area. A login that already has a company
 * gets a unique violation (SQLSTATE 23505). `db` must be connected as app_rw.
 */
export function createWithSignup(db: DbClient): WithSignup {
  return (claims, company) =>
    db.transaction(async (tx) => {
      const res = await tx.query<{ id: string }>("SELECT create_company_for_sub($1, $2, $3) AS id", [claims.sub, company.name, claims.email]);
      return res.rows[0]!.id;
    });
}
