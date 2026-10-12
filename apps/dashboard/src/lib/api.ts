// The dashboard's client for the company-api. Paths, methods and schemas come
// from packages/api-contract; every response is parsed with its schema, so a
// server that drifts from the contract fails here and not somewhere in a view.

import {
  ErrorResponse,
  routes,
  type BillingSession,
  type BillingSessionRequest,
  type Company,
  type CreateCompanyRequest,
  type CreatePricingVersionRequest,
  type ErrorCode,
  type Lead,
  type LeadDecisionRequest,
  type LeadList,
  type PreviewQuoteRequest,
  type PreviewQuoteResponse,
  type PricingVersion,
  type PricingVersionContent,
  type PricingVersionDiff,
  type PricingVersionList,
  type Questionnaire,
  type Regions,
  type ServiceAreaSettings,
  type ServiceRadius,
  type UpdateCompanyRequest,
  type Usage,
  type ZipsNear,
} from "@lq/api-contract";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network" | "bad_response",
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type OwnerRoute = { [K in keyof typeof routes]: (typeof routes)[K] extends { auth: "owner" } ? K : never }[keyof typeof routes];

export type ApiOptions = {
  baseUrl: string;
  getToken: () => string | null;
  /** Called on 401: the session is gone or expired. */
  onUnauthenticated: () => void;
};

export function createApi({ baseUrl, getToken, onUnauthenticated }: ApiOptions) {
  async function call<K extends OwnerRoute>(
    name: K,
    options: { id?: string; query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<z.infer<(typeof routes)[K]["response"]>> {
    const route = routes[name];
    let url = baseUrl + route.path.replace("{id}", encodeURIComponent(options.id ?? ""));
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) query.set(key, value);
    if (query.size > 0) url += `?${query}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: route.method,
        headers: {
          Authorization: `Bearer ${getToken() ?? ""}`,
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        cache: "no-store",
      });
    } catch {
      throw new ApiError(0, "network", "The request did not reach the server");
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = ErrorResponse.safeParse(payload);
      if (response.status === 401) onUnauthenticated();
      if (!parsed.success) throw new ApiError(response.status, "bad_response", `HTTP ${response.status}`);
      throw new ApiError(response.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.fields);
    }
    const parsed = route.response.safeParse(payload);
    if (!parsed.success) throw new ApiError(response.status, "bad_response", "The response does not match the contract");
    return parsed.data as z.infer<(typeof routes)[K]["response"]>;
  }

  return {
    getCompany: (): Promise<Company> => call("getCompany"),
    updateCompany: (body: UpdateCompanyRequest): Promise<Company> => call("updateCompany", { body }),
    /** A new login's first call. 409 `conflict` if it already has a company. */
    createCompany: (body: CreateCompanyRequest): Promise<Company> => call("createCompany", { body }),
    getRegions: (): Promise<Regions> => call("getRegions"),
    /** Replaces the whole list. */
    replaceRegions: (body: Regions): Promise<Regions> => call("replaceRegions", { body }),
    getQuestionnaire: (): Promise<Questionnaire> => call("getQuestionnaire"),
    /** Replaces the whole list. */
    replaceQuestionnaire: (body: Questionnaire): Promise<Questionnaire> => call("replaceQuestionnaire", { body }),
    getServiceArea: (): Promise<ServiceAreaSettings> => call("getServiceArea"),
    /** Stores the address and radius and replaces the regions with the zips inside. 400 if the zip has no location. */
    replaceServiceArea: (body: ServiceRadius): Promise<ServiceAreaSettings> => call("replaceServiceArea", { body }),
    /** The zip codes within `miles` of the centre of `zip`, nearest first. 400 if the zip has no location. */
    zipsNear: (query: { zip: string; miles: number }): Promise<ZipsNear> => call("getZipsNear", { query: { zip: query.zip, miles: String(query.miles) } }),
    listPricingVersions: (): Promise<PricingVersionList> => call("listPricingVersions"),
    createPricingVersion: (body: CreatePricingVersionRequest): Promise<PricingVersion> => call("createPricingVersion", { body }),
    getPricingVersion: (id: string): Promise<PricingVersion> => call("getPricingVersion", { id }),
    replacePricingVersion: (id: string, body: PricingVersionContent): Promise<PricingVersion> => call("replacePricingVersion", { id, body }),
    publishPricingVersion: (id: string): Promise<PricingVersion> => call("publishPricingVersion", { id, body: { confirm: true } }),
    diffPricingVersion: (id: string): Promise<PricingVersionDiff> => call("diffPricingVersion", { id }),
    previewQuote: (id: string, body: PreviewQuoteRequest): Promise<PreviewQuoteResponse> => call("previewQuote", { id, body }),
    listLeads: (query: { status?: string; cursor?: string; limit?: number }): Promise<LeadList> =>
      call("listLeads", { query: { status: query.status, cursor: query.cursor, limit: query.limit?.toString() } }),
    getLead: (id: string): Promise<Lead> => call("getLead", { id }),
    decideLead: (id: string, body: LeadDecisionRequest): Promise<Lead> => call("decideLead", { id, body }),
    getUsage: (): Promise<Usage> => call("getUsage"),
    /** A short-lived link to a billing page the billing provider hosts. 503 `billing_unavailable` when there is none. */
    createBillingSession: (body: BillingSessionRequest): Promise<BillingSession> => call("createBillingSession", { body }),
  };
}

export type Api = ReturnType<typeof createApi>;

/** What to tell the owner when a call fails. The server's `message` is for logs, not for display. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "network":
        return "We couldn’t reach the server. Check your connection and try again.";
      case "unauthenticated":
      case "token_expired":
      case "token_invalid":
        return "Your session has ended. Sign in again to continue.";
      case "forbidden":
        return "Your account doesn’t have access to this.";
      case "not_found":
        return "We couldn’t find that. It may have been removed.";
      case "version_published":
        return "This version is already published, so it can’t be changed. Start a new draft from it instead.";
      case "lead_already_decided":
        return "This lead has already been decided. A decision can’t be changed.";
      case "invalid_request":
        return "The server didn’t accept that. Check the values and try again.";
      case "billing_unavailable":
        return "Billing isn’t available right now. Try again in a few minutes.";
      default:
        return "Something went wrong on our side. Try again in a moment.";
    }
  }
  return "Something went wrong. Try again in a moment.";
}
