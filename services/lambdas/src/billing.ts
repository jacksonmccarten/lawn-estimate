// What a company pays us: the seam a billing provider plugs into. The
// subscriber is the company, named by its slug, which never changes: the
// public routes know the slug before they open a transaction, and the
// dashboard reads it from the company row.
//
// No provider is configured, so the functions run with billing null and the
// database allowance (companies.regrid_lookup_quota) alone decides how many
// estimates a company may price each month. With a provider, the allowance
// still decides for a company with no subscription, and whenever the provider
// cannot be reached: a billing outage never takes the widget down.

/** The event a provider would count: one new estimate priced for a homeowner. */
export const ESTIMATE_PRICED = "estimate_priced";

/**
 * Whether a company may price another estimate.
 * - `allow`: its plan covers it; the database allowance does not apply.
 * - `deny`: its plan's allowance for the month is used up.
 * - `none`: no active subscription, or billing could not answer; the database allowance decides.
 */
export type Entitlement = "allow" | "deny" | "none";

/** The two pages a provider hosts for a company owner: choosing a plan, and managing it. */
export type BillingPage = "plans" | "portal";

export type Billing = {
  entitlement(company: string): Promise<Entitlement>;
  /** Counts one estimate priced. Never throws: the estimate is already stored. */
  estimatePriced(company: string): Promise<void>;
  /** A short-lived link to a hosted billing page, which returns to `returnUrl`. */
  page(company: string, page: BillingPage, returnUrl: string): Promise<string>;
};
