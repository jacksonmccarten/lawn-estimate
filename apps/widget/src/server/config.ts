// Server-side configuration, read from the environment on each request so one
// build serves every Amplify branch. Nothing here is secret: the Turnstile
// site key, the API address and the Mapbox public token are public by design.

import { Origin } from "@lq/api-contract";

export type ServerConfig = {
  /** Serve /estimate, /submit and company profiles from apps/widget/fixtures. */
  fixtures: boolean;
  /** Where the browser sends /estimate and /submit. */
  apiBase: string;
  /** The origin of `apiBase` when it is not this app, for connect-src. */
  apiOrigin: string | null;
  /** Null only with fixtures, where no token is checked. */
  turnstileSiteKey: string | null;
  /** The CDN in front of our logo bucket, e.g. https://assets.example.com. */
  logoBaseUrl: string | null;
  /**
   * A Mapbox public token (pk.) for finding the address and showing the
   * aerial photo. Null: no photo, and the homeowner gives the lot size.
   */
  mapboxToken: string | null;
  dev: boolean;
};

export const FIXTURE_API_BASE = "/api/fixtures";

function originOf(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (!Origin.safeParse(url.origin).success) throw new Error(`${name} must be an http(s) URL`);
  return url.origin;
}

export function serverConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const dev = env.NODE_ENV !== "production";
  // Fixtures are the default in development and opt-in anywhere else.
  const fixtures = env.LQ_FIXTURES === "1" || (dev && env.LQ_FIXTURES !== "0");

  const logoBaseUrl = env.LQ_LOGO_BASE_URL ? originOf("LQ_LOGO_BASE_URL", env.LQ_LOGO_BASE_URL) : null;
  const turnstileSiteKey = env.LQ_TURNSTILE_SITE_KEY || null;
  const mapboxToken = env.NEXT_PUBLIC_MAPBOX_TOKEN || null;
  // A secret token (sk.) must never reach a browser; only a public one is accepted.
  if (mapboxToken !== null && !mapboxToken.startsWith("pk.")) {
    throw new Error("NEXT_PUBLIC_MAPBOX_TOKEN must be a Mapbox public token (pk.)");
  }

  if (fixtures) {
    return {
      fixtures,
      apiBase: FIXTURE_API_BASE,
      apiOrigin: null,
      turnstileSiteKey,
      logoBaseUrl,
      mapboxToken,
      dev,
    };
  }

  if (!env.LQ_API_BASE) throw new Error("LQ_API_BASE is required when LQ_FIXTURES is not 1");
  if (!turnstileSiteKey) throw new Error("LQ_TURNSTILE_SITE_KEY is required when LQ_FIXTURES is not 1");
  return {
    fixtures,
    apiBase: env.LQ_API_BASE.replace(/\/+$/, ""),
    apiOrigin: originOf("LQ_API_BASE", env.LQ_API_BASE),
    turnstileSiteKey,
    logoBaseUrl,
    mapboxToken,
    dev,
  };
}
