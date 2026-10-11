// The widget page's Content-Security-Policy (docs/ENGINEERING_DESIGN.md
// sections 4 and 10). frame-ancestors is the company's allowlist when it has
// one; an empty list lets any site embed the widget (the default), and an
// unknown company leaves 'self' only.

import { Origin } from "@lq/api-contract";

const TURNSTILE = "https://challenges.cloudflare.com";
// Geocoding (fetch) and the aerial photo (an image). No Mapbox script is loaded.
const MAPBOX = "https://api.mapbox.com";

export type CspInput = {
  /** companies.allowed_origins: empty for any site. Null when no company has the slug. Anything that is not a bare origin is dropped. */
  allowedOrigins: string[] | null;
  /** The API origin when it differs from this app's. */
  apiOrigin: string | null;
  /** The origin logos are served from. */
  logoOrigin: string | null;
  turnstile: boolean;
  /** A Mapbox token is configured: the address lookup and the aerial photo. */
  mapbox: boolean;
  /** `next dev` evaluates and injects code; production never gets these. */
  dev: boolean;
};

export function frameAncestors(allowedOrigins: string[] | null): string {
  if (allowedOrigins === null) return "frame-ancestors 'self'";
  // No list: any site may embed the widget. Turnstile and the quota still guard the API.
  if (allowedOrigins.length === 0) return "frame-ancestors *";
  const origins = new Set<string>();
  for (const origin of allowedOrigins) {
    if (Origin.safeParse(origin).success) origins.add(origin.toLowerCase());
  }
  return ["frame-ancestors", "'self'", ...origins].join(" ");
}

export function buildCsp(input: CspInput): string {
  const list = (...sources: (string | null | false)[]) => sources.filter(Boolean).join(" ");
  return [
    "default-src 'none'",
    // No inline script: the page ships none, so nothing a company's name or
    // theme could smuggle in would run.
    `script-src ${list("'self'", input.turnstile && TURNSTILE, input.dev && "'unsafe-eval' 'unsafe-inline'")}`,
    `style-src ${list("'self'", input.dev && "'unsafe-inline'")}`,
    // The brand color reaches the page as custom properties in a style
    // attribute, whose values are hex colors validated on the server.
    "style-src-attr 'unsafe-inline'",
    `img-src ${list("'self'", input.logoOrigin, input.mapbox && MAPBOX)}`,
    `connect-src ${list("'self'", input.apiOrigin, input.mapbox && MAPBOX, input.dev && "ws:")}`,
    input.turnstile ? `frame-src ${TURNSTILE}` : "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    frameAncestors(input.allowedOrigins),
  ].join("; ");
}
