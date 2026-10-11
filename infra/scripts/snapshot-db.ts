// Takes a snapshot of the cluster bootstrap-db.ts made, for LqState to
// restore into the VPC (docs/deploy.md, "Moving the database into the VPC").
// That cluster is not encrypted, and RDS refuses to copy an unencrypted
// snapshot as an encrypted one; restoring it with a key (LqState's
// storageEncryptionKey) is what encrypts it. Leaves the source cluster
// running and untouched.
//
// Run from infra/:  npm run snapshot-db
// It prints the ARN to put in cdk.json as databaseSnapshot.

import { readFileSync } from "node:fs";
import { CreateDBClusterSnapshotCommand, DescribeDBClusterSnapshotsCommand, RDSClient } from "@aws-sdk/client-rds";

const context = (JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")) as { context: Record<string, string> }).context;
const region = context.region!;
if (!context.databaseClusterArn) throw new Error("cdk.json has no databaseClusterArn: nothing to snapshot");
const clusterId = context.databaseClusterArn.split(":").at(-1)!;

const rds = new RDSClient({ region });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (message: string) => console.log(`[snapshot-db] ${message}`);

async function waitFor(id: string): Promise<string> {
  for (;;) {
    const res = await rds.send(new DescribeDBClusterSnapshotsCommand({ DBClusterSnapshotIdentifier: id }));
    const snapshot = res.DBClusterSnapshots?.[0];
    if (snapshot?.Status === "available") return snapshot.DBClusterSnapshotArn!;
    say(`${id} is ${snapshot?.Status ?? "missing"} (${snapshot?.PercentProgress ?? 0}%); waiting`);
    await sleep(15_000);
  }
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const id = `${clusterId}-move-${stamp}`;

say(`snapshotting ${clusterId} as ${id}`);
await rds.send(new CreateDBClusterSnapshotCommand({ DBClusterIdentifier: clusterId, DBClusterSnapshotIdentifier: id }));
const arn = await waitFor(id);

say("done. Put this in infra/cdk.json as databaseSnapshot, then cdk diff LqState:");
console.log(arn);
