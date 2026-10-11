// Seeds the local loop: lets the two application roles log in, and creates
// the one company the dashboard's mock sign-in belongs to (demo-company.ts).
// Safe to run again: an existing company keeps its pricing, regions and leads.

import { PgDbClient } from "@lq/db";
import pg from "pg";
import { DEMO_SLUG, ensureDemoCompany } from "./demo-company.js";
import { env, LOCAL_ROLE_PASSWORD, requireLocal } from "./env.js";

const MOCK_OWNER_SUB = "mock-sub-owner-0001";

requireLocal(env.ownerUrl);

const pool = new pg.Pool({ connectionString: env.ownerUrl, max: 1 });
try {
  // Roles are created NOLOGIN by the migrations; each environment enables them.
  await pool.query(`ALTER ROLE app_rw LOGIN PASSWORD '${LOCAL_ROLE_PASSWORD}'`);
  await pool.query(`ALTER ROLE app_public LOGIN PASSWORD '${LOCAL_ROLE_PASSWORD}'`);

  const result = await ensureDemoCompany(new PgDbClient(pool), { ownerSubs: [MOCK_OWNER_SUB], quota: 200, alertEmail: "owner@nittanylawn.example" });
  console.log(
    result === "created"
      ? `created ${DEMO_SLUG}: mowing and leaf raking published as version 1, serving every Pennsylvania county`
      : `${DEMO_SLUG} already exists: left as it is`,
  );
  console.log(`widget:    ${env.widgetOrigin}/w/${DEMO_SLUG}`);
  console.log(`dashboard: ${env.dashboardOrigin}  (owner@nittanylawn.example, any password, code 123456)`);
} finally {
  await pool.end();
}
