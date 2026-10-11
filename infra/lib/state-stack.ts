// Everything that holds state and must outlive a redeploy: the logins and
// secrets, and the user pool. Kept apart from the API stack so that stack can
// be torn down and rebuilt without touching any of it.
//
// The database is here too, in a private network: a VPC with two isolated
// subnets and no route out, encrypted with a key of our own, 7-day backups.
// The Lambdas stay outside the VPC and reach it through the Data API.
//
// It was first made outside CloudFormation, while the account was on the
// free plan (infra/scripts/bootstrap-db.ts, "express configuration"). The
// move restores a snapshot of that cluster: cdk.json `databaseSnapshot`
// names it, and it must never change afterwards, since a new snapshot
// identifier replaces the cluster. Until it is set, the stack builds only
// the network and the key and uses `databaseClusterArn`, so the move is two
// deploys (docs/deploy.md, "Moving the database into the VPC").

import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as rds from "aws-cdk-lib/aws-rds";
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
  /** The cluster the Data API calls go to: the one restored here, or before the move the one bootstrap-db.ts made. */
  readonly clusterArn: string;
  /** Encrypts the database's storage, its snapshots and its admin login. Restoring the old, unencrypted cluster's snapshot with it is what encrypts the data. */
  readonly databaseKey: kms.Key;
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

    const { config } = props;
    this.databaseKey = new kms.Key(this, "DatabaseKey", {
      description: "Instant Lawn Quote database storage and snapshots",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Two availability zones because a subnet group needs them; no NAT, no
    // internet gateway. Nothing in it needs to reach out, and nothing reaches in
    // except the Data API, which is AWS's own path to the cluster.
    const vpc = new ec2.Vpc(this, "Network", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "database", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });
    vpc.addFlowLog("FlowLog", { trafficType: ec2.FlowLogTrafficType.REJECT });

    if (config.databaseSnapshot) {
      const cluster = new rds.DatabaseClusterFromSnapshot(this, "Database", {
        snapshotIdentifier: config.databaseSnapshot,
        engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_17_9 }),
        // A new admin password, in a secret encrypted with the same key. Nothing uses it
        // day to day (migrations and the application sign in as their own roles); it is
        // the way in if one of those roles is ever locked out, through the Data API.
        snapshotCredentials: rds.SnapshotCredentials.fromGeneratedSecret("postgres", { encryptionKey: this.databaseKey, excludeCharacters: "\"@/\\' " }),
        storageEncryptionKey: this.databaseKey,
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        writer: rds.ClusterInstance.serverlessV2("Writer"),
        serverlessV2MinCapacity: 0,
        serverlessV2MaxCapacity: 4,
        serverlessV2AutoPauseDuration: Duration.minutes(5),
        enableDataApi: true,
        backup: { retention: Duration.days(7) },
        deletionProtection: true,
        removalPolicy: RemovalPolicy.SNAPSHOT,
        cloudwatchLogsExports: ["postgresql"],
        cloudwatchLogsRetention: 90,
        copyTagsToSnapshot: true,
      });
      this.clusterArn = cluster.clusterArn;
    } else {
      if (!config.databaseClusterArn) throw new Error('set "databaseSnapshot" or "databaseClusterArn" in cdk.json');
      this.clusterArn = config.databaseClusterArn;
    }

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

    new CfnOutput(this, "DatabaseKeyArn", { value: this.databaseKey.keyArn, description: "Encrypts the database: the restored cluster's storage and its snapshots" });
    new CfnOutput(this, "DatabaseClusterArn", { value: this.clusterArn });
    new CfnOutput(this, "OwnerLoginArn", { value: this.ownerLogin.secretArn, description: "Read by infra/scripts/bootstrap-db.ts to give app_owner its password" });
  }
}
