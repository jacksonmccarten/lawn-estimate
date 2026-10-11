// Stand-ins for /estimate and /submit until the Lambdas exist: every answer
// is one of the recorded request/response pairs in apps/widget/fixtures, each
// of which test/fixtures.test.ts checks against packages/api-contract. No
// pricing happens here and nothing here calls Regrid.

import type { ErrorCode, ErrorResponse, EstimateRequest, EstimateResponse, SubmitRequest, SubmitResponse } from "@lq/api-contract";
import errorFixtures from "../../fixtures/errors.json";
import estimateFixtures from "../../fixtures/estimate.json";
import submitFixtures from "../../fixtures/submit.json";

export type Recorded<Req, Res> = { name: string; request: Req; response: Res };
export type RecordedError = { name: string; httpStatus: number; body: ErrorResponse };

export const estimateRecordings = estimateFixtures as Recorded<EstimateRequest, EstimateResponse>[];
export const submitRecordings = submitFixtures as Recorded<SubmitRequest, SubmitResponse>[];
export const errorRecordings = errorFixtures as RecordedError[];

export type FixtureReply<T> = { httpStatus: 200; body: T } | { httpStatus: number; body: ErrorResponse };

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * What decides which recording answers a request. An adjustment is keyed on
 * its token; a manual request on zip and county, whatever the lot size, with
 * an outlined lawn apart from the rest; a first request on address and
 * service.
 */
export function estimateKey(request: EstimateRequest): string {
  if ("token" in request) return `adjust|${request.token}|${request.adjust}`;
  if (request.manual) {
    const kind = request.manual.size.kind === "drawn" ? "drawn" : "manual";
    return `${kind}|${request.manual.zip}|${request.manual.county ?? ""}`;
  }
  return `address|${normalize(request.address)}|${request.service}`;
}

function recordedError(code: ErrorCode): FixtureReply<never> {
  const found = errorRecordings.find((e) => e.body.error.code === code);
  if (!found) throw new Error(`no recorded error for ${code}`);
  return { httpStatus: found.httpStatus, body: found.body };
}

function named(name: string): EstimateResponse {
  const found = estimateRecordings.find((r) => r.name === name);
  if (!found) throw new Error(`no recording named ${name}`);
  return found.response;
}

/**
 * `allowedOrigins` is null when no company has the request's slug. An
 * address or zip with no recording falls back to the no-match and
 * unknown-zip recordings, as an unrecognized one would in production.
 */
export function replayEstimate(request: EstimateRequest, allowedOrigins: string[] | null): FixtureReply<EstimateResponse> {
  if (!("token" in request)) {
    if (!allowedOrigins) return recordedError("not_found");
    if (request.embedOrigin !== null && allowedOrigins.length > 0 && !allowedOrigins.includes(request.embedOrigin.toLowerCase())) {
      return recordedError("origin_not_allowed");
    }
  }
  const key = estimateKey(request);
  const found = estimateRecordings.find((r) => estimateKey(r.request) === key);
  if (found) return { httpStatus: 200, body: found.response };
  if ("token" in request) return recordedError("token_invalid");
  return { httpStatus: 200, body: named(request.manual ? "manual-unknown-zip" : "no-match") };
}

export function replaySubmit(request: SubmitRequest): FixtureReply<SubmitResponse> {
  const priced = estimateRecordings.some((r) => r.response.status === "priced" && r.response.token === request.token);
  if (!priced) return recordedError("token_invalid");
  return { httpStatus: 200, body: submitRecordings[0]!.response };
}

export function invalidRequest(fields?: Record<string, string>): FixtureReply<never> {
  const base = recordedError("invalid_request");
  return fields ? { ...base, body: { error: { ...base.body.error, fields } } } : base;
}
