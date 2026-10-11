// The public routes sit behind CloudFront and WAF (design section 9). Two
// headers come from there and from nowhere else:
//
//   x-origin-verify  an origin custom header holding ORIGIN_VERIFY_SECRET.
//                    Proves the request went through CloudFront, and so
//                    through WAF, and did not call the execute-api address.
//   x-viewer-ip      the visitor's address, set by a CloudFront Function that
//                    overwrites whatever the visitor sent. Behind CloudFront,
//                    API Gateway's sourceIp is CloudFront's own address.
//
// With no secret configured (local runs, tests) neither header is read.
// Until `enforce` is on, a request that skipped CloudFront is logged and
// still served, so the front ends can move to the new address first.

import { timingSafeEqual } from "node:crypto";
import { HttpError, type HttpEvent } from "../http.js";
import type { Log } from "../log.js";

export type Edge = {
  /** ORIGIN_VERIFY_SECRET, or null when the API is not behind CloudFront. */
  secret: string | null;
  /** Refuse a request that did not come through CloudFront. */
  enforce: boolean;
};

export const NO_EDGE: Edge = { secret: null, enforce: false };

function fromEdge(edge: Edge, event: HttpEvent): boolean {
  if (edge.secret === null) return false;
  const given = Buffer.from(event.headers?.["x-origin-verify"] ?? "");
  const expected = Buffer.from(edge.secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Checks the request came through CloudFront, and returns the visitor's
 * address: the one CloudFront saw when it did, API Gateway's otherwise.
 */
export function throughEdge(edge: Edge, event: HttpEvent, log: Log): { ip: string | null } {
  const sourceIp = event.requestContext?.http?.sourceIp ?? null;
  if (edge.secret === null) return { ip: sourceIp };
  if (fromEdge(edge, event)) return { ip: event.headers?.["x-viewer-ip"] || sourceIp };
  // Counted from this line by a metric filter, like origin_refused.
  log("warn", "edge_bypassed", { enforced: edge.enforce });
  if (edge.enforce) throw new HttpError("forbidden", "call the API through its public address");
  return { ip: sourceIp };
}
