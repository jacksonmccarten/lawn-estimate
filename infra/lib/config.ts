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
  /** The Aurora cluster infra/scripts/bootstrap-db.ts made. */
  databaseClusterArn: string;
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
  const databaseClusterArn = text("databaseClusterArn");
  if (!/^arn:aws[a-z-]*:rds:[a-z0-9-]+:\d{12}:cluster:[A-Za-z0-9-]+$/.test(databaseClusterArn)) {
    throw new Error('context "databaseClusterArn" must be the ARN of an Aurora cluster (run infra/scripts/bootstrap-db.ts first)');
  }
  return { region: text("region"), widgetOrigin: origin("widgetOrigin"), dashboardOrigin: origin("dashboardOrigin"), sesFrom, databaseClusterArn };
}
