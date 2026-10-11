# Widget app

`/w/[company]` (the widget, and the hosted page when nothing embeds it) and the `v1.js` embed script. Design: `docs/ENGINEERING_DESIGN.md` sections 4, 5 and 11.

```html
<script src="https://widget.example.com/v1.js" data-company="joes-lawn" async></script>
```

Put the tag where the widget should appear; the iframe is inserted right after it.

## Commands

Run from `apps/widget`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Builds `v1.js`, then `next dev` on port 3001 with fixtures on. Open `/w/joes-lawn`. |
| `npm run build` | Builds `public/v1.js` and the app. |
| `npm test` | Vitest: contrast and tokens, the CSP builder, profile validation, and every fixture against `packages/api-contract`. |
| `npm run test:e2e` | Playwright with axe at 390 px against a production build (ports 3101 and 3102). First run: `npx playwright install chromium`. |
| `npm run lint` | ESLint with `jsx-a11y` (strict) and `react-hooks`. |

The app builds with webpack (`--webpack`): Turbopack in Next 16.4 does not resolve the `./x.js` imports in `packages/api-contract`'s TypeScript source.

## Environment

Read on the server per request; none of it is secret.

| Variable | Meaning |
| --- | --- |
| `LQ_FIXTURES` | `1` serves profiles, `/estimate` and `/submit` from `fixtures/`. Default in development; must be set explicitly anywhere else. |
| `LQ_API_BASE` | Where the browser posts `/estimate` and `/submit`, and where this app's server reads `/profile/{company}`, e.g. `https://api.example.com`. Required without fixtures. |
| `LQ_TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key. Required without fixtures. |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | A Mapbox **public** token (`pk.`), restricted to this app's origins in the Mapbox account. With it, the address leads to an aerial photo the homeowner outlines the lawn on; without it, to the lot-size form. Any other kind of token stops the app from starting. Locally: `apps/widget/.env.local`, which git ignores. |
| `LQ_LOGO_BASE_URL` | Origin of the CDN in front of the logo bucket. Without it no logo is shown. |
| `LQ_WIDGET_ORIGIN` | Build time, for `v1.js` only: the widget app's origin (`https://w.example.com`). Unset, the script uses the origin it was loaded from. |

## Against the real handlers

`.env.example` holds the settings for the local loop: copy it to `.env.local` and run the local API (`npm run dev:api` from the repo root). Company profiles then come from `GET /profile/{company}`. See `docs/local-loop.md`.

## Aerial photo

`src/lib/mapbox.ts` makes the only two Mapbox calls, both from the browser: one geocoding request for the typed address, and static satellite images. `src/components/YardScreen.tsx` draws the outline in SVG over the image; there is no map library. Each view fetches two pictures: the one shown, with Mapbox's logo and credit, and a wider one behind it that a drag brings into view. The photo is moved with one button in its corner (drag it, tap it then the photo, or arrow keys) and zoomed with two more. Nothing from Mapbox is sent to our API or stored: the request carries the outline's area in square feet and the zip the homeowner typed. `e2e/yard.spec.ts` runs the screen against a stubbed Mapbox on a second server (port 3103).

## Fixtures

Nothing here calls Regrid, and no pricing happens in this app. `fixtures/estimate.json` and `fixtures/submit.json` are request/response pairs written to the contract (the Lambdas of step 4 do not exist yet, so they are not captures of a live API); `npm test` parses every one with the contract's schemas and checks that each price adds up.

| Type this | You get |
| --- | --- |
| `412 Maple Ave, Lancaster, PA 17601` | A price (mowing: taxable; leaf raking: not taxable), adjustable once |
| `88 Ridge Rd, Pittsburgh, PA 15237` (mowing) | A price at Allegheny's 7%, with "includes the house footprint" |
| `1 Farm Ln, Kutztown, PA 19530` (mowing) | Manual path: parcel over two acres |
| `7 Ridge Ave, Philadelphia, PA 19128` (mowing) | Manual path; zip 19128 then asks Philadelphia or Montgomery County |
| `500 Market St, Wilmington, DE 19801` (mowing) | "Please call": outside the service area |
| Anything else | Manual path: no match |

An outlined lawn is priced for zip 17601 only (the `drawn-17601` recording). On the manual path, zips 17601, 19530 and 19128 are priced; any other zip answers "please call" (no county on file), whatever lot size is chosen.

Companies: `joes-lawn` (two services, a dark brand color, embeddable from `https://joeslawn.example` and the test host) and `sunny-yards` (one service, a light brand color, hosted page only).

## Not wired yet

- **Turnstile** has run against Cloudflare's test keys in the local loop, never against a real site key.
