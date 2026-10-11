// Wiring for the deployed Lambdas: configuration from the environment,
// secrets from Secrets Manager (read once per cold start), and the two
// database clients, each with its own credentials.
//
// Environment:
//   SECRETS_ARN            JSON secrets, comma-separated, that between them hold
//                          TURNSTILE_SECRET, QUOTE_TOKEN_SECRET, IP_HASH_SALT
//                          and ORIGIN_VERIFY_SECRET. Each may be set directly
//                          in the environment instead (local runs).
//   ORIGIN_VERIFY_ENFORCE  "true": refuse public requests that did not come
//                          through CloudFront (public/edge.ts). Without
//                          ORIGIN_VERIFY_SECRET nothing is checked.
//   DB_RESOURCE_ARN, DB_NAME, DB_PUBLIC_SECRET_ARN, DB_RW_SECRET_ARN
//                          Aurora through the Data API, as app_public and app_rw.
//   DATABASE_URL_PUBLIC, DATABASE_URL_RW
//                          plain PostgreSQL instead (local runs).
//   WIDGET_ORIGIN          https://w.<domain>; other origins are refused.
//   DASHBOARD_URL          https://app.<domain>, for links in lead alerts.
//   SES_FROM               the verified sender of lead alerts.
//   SMS_ALERTS_ENABLED     "true" once 10DLC registration has cleared.
//   REGRID_BASE_URL        optional override.
//   MONETIZATION_APP_ID, MONETIZATION_ENDPOINT
//                          AWS Monetization, which sells companies their plan
//                          (src/billing.ts). Unset: no billing.

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { createWithCompany, createWithPublic, createWithSignup, DataApiDbClient, PgDbClient, type DbClient } from "@lq/db";
import { billingFromEnv } from "./billing.js";
import { createCompanyApi } from "./company/api.js";
import { log } from "./log.js";
import type { PublicDeps } from "./public/deps.js";
import type { Edge } from "./public/edge.js";
import { createEstimateHandler } from "./public/estimate.js";
import { createNotifier } from "./public/notify.js";
import { createProfileHandler } from "./public/profile.js";
import { createRegridLookup } from "./public/regrid.js";
import { createSubmitHandler } from "./public/submit.js";
import { createTokenCodec } from "./public/token.js";
import { createTurnstile } from "./public/turnstile.js";

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The environment, with the Secrets Manager secret's keys laid over it. */
async function loadEnv(): Promise<Env> {
  const arns = (process.env.SECRETS_ARN ?? "").split(",").map((arn) => arn.trim()).filter(Boolean);
  if (arns.length === 0) return process.env;
  const client = new SecretsManagerClient({});
  const secrets = await Promise.all(arns.map((arn) => client.send(new GetSecretValueCommand({ SecretId: arn }))));
  return Object.assign({}, process.env, ...secrets.map((res) => JSON.parse(res.SecretString ?? "{}") as Env));
}

async function dbClient(env: Env, role: "PUBLIC" | "RW"): Promise<DbClient> {
  const url = env[`DATABASE_URL_${role}`];
  if (url) {
    const { default: pg } = await import("pg");
    return new PgDbClient(new pg.Pool({ connectionString: url, max: 2 }));
  }
  return new DataApiDbClient({
    resourceArn: required(env, "DB_RESOURCE_ARN"),
    secretArn: required(env, `DB_${role}_SECRET_ARN`),
    database: required(env, "DB_NAME"),
  });
}

function edgeFrom(env: Env): Edge {
  return { secret: env.ORIGIN_VERIFY_SECRET || null, enforce: env.ORIGIN_VERIFY_ENFORCE === "true" };
}

async function publicDeps(): Promise<PublicDeps> {
  const env = await loadEnv();
  const ses = new SESv2Client({});
  const sns = new SNSClient({});
  const from = required(env, "SES_FROM");
  const regridToken = env.REGRID_TOKEN;
  if (!regridToken) log("warn", "regrid_not_configured");

  return {
    withPublic: createWithPublic(await dbClient(env, "PUBLIC")),
    turnstile: createTurnstile({ secret: required(env, "TURNSTILE_SECRET") }),
    regrid: regridToken
      ? createRegridLookup({ token: regridToken, ...(env.REGRID_BASE_URL ? { baseUrl: env.REGRID_BASE_URL } : {}) })
      : null,
    tokens: createTokenCodec(required(env, "QUOTE_TOKEN_SECRET")),
    notifier: createNotifier({
      sendEmail: async ({ to, subject, text }) => {
        await ses.send(
          new SendEmailCommand({
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
          }),
        );
      },
      sendSms: async ({ to, text }) => {
        await sns.send(
          new PublishCommand({
            PhoneNumber: to,
            Message: text,
            MessageAttributes: { "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" } },
          }),
        );
      },
      smsEnabled: env.SMS_ALERTS_ENABLED === "true",
      dashboardUrl: required(env, "DASHBOARD_URL"),
      log,
    }),
    billing: await billingFromEnv(env, log),
    ipHashSalt: required(env, "IP_HASH_SALT"),
    widgetOrigin: env.WIDGET_ORIGIN ?? null,
    edge: edgeFrom(env),
    log,
  };
}

/** Builds a handler once per cold start and reuses it for every invocation. */
function lazy<E, R>(build: () => Promise<(event: E) => Promise<R>>): (event: E) => Promise<R> {
  let ready: Promise<(event: E) => Promise<R>> | undefined;
  return async (event) => (await (ready ??= build()))(event);
}

export const estimate = lazy(async () => createEstimateHandler(await publicDeps()));
export const submit = lazy(async () => createSubmitHandler(await publicDeps()));
// The database, and the origin-verify secret only.
export const profile = lazy(async () => {
  const env = await loadEnv();
  return createProfileHandler({ withPublic: createWithPublic(await dbClient(env, "PUBLIC")), edge: edgeFrom(env), log });
});
export const companyApi = lazy(async () => {
  const db = await dbClient(process.env, "RW");
  return createCompanyApi({
    withCompany: createWithCompany(db),
    signUp: createWithSignup(db),
    billing: await billingFromEnv(process.env, log),
    dashboardOrigin: required(process.env, "DASHBOARD_URL"),
  });
});
