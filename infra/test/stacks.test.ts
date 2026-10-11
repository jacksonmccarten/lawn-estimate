// The synthesized templates, checked for the properties the design depends
// on. Bundling is off: these tests read CloudFormation, not Lambda code.

import { routes } from "@lq/api-contract";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ApiStack } from "../lib/api-stack.js";
import { readConfig } from "../lib/config.js";
import { EdgeStack } from "../lib/edge-stack.js";
import { StateStack } from "../lib/state-stack.js";

const context = {
  "aws:cdk:bundling-stacks": [],
  "@aws-cdk/core:defaultCrossStackReferences": "strong",
  region: "us-east-2",
  databaseClusterArn: "arn:aws:rds:us-east-2:111111111111:cluster:lq-db",
  widgetOrigin: "https://w.example.com",
  dashboardOrigin: "https://app.example.com",
  sesFrom: "alerts@example.com",
};

function synth(over: Record<string, unknown> = {}) {
  const app = new App({ context: { ...context, ...over } });
  const config = readConfig(app);
  const env = { account: "111111111111", region: config.region };
  const state = new StateStack(app, "LqState", { env, config });
  const edge = config.edge ? new EdgeStack(app, "LqEdge", { env: { account: env.account, region: "us-east-1" }, edge: config.edge }) : undefined;
  const api = new ApiStack(app, "LqApi", { env, config, state, edge });
  return { state: Template.fromStack(state), api: Template.fromStack(api), edge: edge && Template.fromStack(edge) };
}

const { state, api } = synth();

describe("state stack", () => {
  it("before the move, builds the network and the key but no database, and uses the cluster it is told", () => {
    state.resourceCountIs("AWS::RDS::DBCluster", 0);
    state.resourceCountIs("AWS::EC2::VPC", 1);
    state.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true });
    state.hasOutput("OwnerLoginArn", {});
    state.hasOutput("DatabaseClusterArn", { Value: "arn:aws:rds:us-east-2:111111111111:cluster:lq-db" });
  });

  it("has no way out of the network: no NAT gateway, no internet gateway, only isolated subnets", () => {
    state.resourceCountIs("AWS::EC2::NatGateway", 0);
    state.resourceCountIs("AWS::EC2::InternetGateway", 0);
    state.resourceCountIs("AWS::EC2::Subnet", 2);
    state.hasResourceProperties("AWS::EC2::FlowLog", { TrafficType: "REJECT" });
  });

  describe("after the move", () => {
    const snapshot = "arn:aws:rds:us-east-2:111111111111:cluster-snapshot:lq-db-move-encrypted";
    const moved = synth({ databaseSnapshot: snapshot });

    it("restores the snapshot into the VPC, encrypted with its own key, with 7-day backups and the Data API", () => {
      moved.state.resourceCountIs("AWS::RDS::DBCluster", 1);
      moved.state.hasResourceProperties("AWS::RDS::DBCluster", {
        SnapshotIdentifier: snapshot,
        Engine: "aurora-postgresql",
        EngineVersion: "17.9",
        StorageEncrypted: true,
        KmsKeyId: Match.anyValue(),
        DBSubnetGroupName: Match.anyValue(),
        BackupRetentionPeriod: 7,
        EnableHttpEndpoint: true,
        DeletionProtection: true,
        ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 4, SecondsUntilAutoPause: 300 },
      });
      moved.state.hasResource("AWS::RDS::DBCluster", { DeletionPolicy: "Snapshot", UpdateReplacePolicy: "Snapshot" });
      moved.state.hasResourceProperties("AWS::RDS::DBInstance", { DBInstanceClass: "db.serverless", PubliclyAccessible: false });
    });

    it("points the functions' Data API permission at the restored cluster and no other", () => {
      const policies = Object.values(moved.api.findResources("AWS::IAM::Policy")).map((p) => JSON.stringify(p));
      const estimate = policies.find((p) => p.includes('"Ref":"EstimateServiceRole'))!;
      expect(estimate).toMatch(/rds-data:ExecuteStatement/);
      expect(estimate).toMatch(/Fn::ImportValue/);
      expect(estimate).not.toMatch(/cluster:lq-db"/);
    });
  });

  it("keeps a login per database role, and the application secrets apart", () => {
    // Owner, app_rw, app_public, Turnstile, quote token, IP salt, origin verify.
    state.resourceCountIs("AWS::SecretsManager::Secret", 7);
    for (const username of ["app_owner", "app_rw", "app_public"]) {
      state.hasResourceProperties("AWS::SecretsManager::Secret", {
        GenerateSecretString: Match.objectLike({ SecretStringTemplate: JSON.stringify({ username }), GenerateStringKey: "password" }),
      });
    }
  });

  it("has a user pool anyone can sign up to with a verified email, an optional authenticator and the two groups", () => {
    state.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      AutoVerifiedAttributes: ["email"],
      MfaConfiguration: "OPTIONAL",
      EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
      UsernameAttributes: ["email"],
      DeletionProtection: "ACTIVE",
    });
    state.hasResourceProperties("AWS::Cognito::UserPoolClient", { GenerateSecret: false, ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_SRP_AUTH"]) });
    state.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "admin" });
    state.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "owner" });
  });
});

describe("api stack", () => {
  const found = Object.values(api.findResources("AWS::ApiGatewayV2::Route")).map(
    (r) => (r as { Properties: { RouteKey: string; AuthorizationType: string } }).Properties,
  );

  it("has exactly the contract's routes", () => {
    expect(found.map((r) => r.RouteKey).sort()).toEqual(Object.values(routes).map((r) => `${r.method} ${r.path}`).sort());
  });

  it("puts every route behind the Cognito authorizer except the contract's public ones", () => {
    const open = found.filter((r) => r.AuthorizationType === "NONE").map((r) => r.RouteKey).sort();
    expect(open).toEqual(["GET /profile/{company}", "POST /estimate", "POST /submit"]);
    expect(found.filter((r) => r.AuthorizationType !== "NONE").every((r) => r.AuthorizationType === "JWT")).toBe(true);
  });

  it("answers the two front ends' browsers and no other origin, and throttles every route", () => {
    api.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.objectLike({ AllowOrigins: ["https://w.example.com", "https://app.example.com"] }),
    });
    api.hasResourceProperties("AWS::ApiGatewayV2::Stage", { DefaultRouteSettings: { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10 } });
  });

  it("gives the schema owner's login to the migrate function alone", () => {
    const policies = Object.values(api.findResources("AWS::IAM::Policy")).map((p) => JSON.stringify(p));
    const withOwner = policies.filter((p) => /OwnerLogin/.test(p));
    expect(withOwner).toHaveLength(1);
    expect(withOwner[0]).toMatch(/"Roles":\[\{"Ref":"MigrateServiceRole/);
  });

  it("lets the public functions use the app_public login and never app_rw's", () => {
    const policy = (role: string) => {
      const match = Object.values(api.findResources("AWS::IAM::Policy")).map((p) => JSON.stringify(p)).find((p) => p.includes(`"Ref":"${role}ServiceRole`));
      expect(match, role).toBeDefined();
      return match!;
    };
    for (const name of ["Estimate", "Submit", "Profile"]) {
      expect(policy(name), name).toMatch(/PublicLogin/);
      expect(policy(name), name).not.toMatch(/RwLogin/);
      expect(policy(name), name).toMatch(/rds-data:ExecuteStatement/);
      // The Data API on this cluster and no other.
      expect(policy(name), name).toMatch(/"Resource":"arn:aws:rds:us-east-2:111111111111:cluster:lq-db"/);
    }
    expect(policy("CompanyApi")).toMatch(/RwLogin/);
    expect(policy("CompanyApi")).not.toMatch(/PublicLogin|TurnstileSecret|QuoteTokenSecret/);
    // Only the function that sends lead alerts may send email.
    expect(policy("Submit")).toMatch(/ses:SendEmail/);
    expect(policy("Estimate")).not.toMatch(/ses:SendEmail/);
  });

  describe("AWS Monetization", () => {
    const appId = "arn:aws:appmonetization:us-west-2:111111111111:apps/0123456789abcdef0123456789abcdef/sandbox";
    const billed = synth({ monetizationAppId: appId, monetizationEndpoint: "https://us-west-2.monetization.example" });
    const billedPolicy = (fn: string) =>
      JSON.stringify(
        Object.values(billed.api.findResources("AWS::IAM::Policy")).find((p) =>
          JSON.stringify((p as { Properties: { Roles: unknown } }).Properties.Roles).includes(fn),
        ),
      );
    const environment = (fn: string) =>
      JSON.stringify(
        Object.entries(billed.api.findResources("AWS::Lambda::Function")).find(([id]) => id.startsWith(fn))?.[1],
      );

    it("is off unless configured: no app, no permission", () => {
      expect(JSON.stringify(api.toJSON())).not.toMatch(/appmonetization|MONETIZATION_/);
    });

    it("lets estimate check the plan and count, and the company API open the hosted pages, and nothing else", () => {
      expect(billedPolicy("Estimate")).toMatch(/appmonetization:GetEntitlementDecision/);
      expect(billedPolicy("Estimate")).toMatch(/appmonetization:PutEvent/);
      expect(billedPolicy("Estimate")).not.toMatch(/Session/);
      expect(billedPolicy("CompanyApi")).toMatch(/appmonetization:CreateBillingPortalSession/);
      expect(billedPolicy("CompanyApi")).not.toMatch(/PutEvent|GetEntitlementDecision/);
      for (const fn of ["Submit", "Profile", "Migrate"]) expect(billedPolicy(fn)).not.toMatch(/appmonetization/);
      expect(environment("Estimate")).toContain(appId);
      expect(environment("CompanyApi")).toContain(appId);
      expect(environment("Profile")).not.toContain("MONETIZATION_");
    });

    it("refuses an app id that is not an ARN, or one setting without the other", () => {
      const config = (over: Record<string, unknown>) => readConfig(new App({ context: { ...context, ...over } }));
      expect(() => config({ monetizationAppId: "0123456789abcdef0123456789abcdef", monetizationEndpoint: "https://m.example" })).toThrow(/monetizationAppId/);
      expect(() => config({ monetizationAppId: appId })).toThrow(/together/);
      expect(() => config({ monetizationAppId: appId, monetizationEndpoint: "https://m.example/path" })).toThrow(/monetizationEndpoint/);
    });
  });

  it("runs five functions on Node 22, none of them in the VPC", () => {
    const functions = Object.values(api.findResources("AWS::Lambda::Function")).map((f) => (f as { Properties: Record<string, unknown> }).Properties);
    expect(functions).toHaveLength(5);
    for (const f of functions) {
      expect(f.Runtime).toBe("nodejs22.x");
      expect(f.VpcConfig).toBeUndefined();
    }
  });
});

describe("behind CloudFront and WAF", () => {
  const edgeContext = { zoneName: "example.com", hostedZoneId: "Z0123456789ABCDEFGHIJ", apiDomain: "api.example.com" };
  const logOnly = synth({ ...edgeContext, originVerify: "log" });
  const enforced = synth({ ...edgeContext, originVerify: "enforce" });

  it("puts the API behind a distribution at its own name, with the web ACL, and nothing cached", () => {
    logOnly.api.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["api.example.com"],
        WebACLId: Match.anyValue(),
        ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: "TLSv1.2_2021" }),
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "https-only",
          CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
          FunctionAssociations: [Match.objectLike({ EventType: "viewer-request" })],
        }),
        Origins: [
          Match.objectLike({
            OriginCustomHeaders: [{ HeaderName: "x-origin-verify", HeaderValue: Match.anyValue() }],
            CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: "https-only" }),
          }),
        ],
      }),
    });
    logOnly.api.resourceCountIs("AWS::Route53::RecordSet", 2);
    logOnly.api.hasOutput("PublicApiUrl", { Value: "https://api.example.com" });
  });

  it("sends HSTS on every API response", () => {
    logOnly.api.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({ StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 31536000, IncludeSubdomains: true }) }),
      }),
    });
  });

  it("gives the public functions the origin-verify secret, and enforces it only when told", () => {
    const env = (template: Template, name: string) => {
      const found = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) => id.startsWith(name));
      return (found![1] as { Properties: { Environment: { Variables: Record<string, unknown> } } }).Properties.Environment.Variables;
    };
    for (const name of ["Estimate", "Submit", "Profile"]) {
      expect(env(logOnly.api, name).ORIGIN_VERIFY_ENFORCE, name).toBe("false");
      expect(env(enforced.api, name).ORIGIN_VERIFY_ENFORCE, name).toBe("true");
      expect(JSON.stringify(env(enforced.api, name).SECRETS_ARN), name).toMatch(/OriginVerifySecret/);
    }
    expect(env(enforced.api, "CompanyApi").ORIGIN_VERIFY_ENFORCE).toBeUndefined();
    // Without an edge, nothing changes.
    expect(env(api, "Estimate").ORIGIN_VERIFY_ENFORCE).toBeUndefined();
    api.resourceCountIs("AWS::CloudFront::Distribution", 0);
  });

  it("has a certificate for the API's name and a CloudFront web ACL with rate limits and bot control on the public routes", () => {
    const edge = logOnly.edge!;
    edge.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: "api.example.com", ValidationMethod: "DNS" });
    edge.hasResourceProperties("AWS::WAFv2::WebACL", {
      Scope: "CLOUDFRONT",
      DefaultAction: { Allow: {} },
      Rules: Match.arrayWith([
        Match.objectLike({ Name: "PublicRoutesPerAddress", Statement: { RateBasedStatement: Match.objectLike({ Limit: 100, EvaluationWindowSec: 300 }) } }),
        Match.objectLike({ Name: "AllRoutesPerAddress", Statement: { RateBasedStatement: Match.objectLike({ Limit: 1000 }) } }),
        Match.objectLike({
          Name: "AWSManagedRulesBotControlRuleSet",
          Statement: { ManagedRuleGroupStatement: Match.objectLike({ ScopeDownStatement: Match.anyValue() }) },
        }),
      ]),
    });
  });
});

describe("configuration", () => {
  it("refuses an origin with a path, a plain http origin, or a missing value", () => {
    const config = (over: Record<string, unknown>) => readConfig(new App({ context: { ...context, ...over } }));
    expect(() => config({ widgetOrigin: "https://w.example.com/w" })).toThrow(/widgetOrigin/);
    expect(() => config({ dashboardOrigin: "http://app.example.com" })).toThrow(/dashboardOrigin/);
    expect(() => config({ sesFrom: "" })).toThrow(/sesFrom/);
    expect(() => config({ sesFrom: "not an address" })).toThrow(/sesFrom/);
    expect(() => config({ databaseClusterArn: "lq-db" })).toThrow(/databaseClusterArn/);
    expect(() => config({ databaseClusterArn: undefined })).toThrow(/databaseSnapshot/);
    expect(() => config({ databaseSnapshot: "lq-db-snap" })).toThrow(/databaseSnapshot/);
    const edge = { zoneName: "example.com", hostedZoneId: "Z0123456789ABCDEFGHIJ", apiDomain: "api.example.com", originVerify: "log" };
    expect(config(edge).edge).toEqual(edge);
    expect(() => config({ ...edge, apiDomain: "api.other.com" })).toThrow(/apiDomain/);
    expect(() => config({ ...edge, originVerify: "on" })).toThrow(/originVerify/);
  });
});
