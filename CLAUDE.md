# InstaQuotesAI Platform

B2B SaaS: lawn and snow operators embed a widget (or share a hosted page) that gives homeowners an instant price from the lawn they outline on an aerial photo of their address (Mapbox) and the operator's own rate table. Launch market: Pennsylvania.

Source of truth for design decisions: `docs/ENGINEERING_DESIGN.md`. Legal, tax and licensing requirements (R1–R31): `docs/COMPLIANCE_REQUIREMENTS.md`. Read the relevant section before implementing a feature; update the Decisions table in the design doc when you make a call that isn't recorded there.

## Non-negotiables

- **Pricing is rules only.** Price = the company's published pricing version applied to an estimated grass area. No models, no learned parameters, no cross-tenant data, ever. (R20)
- **Pricing runs server-side in a pure package** (`packages/pricing`). The browser never receives a rate or a tier. The dashboard's "preview a quote" calls the same package.
- **Every service has a `taxable` flag; every quote stores line items; tax applies only to the taxable subtotal** at the county rate. Taxable and non-taxable lines are never merged. (R1–R4)
- **The lawn area is the homeowner's outline.** The widget finds the address with Mapbox, shows a satellite photo, and measures the outline in the browser; `/estimate` receives square feet (`manual.size.kind = "drawn"`). The lot-size form is always offered beside it, and is the path when the address is not found. No Regrid: the parcel lookup is retired on cost and no Regrid token is configured anywhere.
- **Nothing from Mapbox is stored or sent to our API.** Only the address's position is read, to aim the photo; the zip on a quote is the one the homeowner typed. (R16)
- **The tax county is the primary county of the zip** (`county_for_zip`); when a zip's counties are taxed differently the homeowner is asked which. Every estimate carries a zip. The quote shows the county. (R4)
- **An unknown county at pricing time routes to the manual path with an alert.** If the zip gives no county either, the homeowner is asked to call. Never a default tax rate. (R4)
- **`parcel_cache` is a cache, not a record**, and dormant since Regrid was retired. No foreign keys into it; it must be truncatable without touching a quote. The Regrid code path, the cache and the lookup meters stay until a cleanup step removes them. (R10)
- **Row Level Security on every company-scoped table**, keyed on `current_setting('app.company_id')`, with `FORCE ROW LEVEL SECURITY` and a non-owner application role. There are exactly three database entry points, all in `packages/db`: `withCompany(claims, fn)` for authenticated routes, `withPublic(companySlug, fn)` for the public routes, and `signUp(claims, company)`, which makes a new login's own company and does nothing else. Nothing else opens a transaction. The wrong-tenant test must pass before any feature merges.
- **Public routes run as `app_public`, with its own credentials.** That role has no table grants; it can read `public_company_profile` and call only the SECURITY DEFINER functions granted to it.
- **`company_id` comes from `company_members` by Cognito `sub`, server-side.** Never from a user-writable Cognito attribute.
- **Anyone may sign up, and a new company is on a trial.** A login must verify its email before it can create a company; the company starts with an allowance of 50 estimates a month (`companies.regrid_lookup_quota`, which now counts estimates priced) and no pricing, so nothing is quoted until its owner publishes a version.
- **Public routes (`/estimate`, `/submit`) always check Turnstile, origin allowlist and company quota before pricing.**
- **Secrets live only in Secrets Manager and Lambda env.** Nothing secret in the widget bundle or the dashboard. The Mapbox token the widget sends to browsers is a public token (`pk.`), restricted to our origins in the Mapbox account; the widget refuses to start with any other kind.
- **Widget and dashboard are separate origins** (`w.` and `app.`). Company theming is validated (hex color regex, logo from our S3 only, name escaped). No inline script in the widget CSP.
- **The homeowner quote is an estimate.** The CTA is "request service"; nothing on the quote screen reads as a contract. (R6)
- **Accessibility definition of done** on every front-end PR: labels and names present, keyboard operable, focus visible and managed, status announced, contrast from tokens, axe clean.

## Stack

- Front ends: Next.js on AWS Amplify Hosting; widget app at `w.<domain>/w/[company]`, dashboard at `app.<domain>`; embed script `widget.<domain>/v1.js` injects an iframe.
- API: API Gateway HTTP API behind CloudFront + WAF; Cognito JWT authorizer for dashboard routes.
- Compute: Lambda (Node 22, TypeScript) outside the VPC.
- Infrastructure: AWS CDK in `infra/` (stacks `LqState` and `LqApi`, us-east-2). Read `cdk diff` before every deploy; a change that replaces the database or the user pool is never deployed.
- Database: Aurora Serverless v2 PostgreSQL (17, express configuration, created by `infra/scripts/bootstrap-db.ts` while the AWS account is on the free plan) via RDS Data API; migrations are backward-compatible. Over the Data API, parameters are written into the statement as literals by `packages/db/src/sql-text.ts`: handler SQL stays `$1`-style, and nothing else builds SQL from values.
- Auth: Cognito user pool with self sign-up and email verification; password sign-in, an authenticator app optional; groups `admin` and `owner`. Text-message codes wait on a paid AWS plan and a registered sending number.
- External: Mapbox (address lookup and static satellite photo, called from the homeowner's browser; no map library), Cloudflare Turnstile, SES + SNS (lead alerts), AWS Monetization (private beta: companies' plans, checkout and invoices; replaces the planned Stripe Checkout).
- Components: React Aria Components (combobox, table, dialog). Lint: `eslint-plugin-jsx-a11y`. Tests: Vitest for `packages/pricing`, Playwright + `@axe-core/playwright` for routes.

## Conventions

- Monorepo: `apps/widget`, `apps/dashboard`, `packages/pricing`, `packages/api-contract` (zod schemas and types for every route), `packages/db` (schema, migrations, RLS tests), `services/lambdas`, `infra` (CDK).
- Database suites run twice: over node-postgres with bound parameters, and with the statement text and row shapes of the Data API (`LQ_TEST_DRIVER=data-api-sql`). A handler must pass both; select json with `fromJson` and arrays through `to_jsonb`.
- One branch per build step, always created from `main`. Never stack a branch on another open branch.
- Migrations are append-only after the step-1 commit: never edit a file in `packages/db/migrations`; add a new numbered one.
- Pricing versions are immutable once published; edits create version n+1; quotes pin the version id.
- Money is integer cents in the database and in `packages/pricing`; tax rates are integer basis points (600 for 6%). Format only at the edge.
- A request or response shape changes in `packages/api-contract` first; Lambdas validate with those schemas and the front ends use the inferred types.
- Never log PII (addresses, phones, emails). Log quote ids.
- Mapbox calls come from the homeowner's browser and are not metered by us: watch usage in the Mapbox account. The Regrid meters (`usage_meters.regrid_lookups`, the 8,000/month cap) are dormant.
- Pennsylvania seeds: services with taxable flags per 61 Pa. Code § 55.6; county tax rates 6% (7% Allegheny, 8% Philadelphia).
- A service area is county regions plus zip regions, each with a region group; a zip region wins over a county region. A "service area" in the dashboard is a region group; one made there is only a set of zip regions sharing a group, made from zip-code centre points (`zip_centroid`), never from a geocoded address.

## Build order

Follow the Build sequence in `docs/ENGINEERING_DESIGN.md`: schema + RLS + tests → pricing package → Cognito + dashboard shell → estimate and submit Lambdas → widget app and `v1.js` → abuse controls + billing → Playwright/axe + design-partner month.

## Commands

Run from the repo root (npm workspaces; Docker for the local database).

- `npm install`
- `npm run db:up` — start local PostgreSQL 16 on port 54320 (`db:down` to stop); connect as `app_owner`, never `postgres`
- `npm run db:migrate` — apply `packages/db/migrations` to `DATABASE_URL` (see `.env.example`)
- `npm test` — all workspace tests, including the wrong-tenant RLS suite (needs `db:up`)
- `npm run typecheck`
- `npm run synth -w @lq/infra` — synthesize the CDK stacks; deploying is in `docs/deploy.md`
- `npm run smoke -w @lq/infra` — check the deployed backend end to end (needs AWS credentials)
- `npm run db:seed`, then `npm run dev:api`, `dev:widget` and `dev:dashboard` — the local loop from widget to lead inbox (`docs/local-loop.md`)

CI (`.github/workflows/ci.yml`) runs typecheck, the migrations and all tests on every pull request.
