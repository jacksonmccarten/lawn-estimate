// The CDK app: `npm run synth -w @lq/infra`, then `cdk diff` and `cdk deploy`.
// The account comes from the credentials in use; the region and the origins
// from cdk.json.

import { App } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";
import { readConfig } from "../lib/config.js";
import { StateStack } from "../lib/state-stack.js";

const app = new App();
const config = readConfig(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

const state = new StateStack(app, "LqState", { env, config, description: "Instant Lawn Quote: logins, secrets and user pool" });
new ApiStack(app, "LqApi", { env, config, state, description: "Instant Lawn Quote: HTTP API and Lambdas" });
