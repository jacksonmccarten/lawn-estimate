---
tags: [structure, package, database]
workspace: "@lq/db"
path: packages/db
---

# Database package

`packages/db` is the only way application code reaches PostgreSQL. It holds the schema as append-only [[Migrations]], the three transaction entry points, two drivers (node-postgres locally, the RDS Data API on AWS), the SQL-as-text layer the Data API needs, and the wrong-tenant test that must pass before any feature merges. Design: [[ENGINEERING_DESIGN#7. Data model and Row Level Security|§7]] and the "Database entry points", "Data API client" and "Migrations on Aurora" decisions. The footguns found while building it are in [[gotchas]].

## Layout

```text
packages/db/
├── migrations/0001…0018_*.sql      the schema, roles, RLS, seeds, public functions (see Migrations)
├── scripts/
│   ├── gen_zip_county.py           Census ZCTA → county file → migrations 0006 and 0007
│   └── gen_zip_centroid.py         Census gazetteer → migration 0014
├── src/
│   ├── index.ts                    the package's public surface
│   ├── client.ts                   DbClient { transaction(fn) } and DbTx { query(sql, params) }
│   ├── pg-client.ts                PgDbClient over a pg Pool (local, tests)
│   ├── data-api-client.ts          DataApiDbClient over the RDS Data API (the Lambdas on AWS)
│   ├── interpolating-pg-client.ts  for tests: node-postgres fed the Data API's statement text
│   ├── sql-text.ts                 literal, interpolate, splitStatements, MAX_STATEMENT_CHARS
│   ├── with-company.ts             withCompany(claims, fn): the owner routes' entry point
│   ├── with-public.ts              withPublic(companySlug, fn): the public routes' entry point
│   ├── with-signup.ts              signUp(claims, company): a new login's one statement
│   ├── migrate.ts                  the node-postgres migration runner (local, CI)
│   ├── migrate-statements.ts       the one-statement-at-a-time runner (Data API)
│   └── cli.ts                      `npm run db:migrate`
├── test/
│   ├── rls.test.ts                 the wrong-tenant suite
│   ├── data-api.test.ts            the Data API client against a fake transport; both runners compared
│   └── sql-text.test.ts            hostile values through the literal writer
├── vitest.config.ts                serial: roles are cluster-wide
└── vitest.data-api.config.ts       rls.test.ts again with LQ_TEST_DRIVER=data-api-sql
```

## The three entry points

There is deliberately no query method outside a transaction: `app.company_id` is transaction-scoped, so a statement outside one would run with no company.

### withCompany

`createWithCompany(db)` returns `withCompany(claims, fn, options?)`. `claims` come from a Cognito JWT that API Gateway already verified; never from a body or a caller-controlled header. One transaction: `company_id_for_sub(sub)` finds the company, `set_config('app.company_id', …, true)` sets it, and every statement in `fn` is filtered by RLS. The `db` must be connected as `app_rw`. A login with no company gets `NotAMemberError`.

The `admin` group may pass `asCompanyId`, which first writes `admin_access_log` in a transaction of its own (so the record survives a rollback, and `fn` never starts if it cannot be written), then runs `fn` as that company. Anyone else gets `NotAdminError`.

### withPublic

`createWithPublic(db)` returns `withPublic(companySlug, fn)`. The `db` must be connected as `app_public`, which has no table privileges at all: inside `fn` the only things that work are reading `public_company_profile` and calling the SECURITY DEFINER functions granted to that role by name. The slug is validated, the profile row is loaded and handed to `fn` as `PublicCompany`, and the call refuses to run if the connection's role is not `app_public` (`WrongRoleError`, a guard against being handed the `app_rw` client by mistake). An unknown slug is `UnknownCompanyError`, which the handlers answer as 404.

### signUp

`createWithSignup(db)` returns `signUp(claims, { name })`. A login with no company cannot use `withCompany`, so this runs exactly one statement, `create_company_for_sub(sub, name, email)`, and returns the new company's id. Connected as `app_rw`. A login that already has a company gets a unique violation (SQLSTATE `23505`).

## Drivers and SQL as text

Handler SQL is written `$1`-style for both drivers. The Data API's bind parameters are typed (a string arrives as `varchar`), which breaks `id = $1` on a uuid column, and it runs one statement per call of at most 65,536 characters. So `DataApiDbClient` writes every parameter into the statement as an untyped quoted literal through `sql-text.ts` (`interpolate`). That is safe because, with `standard_conforming_strings` on, a single quote is the only character that can end a literal, and it is doubled; a NUL is refused, and the client checks that setting before its first statement. The client reads the region from the cluster's ARN and the SQLSTATE out of the Data API's error message (`DataApiError.code`). `splitStatements` cuts migration files into statements, respecting quotes, comments and dollar-quoted bodies.

`InterpolatingPgClient` lets the test suites prove the same SQL over both paths: it sends node-postgres the text the Data API client would send and returns rows in the Data API's shape (json, timestamps and arrays as text, so a handler that forgets `to_jsonb` fails locally rather than in AWS). Handlers select json with `fromJson` and arrays through `to_jsonb` for that reason.

## Roles

| Role | Created by | Used by | Can |
| --- | --- | --- | --- |
| `app_owner` | `docker/initdb` locally; `infra/scripts/bootstrap-db.ts` on AWS | Migrations, the `migrate` Lambda, test setup | Owns every table. Not a superuser, so `FORCE ROW LEVEL SECURITY` binds it too |
| `app_rw` | `0001_roles.sql` (NOLOGIN; each environment enables login out of band) | `withCompany`, `signUp`, the company-api Lambda | Table grants filtered by the tenant policies |
| `app_public` | `0001_roles.sql` | `withPublic`, the public Lambdas | No table grants; `SELECT` on `public_company_profile` and `EXECUTE` on named functions |
| `app_definer` | `0001_roles.sql` | Nobody logs in as it | Owns the cross-company view and the SECURITY DEFINER functions, with its own `SELECT` policies and column-level grants |

## Tests

`npm test -w @lq/db` runs the suites twice: once over node-postgres with bound parameters, once (`vitest.data-api.config.ts`) with the statement text and row shapes of the Data API. `rls.test.ts` builds a throwaway database from the migrations, loads three companies, connects as the real roles through the same `withCompany` the Lambdas use, and proves no company can see or change another's rows. It resets the `app_rw` and `app_public` passwords on whatever cluster it runs against and refuses any host but localhost. `data-api.test.ts` builds one database statement by statement and one with the ordinary runner and compares tables, columns, constraints, functions, policies, grants and seed rows.

Related: [[Data Model]], [[Migrations]], [[Lambdas]], [[Testing and CI]].
