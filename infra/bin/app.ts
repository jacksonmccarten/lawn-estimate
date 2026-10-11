// The CDK app: `npm run synth -w @lq/infra`, then `cdk diff` and `cdk deploy`.
// The account comes from the credentials in use; the region and the origins
// from cdk.json.

import { App } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";
import { readConfig } from "../lib/config.js";
import { EdgeStack } from "../lib/edge-stack.js";
import { StateStack } from "../lib/state-stack.js";

const app = new App();
const config = readConfig(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

const state = new StateStack(app, "LqState", { env, config, description: "InstaQuotesAI: logins, secrets and user pool" });
// CloudFront reads certificates and web ACLs from us-east-1 only.
const edge = config.edge
  ? new EdgeStack(app, "LqEdge", { env: { account: env.account, region: "us-east-1" }, edge: config.edge, description: "InstaQuotesAI: the API's certificate and WAF rules" })
  : undefined;
new ApiStack(app, "LqApi", { env, config, state, edge, description: "InstaQuotesAI: HTTP API, Lambdas, and the CloudFront distribution in front of them" });
