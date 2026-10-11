// What a deployment is told from outside: `cdk.json` context, overridable
// with `-c name=value`. None of it is secret.

import type { App } from "aws-cdk-lib";

export type Config = {
  /** Where the stacks go. The Amplify apps are in us-east-2, so the API is too. */
  region: string;
  /** https://w.<domain>: the only browser origin that may call /estimate and /submit. */
  widgetOrigin: string;
  /** https://app.<domain>: the dashboard, for CORS and for links in lead alerts. */
  dashboardOrigin: string;
  /** The SES-verified address lead alerts are sent from. */
  sesFrom: string;
  /** The snapshot the cluster in LqState is restored from. Once set, never changed: a new one replaces the database. */
  databaseSnapshot?: string;
  /** Before `databaseSnapshot` is set: the cluster infra/scripts/bootstrap-db.ts made, outside CloudFormation. */
  databaseClusterArn?: string;
  /**
   * AWS Monetization, which sells companies their plan: the app's ARN (ending in /sandbox for the
   * test copy) and the service endpoint. Both or neither; unset, the functions run without billing.
   */
  monetization?: { appId: string; endpoint: string };
};

const ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

export function readConfig(app: App): Config {
  const text = (name: string): string => {
    const value: unknown = app.node.tryGetContext(name);
    if (typeof value !== "string" || value.trim() === "") throw new Error(`context "${name}" is not set (cdk.json, or -c ${name}=...)`);
    return value.trim();
  };
  const origin = (name: string): string => {
    const value = text(name);
    if (!ORIGIN.test(value)) throw new Error(`context "${name}" must be an https origin with no path, like https://w.example.com`);
    return value;
  };
  const sesFrom = text("sesFrom");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sesFrom)) throw new Error('context "sesFrom" must be an email address');
  const optional = (name: string): string | undefined => (app.node.tryGetContext(name) === undefined ? undefined : text(name));
  const databaseSnapshot = optional("databaseSnapshot");
  if (databaseSnapshot !== undefined && !/^arn:aws[a-z-]*:rds:[a-z0-9-]+:\d{12}:cluster-snapshot:[A-Za-z0-9-]+$/.test(databaseSnapshot)) {
    throw new Error('context "databaseSnapshot" must be the ARN of a cluster snapshot (infra/scripts/snapshot-db.ts prints it)');
  }
  const databaseClusterArn = optional("databaseClusterArn");
  if (databaseClusterArn !== undefined && !/^arn:aws[a-z-]*:rds:[a-z0-9-]+:\d{12}:cluster:[A-Za-z0-9-]+$/.test(databaseClusterArn)) {
    throw new Error('context "databaseClusterArn" must be the ARN of an Aurora cluster (run infra/scripts/bootstrap-db.ts first)');
  }
  if (!databaseSnapshot && !databaseClusterArn) throw new Error('context "databaseSnapshot" (or, before the move, "databaseClusterArn") is not set');
  const monetizationAppId = optional("monetizationAppId");
  const monetizationEndpoint = optional("monetizationEndpoint");
  if ((monetizationAppId === undefined) !== (monetizationEndpoint === undefined)) {
    throw new Error('context "monetizationAppId" and "monetizationEndpoint" are set together or not at all');
  }
  if (monetizationAppId !== undefined && !/^arn:aws:appmonetization:[a-z0-9-]+:\d{12}:apps\/[0-9a-f]{32}(\/sandbox)?$/.test(monetizationAppId)) {
    throw new Error('context "monetizationAppId" must be an AWS Monetization app ARN, optionally ending in /sandbox');
  }
  if (monetizationEndpoint !== undefined && !ORIGIN.test(monetizationEndpoint)) {
    throw new Error('context "monetizationEndpoint" must be an https origin with no path');
  }
  const monetization = monetizationAppId && monetizationEndpoint ? { appId: monetizationAppId, endpoint: monetizationEndpoint } : undefined;
  return {
    region: text("region"),
    widgetOrigin: origin("widgetOrigin"),
    dashboardOrigin: origin("dashboardOrigin"),
    sesFrom,
    databaseSnapshot,
    databaseClusterArn,
    monetization,
  };
}
