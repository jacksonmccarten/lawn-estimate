---
tags: [structure, config]
---

# Configuration

Where every setting comes from, by workspace. Nothing in either front end is secret; the Lambdas' secrets come from Secrets Manager; the CDK context is public. Deploy-time steps are in [[deploy]], local values in [[local-loop]].

## Origins and ports

| Piece | Deployed | Local |
| --- | --- | --- |
| Dashboard and public website | `https://instaquotesai.com` on Amplify (`app.<domain>` in the design) | `http://localhost:3000` |
| Widget app and `v1.js` | `https://w.instaquotesai.com` on Amplify (the design also names `widget.<domain>` for the script) | `http://localhost:3001` |
| API | API Gateway's execute-api address; `https://api.instaquotesai.com` behind CloudFront when the edge context is set | `http://localhost:8787` (`dev/server.ts`) |
| Database | Aurora through the RDS Data API | `postgres://app_owner:app_owner@localhost:54320/lawnquote` |
| Playwright servers | | dashboard 3100; widget 3101, its host page 3102, widget with a Mapbox stub 3103 |

## Widget (`apps/widget`)

Read on the server per request, so one build serves every environment. Local values are in `.env.example`, copied to `.env.local`.

| Variable | Meaning |
| --- | --- |
| `LQ_FIXTURES` | `1` serves profiles, `/estimate` and `/submit` from `fixtures/`. The default in `next dev`; must be set explicitly anywhere else |
| `LQ_API_BASE` | Where the browser posts `/estimate` and `/submit` and the server reads `/profile/{company}`. Required without fixtures |
| `LQ_TURNSTILE_SITE_KEY` | The Turnstile site key (Cloudflare's always-pass test key locally) |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | A Mapbox public token (`pk.`), restricted to the widget's origins in the Mapbox account. Without it there is no photo screen; with any other kind of token the app refuses to start. Never in a tracked file |
| `LQ_LOGO_BASE_URL` | The CDN in front of the logo bucket; without it no logo is shown |
| `LQ_WIDGET_ORIGIN` | Build time, for `v1.js` only: the widget app's origin when the script is served from another host |
| `LQ_CANONICAL_ORIGIN` | Build time: every other host redirects here for good |

## Dashboard (`apps/dashboard`)

Baked in at build time through `next.config.ts`.

| Variable | Meaning |
| --- | --- |
| `LQ_MOCK` | `1` turns the mock sign-in and mock company-api on in a production build (Playwright does this). Never on a deployed branch |
| `NEXT_PUBLIC_API_BASE_URL` | The company-api; `/mock-api` when the mock is on |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID`, `NEXT_PUBLIC_COGNITO_CLIENT_ID` | Outputs of `LqApi`. Both set with the mock off: Cognito sign-in. Neither: every sign-in refused |
| `NEXT_PUBLIC_WIDGET_SCRIPT_ORIGIN`, `NEXT_PUBLIC_WIDGET_APP_ORIGIN` | Shown in the embed snippet and the hosted-page link |
| `LQ_CANONICAL_ORIGIN` | Build time: every other host redirects here for good |

## Lambdas (`services/lambdas/src/runtime.ts`)

| Variable | On AWS | Locally |
| --- | --- | --- |
| `SECRETS_ARN` | Comma-separated Secrets Manager ARNs that between them hold `TURNSTILE_SECRET`, `QUOTE_TOKEN_SECRET`, `IP_HASH_SALT` and `ORIGIN_VERIFY_SECRET` | Each may be set directly in the environment |
| `DB_RESOURCE_ARN`, `DB_NAME`, `DB_PUBLIC_SECRET_ARN`, `DB_RW_SECRET_ARN` | Aurora through the Data API, as `app_public` and `app_rw` | `DATABASE_URL_PUBLIC` and `DATABASE_URL_RW` instead |
| `WIDGET_ORIGIN` | The only browser origin `/estimate` and `/submit` answer | |
| `DASHBOARD_URL` | Links in lead alerts | |
| `SES_FROM`, `CONTACT_TO` | The verified sender; where the contact form goes (unset: 503 `contact_unavailable`) | Alerts are printed, not sent |
| `SMS_ALERTS_ENABLED` | `"true"` once 10DLC registration clears; off today | |
| `ORIGIN_VERIFY_ENFORCE` | `"true"` refuses public requests that skipped CloudFront | Not checked |
| `MIGRATIONS_DIR`, `DB_OWNER_SECRET_ARN` | The `migrate` function only | |
| `REGRID_BASE_URL` | Optional override for the retired lookup; no token exists anywhere | |

## CDK context (`infra/cdk.json`)

| Context | Meaning |
| --- | --- |
| `region` | `us-east-2` |
| `widgetOrigin`, `dashboardOrigin` | CORS, the widget-origin check, links in alerts |
| `sesFrom`, `contactTo` | The SES sender; the contact-form inbox (optional) |
| `databaseSnapshot` | The snapshot `LqState`'s cluster was restored from. Never change it: a new value replaces the database |
| `databaseClusterArn` | The pre-move cluster; read by `snapshot-db` only |
| `apiDomain`, `zoneName`, `hostedZoneId`, `originVerify` | Together they turn on `LqEdge` and CloudFront. Not set as committed (see [[Infrastructure]]) |

## Secrets (Secrets Manager, made by `LqState`)

A generated login per database role (`app_owner`, `app_rw`, `app_public`); the Turnstile secret (Cloudflare's test secret, which passes every token, until replaced by hand); the quote-token key; the IP-hash salt; the CloudFront origin-verify secret; the database admin password, for emergencies. Each Lambda's role can read only the secrets it is given in `infra/lib/api-stack.ts`.

## The database allowance

A company's monthly estimate allowance is `companies.regrid_lookup_quota`: 5 for a new company, 200 for the demonstration company, raised by hand for a company that needs more. `services/lambdas/src/billing.ts` is the seam a billing provider would plug into; none is configured.

Related: [[Repository Root]], [[Infrastructure]], [[Lambdas]], [[Widget App]], [[Dashboard App]].
