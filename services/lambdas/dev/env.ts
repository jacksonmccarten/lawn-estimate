// Settings for the local loop (dev/server.ts and dev/seed.ts), read from the
// repo root's .env when there is one. Every default is for a developer's own
// machine; none of this is deployed.

import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env: the defaults below.
}

/** The password the test suites give app_rw and app_public; roles are cluster-wide, so the loop shares it. */
export const LOCAL_ROLE_PASSWORD = "local-test-only";

const OWNER_URL = process.env.DATABASE_URL ?? "postgres://app_owner:app_owner@localhost:54320/lawnquote";

function as(user: string): string {
  const url = new URL(OWNER_URL);
  url.username = user;
  url.password = LOCAL_ROLE_PASSWORD;
  return url.toString();
}

export const env = {
  ownerUrl: OWNER_URL,
  publicUrl: process.env.DATABASE_URL_PUBLIC ?? as("app_public"),
  rwUrl: process.env.DATABASE_URL_RW ?? as("app_rw"),
  port: Number(process.env.API_PORT ?? 8787),
  widgetOrigin: process.env.WIDGET_ORIGIN ?? "http://localhost:3001",
  dashboardOrigin: process.env.DASHBOARD_URL ?? "http://localhost:3000",
  /** Unset: no Regrid call is made and every address goes to the manual path. */
  regridToken: process.env.REGRID_TOKEN || null,
  regridBaseUrl: process.env.REGRID_BASE_URL || null,
  // Cloudflare's published test secret: every token passes.
  turnstileSecret: process.env.TURNSTILE_SECRET ?? "1x0000000000000000000000000000000AA",
  quoteTokenSecret: process.env.QUOTE_TOKEN_SECRET ?? "local-loop-quote-token-secret-not-for-deployment",
  ipHashSalt: process.env.IP_HASH_SALT ?? "local-loop-ip-salt",
};

/** The loop trusts an unsigned sign-in and seeds data, so it only ever runs against this machine. */
export function requireLocal(...urls: string[]): void {
  for (const url of urls) {
    const host = new URL(url).hostname;
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
      throw new Error(`refusing to run against ${host}: the local loop is for a database on this machine`);
    }
  }
}
