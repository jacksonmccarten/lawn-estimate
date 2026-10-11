// GET /profile/{company}: what the widget app's server renders a company's
// page from. No Turnstile and no quota: it makes no Regrid call, stores
// nothing, and returns only what the page itself shows or sends as a header.

import { Origin, PublicProfile, Theme } from "@lq/api-contract";
import type { WithPublic } from "@lq/db";
import { fromJson, json, respond, type HttpEvent, type HttpResult } from "../http.js";
import type { Log } from "../log.js";
import { NO_EDGE, throughEdge, type Edge } from "./edge.js";

/** How long a shared cache may hold a profile; the widget page uses the same figure. */
const MAX_AGE_SECONDS = 60;

export function createProfileHandler(deps: { withPublic: WithPublic; edge?: Edge; log?: Log }) {
  return (event: HttpEvent): Promise<HttpResult> =>
    respond(async () => {
      throughEdge(deps.edge ?? NO_EDGE, event, deps.log ?? (() => {}));
      // An unknown or malformed slug is withPublic's UnknownCompanyError: a 404.
      const slug = event.pathParameters?.company ?? "";
      const body = await deps.withPublic(slug, async (tx, company) => {
        // As jsonb: the Data API does not return array columns.
        const res = await tx.query<{ origins: unknown }>("SELECT to_jsonb(company_allowed_origins($1)) AS origins", [slug]);
        const origins = fromJson<string[] | null>(res.rows[0]?.origins) ?? [];
        // Stored values are checked on the way in; anything that still is not
        // exactly a color, a logo key or an origin is left out, not repaired.
        const color = Theme.shape.color.safeParse(company.theme.color);
        const logoKey = Theme.shape.logoKey.safeParse(company.theme.logoKey);
        return {
          slug: company.slug,
          name: company.name,
          theme: {
            ...(color.success && color.data ? { color: color.data } : {}),
            ...(logoKey.success && logoKey.data ? { logoKey: logoKey.data } : {}),
          },
          services: company.services,
          allowedOrigins: origins.filter((o) => Origin.safeParse(o).success),
        };
      });
      const result = json(200, PublicProfile.parse(body));
      return { ...result, headers: { ...result.headers, "cache-control": `public, max-age=${MAX_AGE_SECONDS}` } };
    });
}
