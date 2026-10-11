// The wire contract: one zod schema per request and response, shared by the
// Lambdas (which validate with them) and the two front ends (which use the
// inferred types). Depends on zod only, so it is safe in a browser bundle.

import * as company from "./company.js";
import { ErrorResponse } from "./common.js";
import * as pub from "./public.js";

export * from "./common.js";
export * from "./public.js";
export * from "./company.js";

/**
 * Every route, with the schemas for its body (or query) and its 2xx response.
 * Anything else is an ErrorResponse; `errors` lists the route-specific ones.
 * `auth: "public"` routes go through
 * withPublic; `auth: "owner"` routes through withCompany.
 */
export const routes = {
  estimate: { method: "POST", path: "/estimate", auth: "public", request: pub.EstimateRequest, response: pub.EstimateResponse },
  submit: { method: "POST", path: "/submit", auth: "public", request: pub.SubmitRequest, response: pub.SubmitResponse },
  sendContact: { method: "POST", path: "/contact", auth: "public", request: pub.ContactRequest, response: pub.ContactResponse, errors: { 503: "contact_unavailable" } },
  getProfile: { method: "GET", path: "/profile/{company}", auth: "public", response: pub.PublicProfile },

  getCompany: { method: "GET", path: "/company", auth: "owner", response: company.Company },
  updateCompany: { method: "PATCH", path: "/company", auth: "owner", request: company.UpdateCompanyRequest, response: company.Company },
  createCompany: { method: "POST", path: "/company", auth: "owner", request: company.CreateCompanyRequest, response: company.Company, errors: { 409: "conflict" } },
  getRegions: { method: "GET", path: "/regions", auth: "owner", response: company.Regions },
  replaceRegions: { method: "PUT", path: "/regions", auth: "owner", request: company.Regions, response: company.Regions },
  getQuestionnaire: { method: "GET", path: "/questionnaire", auth: "owner", response: company.Questionnaire },
  replaceQuestionnaire: { method: "PUT", path: "/questionnaire", auth: "owner", request: company.Questionnaire, response: company.Questionnaire },
  getServiceArea: { method: "GET", path: "/service-area", auth: "owner", response: company.ServiceAreaSettings },
  replaceServiceArea: { method: "PUT", path: "/service-area", auth: "owner", request: company.ServiceRadius, response: company.ServiceAreaSettings },
  getZipsNear: { method: "GET", path: "/zips-near", auth: "owner", query: company.ZipsNearQuery, response: company.ZipsNear },

  listPricingVersions: { method: "GET", path: "/pricing-versions", auth: "owner", response: company.PricingVersionList },
  createPricingVersion: { method: "POST", path: "/pricing-versions", auth: "owner", request: company.CreatePricingVersionRequest, response: company.PricingVersion },
  getPricingVersion: { method: "GET", path: "/pricing-versions/{id}", auth: "owner", response: company.PricingVersion },
  replacePricingVersion: { method: "PUT", path: "/pricing-versions/{id}", auth: "owner", request: company.ReplacePricingVersionRequest, response: company.PricingVersion, errors: { 409: "version_published" } },
  publishPricingVersion: { method: "POST", path: "/pricing-versions/{id}/publish", auth: "owner", request: company.PublishPricingVersionRequest, response: company.PricingVersion, errors: { 409: "version_published" } },
  diffPricingVersion: { method: "GET", path: "/pricing-versions/{id}/diff", auth: "owner", response: company.PricingVersionDiff },
  previewQuote: { method: "POST", path: "/pricing-versions/{id}/preview", auth: "owner", request: company.PreviewQuoteRequest, response: company.PreviewQuoteResponse },

  listLeads: { method: "GET", path: "/leads", auth: "owner", query: company.ListLeadsQuery, response: company.LeadList },
  getLead: { method: "GET", path: "/leads/{id}", auth: "owner", response: company.Lead },
  decideLead: { method: "POST", path: "/leads/{id}/decision", auth: "owner", request: company.LeadDecisionRequest, response: company.Lead, errors: { 409: "lead_already_decided" } },

  getUsage: { method: "GET", path: "/usage", auth: "owner", response: company.Usage },

  createBillingSession: { method: "POST", path: "/billing/session", auth: "owner", request: company.BillingSessionRequest, response: company.BillingSession, errors: { 503: "billing_unavailable" } },
} as const;

export const errorResponse = ErrorResponse;
