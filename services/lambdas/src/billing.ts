// What a company pays us, through AWS Monetization (private beta). The
// subscriber is the company, named by its slug, which never changes: the
// public routes know the slug before they open a transaction, and the
// dashboard reads it from the company row.
//
// The plans live in AWS Monetization: a free Trial of 50 estimates a month and
// a $100 Standard plan with no practical limit. One meter, estimate_priced,
// counts every new estimate a homeowner is priced.
//
// The database allowance (companies.regrid_lookup_quota) stays the rule for a
// company with no subscription, and whenever AWS Monetization cannot be
// reached: a billing outage never takes the widget down.
//
// Environment:
//   MONETIZATION_APP_ID    the app's ARN; ending in /sandbox, the test copy
//                          where checkout takes test cards. Unset: no billing.
//   MONETIZATION_ENDPOINT  the AWS Monetization endpoint (the SDK's default
//                          when unset).

import type { MonetizationAI } from "@aws-app-monetization/sdk";
import type { Log } from "./log.js";

/** The meter's event type, as created in AWS Monetization. */
export const ESTIMATE_PRICED = "estimate_priced";

/**
 * Whether a company may price another estimate.
 * - `allow`: its plan covers it; the database allowance does not apply.
 * - `deny`: its plan's allowance for the month is used up.
 * - `none`: no active subscription, or billing could not answer; the database allowance decides.
 */
export type Entitlement = "allow" | "deny" | "none";

/** The two pages AWS Monetization hosts for a company owner. */
export type BillingPage = "plans" | "portal";

export type Billing = {
  entitlement(company: string): Promise<Entitlement>;
  /** Counts one estimate priced. Never throws: the estimate is already stored. */
  estimatePriced(company: string): Promise<void>;
  /** A short-lived link to a hosted billing page, which returns to `returnUrl`. */
  page(company: string, page: BillingPage, returnUrl: string): Promise<string>;
};

/** The part of the SDK billing uses, so tests can stand in for it. */
export type MonetizationClient = Pick<
  MonetizationAI,
  "checkEntitlement" | "putEvent" | "createPricingSession" | "createBillingPortalSession"
>;

/** Reasons a company without a working subscription is denied; the database allowance decides for them. */
const UNSUBSCRIBED = new Set(["NO_SUBSCRIPTION", "SUBSCRIPTION_INACTIVE"]);

/** An hour: the page is opened right after the link is made. */
const SESSION_SECONDS = 60 * 60;

export function createBilling(client: MonetizationClient, log: Log): Billing {
  return {
    async entitlement(company) {
      try {
        const result = await client.checkEntitlement(company, { eventType: ESTIMATE_PRICED });
        if (result.decision === "ALLOW") return "allow";
        if (UNSUBSCRIBED.has(result.reason?.code ?? "")) return "none";
        return "deny";
      } catch (err) {
        log("warn", "billing_unavailable", { op: "entitlement", company, error: (err as Error).name });
        return "none";
      }
    },

    async estimatePriced(company) {
      try {
        await client.putEvent(company, { eventType: ESTIMATE_PRICED });
      } catch (err) {
        log("error", "billing_meter_failed", { company, error: (err as Error).name });
      }
    },

    async page(company, page, returnUrl) {
      const options = { returnUrl, refreshUrl: returnUrl, sessionDurationSeconds: SESSION_SECONDS };
      if (page === "plans") {
        const { pricingUrl } = await client.createPricingSession(company, options);
        if (!pricingUrl) throw new Error("AWS Monetization returned no pricing page");
        return pricingUrl;
      }
      const { billingPortalUrl } = await client.createBillingPortalSession(company, options);
      if (!billingPortalUrl) throw new Error("AWS Monetization returned no billing portal");
      return billingPortalUrl;
    },
  };
}

/** Billing from the environment, or null when MONETIZATION_APP_ID is not set. */
export async function billingFromEnv(env: Record<string, string | undefined>, log: Log): Promise<Billing | null> {
  const appId = env.MONETIZATION_APP_ID;
  if (!appId) return null;
  const { MonetizationAI } = await import("@aws-app-monetization/sdk");
  // The endpoint and region come from MONETIZATION_ENDPOINT, read by the SDK itself.
  return createBilling(new MonetizationAI({ appId }), log);
}
