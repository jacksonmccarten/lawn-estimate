---
tags: [howto]
---

# Deploying the backend

The database, secrets, user pool, API and Lambdas are defined with AWS CDK
in `infra/`. The two front ends are separate: they deploy from Amplify Hosting on
every push to `main`. The design is in [[ENGINEERING_DESIGN]] (Decisions:
"Infrastructure as code", "Database on the free plan", "Data API client").

## What exists

| Piece | Made by | Holds |
| --- | --- | --- |
| Stack `LqState` | CDK | The database (Aurora PostgreSQL 17, serverless, pauses to zero, Data API on, deletion protection on, 7-day backups) in a VPC of two isolated subnets with no route out, encrypted with the stack's KMS key; a login secret for each database role, the three application secrets, the Cognito user pool. Termination protection on; the user pool and the key are retained, the database leaves a snapshot if it is ever removed |
| Aurora cluster `lq-db` | `npm run bootstrap-db`, on the free plan | The old cluster, outside the VPC and unencrypted. Kept, unused, until the move is confirmed; then delete it (below) |
| Stack `LqApi` | CDK | The HTTP API, its routes (from `packages/api-contract`), five Lambdas, and the CloudFront distribution in front of them at `api.instaquotesai.com`. Stateless; safe to delete and deploy again |
| Stack `LqEdge` (us-east-1) | CDK | What CloudFront reads from us-east-1: the API's certificate and the WAF web ACL |

Not created yet: the nightly cleanup job and alarms.

The front ends' names are Amplify custom domains, set in the Amplify console:
the dashboard at `instaquotesai.com` (and `www.`), the widget at
`w.instaquotesai.com`, which also serves `v1.js`. The domain is registered in
Route 53, in this account.

The account is on a paid plan (since 2026-10-11).

## Settings

`infra/cdk.json` holds the region and what a deployment must be told:

| Context | Meaning |
| --- | --- |
| `databaseSnapshot` | The snapshot `LqState`'s cluster was restored from. **Never change it**: a new value replaces the database |
| `databaseClusterArn` | The old cluster `bootstrap-db` made; read only by `snapshot-db` |
| `widgetOrigin` | The widget app's origin. The only browser origin `/estimate` and `/submit` answer |
| `dashboardOrigin` | The dashboard's origin, for CORS and for the links in lead alerts |
| `sesFrom` | The SES-verified address lead alerts and contact messages are sent from |
| `contactTo` | Optional. Where the website contact form is emailed; unset, the form says it is unavailable |
| `monetizationAppId` | The AWS Monetization app that sells companies their plan. Its ARN, ending in `/sandbox` for the test copy (test cards, no real charges). Set with `monetizationEndpoint`, or leave both out to run without billing |
| `monetizationEndpoint` | The AWS Monetization endpoint, as in `.env.monetization` |
| `zoneName`, `hostedZoneId` | The Route 53 zone the API's name is made in |
| `apiDomain` | The API's public name, served by CloudFront behind WAF. Without it there is no CloudFront |
| `originVerify` | `log` or `enforce`: whether a public request that skipped CloudFront (straight to `execute-api`) is only logged, or refused |

Override any of them for one command with `-c name=value`.

## Billing (AWS Monetization, private beta)

Companies buy their plan through AWS Monetization: a free Trial (5 estimates
a month) and Standard (no practical limit), paid by the month ($20) or for a
full year ($200). It hosts the plan,
checkout and invoice pages; the dashboard's Billing page opens them. The
`/estimate` function asks it before pricing and counts each new estimate
(`services/lambdas/src/billing.ts`). A company with no subscription, or a
moment when AWS Monetization does not answer, falls back to the database
allowance (`companies.regrid_lookup_quota`).

The plans are not in this repository. A change to a price, a billing period or
the Trial's allowance is made in AWS Monetization and published there; the
sign-up allowance in the database (migration `0018`) and the wording on the
dashboard's Billing and onboarding pages are kept in step by hand.

The SDK comes from a private npm registry (`.npmrc`). Installing needs its
token, which is never committed:

- **Your machine:** the token in `~/.npmrc`.
- **GitHub Actions:** the repository secret `MONETIZATION_REGISTRY_TOKEN`.
- **Amplify (both apps):** the environment variable `MONETIZATION_REGISTRY_TOKEN`,
  as a secret. The front ends do not use the SDK, but `npm ci` installs every
  workspace.

Plans are drafts until published (the AWS Monetization console, or `/monetize
live`). A paid plan publishes only once seller registration is `ACTIVE`. The
functions point at the live app: real companies pay real money. To test a
change without charging anyone, deploy with
`-c monetizationAppId=<the live ARN>/sandbox`.

## First deploy

From `infra/`, with AWS credentials for the account:

1. `npx cdk bootstrap aws://<account>/us-east-2` — once per account and region.
2. `npx cdk deploy LqState` — the secrets and the user pool.
3. `npm run bootstrap-db` — creates the cluster if it is missing, turns on the
   Data API, and creates `app_owner` (with the password in `LqState`'s
   secret) and the `lawnquote` database. Safe to run again.
4. `npx cdk diff LqApi`, then `npx cdk deploy LqApi`.
5. Run the migrations with the function named in the `MigrateFunction` output:
   `aws lambda invoke --region us-east-2 --function-name <MigrateFunction> out.json`.
   It applies what has not run and lets `app_rw` and `app_public` log in with
   the passwords in their secrets. Run it again after any deploy that adds a
   migration.
6. `npm run onboard-demo -- owner@example.com` — the demonstration company
   and a login for its owner. The first password is printed once; the owner
   sets up an authenticator app at first sign-in.
7. `npm run smoke` — an estimate, a lead and the owner's routes behind a real
   sign-in, against the deployment. It makes and deletes a login of its own.
8. Put the real Turnstile secret in the secret named in `TurnstileSecretArn`.
   Until then it holds Cloudflare's test secret, which passes every token.
9. Give the front ends the outputs as Amplify environment variables, then
   rebuild them. Dashboard (`pre-hack`): `LQ_MOCK=0`,
   `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_COGNITO_USER_POOL_ID`,
   `NEXT_PUBLIC_COGNITO_CLIENT_ID`, and the widget's origin in
   `NEXT_PUBLIC_WIDGET_APP_ORIGIN` and `NEXT_PUBLIC_WIDGET_SCRIPT_ORIGIN`.
   Widget (`pre-hack-widget`): `LQ_FIXTURES=0`, `LQ_API_BASE`,
   `LQ_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_MAPBOX_TOKEN`.
10. Put the widget's origin in `cdk.json` as `widgetOrigin` and deploy `LqApi`
    again: the API answers that browser origin and no other.

## Moving the database into the VPC

Done once, on 2026-10-11, when the account left the free plan. Recorded for
what it did; do not repeat it.

1. `cdk deploy LqState` with no `databaseSnapshot`: the VPC and the key.
2. `npm run snapshot-db`: a snapshot of the old cluster. Its ARN went into
   `cdk.json` as `databaseSnapshot`. (The old cluster is unencrypted, and RDS
   will not copy such a snapshot encrypted; the restore encrypts it, with
   the key.)
3. `cdk diff`, then `cdk deploy LqState LqApi`: the cluster restored into the
   VPC, then the Lambdas' Data API calls pointed at it. Writes to the old
   cluster between the snapshot and the deploy are not carried over.
4. `npm run smoke`.

The admin login is a secret `LqState` made (`Database/Secret`), encrypted
with the key; nothing uses it day to day.

Once the new cluster has served for a while, delete the old one and its
snapshots by hand:
`aws rds modify-db-cluster --db-cluster-identifier lq-db --no-deletion-protection --apply-immediately`,
then `aws rds delete-db-cluster --db-cluster-identifier lq-db --final-db-snapshot-identifier lq-db-final`.

## CloudFront and WAF in front of the API

The public routes check a header only CloudFront sends (the
`OriginVerifySecret` in `LqState`), so WAF cannot be walked around by
calling API Gateway's own address; a CloudFront Function passes the
visitor's address in `x-viewer-ip`. Turned on in two steps, so nothing
breaks in between:

1. With `originVerify` at `log`: `npx cdk deploy LqState LqEdge LqApi`. The
   API answers at both addresses. (`cdk bootstrap` was run for us-east-1
   once, for `LqEdge`.)
2. Point the front ends at `PublicApiUrl` (`LQ_API_BASE` on the widget,
   `NEXT_PUBLIC_API_BASE_URL` on the dashboard) and rebuild them. Watch the
   `edge_bypassed` log lines stop.
3. Set `originVerify` to `enforce`, deploy `LqApi`, run `npm run smoke`.

The smoke test calls `/estimate` and `/submit` straight at API Gateway with the
origin-verify header (it reads `OriginVerifySecret`), since WAF's Bot Control
rightly blocks a script there; it checks separately that a scripted estimate
at `api.instaquotesai.com` is stopped by WAF. Everything else goes through
CloudFront.

WAF's rules are in `infra/lib/edge-stack.ts`. Its cost: about $5 a month for
the web ACL, $1 a month per rule, $10 a month for Bot Control, and per
million requests on top.

## Later deploys

`npx cdk diff`, then `npx cdk deploy --all`, then `npm run smoke`. Always read
the diff: a change that replaces the user pool must never be deployed.

> [!warning] The first request after a quiet spell is slow
> The database pauses after five idle minutes and takes some seconds to wake.
> The Lambdas wait for it (up to about 25 seconds), so the first estimate
> after a pause is slow rather than failed.
