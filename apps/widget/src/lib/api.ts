// The two public calls of docs/ENGINEERING_DESIGN.md section 5. Types come
// from packages/api-contract; the schemas themselves stay on the server so
// zod is not in the widget bundle.

import type { ErrorCode, EstimateRequest, EstimateResponse, SubmitRequest, SubmitResponse } from "@lq/api-contract";

/** `network` covers anything that never produced a contract response. */
export type ApiFailure = { ok: false; code: ErrorCode | "network"; fields?: Record<string, string> };
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

export type Api = {
  estimate(body: EstimateRequest): Promise<ApiResult<EstimateResponse>>;
  submit(body: SubmitRequest): Promise<ApiResult<SubmitResponse>>;
};

async function post<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  let response: Response;
  let json: unknown;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // No cookies, ever; state is the signed quote token.
      credentials: "omit",
      cache: "no-store",
    });
    json = await response.json();
  } catch {
    return { ok: false, code: "network" };
  }
  if (!json || typeof json !== "object") return { ok: false, code: "network" };

  if (response.ok) {
    if (typeof (json as { status?: unknown }).status !== "string") return { ok: false, code: "network" };
    return { ok: true, data: json as T };
  }
  const error = (json as { error?: { code?: unknown; fields?: unknown } }).error;
  if (!error || typeof error.code !== "string") return { ok: false, code: "network" };
  const fields = error.fields && typeof error.fields === "object" ? (error.fields as Record<string, string>) : undefined;
  return { ok: false, code: error.code as ErrorCode, fields };
}

export function createApi(base: string): Api {
  return {
    estimate: (body) => post(`${base}/estimate`, body),
    submit: (body) => post(`${base}/submit`, body),
  };
}
