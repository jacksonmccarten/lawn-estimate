// The demonstration company, for the local loop and for a first deployment:
// Nittany Lawn Care, with a published rate table so the widget prices from
// the first run, serving every Pennsylvania county. Written against DbClient,
// so the same code seeds a local database over node-postgres and Aurora over
// the Data API. `db` must be connected as the schema's owner.

import type { DbClient } from "@lq/db";

// The same company the dashboard's mock describes (apps/dashboard/src/mock/store.ts).
export const DEMO_COMPANY_ID = "0b0f6a52-6d0c-4a7e-9a55-10ca1100b001";
export const DEMO_SLUG = "nittany-lawn";
const REGION_GROUP = "standard";

export type DemoOptions = {
  /** Cognito subs (or the mock's) that sign in as this company's owner. */
  ownerSubs: string[];
  /** Estimates a month. The dashboard cannot set this; billing will (step 6). */
  quota: number;
  /** Where lead alerts go. */
  alertEmail: string;
};

/** Creates the company if it is missing; an existing one keeps its pricing, regions and leads. */
export async function ensureDemoCompany(db: DbClient, options: DemoOptions): Promise<"created" | "exists"> {
  return db.transaction(async (tx) => {
    // FORCE ROW LEVEL SECURITY binds the owner too.
    await tx.query("SELECT set_config('app.company_id', $1, true)", [DEMO_COMPANY_ID]);
    const existing = await tx.query("SELECT 1 FROM companies WHERE id = $1", [DEMO_COMPANY_ID]);
    const created = existing.rows.length === 0;

    if (created) {
      await tx.query(
        `INSERT INTO companies (id, slug, name, hic_no, phone, alert_email, regrid_lookup_quota, theme)
         VALUES ($1, $2, 'Nittany Lawn Care', 'PA000000', '814-555-0100', $3, $4, $5)`,
        [DEMO_COMPANY_ID, DEMO_SLUG, options.alertEmail, options.quota, { color: "#1b5e20" }],
      );
      // Every Pennsylvania county, one region group: any address in the state prices.
      await tx.query(
        `INSERT INTO service_regions (company_id, kind, value, tier_group)
         SELECT DISTINCT $1::uuid, 'county', county, $2 FROM tax_rates WHERE state = 'PA'`,
        [DEMO_COMPANY_ID, REGION_GROUP],
      );

      const version = await tx.query<{ id: string }>(
        "INSERT INTO pricing_versions (company_id, version, min_charge_cents, coverage_factor) VALUES ($1, 1, 4500, 0.70) RETURNING id",
        [DEMO_COMPANY_ID],
      );
      const versionId = version.rows[0]!.id;
      // Names and taxable flags from the seeded catalog (61 Pa. Code § 55.6): one taxable, one not.
      const services = await tx.query<{ id: string; code: string }>(
        `INSERT INTO services (version_id, company_id, code, name, taxable, season)
         SELECT $1, $2, code, name, taxable, season FROM service_catalog
         WHERE state = 'PA' AND code IN ('mow', 'leaf_raking')
         RETURNING id, code`,
        [versionId, DEMO_COMPANY_ID],
      );
      const serviceId = (code: string) => services.rows.find((s) => s.code === code)!.id;
      const tier = (code: string, min: number, max: number, price: { microcents: number } | { flatCents: number }) =>
        tx.query(
          `INSERT INTO pricing_tiers (version_id, company_id, service_id, region_group, min_sqft, max_sqft,
                                      price_per_sqft_microcents, flat_price_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            versionId,
            DEMO_COMPANY_ID,
            serviceId(code),
            REGION_GROUP,
            min,
            max,
            "microcents" in price ? price.microcents : null,
            "flatCents" in price ? price.flatCents : null,
          ],
        );
      await tier("mow", 0, 5_000, { microcents: 900_000 });
      await tier("mow", 5_000, 10_000, { microcents: 750_000 });
      await tier("mow", 10_000, 90_000, { microcents: 600_000 });
      await tier("leaf_raking", 0, 10_000, { flatCents: 12_000 });
      await tier("leaf_raking", 10_000, 90_000, { flatCents: 22_000 });
      await tx.query("UPDATE pricing_versions SET published_at = now() WHERE id = $1", [versionId]);
    } else {
      // Left as the dashboard has it; only what the dashboard cannot set is restored.
      await tx.query("UPDATE companies SET regrid_lookup_quota = $2 WHERE id = $1 AND regrid_lookup_quota = 0", [DEMO_COMPANY_ID, options.quota]);
    }

    for (const sub of options.ownerSubs) {
      await tx.query("INSERT INTO company_members (cognito_sub, company_id) VALUES ($1, $2) ON CONFLICT (cognito_sub) DO NOTHING", [sub, DEMO_COMPANY_ID]);
    }
    return created ? "created" : "exists";
  });
}
