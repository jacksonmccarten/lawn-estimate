---
tags: [structure, testing]
---

# Testing and CI

Every workspace has `npm test`; the root `npm test` runs them all. The database suites need the local Postgres (`npm run db:up`). The Playwright suites run on demand and are not in CI yet (build step 7 in [[ENGINEERING_DESIGN#14. Build sequence|design §14]]).

## By workspace

| Workspace | Unit and integration (Vitest) | Browser (Playwright + axe) |
| --- | --- | --- |
| `packages/pricing` | `test/pricing.test.ts`: table-driven over every rule | |
| `packages/api-contract` | `test/contract.test.ts` | |
| `packages/db` | `test/rls.test.ts` (the wrong-tenant suite), `test/data-api.test.ts` (a fake Data API transport; both migration runners compared), `test/sql-text.test.ts` (hostile values). Run twice, see below | |
| `services/lambdas` | `test/public.test.ts` and `test/company-api.test.ts` against a throwaway database built by `test/harness.ts`, with a fake Turnstile, Regrid and notifier; `test/unit.test.ts` for the pure modules. Run twice | |
| `apps/widget` | `test/`: every fixture parsed with the contract and its totals re-added; the CSP builder, profile sanitizer, Mapbox maths, tokens and contrast pairs | `e2e/widget.spec.ts`, `embed.spec.ts` (a real host page), `yard.spec.ts` (stubbed Mapbox) at 390×844 against a production build; ports 3101 to 3103 |
| `apps/dashboard` | `test/`: the Cognito client, the form model and parsing, the mock against the contract, the QR code decoded with `jsqr` | `e2e/*.spec.ts`: every route through axe in both color schemes, no sideways scroll at 320 px; port 3100, `LQ_MOCK=1`, one worker |
| `infra` | `test/stacks.test.ts`: properties of the synthesized CloudFormation, bundling off | `npm run smoke`: the deployed chain end to end (not a suite; needs AWS credentials) |

## The database suites run twice

`packages/db` and `services/lambdas` each have a second Vitest config (`vitest.data-api.config.ts`) that sets `LQ_TEST_DRIVER=data-api-sql`. The suites then go through `InterpolatingPgClient`, which sends node-postgres the exact statement text the Data API client would send (every parameter written in as a literal) and returns rows in the Data API's shape (json and timestamps as text). A handler must pass both: the first proves the SQL with bound parameters, the second proves it means the same over the Data API and that the code does not lean on node-postgres parsing a column. See [[Database Package]].

The suites build their own databases from the migrations, but roles are cluster-wide, so files run serially (`fileParallelism: false`), the RLS suite resets the `app_rw` and `app_public` passwords to the local test password (the same one `db:seed` uses, so the suites and the local loop share a cluster), and it refuses any host but localhost.

## CI

`.github/workflows/ci.yml`, on every push to `main` and every pull request:

1. `ubuntu-24.04`, a `postgres:16` service container on port 54320.
2. `actions/setup-node` with Node 20 and `npm ci`.
3. `psql … -f docker/initdb/01_app_owner.sql`: a service container starts before checkout, so it cannot mount the init script; the same file is run by hand. Keep the two in step.
4. `npm run typecheck`.
5. `npm run db:migrate` as `app_owner`.
6. `npm test`.

Ten-minute timeout. The front ends deploy separately: Amplify Hosting builds each app on a push to `main` (`amplify.yml`), and the backend is deployed by hand with CDK ([[deploy]]).

## Accessibility definition of done

Every front-end change: labels and names present, keyboard operable, focus visible and managed, status announced, contrast from tokens, axe clean. Lint is ESLint with `eslint-plugin-jsx-a11y` (strict) and `react-hooks` in both apps (`npm run lint -w @lq/widget`, `-w @lq/dashboard`). Design: [[ENGINEERING_DESIGN#11. Accessibility (WCAG 2.2 AA)|§11]]; requirements R24–R31 in [[COMPLIANCE_REQUIREMENTS]].

Related: [[Repository Root]], [[local-loop]], [[gotchas]] (the CI and Docker entries).
