---
tags: [howto]
---

# Deploying the backend

The secrets, user pool, API and Lambdas are defined with AWS CDK in `infra/`.
The database is made by a script beside them, because of the account's plan
(below). The two front ends are separate: they deploy from Amplify Hosting on
every push to `main`. The design is in [[ENGINEERING_DESIGN]] (Decisions:
"Infrastructure as code", "Database on the free plan", "Data API client").

## What exists

| Piece | Made by | Holds |
| --- | --- | --- |
| Aurora cluster `lq-db` | `npm run bootstrap-db` | PostgreSQL 17, serverless, pauses to zero, Data API on, deletion protection on |
| Stack `LqState` | CDK | A login secret for each database role, the three application secrets, the Cognito user pool. Termination protection on; the user pool is retained |
| Stack `LqApi` | CDK | The HTTP API, its routes (from `packages/api-contract`), five Lambdas. Stateless; safe to delete and deploy again |

Not created yet: CloudFront and WAF in front of the API, the nightly cleanup
job, alarms, and custom domains.

> [!warning] The database is not in a private network
> The AWS free plan allows Aurora only in its "express configuration": no
> VPC, reached through Aurora's internet access gateway, with an admin that
> signs in by IAM token alone. CloudFormation cannot create it, which is why
> a script does. The application never uses that gateway; it goes through
> the Data API as `app_public` and `app_rw`. When the account is on a paid
> plan, move the database into the VPC the design describes (rev 2.3 of
> `infra/lib/state-stack.ts` has it) and restore 7-day backups.

> [!warning] The free plan closes the account
> After six months, or when its credits are used, a free-plan account is
> closed and its data deleted. Upgrade before anything real depends on it.

## Settings

`infra/cdk.json` holds the region and what a deployment must be told:

| Context | Meaning |
| --- | --- |
| `databaseClusterArn` | The cluster `bootstrap-db` made |
| `widgetOrigin` | The widget app's origin. The only browser origin `/estimate` and `/submit` answer |
| `dashboardOrigin` | The dashboard's origin, for CORS and for the links in lead alerts |
| `sesFrom` | The SES-verified address lead alerts are sent from |

Override any of them for one command with `-c name=value`.

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

## Later deploys

`npx cdk diff`, then `npx cdk deploy --all`, then `npm run smoke`. Always read
the diff: a change that replaces the user pool must never be deployed.

> [!warning] The first request after a quiet spell is slow
> The database pauses after five idle minutes and takes some seconds to wake.
> The Lambdas wait for it (up to about 25 seconds), so the first estimate
> after a pause is slow rather than failed.
