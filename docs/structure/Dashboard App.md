---
tags: [structure, frontend]
workspace: "@lq/dashboard"
path: apps/dashboard
---

# Dashboard app

`apps/dashboard` is a Next.js App Router app on the company's origin (`app.<domain>` in the design; `instaquotesai.com` as deployed). It holds two things on one origin: the public marketing site (home, about, contact, login) and the signed-in operator dashboard (leads, pricing, service area, embed settings). Design: [[ENGINEERING_DESIGN#11. Accessibility (WCAG 2.2 AA)|§11]] and the "Dashboard app", "Dashboard sign-in", "Cognito sign-in" and "Public website in the dashboard app" rows of the [[ENGINEERING_DESIGN#15. Decisions and open questions|Decisions table]].

Every signed-in screen is a client component. The Cognito ID token lives in `sessionStorage`, and every company-api call is made from the browser through `lib/api.ts`, which parses each response with [[API Contract Package|the contract's]] schema so a server that drifts fails here and not in a view. The dashboard never sees a database.

## Layout

```text
apps/dashboard/
├── src/app/
│   ├── layout.tsx                  root layout (the app is noindex)
│   ├── (site)/                     public website: server-rendered, indexable
│   │   ├── layout.tsx, site.css
│   │   ├── page.tsx                /         homepage
│   │   ├── about/page.tsx          /about
│   │   └── contact/page.tsx        /contact  (POST /contact, Turnstile-checked)
│   ├── login/page.tsx              /login → the sign-in screen
│   ├── sign-in/page.tsx            password, then an authenticator code if one is set up
│   ├── sign-up/page.tsx            Cognito self sign-up with an emailed code
│   ├── reset-password/page.tsx     Cognito forgot-password
│   ├── onboarding/page.tsx         name the company (POST /company) → service area
│   ├── (app)/                      the dashboard shell: nav, session keeper, focus on route change
│   │   ├── layout.tsx
│   │   ├── leads/page.tsx          /leads          the inbox: native table, cursor paging
│   │   ├── leads/[id]/page.tsx     /leads/{id}     one lead; accept, adjust or decline
│   │   ├── pricing/page.tsx        /pricing        versions list and the questionnaire editor
│   │   ├── pricing/[id]/page.tsx   /pricing/{id}   a draft's editor, or a published version
│   │   ├── settings/area/page.tsx  /settings/area  service areas: address + radius
│   │   ├── settings/embed/page.tsx /settings/embed snippet, hosted link, QR code, allowed sites
│   │   └── help/page.tsx
│   └── mock-api/[...path]/route.ts /mock-api/*     the in-app mock of the company-api
├── src/components/
│   ├── auth-provider.tsx           AuthProvider, useAuth, useApi; keeps drafts across a forced sign-out
│   ├── session-keeper.tsx          refresh while active, 2-minute warning, then sign out (2.2.1)
│   ├── providers.tsx               React Aria links through the Next router
│   ├── ui.tsx                      PageHeading, TextInput, SelectField, ErrorSummary, BusyButton, ConfirmDialog, toasts, StatusChip
│   ├── quote-lines.tsx             a quote's lines, tax and total
│   ├── questionnaire-editor.tsx    the company's customer questions; reorder by buttons (2.5.7)
│   └── pricing/
│       ├── editor.tsx              lawn-size categories, one flat rate each
│       ├── describe.tsx            a version in words
│       └── publish-dialog.tsx      the diff, then a confirmation
├── src/lib/
│   ├── api.ts                      createApi over the contract; ApiError; describeError
│   ├── auth/                       AuthClient interface; cognito-client, mock-client, mock-token, password, types
│   ├── pricing-form.ts             form model ↔ PricingVersionContent; errors named by field id
│   ├── tiers.ts                    overlap check: the same rule as the database's exclusion constraint
│   ├── money.ts, format.ts         integer cents ↔ display, only at the edge
│   ├── qr.ts                       QR modules for the hosted-page link, made in the browser
│   ├── pa-counties.ts              the 67 counties, for quote previews
│   ├── tokens.ts, contrast.ts      design tokens with contrast checks
│   └── use-load.ts                 load / reload / set
├── src/mock/                       the in-memory company-api: store.ts, handlers.ts, diff.ts
├── e2e/                            Playwright + axe on every route (port 3100, LQ_MOCK=1)
├── test/                           Vitest: cognito-client, lib, mock-api, qr
├── next.config.ts                  the mock switch, public env, headers, canonical redirect
└── playwright.config.ts
```

## Authentication

`lib/auth/client.ts` picks the `AuthClient`:

| Condition | Client |
| --- | --- |
| `NEXT_PUBLIC_LQ_MOCK=1` (always in `next dev`; `LQ_MOCK=1` at build time) | `mock-client.ts`: one seeded owner (`owner@nittanylawn.example`, any password, code `123456`), sign-ups that last until the page reloads |
| Both Cognito variables set | `cognito-client.ts`: SRP password sign-in with `amazon-cognito-identity-js`, an authenticator step when one is set up, refresh, reset |
| Neither | Every sign-in is refused |

The company is never chosen in the browser: the API resolves it from the token's `sub` through `company_members` ([[Database Package#withCompany|withCompany]]). A signed-in login with no company is sent to `/onboarding` from anywhere in the app; a new company then goes on to the service area screen.

## The mock

`src/mock/handlers.ts` answers every `auth: "owner"` route in the contract from `src/mock/store.ts`, validating requests and parsing responses with the contract's schemas and running previews through [[Pricing Package|packages/pricing]], so the mock cannot drift from the contract. It is served at `/mock-api/*` only when the mock switch is on; any other build answers 404 there. The store's seeded company mirrors the demonstration company that `services/lambdas/dev/demo-company.ts` creates in a real database. When a real handler changes behavior, the mock is updated with it.

## Screens worth knowing

- **Pricing editor** (`components/pricing/editor.tsx`, `lib/pricing-form.ts`): one service, mowing, priced by lawn-size categories with a flat rate each. Categories are contiguous by construction (each row has only an upper bound) and are written as flat tiers in every region group the company has. Publishing is two steps: the diff against the current version, then a confirmation; rollback copies an old version into a new draft.
- **Lead inbox** (`(app)/leads`): a native `<table>` with `<th scope>` and `aria-sort`, not React Aria's grid, so Tab reaches the row actions. Pages by cursor; sorts only the page on screen.
- **Service area** (`(app)/settings/area`): lists the company's areas (one per region group), removes one, and creates one from a name, a typed address and a distance (`GET /zips-near`, then `PUT /regions`). The address is never geocoded (R16).
- **Embed settings** (`(app)/settings/embed`): the script snippet, the hosted-page link and its QR code (drawn with `qrcode-generator`, downloadable as PNG), and an optional "limit to your own sites" list.

## Environment

`LQ_MOCK`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_COGNITO_USER_POOL_ID`, `NEXT_PUBLIC_COGNITO_CLIENT_ID`, `NEXT_PUBLIC_WIDGET_SCRIPT_ORIGIN`, `NEXT_PUBLIC_WIDGET_APP_ORIGIN`, `LQ_CANONICAL_ORIGIN`. None is a secret. See [[Configuration]].

Headers on every response: `frame-ancestors 'none'` (the dashboard is never framed), `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS.

## Tests

`npm test -w @lq/dashboard` needs no database. `npm run test:e2e -w @lq/dashboard` builds with `LQ_MOCK=1`, serves on port 3100 with one worker (the mock holds one company, reset between tests), and runs every route through axe in both color schemes. See [[Testing and CI]].

Related: [[Lambdas]] (the company-api on the other end), [[Request Flows]].
