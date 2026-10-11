---
tags: [howto]
---

# Local loop: homeowner to contractor on one machine

Runs the widget, the real Lambda handlers and the dashboard against the local
database, so a quote requested in the widget shows up in the dashboard's lead
inbox. The design is in [[ENGINEERING_DESIGN]] (Decisions: "Local loop").

## What is real and what is not

| Piece | In the loop |
| --- | --- |
| `/estimate`, `/submit`, `/profile/{company}`, every dashboard route | The real handlers, through `withPublic` (as `app_public`) and `withCompany` (as `app_rw`) |
| Pricing, tax county, quotas, RLS | Real |
| Turnstile | Real calls to Cloudflare, with its published always-pass test keys |
| Mapbox | Real, from your browser, when `NEXT_PUBLIC_MAPBOX_TOKEN` is in `apps/widget/.env.local`: the address is found and the homeowner outlines the lawn on the aerial photo. Without it every address goes to the lot-size form |
| Regrid | Retired. No token is set, so it is never called |
| Sign-in | The dashboard's mock (no Cognito). The local API trusts its unsigned token, which is why it only listens on loopback and refuses a database that is not on this machine |
| Lead alerts | Composed, then noted in the API's console with the lead's link. Nothing is sent |

## One-time setup

From the repo root:

1. `npm install`
2. `npm run db:up`, then `npm run db:migrate`
3. `npm run db:seed` — enables the two application roles and creates **Nittany Lawn Care** (`nittany-lawn`): mowing (taxable) and leaf raking (not taxable) published as version 1, every Pennsylvania county as its service area, 200 Regrid lookups a month. Running it again changes nothing.
4. Copy `apps/widget/.env.example` to `apps/widget/.env.local` and `apps/dashboard/.env.example` to `apps/dashboard/.env.local`.
5. For the aerial photo, add your Mapbox public token to `apps/widget/.env.local` as `NEXT_PUBLIC_MAPBOX_TOKEN=pk....`. That file is ignored by git; never put the token in a tracked file.

## Run it

Three terminals, from the repo root:

- `npm run dev:api` — http://localhost:8787
- `npm run dev:widget` — http://localhost:3001/w/nittany-lawn
- `npm run dev:dashboard` — http://localhost:3000, sign in as `owner@nittanylawn.example`, any password, code `123456`

## Walk through it

1. Dashboard → Pricing: version 1 is current. Make a draft from it, change a rate, preview, publish.
2. Widget: pick a service, type a Pennsylvania address, outline the lawn on the aerial photo (or choose the lot size instead), get the estimate, request service.
3. Dashboard → Leads: the lead is there with the lines the homeowner saw. Accept, adjust or decline it.
4. Dashboard → Embed settings: add `http://localhost:3002` (or wherever a test page is served) to try an embedded widget; the hosted page needs no entry.

To go back to fixtures and the in-memory mock, delete the two `.env.local` files.

> [!warning] Mapbox calls count against your Mapbox account
> Each address lookup is one geocoding request, and each photo shown, zoomed
> or moved is one static image request. Both come from your browser with the
> public token; nothing is metered on our side.

> [!note] Tests share the cluster
> The test suites give `app_rw` and `app_public` the same local password the
> seed does, so `npm test` and the loop can run side by side.
