// Checks a deployment end to end, the way a homeowner and an owner would use
// it, with no browser: the public profile, an estimate, a submitted lead,
// and the owner's routes behind a real Cognito sign-in with an authenticator.
//
// It signs in as logins of its own, made for the run and deleted after it,
// so nobody's real login is borrowed. One is added to the demonstration
// company; another signs up the way a stranger would and makes a company,
// which is deleted too. The quote and lead it submits stay, marked as a test.
// Needs the demonstration company: run onboard-demo first.
//
//   npm run smoke

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  AdminAddUserToGroupCommand,
  AdminConfirmSignUpCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DataApiDbClient } from "@lq/db";
import { AuthenticationDetails, CognitoUser, CognitoUserAttribute, CognitoUserPool, type CognitoUserSession } from "amazon-cognito-identity-js";
import { DEMO_COMPANY_ID, DEMO_SLUG, ensureDemoCompany } from "../../services/lambdas/dev/demo-company.js";

const context = (JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")) as { context: Record<string, string> }).context;
const region = context.region!;

async function outputs(stack: string): Promise<Record<string, string>> {
  const res = await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stack }));
  return Object.fromEntries((res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** The current code for an authenticator key (RFC 6238: SHA-1, 30 seconds, 6 digits). */
function totp(base32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const memory = new Map<string, string>();
const storage = {
  setItem: (k: string, v: string) => void memory.set(k, v),
  getItem: (k: string) => memory.get(k) ?? null,
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
};

/** Password, then the first-sign-in authenticator setup, as the dashboard does it. Returns the ID token. */
function signIn(pool: CognitoUserPool, email: string, password: string): Promise<string> {
  const user = new CognitoUser({ Username: email, Pool: pool, Storage: storage });
  return new Promise((resolve, reject) => {
    const done = (session: CognitoUserSession) => resolve(session.getIdToken().getJwtToken());
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: done,
      onFailure: reject,
      mfaSetup: () =>
        user.associateSoftwareToken({
          associateSecretCode: (secret) => user.verifySoftwareToken(totp(secret), "smoke", { onSuccess: done, onFailure: reject }),
          onFailure: reject,
        }),
    });
  });
}

const [state, api] = [await outputs("LqState"), await outputs("LqApi")];
const base = api.ApiUrl!;
const widget = context.widgetOrigin!;
const cognito = new CognitoIdentityProviderClient({ region });
const owner = new DataApiDbClient({ resourceArn: context.databaseClusterArn!, secretArn: state.OwnerLoginArn!, database: "lawnquote" });
const email = `smoke-${randomBytes(4).toString("hex")}@example.com`;
const password = `${randomBytes(12).toString("base64url")}aA1`;

const call = async (method: string, path: string, options: { body?: unknown; token?: string; origin?: string } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

/** The run's own login, once made, so it can be removed whatever happens. */
let sub: string | undefined;
/** The login and company the sign-up check makes. */
const signupEmail = `smoke-signup-${randomBytes(4).toString("hex")}@example.com`;
let signupCompanyId: string | undefined;

try {
  // ---- the homeowner's side
  const profile = await call("GET", `/profile/${DEMO_SLUG}`);
  check("public profile", profile.status === 200 && profile.body?.slug === DEMO_SLUG, `${profile.status}`);
  check("an unknown company is a 404", (await call("GET", "/profile/no-such-company")).status === 404);
  check("another origin may not ask for an estimate", (await call("POST", "/estimate", { body: {}, origin: "https://evil.example" })).status === 403);

  const address = `1 Smoke Test Ln, State College, PA 16801 (${email})`;
  const common = { turnstile: "smoke-test-token", embedOrigin: null };
  const estimate = await call("POST", "/estimate", {
    origin: widget,
    body: { company: DEMO_SLUG, address, service: "mow", manual: { zip: "16801", size: { kind: "drawn", sqft: 6449 } }, ...common },
  });
  // 6,400 sq ft at 0.75 cents is $48.00; Centre County's 6% makes $50.88.
  check(
    "an outlined lawn is priced from the published rates",
    estimate.status === 200 && estimate.body?.status === "priced" && estimate.body.quote.totalCents === 5088 && estimate.body.county === "Centre" && estimate.body.origin === "drawn",
    JSON.stringify(estimate.body).slice(0, 160),
  );
  const submit = await call("POST", "/submit", {
    origin: widget,
    body: { token: estimate.body?.token, contact: { name: "Smoke Test", email: "smoke@example.com" }, ...common },
  });
  check("the request for service is taken", submit.status === 200 && submit.body?.status === "submitted", `${submit.status}`);

  // ---- the owner's side
  check("the owner's routes need a sign-in", (await call("GET", "/company")).status === 401);
  const created = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: api.UserPoolId!,
      Username: email,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
    }),
  );
  sub = created.User!.Attributes!.find((a) => a.Name === "sub")!.Value!;
  await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: api.UserPoolId!, Username: email, Password: password, Permanent: true }));
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: api.UserPoolId!, Username: email, GroupName: "owner" }));
  await ensureDemoCompany(owner, { ownerSubs: [sub], quota: 200, alertEmail: "owner@nittanylawn.example" });

  const token = await signIn(new CognitoUserPool({ UserPoolId: api.UserPoolId!, ClientId: api.UserPoolClientId!, Storage: storage }), email, password);
  check("Cognito sign-in", token.split(".").length === 3);

  const company = await call("GET", "/company", { token });
  check("the owner reads their company", company.status === 200 && company.body?.slug === DEMO_SLUG, `${company.status} ${JSON.stringify(company.body).slice(0, 120)}`);
  const versions = await call("GET", "/pricing-versions", { token });
  check("the owner reads their pricing versions", versions.status === 200 && versions.body?.versions?.length >= 1, `${versions.status}`);
  const near = await call("GET", "/zips-near?zip=16801&miles=5", { token });
  check("zip codes within five miles of State College", near.status === 200 && near.body?.zips?.[0] === "16801" && near.body.zips.includes("16803") && !near.body.zips.includes("15217"), `${near.status} ${near.body?.zips?.length}`);
  const leads = await call("GET", "/leads?limit=5", { token });
  const lead = leads.body?.leads?.find((l: { quoteId: string }) => l.quoteId === submit.body?.quoteId);
  check("the lead is in the owner's inbox, with the estimate the homeowner saw", leads.status === 200 && lead?.quote?.totalCents === 5088 && lead?.origin === "drawn", `${leads.status}`);
  const detail = lead ? await call("GET", `/leads/${lead.id}`, { token }) : { status: 0, body: null };
  check("the lead opens", detail.status === 200 && detail.body?.contact?.name === "Smoke Test", `${detail.status}`);
  const declined = lead ? await call("POST", `/leads/${lead.id}/decision`, { token, body: { action: "decline" } }) : { status: 0, body: null };
  check("the owner declines the test lead", declined.status === 200 && declined.body?.status === "declined", `${declined.status} ${JSON.stringify(declined.body).slice(0, 120)}`);
  const again = lead ? await call("POST", `/leads/${lead.id}/decision`, { token, body: { action: "accept" } }) : { status: 0, body: null };
  // The database raises LQ001; the Data API client must carry that code through.
  check("a second decision is refused as already decided", again.status === 409 && again.body?.error?.code === "lead_already_decided", `${again.status} ${JSON.stringify(again.body).slice(0, 120)}`);

  // ---- a stranger signing up
  const pool = new CognitoUserPool({ UserPoolId: api.UserPoolId!, ClientId: api.UserPoolClientId!, Storage: storage });
  const signedUp = await new Promise<boolean>((resolve) =>
    pool.signUp(signupEmail, password, [new CognitoUserAttribute({ Name: "email", Value: signupEmail })], [], (err) => resolve(!err)),
  );
  check("anyone can sign up", signedUp);
  const early = await signIn(pool, signupEmail, password).then(
    () => "signed in",
    (err: { name?: string }) => err.name ?? "refused",
  );
  check("a login cannot be used until its email is verified", early === "UserNotConfirmedException", early);
  // In place of reading the emailed code. The address is then marked verified, as the code would have done.
  await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: api.UserPoolId!, Username: signupEmail }));
  await cognito.send(new AdminUpdateUserAttributesCommand({ UserPoolId: api.UserPoolId!, Username: signupEmail, UserAttributes: [{ Name: "email_verified", Value: "true" }] }));
  const newToken = await signIn(pool, signupEmail, password);
  check("a new login signs in with its password alone", newToken.split(".").length === 3);
  check("a login with no company can read nothing", (await call("GET", "/company", { token: newToken })).status === 403);
  const made = await call("POST", "/company", { token: newToken, body: { name: `Smoke Signup ${signupEmail.slice(13, 21)}` } });
  signupCompanyId = made.body?.id;
  check("it creates its own company", made.status === 201 && /^smoke-signup-/.test(made.body?.slug ?? ""), `${made.status} ${JSON.stringify(made.body).slice(0, 120)}`);
  const mine = await call("GET", "/company", { token: newToken });
  check("and then reads it", mine.status === 200 && mine.body?.id === signupCompanyId, `${mine.status}`);
  const regions = await call("GET", "/regions", { token: newToken });
  check("with Pennsylvania as its service area", regions.status === 200 && regions.body?.regions?.length === 67, `${regions.status}`);
  check("and cannot make a second", (await call("POST", "/company", { token: newToken, body: { name: "Second" } })).status === 409);
  const others = await call("GET", "/leads?limit=5", { token: newToken });
  check("and sees none of another company's leads", others.status === 200 && others.body?.leads?.length === 0, `${others.status}`);
} finally {
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: api.UserPoolId!, Username: signupEmail })).catch(() => {});
  if (signupCompanyId) {
    const id = signupCompanyId;
    await owner
      .transaction(async (tx) => {
        await tx.query("SELECT set_config('app.company_id', $1, true)", [id]);
        await tx.query("DELETE FROM service_regions WHERE company_id = $1", [id]);
        await tx.query("DELETE FROM company_members WHERE company_id = $1", [id]);
        await tx.query("DELETE FROM companies WHERE id = $1", [id]);
      })
      .catch((err: Error) => console.log(`could not remove the sign-up check's company ${id}: ${err.message}`));
  }
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: api.UserPoolId!, Username: email })).catch(() => {});
  await owner
    .transaction(async (tx) => {
      await tx.query("SELECT set_config('app.company_id', $1, true)", [DEMO_COMPANY_ID]);
      if (sub) await tx.query("DELETE FROM company_members WHERE cognito_sub = $1", [sub]);
    })
    .catch(() => {});
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
