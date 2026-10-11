// Onboards the demonstration company in a deployed environment: a Cognito
// login for its owner, and the company itself with a published rate table
// (services/lambdas/dev/demo-company.ts). Safe to run again; an existing
// login keeps its password and its authenticator.
//
// Until there is a sign-up flow, this is how an account comes to exist.
//
//   npm run onboard-demo -- owner@example.com [alert-email]
//
// The login's first password is printed once. The owner sets up an
// authenticator app the first time they sign in.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DataApiDbClient } from "@lq/db";
import { DEMO_SLUG, ensureDemoCompany } from "../../services/lambdas/dev/demo-company.js";

const context = (JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")) as { context: Record<string, string> }).context;
const region = context.region!;

const [email, alertEmail = email] = process.argv.slice(2).map((arg) => arg.trim().toLowerCase());
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("usage: npm run onboard-demo -- owner@example.com [alert-email]");

async function outputs(stack: string): Promise<Record<string, string>> {
  const res = await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stack }));
  return Object.fromEntries((res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
}

const [state, api] = [await outputs("LqState"), await outputs("LqApi")];
const userPoolId = api.UserPoolId!;
const cognito = new CognitoIdentityProviderClient({ region });

/** The user's sub, creating the user if there is none. */
async function ensureLogin(): Promise<{ sub: string; password: string | null }> {
  const subOf = (attributes: { Name?: string; Value?: string }[] | undefined) => attributes?.find((a) => a.Name === "sub")?.Value;
  try {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
    return { sub: subOf(user.UserAttributes)!, password: null };
  } catch (err) {
    if ((err as { name?: string }).name !== "UserNotFoundException") throw err;
  }
  const created = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      // No invitation email: the password is handed over by whoever runs this.
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
    }),
  );
  // Permanent, so the first sign-in goes straight to setting up the authenticator.
  const password = `${randomBytes(12).toString("base64url")}aA1`;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: email, Password: password, Permanent: true }));
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName: "owner" }));
  // Said at once: if a later step fails, the password is not lost with it.
  console.log(`login ${email} created. First password (shown once): ${password}`);
  return { sub: subOf(created.User?.Attributes)!, password };
}

const login = await ensureLogin();
const owner = new DataApiDbClient({ resourceArn: state.DatabaseClusterArn!, secretArn: state.OwnerLoginArn!, database: "lawnquote" });
const result = await ensureDemoCompany(owner, { ownerSubs: [login.sub], quota: 200, alertEmail: alertEmail! });

console.log(`company ${DEMO_SLUG}: ${result}`);
if (!login.password) console.log(`login ${email} already existed; password unchanged`);
console.log(`dashboard: ${context.dashboardOrigin}`);
console.log(`widget:    ${context.widgetOrigin}/w/${DEMO_SLUG}`);
console.log(`api:       ${api.PublicApiUrl ?? api.ApiUrl}`);
