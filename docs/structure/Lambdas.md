---
tags: [structure, backend]
workspace: "@lq/lambdas"
path: services/lambdas
---

# Lambdas

`services/lambdas` is the API: one handler file per Lambda function, the modules behind them, a local server that stands in for the AWS plumbing, and the handler test suites. Design: [[ENGINEERING_DESIGN#5. Estimate and lead flow|§5]], [[ENGINEERING_DESIGN#9. Public routes and abuse controls|§9]], [[ENGINEERING_DESIGN#10. Threat model|§10]].

Every handler validates its body with [[API Contract Package|the contract]], reaches the database only through one of the three entry points in [[Database Package]], and prices only with [[Pricing Package]]. Nothing here logs an address, a phone number, an email or a name; logs carry quote and lead ids.

## Layout

```text
services/lambdas/
├── src/
│   ├── handlers/                 Lambda entry points: each re-exports one function from runtime.ts
│   │   ├── estimate.ts           POST /estimate
│   │   ├── submit.ts             POST /submit
│   │   ├── profile.ts            GET /profile/{company}
│   │   ├── contact.ts            POST /contact
│   │   ├── company-api.ts        every owner route, behind the Cognito authorizer
│   │   └── migrate.ts            no route: invoked by hand after a deploy
│   ├── runtime.ts                wiring for AWS: env, secrets read once per cold start, the two DB clients
│   ├── http.ts                   HttpError, json, parseBody, validate, respond, fromJson; error code → status
│   ├── log.ts                    one JSON line per event, for CloudWatch metric filters
│   ├── billing.ts                the seam a billing provider would plug into (none configured)
│   ├── public/                   the anonymous routes
│   │   ├── estimate.ts           createEstimateHandler
│   │   ├── submit.ts             createSubmitHandler, isHoneypotHit
│   │   ├── profile.ts            createProfileHandler
│   │   ├── contact.ts            createContactHandler, renderContactEmail
│   │   ├── db.ts                 typed calls to the SECURITY DEFINER functions of migration 0009
│   │   ├── deps.ts               PublicDeps: everything that touches the outside world, injected
│   │   ├── edge.ts               the CloudFront origin-verify header and x-viewer-ip
│   │   ├── grass.ts              pure: manual sizes, round100, address normalizing, zip parsing
│   │   ├── token.ts              the signed quote token (HMAC-SHA256, 7 days)
│   │   ├── turnstile.ts          Cloudflare verification: ok, failed or unavailable
│   │   ├── notify.ts             lead alerts: SES email, SNS SMS behind a flag
│   │   └── regrid.ts             the retired parcel lookup; never called (no token anywhere)
│   └── company/                  the owner routes
│       ├── api.ts                createCompanyApi: claims from the JWT, one withCompany per request, routing on the route key
│       ├── company.ts            company, regions, zips-near, questionnaire, service area, usage
│       ├── leads.ts              list, get, decide
│       └── pricing-versions.ts   list, get, create, replace, publish, diff, preview
├── dev/                          the local loop; never deployed
│   ├── server.ts                 one HTTP server on loopback: routes from the contract, CORS, trusts the mock token
│   ├── seed.ts                   enables app_rw and app_public locally, creates the demo company
│   ├── demo-company.ts           Nittany Lawn Care (nittany-lawn): mowing and leaf raking published, every PA county
│   └── env.ts                    local settings and the shared local role password
├── test/
│   ├── harness.ts                a throwaway database with the real roles
│   ├── public.test.ts            /estimate, /submit, /profile, /contact against it
│   ├── company-api.test.ts       every owner route against it
│   └── unit.test.ts              the pure modules
├── vitest.config.ts              and vitest.data-api.config.ts: the suites run twice
└── package.json
```

## The public functions

`runtime.ts` builds `PublicDeps` once per cold start: `withPublic` connected as `app_public`, the Turnstile verifier, the token codec, the notifier, the IP-hash salt, the edge settings, a null Regrid lookup and a null billing seam. Tests build the same handlers with fakes.

**`/estimate`** runs its checks cheapest first: contract validation, Turnstile, then one `withPublic` transaction for the origin allowlist, the company's allowance, the service and the service region (`estimate_context`). For a drawn or manual size it resolves the tax county from the zip (`counties_for_zip`, answering `county_required` when the zip's counties are taxed differently and the request did not choose), loads only the tiers of that service and region group (`estimate_pricing_input`), calls `priceQuote`, inserts the quote with the pinned version id (`estimate_insert_quote`), and returns the lines with a signed token. The browser gets amounts and a token, never a rate. When Cloudflare cannot be reached the estimate still prices, with `turnstile_ok = false`.

**`/submit`** verifies Turnstile and the token, turns the quote into a lead (`submit_lead`), composes the alert email (and an SMS when `SMS_ALERTS_ENABLED`) and marks the lead notified. A filled honeypot gets a success answer and stores nothing. A contact that already sent the company a lead in the last 24 hours gets a row but no second alert. A failed alert never fails the submit.

**`/profile/{company}`** needs no Turnstile and counts against no allowance: it returns the name, validated theme, published services and allowed origins the widget page renders from, cacheable for 60 seconds. An unknown slug is a 404.

**`/contact`** has no database login. It checks Turnstile and the honeypot and emails the message through SES to `CONTACT_TO`, answering 503 `contact_unavailable` when none is set or the send fails, so the form never claims a message went out when it did not.

## company-api

One function for every owner route, switching on the HTTP API route key (`"GET /leads"` and so on). `claimsFrom` reads `sub` and `cognito:groups` from the authorizer's verified claims; `withCompany` opens one transaction per request with `app.company_id` set, and the handler's SQL names no company because RLS already narrowed every table. `POST /company` is the exception: a login with no company goes through `signUp` instead, and only with a verified email claim. The `admin` group may act as another company with the `x-act-as-company` header, which `withCompany` checks and audits.

Database errors are translated here: SQLSTATE `55000` (a published version changed) becomes 409 `version_published`; `LQ001` (a lead decided twice) becomes 409 `lead_already_decided`; a malformed or foreign id is a 404. A version with no service or no tier cannot be published.

## migrate

Not routed. Invoked with `aws lambda invoke` after a deploy. It is the only function holding the schema owner's login: it applies pending migrations one statement at a time over the Data API, then gives `app_rw` and `app_public` the passwords in their own secrets (`ALTER ROLE … LOGIN PASSWORD`, written as a literal). The `.sql` files reach it in a Lambda layer (`MIGRATIONS_DIR`).

## billing.ts

The seam: `Billing` has `entitlement(company)` (`allow`, `deny` or `none`), `estimatePriced(company)` and `page(company, "plans" | "portal", returnUrl)`. With no provider the functions run with billing null and the database allowance (`companies.regrid_lookup_quota`) alone decides; `POST /billing/session` answers 503. A billing outage never takes the widget down.

## Environment

Read by `runtime.ts`; the full table is in [[Configuration]]. On AWS the secrets come from Secrets Manager (`SECRETS_ARN`) and the database through the Data API (`DB_RESOURCE_ARN`, `DB_NAME`, `DB_PUBLIC_SECRET_ARN`, `DB_RW_SECRET_ARN`); locally the same secret names can be set directly and `DATABASE_URL_PUBLIC` / `DATABASE_URL_RW` point at plain PostgreSQL.

## Tests

`npm test -w @lq/lambdas` runs the handler suites against a real local database (through `test/harness.ts`) with a fake Turnstile, Regrid and notifier, and runs them again with the Data API's statement text and row shapes. See [[Testing and CI]].

Related: [[Request Flows]], [[Infrastructure]] (how these become functions), [[local-loop]].
