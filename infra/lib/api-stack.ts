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
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { Config } from "./config.js";
import type { EdgeStack } from "./edge-stack.js";
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

export type ApiStackProps = StackProps & { config: Config; state: StateStack; edge?: EdgeStack };

/**
 * Runs on every request at CloudFront: the visitor's address, in a header
 * the visitor cannot set, since this overwrites it (public/edge.ts).
 */
const VIEWER_IP_FUNCTION = `function handler(event) {
  event.request.headers["x-viewer-ip"] = { value: event.viewer.ip };
  return event.request;
}`;

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, { ...props, crossRegionReferences: props.edge !== undefined });
    const { config, state, edge } = props;

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

    // Behind CloudFront, the public functions check its origin-verify header (public/edge.ts).
    const edgeSecrets = config.edge ? [state.originVerifySecret] : [];
    const edgeEnvironment: Record<string, string> = config.edge ? { ORIGIN_VERIFY_ENFORCE: String(config.edge.originVerify === "enforce") } : {};
    const publicEnvironment = {
      DB_PUBLIC_SECRET_ARN: state.publicLogin.secretArn,
      SECRETS_ARN: [...state.appSecrets, ...edgeSecrets].map((s) => s.secretArn).join(","),
      ...edgeEnvironment,
      WIDGET_ORIGIN: config.widgetOrigin,
      DASHBOARD_URL: config.dashboardOrigin,
      SES_FROM: config.sesFrom,
      // Off until 10DLC registration clears.
      SMS_ALERTS_ENABLED: "false",
    };
    // The public functions log in as app_public, with its own credentials, and can read no other login.
    const estimate = fn("Estimate", "estimate", [state.publicLogin], { environment: publicEnvironment });
    const submit = fn("Submit", "submit", [state.publicLogin], { environment: publicEnvironment });
    for (const func of [estimate, submit]) for (const secret of [...state.appSecrets, ...edgeSecrets]) secret.grantRead(func);
    // The website's contact form: Turnstile from the app secrets, and SES to the team's inbox when one is configured.
    // Behind CloudFront like the other public routes, so it checks the origin-verify header too.
    const contact = fn("Contact", "contact", [], {
      environment: {
        SECRETS_ARN: [...state.appSecrets, ...edgeSecrets].map((s) => s.secretArn).join(","),
        ...edgeEnvironment,
        SITE_ORIGIN: config.dashboardOrigin,
        SES_FROM: config.sesFrom,
        ...(config.contactTo ? { CONTACT_TO: config.contactTo } : {}),
      },
    });
    for (const secret of [...state.appSecrets, ...edgeSecrets]) secret.grantRead(contact);
    for (const func of [submit, contact]) {
      func.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: [`arn:${this.partition}:ses:${this.region}:${this.account}:identity/*`],
          conditions: { StringEquals: { "ses:FromAddress": config.sesFrom } },
        }),
      );
    }
    const profile = fn("Profile", "profile", [state.publicLogin], {
      environment: {
        DB_PUBLIC_SECRET_ARN: state.publicLogin.secretArn,
        ...(config.edge ? { SECRETS_ARN: state.originVerifySecret.secretArn, ...edgeEnvironment } : {}),
      },
    });
    for (const secret of edgeSecrets) secret.grantRead(profile);
    const companyApi = fn("CompanyApi", "company-api", [state.rwLogin], {
      environment: { DB_RW_SECRET_ARN: state.rwLogin.secretArn, DASHBOARD_URL: config.dashboardOrigin },
    });

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

    if (config.edge && edge) {
      // Nothing is cached: every response is a person's own. All of the
      // visitor's headers but Host reach API Gateway, which answers only to
      // its own name; CloudFront adds the origin-verify header.
      const distribution = new cloudfront.Distribution(this, "ApiDistribution", {
        comment: "InstaQuotesAI API, behind WAF",
        domainNames: [config.edge.apiDomain],
        certificate: edge.certificate,
        webAclId: edge.webAclArn,
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        defaultBehavior: {
          origin: new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.${this.urlSuffix}`, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            customHeaders: { "x-origin-verify": state.originVerifySecret.secretValueFromJson("ORIGIN_VERIFY_SECRET").unsafeUnwrap() },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, "ApiHeaders", {
            comment: "HSTS and nosniff on every API response",
            securityHeadersBehavior: {
              strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
              contentTypeOptions: { override: true },
            },
          }),
          functionAssociations: [
            {
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
              function: new cloudfront.Function(this, "ViewerIp", {
                code: cloudfront.FunctionCode.fromInline(VIEWER_IP_FUNCTION),
                runtime: cloudfront.FunctionRuntime.JS_2_0,
                comment: "Passes the visitor's address to the API in x-viewer-ip",
              }),
            },
          ],
        },
      });
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: config.edge.hostedZoneId, zoneName: config.edge.zoneName });
      const alias = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
      new route53.ARecord(this, "ApiAlias", { zone, recordName: config.edge.apiDomain, target: alias });
      new route53.AaaaRecord(this, "ApiAliasIpv6", { zone, recordName: config.edge.apiDomain, target: alias });
      new CfnOutput(this, "PublicApiUrl", {
        value: `https://${config.edge.apiDomain}`,
        description: "LQ_API_BASE for the widget, NEXT_PUBLIC_API_BASE_URL for the dashboard: through CloudFront and WAF",
      });
    }

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint, description: "API Gateway's own address. Behind CloudFront, use PublicApiUrl" });
    new CfnOutput(this, "UserPoolId", { value: state.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: state.dashboardClient.userPoolClientId });
    new CfnOutput(this, "MigrateFunction", { value: migrate.functionName, description: "aws lambda invoke --function-name <this> out.json" });
    new CfnOutput(this, "TurnstileSecretArn", { value: state.appSecrets[0]!.secretArn, description: "Holds Cloudflare's test secret until the real one is put" });
  }
}
