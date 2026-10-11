# Dashboard

The operator dashboard (`app.<domain>`): lead inbox, pricing versions, embed settings.

## Run it

From the repo root:

- `npm run dev -w @lq/dashboard` — http://localhost:3000, with the mock sign-in and mock company-api on. Sign in as `owner@nittanylawn.example`, any password, code `123456`.
- `npm test -w @lq/dashboard` — unit tests (no database needed).
- `npx playwright install chromium` once, then `npm run test:e2e -w @lq/dashboard` — builds with `LQ_MOCK=1`, serves on port 3100, runs every route through axe.
- `npm run lint -w @lq/dashboard` — ESLint with `jsx-a11y` (strict).

## Accounts

`/sign-up` creates a login and asks for the code emailed to it; `/onboarding` then names the company, which creates it (`POST /company`), and leads on to the Service area screen. A signed-in login with no company is sent to `/onboarding` from anywhere in the app. In the mock, no email is sent and the code is `123456`; an account made there lasts until the page is reloaded. `/reset-password` sets a new password with an emailed code (the same `123456` in the mock).

## Service area

`/settings/area` lists the company's service areas (one for each region group), removes one from a dropdown, and creates one from a name, a centre address and a distance: every zip code within that distance of the address's zip code (`GET /zips-near`, then `PUT /regions`, saved at once). The mock knows the centre points of seven zip codes, six of them around State College.

## What is mocked

| Piece | Now | Later |
| --- | --- | --- |
| Sign-in | `src/lib/auth/mock-client.ts` behind the `AuthClient` interface | `src/lib/auth/cognito-client.ts`, used when the mock is off and the two Cognito variables are set |
| company-api | `src/mock/*`, served at `/mock-api/*` by this app | Set `NEXT_PUBLIC_API_BASE_URL` to the real API. Locally: copy `.env.example` to `.env.local` and run `npm run dev:api` from the repo root (`docs/local-loop.md`) |

Both are on in `next dev` and when a build is made with `LQ_MOCK=1`. Any other build serves 404 for `/mock-api/*` and refuses every sign-in.

## Environment

| Variable | Purpose |
| --- | --- |
| `LQ_MOCK` | `1` turns the mocks on in a production build. Never set it on a deployed branch. |
| `NEXT_PUBLIC_API_BASE_URL` | Base URL of the company-api. |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID`, `NEXT_PUBLIC_COGNITO_CLIENT_ID` | The user pool and its app client (outputs of the `LqApi` stack). With both set and the mock off, sign-in is Cognito's; with neither, every sign-in is refused. |
| `NEXT_PUBLIC_WIDGET_SCRIPT_ORIGIN`, `NEXT_PUBLIC_WIDGET_APP_ORIGIN` | The `widget.` and `w.` origins shown in the embed snippet and hosted page link. |

None of these is a secret; nothing secret belongs in this app.
