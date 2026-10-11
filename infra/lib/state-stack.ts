// Everything that holds state and must outlive a redeploy: the logins and
// secrets, and the user pool. Kept apart from the API stack so that stack can
// be torn down and rebuilt without touching any of it.
//
// The database itself is not here. The account's free plan allows Aurora
// only in its "express configuration", which CloudFormation cannot create,
// so the cluster is made by infra/scripts/bootstrap-db.ts and this stack is
// told its ARN (cdk.json, databaseClusterArn).

import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { Config } from "./config.js";

export const DATABASE_NAME = "lawnquote";

/** A generated login for one of the roles the migrations create NOLOGIN. */
function roleLogin(scope: Construct, id: string, username: string): secretsmanager.Secret {
  return new secretsmanager.Secret(scope, id, {
    description: `Data API login for the ${username} database role`,
    generateSecretString: {
      secretStringTemplate: JSON.stringify({ username }),
      generateStringKey: "password",
      passwordLength: 40,
      // The migrate function writes it into ALTER ROLE as a literal.
      excludePunctuation: true,
    },
  });
}

export class StateStack extends Stack {
  /** The cluster made by infra/scripts/bootstrap-db.ts. */
  readonly clusterArn: string;
  /** The schema owner's login. Only the migrate function may read it. */
  readonly ownerLogin: secretsmanager.Secret;
  readonly rwLogin: secretsmanager.Secret;
  readonly publicLogin: secretsmanager.Secret;
  /** TURNSTILE_SECRET, QUOTE_TOKEN_SECRET and IP_HASH_SALT, one secret each. */
  readonly appSecrets: secretsmanager.Secret[];
  readonly userPool: cognito.UserPool;
  readonly dashboardClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: StackProps & { config: Config }) {
    super(scope, id, { ...props, terminationProtection: true });

    this.clusterArn = props.config.databaseClusterArn;

    // app_owner: not a superuser, so FORCE ROW LEVEL SECURITY binds it, as it
    // does locally. bootstrap-db.ts creates the role with this password.
    this.ownerLogin = roleLogin(this, "OwnerLogin", "app_owner");
    this.rwLogin = roleLogin(this, "RwLogin", "app_rw");
    this.publicLogin = roleLogin(this, "PublicLogin", "app_public");

    const generated = (id: string, key: string) =>
      new secretsmanager.Secret(this, id, {
        description: `${key} for the public Lambdas`,
        generateSecretString: { secretStringTemplate: "{}", generateStringKey: key, passwordLength: 64, excludePunctuation: true },
      });
    this.appSecrets = [
      // Starts as Cloudflare's published test secret, which passes every
      // token. Replace it with the real one before real traffic:
      //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '{"TURNSTILE_SECRET":"..."}'
      new secretsmanager.Secret(this, "TurnstileSecret", {
        description: "TURNSTILE_SECRET for the public Lambdas. Deployed with Cloudflare's test secret; set the real one by hand",
        secretObjectValue: { TURNSTILE_SECRET: SecretValue.unsafePlainText("1x0000000000000000000000000000000AA") },
      }),
      generated("QuoteTokenSecret", "QUOTE_TOKEN_SECRET"),
      generated("IpHashSalt", "IP_HASH_SALT"),
    ];

    // Company owners and our own staff. Anyone may sign up; the address is
    // proved with an emailed code before the login can do anything, and a new
    // company starts on a small trial allowance. The company a user belongs
    // to is not an attribute here; it is a row in company_members.
    this.userPool = new cognito.UserPool(this, "Users", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
        emailSubject: "Your Instant Lawn Quote code",
        emailBody: "Your Instant Lawn Quote verification code is {####}. It expires in 24 hours.",
      },
      // Password only for now. An authenticator app stays available to an
      // account that sets one up; text-message codes wait on a paid AWS plan
      // and a registered sending number.
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    for (const groupName of ["admin", "owner"]) {
      new cognito.CfnUserPoolGroup(this, `Group${groupName}`, { userPoolId: this.userPool.userPoolId, groupName });
    }
    this.dashboardClient = this.userPool.addClient("Dashboard", {
      // A browser app: no client secret, password checked by SRP.
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      idTokenValidity: Duration.minutes(30),
      accessTokenValidity: Duration.minutes(30),
      refreshTokenValidity: Duration.hours(8),
      enableTokenRevocation: true,
    });

    new CfnOutput(this, "OwnerLoginArn", { value: this.ownerLogin.secretArn, description: "Read by infra/scripts/bootstrap-db.ts to give app_owner its password" });
  }
}
