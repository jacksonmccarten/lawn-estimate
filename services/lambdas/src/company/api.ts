// The company-api Lambda: every dashboard route, behind the Cognito JWT
// authorizer. One transaction per request, opened by withCompany, which
// resolves the company from the caller's sub. No request names a company.

import {
  BillingSessionRequest,
  CreateCompanyRequest,
  CreatePricingVersionRequest,
  LeadDecisionRequest,
  ListLeadsQuery,
  PreviewQuoteRequest,
  PublishPricingVersionRequest,
  Regions,
  ServiceRadius,
  ReplacePricingVersionRequest,
  routes,
  UpdateCompanyRequest,
  Uuid,
  ZipsNearQuery,
} from "@lq/api-contract";
import type { Claims, DbTx, WithCompany, WithSignup } from "@lq/db";
import type { z } from "zod";
import type { Billing } from "../billing.js";
import { HttpError, json, parseBody, respond, validate, type HttpEvent, type HttpResult } from "../http.js";
import * as company from "./company.js";
import * as leads from "./leads.js";
import * as versions from "./pricing-versions.js";

/** Staff in the admin group name the company to act as here. withCompany checks the group and audits the use. */
const ACT_AS_HEADER = "x-act-as-company";

/**
 * The verified claims API Gateway passes on. An HTTP API flattens the
 * cognito:groups array into a string such as "[admin owner]".
 */
export function claimsFrom(event: HttpEvent): Claims {
  const claims = (event.requestContext as { authorizer?: { jwt?: { claims?: Record<string, unknown> } } }).authorizer?.jwt
    ?.claims;
  const sub = claims?.sub;
  if (typeof sub !== "string" || sub === "") throw new HttpError("unauthenticated", "sign in to use this route");
  const raw = claims?.["cognito:groups"];
  const groups = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.replace(/^\[|\]$/g, "").split(/[\s,]+/).filter(Boolean)
      : [];
  return { sub, groups };
}

type Run = <T>(fn: (tx: DbTx, companyId: string) => Promise<T>) => Promise<T>;

/** The login's address, if Cognito has verified it. An HTTP API passes every claim as a string. */
function verifiedEmail(event: HttpEvent): string | null {
  const claims = (event.requestContext as { authorizer?: { jwt?: { claims?: Record<string, unknown> } } }).authorizer?.jwt?.claims;
  return String(claims?.email_verified) === "true" && typeof claims?.email === "string" ? claims.email : null;
}

export type CompanyApiDeps = {
  withCompany: WithCompany;
  signUp: WithSignup;
  /** Null when AWS Monetization is not configured: the billing route answers 503. */
  billing: Billing | null;
  /** https://app.<domain>: where a hosted billing page sends the owner back to. */
  dashboardOrigin: string;
};

export function createCompanyApi(deps: CompanyApiDeps) {
  return (event: HttpEvent): Promise<HttpResult> =>
    respond(async () => {
      const claims = claimsFrom(event);
      const actAs = event.headers?.[ACT_AS_HEADER];
      const options = actAs === undefined ? undefined : { asCompanyId: validate(Uuid, actAs) };
      const run: Run = (fn) => deps.withCompany(claims, fn, options);

      // A malformed id names nothing, like an unknown one.
      const id = (): string => {
        const parsed = Uuid.safeParse(event.pathParameters?.id);
        if (!parsed.success) throw new HttpError("not_found", "no such resource");
        return parsed.data;
      };
      const body = <T extends z.ZodType>(schema: T) => validate(schema, parseBody(event));
      // The response schema is strict, so only what the contract names is sent.
      const ok = (schema: z.ZodType, value: unknown, status = 200) => json(status, schema.parse(value));

      switch (event.routeKey) {
        case "GET /company":
          return ok(routes.getCompany.response, await run((tx) => company.getCompany(tx)));
        case "PATCH /company": {
          const patch = body(UpdateCompanyRequest);
          return ok(routes.updateCompany.response, await run((tx, companyId) => company.updateCompany(tx, companyId, patch)));
        }
        case "POST /company": {
          // The one route for a login with no company yet: it makes theirs.
          const { name } = body(CreateCompanyRequest);
          const email = verifiedEmail(event);
          if (!email) throw new HttpError("forbidden", "verify your email address first");
          await deps.signUp({ sub: claims.sub, email }, { name });
          return ok(routes.createCompany.response, await run((tx) => company.getCompany(tx)), 201);
        }
        case "GET /regions":
          return ok(routes.getRegions.response, await run((tx) => company.getRegions(tx)));
        case "PUT /regions": {
          const regions = body(Regions);
          return ok(routes.replaceRegions.response, await run((tx, companyId) => company.replaceRegions(tx, companyId, regions)));
        }

        case "GET /service-area":
          return ok(routes.getServiceArea.response, await run((tx) => company.getServiceArea(tx)));
        case "PUT /service-area": {
          const radius = body(ServiceRadius);
          return ok(routes.replaceServiceArea.response, await run((tx, companyId) => company.replaceServiceArea(tx, companyId, radius)));
        }

        case "GET /zips-near": {
          const query = validate(ZipsNearQuery, event.queryStringParameters ?? {});
          return ok(routes.getZipsNear.response, await run((tx) => company.zipsNear(tx, query)));
        }

        case "GET /pricing-versions":
          return ok(routes.listPricingVersions.response, await run((tx) => versions.listVersions(tx)));
        case "POST /pricing-versions": {
          const { copyFrom } = body(CreatePricingVersionRequest);
          const created = await run((tx, companyId) => versions.createVersion(tx, companyId, copyFrom));
          return ok(routes.createPricingVersion.response, created, 201);
        }
        case "GET /pricing-versions/{id}": {
          const versionId = id();
          return ok(routes.getPricingVersion.response, await run((tx) => versions.getVersion(tx, versionId)));
        }
        case "PUT /pricing-versions/{id}": {
          const versionId = id();
          const content = body(ReplacePricingVersionRequest);
          return ok(
            routes.replacePricingVersion.response,
            await run((tx, companyId) => versions.replaceVersion(tx, companyId, versionId, content)),
          );
        }
        case "POST /pricing-versions/{id}/publish": {
          const versionId = id();
          body(PublishPricingVersionRequest);
          return ok(routes.publishPricingVersion.response, await run((tx) => versions.publishVersion(tx, versionId)));
        }
        case "GET /pricing-versions/{id}/diff": {
          const versionId = id();
          return ok(routes.diffPricingVersion.response, await run((tx) => versions.diffVersion(tx, versionId)));
        }
        case "POST /pricing-versions/{id}/preview": {
          const versionId = id();
          const preview = body(PreviewQuoteRequest);
          return ok(routes.previewQuote.response, await run((tx) => versions.previewQuote(tx, versionId, preview)));
        }

        case "GET /leads": {
          const query = validate(ListLeadsQuery, event.queryStringParameters ?? {});
          return ok(routes.listLeads.response, await run((tx) => leads.listLeads(tx, query)));
        }
        case "GET /leads/{id}": {
          const leadId = id();
          return ok(routes.getLead.response, await run((tx) => leads.getLead(tx, leadId)));
        }
        case "POST /leads/{id}/decision": {
          const leadId = id();
          const decision = body(LeadDecisionRequest);
          return ok(routes.decideLead.response, await run((tx) => leads.decideLead(tx, leadId, decision)));
        }

        case "GET /usage":
          return ok(routes.getUsage.response, await run((tx) => company.getUsage(tx)));

        case "POST /billing/session": {
          const { page } = body(BillingSessionRequest);
          if (!deps.billing) throw new HttpError("billing_unavailable", "billing is not configured");
          // The subscriber is the caller's own company; nothing in the request names one.
          const { slug } = await run((tx) => company.getCompany(tx));
          // The return address is ours, never the request's: no open redirect.
          let url: string;
          try {
            url = await deps.billing.page(slug, page, `${deps.dashboardOrigin}/billing`);
          } catch (err) {
            throw new HttpError("billing_unavailable", `AWS Monetization did not answer: ${(err as Error).name}`);
          }
          return ok(routes.createBillingSession.response, { url });
        }

        default:
          throw new HttpError("not_found", "no such route");
      }
    });
}
