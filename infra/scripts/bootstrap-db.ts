// Makes the database the stacks expect, and is safe to run again.
//
// The AWS free plan allows Aurora only in its "express configuration", which
// CloudFormation cannot create, so this script does what the CDK cannot:
//
//   1. creates the cluster (express configuration: serverless, pauses to
//      zero, no VPC, reached through Aurora's internet access gateway);
//   2. turns on the Data API, which the Lambdas use, and deletion protection;
//   3. signs in once as the admin, which only an IAM token can do, and
//      creates `app_owner` with the password in the LqState stack's secret,
//      and the `lawnquote` database it owns.
//
// After this, nothing connects to the database directly again: migrations
// and the application both go through the Data API as their own roles.
//
// Run from infra/, after `cdk deploy LqState`:  npm run bootstrap-db

import { readFileSync } from "node:fs";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  CreateDBClusterCommand,
  DescribeDBClustersCommand,
  EnableHttpEndpointCommand,
  ModifyDBClusterCommand,
  RDSClient,
  type DBCluster,
} from "@aws-sdk/client-rds";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Signer } from "@aws-sdk/rds-signer";
import pg from "pg";

const context = (JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")) as { context: Record<string, string> }).context;
const region = context.region!;
const clusterId = context.databaseClusterArn!.split(":").at(-1)!;
const DATABASE = "lawnquote";
const OWNER = "app_owner";

const rds = new RDSClient({ region });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (message: string) => console.log(`[bootstrap-db] ${message}`);

async function describe(): Promise<DBCluster | null> {
  try {
    const res = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }));
    return res.DBClusters?.[0] ?? null;
  } catch (err) {
    if ((err as { name?: string }).name === "DBClusterNotFoundFault") return null;
    throw err;
  }
}

async function ensureCluster(): Promise<DBCluster> {
  let cluster = await describe();
  if (!cluster) {
    say(`creating cluster ${clusterId} with express configuration`);
    await rds.send(new CreateDBClusterCommand({ DBClusterIdentifier: clusterId, Engine: "aurora-postgresql", WithExpressConfiguration: true }));
  }
  for (;;) {
    cluster = await describe();
    if (cluster?.Status === "available" && cluster.Endpoint) break;
    say(`cluster is ${cluster?.Status ?? "missing"}; waiting`);
    await sleep(10_000);
  }
  if (cluster.DBClusterArn !== context.databaseClusterArn) {
    throw new Error(`the cluster's ARN is ${cluster.DBClusterArn}; put that in cdk.json as databaseClusterArn`);
  }
  if (!cluster.HttpEndpointEnabled) {
    say("turning on the Data API");
    await rds.send(new EnableHttpEndpointCommand({ ResourceArn: cluster.DBClusterArn }));
  }
  if (!cluster.DeletionProtection) {
    say("turning on deletion protection");
    await rds.send(new ModifyDBClusterCommand({ DBClusterIdentifier: clusterId, DeletionProtection: true, ApplyImmediately: true }));
  }
  return cluster;
}

async function ownerPassword(): Promise<string> {
  const stacks = await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: "LqState" }));
  const arn = stacks.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === "OwnerLoginArn")?.OutputValue;
  if (!arn) throw new Error("the LqState stack has no OwnerLoginArn output; deploy it first (cdk deploy LqState)");
  const secret = await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: arn }));
  const login = JSON.parse(secret.SecretString ?? "{}") as { username?: string; password?: string };
  // Letters and digits only (infra/lib/state-stack.ts), so it can be written into the statement below.
  if (login.username !== OWNER || !login.password || !/^[A-Za-z0-9]+$/.test(login.password)) throw new Error("the owner secret is not a login for app_owner");
  return login.password;
}

async function ensureOwner(cluster: DBCluster, password: string): Promise<void> {
  const host = cluster.Endpoint!;
  const port = cluster.Port ?? 5432;
  const admin = cluster.MasterUsername!;
  // The admin has no password: a 15-minute token, signed with the caller's AWS credentials, stands in for one.
  const token = await new Signer({ region, hostname: host, port, username: admin }).getAuthToken();
  const connect = async () => {
    // The gateway's certificate chains to a public Amazon root, which Node already trusts.
    const client = new pg.Client({ host, port, user: admin, password: token, database: "postgres", ssl: { rejectUnauthorized: true } });
    await client.connect();
    return client;
  };

  // A cluster paused at zero takes some seconds to wake. A client that failed to connect cannot be reused.
  let db: pg.Client;
  for (let attempt = 1; ; attempt++) {
    try {
      db = await connect();
      break;
    } catch (err) {
      if (attempt === 6) throw err;
      say(`could not connect yet (${(err as Error).message}); trying again`);
      await sleep(8_000);
    }
  }
  try {
    const role = await db.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [OWNER]);
    // CREATEDB and CREATEROLE, as docker/initdb gives it locally; never superuser.
    const attributes = `LOGIN CREATEDB CREATEROLE PASSWORD '${password}'`;
    await db.query(role.rowCount ? `ALTER ROLE ${OWNER} ${attributes}` : `CREATE ROLE ${OWNER} ${attributes}`);
    say(role.rowCount ? `${OWNER} exists; password set from the secret` : `created ${OWNER}`);
    // Creating a database owned by another role needs the right to SET ROLE to it.
    await db.query(`GRANT ${OWNER} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`);
    const database = await db.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE]);
    if (!database.rowCount) {
      await db.query(`CREATE DATABASE ${DATABASE} OWNER ${OWNER}`);
      say(`created database ${DATABASE}`);
    } else say(`database ${DATABASE} exists`);
  } finally {
    await db.end();
  }
}

const cluster = await ensureCluster();
await ensureOwner(cluster, await ownerPassword());
say(`done. Cluster ${cluster.DBClusterArn}, PostgreSQL ${cluster.EngineVersion}. Next: cdk deploy LqApi, then invoke the migrate function.`);
