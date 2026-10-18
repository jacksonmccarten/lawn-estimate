---
tags: [structure, infra]
workspace: "@lq/infra"
path: infra
---

# Infrastructure

`infra` is an AWS CDK app in TypeScript: three stacks, a config reader for `cdk.json` context, four operational scripts and a test over the synthesized templates. Deploying is in [[deploy]]; the "Infrastructure as code", "Database on the free plan", "Database in the VPC" and "CloudFront and WAF" rows of [[ENGINEERING_DESIGN#15. Decisions and open questions|the Decisions table]] record how it reached this shape. Region: us-east-2, where the Amplify apps are. The front ends are not here: Amplify Hosting builds them from `amplify.yml` on each push to `main`, with custom domains set in the Amplify console.

Always read `cdk diff` before a deploy: a change that replaces the database or the user pool is never deployed.

## Layout

```text
infra/
├── bin/app.ts                 the CDK app: LqState, LqEdge (when configured), LqApi
├── lib/
│   ├── config.ts              readConfig: cdk.json context, validated; none of it secret
│   ├── state-stack.ts         LqState: everything that must outlive a redeploy
│   ├── api-stack.ts           LqApi: the HTTP API, the Lambdas, CloudFront when the edge is on
│   └── edge-stack.ts          LqEdge (us-east-1): the API's certificate and WAF web ACL
├── scripts/
│   ├── bootstrap-db.ts        made the first cluster on the free plan; creates app_owner and lawnquote
│   ├── snapshot-db.ts         a snapshot of that cluster, for LqState to restore into the VPC
│   ├── onboard-demo.ts        the demonstration company and a Cognito login for its owner
│   └── smoke.ts               end-to-end check of a deployment with no browser
├── test/stacks.test.ts        properties of the synthesized CloudFormation, bundling off
├── cdk.json                   `app` and the context (region, origins, database snapshot, sesFrom, …)
└── cdk.context.json           cached availability zones
```

## Stacks

### LqState

Holds state. Termination protection is on; the user pool and the KMS key are retained, the database leaves a snapshot if it is ever removed.

- **Database**: Aurora Serverless v2 PostgreSQL restored from `databaseSnapshot` into a VPC of two isolated subnets with no NAT and no internet gateway, encrypted with the stack's KMS key, 7-day backups, PostgreSQL logs to CloudWatch, Data API on, deletion protection on. The Lambdas stay outside the VPC and reach it through the Data API, so there is no NAT cost. The snapshot ARN must never change: a new value replaces the cluster.
- **Logins**: one generated secret per database role (`app_owner`, `app_rw`, `app_public`), which the `migrate` Lambda writes into `ALTER ROLE`. The admin gets a password in a secret under the same key, for emergencies only.
- **Application secrets**: the Turnstile secret (Cloudflare's test secret until replaced by hand), the quote-token key, the IP-hash salt, and the CloudFront origin-verify secret.
- **Cognito user pool**: self sign-up with email verification, password sign-in by SRP, an authenticator app optional, groups `admin` and `owner`, a browser app client with no secret. The company a user belongs to is not an attribute here; it is a row in `company_members`.

### LqApi

Stateless; can be deleted and deployed again. `fn(name, entry, logins)` bundles one handler file from `services/lambdas/src/handlers` as a Node 22 function whose role may use the Data API with the logins it is given and no other; a function with no login gets neither the database's address nor the Data API. Logs are kept three months.

| Function | Entry | Login | Notes |
| --- | --- | --- | --- |
| `Estimate` | `estimate` | `app_public` | Widget origin, dashboard URL, SES sender and the SMS flag in its environment |
| `Submit` | `submit` | `app_public` | Same |
| `Profile` | `profile` | `app_public` | |
| `Contact` | `contact` | none | May send SES email from `sesFrom` only |
| `CompanyApi` | `company-api` | `app_rw` | Behind the Cognito JWT authorizer |
| `Migrate` | `migrate` | `app_owner` | Plus the migrations layer; no route |

The HTTP API's routes come straight from the contract's `routes` table: public ones to their own integrations, every other to `CompanyApi` with the `HttpUserPoolAuthorizer`. CORS allows the widget and dashboard origins; throttling is burst 20, 10 requests a second. When the edge is configured the stack also makes the CloudFront distribution at `apiDomain` (nothing cached, the origin-verify header added, a CloudFront Function setting `x-viewer-ip`, HSTS) and its Route 53 alias. Outputs: `ApiUrl`, `PublicApiUrl`, `UserPoolId`, `UserPoolClientId`, `MigrateFunction`, `TurnstileSecretArn`.

### LqEdge

Only synthesized when `apiDomain`, `zoneName`, `hostedZoneId` and `originVerify` are in the context, and only in us-east-1, where CloudFront reads certificates and web ACLs from. The web ACL's rules are listed at the top of `edge-stack.ts`: Amazon's IP reputation list, known bad inputs, the core rule set (body-size rule counting only), 100 requests per 5 minutes per address on `/estimate`, `/submit` and `/contact`, 1,000 on everything but `/profile`, and Bot Control on the three homeowner routes. A rate-limited request gets the contract's 429 `rate_limited` body.

> [!note] Current state of the edge
> The commit "removed WAF" (2026-10-11) took `apiDomain`, `zoneName`, `hostedZoneId` and `originVerify` out of `cdk.json`. As committed, the CDK app therefore synthesizes `LqState` and `LqApi` only: no CloudFront, no WAF, and the API is reached at its execute-api address. The code path stays and turns back on when those four values are restored. [[deploy]] still describes the CloudFront setup.

## Context (`cdk.json`)

`region`, `widgetOrigin`, `dashboardOrigin`, `sesFrom`, optional `contactTo`, `databaseSnapshot` (and the pre-move `databaseClusterArn`, read by `snapshot-db` only), and the four optional edge values. `readConfig` validates every one and refuses a deploy with a bad origin, email or ARN. Override any for one command with `-c name=value`. See [[Configuration]].

## Scripts

| Script | When |
| --- | --- |
| `npm run bootstrap-db` | Once, on the free plan, to make the express-configuration cluster CloudFormation could not; still creates `app_owner` and the database if missing. Safe to run again |
| `npm run snapshot-db` | Once, to move that cluster into the VPC; prints the ARN for `databaseSnapshot` |
| `npm run onboard-demo -- owner@example.com` | The demonstration company in a deployed environment, with a Cognito login for its owner (`services/lambdas/dev/demo-company.ts` does the database part) |
| `npm run smoke` | After every deploy: profile, estimate, lead, a real Cognito sign-in, the owner's routes, a decision and a refused second decision. Makes and deletes its own logins; the quote and lead it submits stay, marked as a test |

`npm run synth -w @lq/infra` synthesizes with `--strict`; `npm test -w @lq/infra` checks the templates.

Related: [[Lambdas]], [[Configuration]], [[deploy]].
