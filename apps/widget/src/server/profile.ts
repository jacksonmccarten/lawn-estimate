// The company's public profile as the widget page needs it, and the one place
// company-supplied theming is validated before it reaches markup or a header
// (docs/ENGINEERING_DESIGN.md section 10, "XSS via company theming").

import { CompanySlug, Origin, PublicProfile, ServiceCode, Theme } from "@lq/api-contract";
import profileFixtures from "../../fixtures/profiles.json";
import type { ServerConfig } from "./config";

/** What a profile source returns: the fixtures, or the API's GET /profile/{company}. */
export type RawProfile = {
  slug: string;
  name: string;
  theme: unknown;
  services: { code: string; name: string; season: string }[];
  allowedOrigins: string[];
};

export type CompanyProfile = {
  slug: string;
  name: string;
  services: { code: string; name: string }[];
  /** A validated #rrggbb color, or null. */
  color: string | null;
  /** A URL under our own logo CDN, or null. */
  logoUrl: string | null;
  /** Validated, lower-cased, de-duplicated. */
  allowedOrigins: string[];
};

/**
 * Drops anything that is not exactly the shape we expect rather than trying
 * to repair it: a bad color or logo key means no color or logo, and a
 * malformed origin never reaches the frame-ancestors header.
 */
export function sanitizeProfile(raw: RawProfile, logoBaseUrl: string | null): CompanyProfile {
  const theme = raw.theme && typeof raw.theme === "object" ? (raw.theme as Record<string, unknown>) : {};
  const color = Theme.shape.color.safeParse(theme.color);
  const logoKey = Theme.shape.logoKey.safeParse(theme.logoKey);

  const origins = new Set<string>();
  for (const origin of raw.allowedOrigins) {
    if (Origin.safeParse(origin).success) origins.add(origin.toLowerCase());
  }

  return {
    slug: raw.slug,
    name: raw.name,
    services: raw.services
      .filter((s) => ServiceCode.safeParse(s.code).success)
      .map((s) => ({ code: s.code, name: s.name })),
    color: color.success && color.data ? color.data.toLowerCase() : null,
    logoUrl: logoBaseUrl && logoKey.success && logoKey.data ? `${logoBaseUrl}/${logoKey.data}` : null,
    allowedOrigins: [...origins],
  };
}

/**
 * The profile from the API. This app holds no database credentials: the
 * route runs as app_public behind the same API the browser posts to.
 */
async function fetchProfile(slug: string, apiBase: string, doFetch: typeof fetch): Promise<RawProfile | null> {
  const response = await doFetch(`${apiBase}/profile/${encodeURIComponent(slug)}`, {
    headers: { accept: "application/json" },
    // The page sets its own shared-cache lifetime; do not add a second one here.
    cache: "no-store",
    // Long enough for a database that paused while idle to wake: the first
    // visitor after a quiet spell waits, and is not shown an error.
    signal: AbortSignal.timeout(25_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`the profile route answered ${response.status}`);
  return PublicProfile.parse(await response.json());
}

/** Null when no company has the slug. Throws when the API cannot be read, so the page is a 500 and not a blank widget. */
export async function loadProfile(
  slug: string,
  config: ServerConfig,
  doFetch: typeof fetch = fetch,
): Promise<CompanyProfile | null> {
  if (!CompanySlug.safeParse(slug).success) return null;
  const raw = config.fixtures
    ? ((profileFixtures as RawProfile[]).find((p) => p.slug === slug) ?? null)
    : await fetchProfile(slug, config.apiBase, doFetch);
  return raw ? sanitizeProfile(raw, config.logoBaseUrl) : null;
}
