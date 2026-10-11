// Request and response plumbing shared by every handler. Bodies are
// validated against packages/api-contract on the way in and on the way out.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { ErrorCode, ErrorResponse } from "@lq/api-contract";
import { NotAdminError, NotAMemberError, UnknownCompanyError } from "@lq/db";
import type { z } from "zod";
import { log } from "./log.js";

export type HttpEvent = APIGatewayProxyEventV2;
export type HttpResult = APIGatewayProxyStructuredResultV2;

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  turnstile_failed: 403,
  origin_not_allowed: 403,
  quota_exceeded: 429,
  rate_limited: 429,
  token_invalid: 400,
  token_expired: 410,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_published: 409,
  lead_already_decided: 409,
  billing_unavailable: 503,
  internal: 500,
};

/** Thrown anywhere in a handler to answer with the contract's ErrorResponse. */
export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(status: number, body: unknown): HttpResult {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

/** The request body as parsed JSON; anything else is an invalid request. */
export function parseBody(event: HttpEvent): unknown {
  if (!event.body) throw new HttpError("invalid_request", "a JSON body is required");
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError("invalid_request", "the body is not valid JSON");
  }
}

/** Validates against a contract schema; failures name the fields, never the values. */
export function validate<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join(".") || "body";
    fields[path] ??= issue.message;
  }
  throw new HttpError("invalid_request", "the request does not match the contract", fields);
}

// SQLSTATEs the database raises on purpose, and the answers they stand for.
const SQLSTATE: Record<string, [ErrorCode, string]> = {
  "55000": ["version_published", "a published pricing version cannot be changed"],
  LQ001: ["lead_already_decided", "this lead already has a decision"],
  "23505": ["conflict", "that already exists"],
  "23P01": ["invalid_request", "tiers of one service and region group overlap"],
  "23514": ["invalid_request", "a value is outside its allowed range"],
  "22003": ["invalid_request", "a number is too large"],
};

function toHttpError(err: unknown): HttpError | undefined {
  if (err instanceof HttpError) return err;
  if (err instanceof UnknownCompanyError) return new HttpError("not_found", "no such company");
  if (err instanceof NotAMemberError || err instanceof NotAdminError) return new HttpError("forbidden", err.message);
  const code = (err as { code?: unknown } | null)?.code;
  const known = typeof code === "string" ? SQLSTATE[code] : undefined;
  return known && new HttpError(known[0], known[1]);
}

/** Runs a handler body and turns whatever it throws into an ErrorResponse. */
export async function respond(fn: () => Promise<HttpResult>): Promise<HttpResult> {
  try {
    return await fn();
  } catch (err) {
    const http = toHttpError(err);
    if (!http) {
      // The error's name and SQLSTATE only: a message can quote a row, and rows hold PII.
      const sqlState = (err as { code?: unknown } | null)?.code;
      log("error", "unhandled", { name: (err as Error | null)?.name, sqlState: typeof sqlState === "string" ? sqlState : undefined });
    }
    const error = http ?? new HttpError("internal", "something went wrong");
    const body: ErrorResponse = {
      error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) },
    };
    return json(STATUS[error.code], body);
  }
}

/** A jsonb value as an object, whichever driver returned it (pg parses, the Data API does not). */
export function fromJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
