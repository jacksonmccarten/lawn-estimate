// The HTTP API and its Lambdas. Stateless: everything here can be deleted
// and deployed again without losing a row or a user.
//
// The routes are the contract's (packages/api-contract): the public ones go
// to their own functions, every other one to the company-api function behind
// the Cognito authorizer.

import { fileURLToPath } from "node:url";
import { routes } from "@lq/api-contract";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { CfnStage, CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { Config } from "./config.js";
import { DATABASE_NAME, type StateStack } from "./state-stack.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const HANDLERS = `${REPO}services/lambdas/src/handlers/`;

/** The Data API calls a DbClient makes; which login it may use is granted separately. */
const DATA_API_ACTIONS = [
  "rds-data:BeginTransaction",
  "rds-data:CommitTransaction",
  "rds-data:RollbackTransaction",
  "rds-data:ExecuteStatement",
];

/**
 * What the functions call in AWS Monetization: the plan check and the meter (estimate) and the
 * hosted billing pages (company API). The service does not yet authorize on the app's ARN, so the
 * resource is "*"; scope it to the app once it does.
 */
const MONETIZATION_ESTIMATE_ACTIONS = ["appmonetization:GetEntitlementDecision", "appmonetization:PutEvent"];
const MONETIZATION_DASHBOARD_ACTIONS = ["appmonetization:CreateSubscriptionCheckoutSession", "appmonetization:CreateBillingPortalSession"];

export type ApiStackProps = StackProps & { config: Config; state: StateStack };

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, state } = props;

    const database = { DB_RESOURCE_ARN: state.clusterArn, DB_NAME: DATABASE_NAME };

    /** One handler file as a function that may use the Data API as the logins it is given, and no other. */
    const fn = (name: string, entry: string, logins: secretsmanager.ISecret[], options: Partial<lambda.FunctionOptions> = {}) => {
      const func = new NodejsFunction(this, name, {
        entry: `${HANDLERS}${entry}.ts`,
        handler: "handler",
        projectRoot: REPO,
        depsLockFilePath: `${REPO}package-lock.json`,
        // Node 20 leaves Lambda support in 2026; the code needs nothing newer than 20.
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        // The first call after the database has paused waits for it to wake.
        timeout: Duration.seconds(29),
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.THREE_MONTHS }),
        bundling: {
          format: OutputFormat.CJS,
          target: "node22",
          sourceMap: true,
          // The AWS SDK is in the runtime; pg is the local driver and is never loaded here.
          externalModules: ["@aws-sdk/*", "pg", "pg-native"],
        },
        ...options,
        // A function with no database login gets neither the database's address nor the Data API.
        environment: { ...(logins.length > 0 ? database : {}), NODE_OPTIONS: "--enable-source-maps", ...options.environment },
      });
      if (logins.length > 0) func.addToRolePolicy(new iam.PolicyStatement({ actions: DATA_API_ACTIONS, resources: [state.clusterArn] }));
      for (const login of logins) login.grantRead(func);
      return func;
    };

    const monetization: Record<string, string> = config.monetization
      ? { MONETIZATION_APP_ID: config.monetization.appId, MONETIZATION_ENDPOINT: config.monetization.endpoint }
      : {};

    const publicEnvironment = {
      ...monetization,
      DB_PUBLIC_SECRET_ARN: state.publicLogin.secretArn,
      SECRETS_ARN: state.appSecrets.map((s) => s.secretArn).join(","),
      WIDGET_ORIGIN: config.widgetOrigin,
      DASHBOARD_URL: config.dashboardOrigin,
      SES_FROM: config.sesFrom,
      // Off until 10DLC registration clears.
      SMS_ALERTS_ENABLED: "false",
    };
    // The public functions log in as app_public, with its own credentials, and can read no other login.
    const estimate = fn("Estimate", "estimate", [state.publicLogin], { environment: publicEnvironment });
    const submit = fn("Submit", "submit", [state.publicLogin], { environment: publicEnvironment });
    for (const func of [estimate, submit]) for (const secret of state.appSecrets) secret.grantRead(func);
    // The website's contact form: Turnstile from the app secrets, and SES to the team's inbox when one is configured.
    const contact = fn("Contact", "contact", [], {
      environment: {
        SECRETS_ARN: state.appSecrets.map((s) => s.secretArn).join(","),
        SITE_ORIGIN: config.dashboardOrigin,
        SES_FROM: config.sesFrom,
        ...(config.contactTo ? { CONTACT_TO: config.contactTo } : {}),
      },
    });
    for (const secret of state.appSecrets) secret.grantRead(contact);
    for (const func of [submit, contact]) {
      func.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: [`arn:${this.partition}:ses:${this.region}:${this.account}:identity/*`],
          conditions: { StringEquals: { "ses:FromAddress": config.sesFrom } },
        }),
      );
    }
    const profile = fn("Profile", "profile", [state.publicLogin], { environment: { DB_PUBLIC_SECRET_ARN: state.publicLogin.secretArn } });
    const companyApi = fn("CompanyApi", "company-api", [state.rwLogin], {
      environment: { ...monetization, DB_RW_SECRET_ARN: state.rwLogin.secretArn, DASHBOARD_URL: config.dashboardOrigin },
    });
    if (config.monetization) {
      estimate.addToRolePolicy(new iam.PolicyStatement({ actions: MONETIZATION_ESTIMATE_ACTIONS, resources: ["*"] }));
      companyApi.addToRolePolicy(new iam.PolicyStatement({ actions: MONETIZATION_DASHBOARD_ACTIONS, resources: ["*"] }));
    }

    // Run by hand after a deploy; the only function with the owner's login.
    const migrations = new lambda.LayerVersion(this, "Migrations", {
      code: lambda.Code.fromAsset(`${REPO}packages/db/migrations`),
      description: "packages/db/migrations, read by the migrate function",
    });
    const migrate = fn("Migrate", "migrate", [state.ownerLogin, state.rwLogin, state.publicLogin], {
      timeout: Duration.minutes(10),
      layers: [migrations],
      environment: {
        DB_OWNER_SECRET_ARN: state.ownerLogin.secretArn,
        DB_RW_SECRET_ARN: state.rwLogin.secretArn,
        DB_PUBLIC_SECRET_ARN: state.publicLogin.secretArn,
        // Where Lambda unpacks a layer.
        MIGRATIONS_DIR: "/opt",
      },
    });

    const api = new HttpApi(this, "Api", {
      description: "InstaQuotesAI: public estimate and submit routes, and the company API",
      corsPreflight: {
        allowOrigins: [...new Set([config.widgetOrigin, config.dashboardOrigin])],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PUT, CorsHttpMethod.PATCH, CorsHttpMethod.OPTIONS],
        allowHeaders: ["authorization", "content-type", "x-act-as-company"],
        maxAge: Duration.minutes(10),
      },
    });
    // Section 9: burst 20, 10 requests a second on every route. (No WAF yet: see the Decisions table.)
    (api.defaultStage!.node.defaultChild as CfnStage).defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };

    const authorizer = new HttpUserPoolAuthorizer("Owners", state.userPool, { userPoolClients: [state.dashboardClient] });
    const integrations = {
      "/estimate": new HttpLambdaIntegration("EstimateIntegration", estimate),
      "/submit": new HttpLambdaIntegration("SubmitIntegration", submit),
      "/profile/{company}": new HttpLambdaIntegration("ProfileIntegration", profile),
      "/contact": new HttpLambdaIntegration("ContactIntegration", contact),
    } as Record<string, HttpLambdaIntegration>;
    const company = new HttpLambdaIntegration("CompanyApiIntegration", companyApi);

    for (const route of Object.values(routes)) {
      const methods = [HttpMethod[route.method]];
      if (route.auth === "public") {
        const integration = integrations[route.path];
        if (!integration) throw new Error(`the contract's public route ${route.path} has no function`);
        api.addRoutes({ path: route.path, methods, integration });
      } else {
        api.addRoutes({ path: route.path, methods, integration: company, authorizer });
      }
    }

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint, description: "LQ_API_BASE for the widget, NEXT_PUBLIC_API_BASE_URL for the dashboard" });
    new CfnOutput(this, "UserPoolId", { value: state.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: state.dashboardClient.userPoolClientId });
    new CfnOutput(this, "MigrateFunction", { value: migrate.functionName, description: "aws lambda invoke --function-name <this> out.json" });
    new CfnOutput(this, "TurnstileSecretArn", { value: state.appSecrets[0]!.secretArn, description: "Holds Cloudflare's test secret until the real one is put" });
  }
}
