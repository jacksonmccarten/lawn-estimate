// What the two public handlers are built from. Everything that touches the
// outside world is passed in, so the tests run them against a real database
// with a fake Regrid, Turnstile and notifier.

import { createHmac } from "node:crypto";
import type { WithPublic } from "@lq/db";
import type { Billing } from "../billing.js";
import { HttpError, type HttpEvent } from "../http.js";
import type { Log } from "../log.js";
import type { Notifier } from "./notify.js";
import type { RegridLookup } from "./regrid.js";
import type { TokenCodec } from "./token.js";
import type { TurnstileVerify } from "./turnstile.js";

export type PublicDeps = {
  withPublic: WithPublic;
  turnstile: TurnstileVerify;
  /** Null when no Regrid token is configured: every address goes to the manual path. */
  regrid: RegridLookup | null;
  tokens: TokenCodec;
  notifier: Notifier;
  /** Null when AWS Monetization is not configured: the database allowance alone decides. */
  billing: Billing | null;
  /** Salt for quotes.ip_hash; IPs are never stored as they are. */
  ipHashSalt: string;
  /** The widget app's own origin (https://w.<domain>). When set, calls from anywhere else are refused. */
  widgetOrigin: string | null;
  log: Log;
};

export function sourceIp(event: HttpEvent): string | null {
  return event.requestContext?.http?.sourceIp ?? null;
}

export function hashIp(salt: string, ip: string | null): string | null {
  return ip === null ? null : createHmac("sha256", salt).update(ip).digest("hex");
}

/**
 * The request must come from the widget app itself. This is the browser's
 * own Origin header; the embedding site's origin is a separate check against
 * the company's allowlist, in the database.
 */
export function requireWidgetOrigin(deps: PublicDeps, event: HttpEvent): void {
  if (deps.widgetOrigin !== null && event.headers?.origin !== deps.widgetOrigin) {
    deps.log("warn", "origin_refused", { check: "widget" });
    throw new HttpError("origin_not_allowed", "this origin may not call the API");
  }
}

export function embedOriginRefused(deps: PublicDeps, company: string): HttpError {
  // Counted from this line by a metric filter (design section 9).
  deps.log("warn", "origin_refused", { check: "embed", company });
  return new HttpError("origin_not_allowed", "this site may not embed the company's widget");
}
