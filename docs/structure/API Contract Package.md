---
tags: [structure, package]
workspace: "@lq/api-contract"
path: packages/api-contract
---

# API contract package

`packages/api-contract` is the wire contract: one zod schema per request and response, and a `routes` table that names every route's method, path, auth mode, schemas and route-specific errors. The Lambdas validate with the schemas on the way in and out; both front ends use the inferred types (the widget imports types only, so zod stays out of its bundle); the CDK stack reads `routes` to build the HTTP API. It depends on zod alone. A request or response shape changes here first.

Schemas are `strictObject`, so a response cannot carry a field the contract does not name. The public schemas name no rate, tier or region group: the browser only ever learns amounts and whether tax applies. Wire fields are camelCase.

## Files

| File | Holds |
| --- | --- |
| `src/common.ts` | Primitives (`Uuid`, `Cents`, `Sqft`, `CompanySlug`, `ServiceCode`, `RegionGroup`, `Zip`, `County`, `Origin`), `Theme`, `QuoteStatus`, `QuoteOrigin`, `QuoteLine`, `QuoteTotals`, `ErrorCode`, `ErrorResponse` |
| `src/public.ts` | The anonymous routes: `ManualSize`, `ManualEntry`, `EstimateRequest` / `EstimateResponse`, `Contact`, `SubmitRequest` / `SubmitResponse`, `ContactRequest` / `ContactResponse`, `PublicProfile` |
| `src/company.ts` | The owner routes: company, regions, zips-near, questionnaire, service area, pricing versions with their diff and preview, leads and decisions, usage, billing session |
| `src/index.ts` | Re-exports everything and defines `routes` |
| `test/contract.test.ts` | Vitest |

## Routes

`auth: "public"` routes go through `withPublic`; `auth: "owner"` routes through `withCompany` (see [[Database Package]]). No owner request names a company; it comes from the token.

| Key | Route | Auth | Notes |
| --- | --- | --- | --- |
| `estimate` | `POST /estimate` | public | A new estimate (address and service, with `manual` after a `manual_required` answer), or an adjustment by token |
| `submit` | `POST /submit` | public | Token and contact → a lead; honeypot field `website` |
| `sendContact` | `POST /contact` | public | The website's contact form; 503 `contact_unavailable` with no inbox |
| `getProfile` | `GET /profile/{company}` | public | What the widget page is rendered from |
| `getCompany`, `updateCompany` | `GET`, `PATCH /company` | owner | Name, HIC number, allowed origins, theme |
| `createCompany` | `POST /company` | owner | A new login's first call; 409 `conflict` if it already has a company |
| `getRegions`, `replaceRegions` | `GET`, `PUT /regions` | owner | Zip and county regions with their region group; `PUT` replaces the list |
| `getQuestionnaire`, `replaceQuestionnaire` | `GET`, `PUT /questionnaire` | owner | Up to 20 yes/no or choice questions, replaced as a whole |
| `getServiceArea`, `replaceServiceArea` | `GET`, `PUT /service-area` | owner | Business address and radius → zip regions in group `standard` |
| `getZipsNear` | `GET /zips-near?zip=&miles=` | owner | Zips whose centre points lie within the distance, nearest first |
| `listPricingVersions`, `createPricingVersion` | `GET`, `POST /pricing-versions` | owner | A new draft is empty or copied from a version (`copyFrom`) |
| `getPricingVersion`, `replacePricingVersion` | `GET`, `PUT /pricing-versions/{id}` | owner | `PUT` replaces a draft's content; 409 `version_published` otherwise |
| `publishPricingVersion` | `POST /pricing-versions/{id}/publish` | owner | `{ confirm: true }`; two-step in the UI |
| `diffPricingVersion` | `GET /pricing-versions/{id}/diff` | owner | A draft against the current published version |
| `previewQuote` | `POST /pricing-versions/{id}/preview` | owner | Runs [[Pricing Package|packages/pricing]] on a draft or published version |
| `listLeads`, `getLead` | `GET /leads`, `GET /leads/{id}` | owner | Cursor paging on `(created_at, id)` |
| `decideLead` | `POST /leads/{id}/decision` | owner | `accept`, `adjust` (with `adjustedTotalCents`), `decline`; 409 `lead_already_decided` |
| `getUsage` | `GET /usage` | owner | This month's estimates against the allowance |
| `createBillingSession` | `POST /billing/session` | owner | 503 `billing_unavailable` until a provider exists |

## The estimate response

`EstimateResponse` is a discriminated union on `status`:

| Status | Meaning |
| --- | --- |
| `priced` | `quote` (lines and totals), `token` (signed; send back on `/submit`), `grassSqft`, `parcelSqft` (null without a parcel), `origin`, `county`, `assumptions[]`, `canAdjust` |
| `manual_required` | No automatic price; show the lot-size form, then call again with `manual`. Reasons: `no_match`, `ambiguous_match`, `parcel_over_two_acres`, `lookup_unavailable`, `unknown_county` |
| `county_required` | The zip spans counties taxed differently; `candidates` lists them (no rates), then repeat with `manual.county` |
| `call_us` | `outside_service_area`, `no_price_for_size` or `unknown_county`, with the company's phone |

`ManualSize` is `drawn` (the outline's area, 100 to 2,000,000 sq ft), `bucket` (`quarter_acre` to `two_plus_acres`) or `sqft` (typed). `ManualEntry` always carries the zip, which decides the tax county.

## Errors

Every non-2xx body is `ErrorResponse`: `{ error: { code, message, fields? } }`, where `message` is for logs and developers, not for display. The codes map to HTTP statuses in `services/lambdas/src/http.ts`:

| Status | Codes |
| --- | --- |
| 400 | `invalid_request` (with `fields`), `token_invalid` |
| 401 / 403 | `unauthenticated`; `forbidden`, `turnstile_failed`, `origin_not_allowed` |
| 404 / 409 / 410 | `not_found`; `conflict`, `version_published`, `lead_already_decided`; `token_expired` |
| 429 | `quota_exceeded`, `rate_limited` |
| 503 / 500 | `billing_unavailable`, `contact_unavailable`; `internal` |

Related: [[Lambdas]], [[Infrastructure]], [[Widget App]], [[Dashboard App]].
