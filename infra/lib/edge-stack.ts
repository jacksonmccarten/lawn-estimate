// What CloudFront needs from us-east-1, where it reads certificates and
// web ACLs from: the API's certificate and the WAF rules in front of it
// (design section 9). The distribution itself is in LqApi, beside the API.
//
// The rules, in order:
//   1. Amazon's IP reputation list: known bad addresses.
//   2. Known bad inputs (Log4j and the like).
//   3. The core rule set, with the body-size rule counting only: a Stripe
//      webhook can carry more than its 8 KB.
//   4. /estimate and /submit: 100 requests per 5 minutes per address.
//   5. Everything but /profile: 1,000 per 5 minutes per address. /profile is
//      called by the widget app's server, from a few shared addresses.
//   6. Bot Control (common), on /estimate and /submit only: the widget's
//      server and Stripe are not browsers and must not be judged as bots.
// A request a rate rule stops gets the contract's 429 rate_limited body.

import { Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import type { EdgeConfig } from "./config.js";

const PUBLIC_POSTS = ["/estimate", "/submit"];

const pathStartsWith = (path: string): wafv2.CfnWebACL.StatementProperty => ({
  byteMatchStatement: {
    fieldToMatch: { uriPath: {} },
    positionalConstraint: "STARTS_WITH",
    searchString: path,
    textTransformations: [{ priority: 0, type: "NONE" }],
  },
});
const anyOf = (statements: wafv2.CfnWebACL.StatementProperty[]): wafv2.CfnWebACL.StatementProperty =>
  statements.length === 1 ? statements[0]! : { orStatement: { statements } };

const visibility = (name: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true,
  metricName: name,
  sampledRequestsEnabled: true,
});

const managed = (priority: number, name: string, overrides: string[] = [], scopeDown?: wafv2.CfnWebACL.StatementProperty): wafv2.CfnWebACL.RuleProperty => ({
  name,
  priority,
  overrideAction: { none: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: "AWS",
      name,
      ...(overrides.length ? { ruleActionOverrides: overrides.map((rule) => ({ name: rule, actionToUse: { count: {} } })) } : {}),
      ...(name === "AWSManagedRulesBotControlRuleSet"
        ? { managedRuleGroupConfigs: [{ awsManagedRulesBotControlRuleSet: { inspectionLevel: "COMMON" } }] }
        : {}),
      ...(scopeDown ? { scopeDownStatement: scopeDown } : {}),
    },
  },
  visibilityConfig: visibility(name),
});

const rateLimited = { block: { customResponse: { responseCode: 429, customResponseBodyKey: "rate_limited" } } };

export class EdgeStack extends Stack {
  readonly certificate: acm.ICertificate;
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: StackProps & { edge: EdgeConfig }) {
    super(scope, id, { ...props, crossRegionReferences: true });
    const { edge } = props;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: edge.hostedZoneId, zoneName: edge.zoneName });
    this.certificate = new acm.Certificate(this, "ApiCertificate", {
      domainName: edge.apiDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const acl = new wafv2.CfnWebACL(this, "ApiAcl", {
      description: "Instant Lawn Quote API: reputation, bad inputs, core rules, per-address rate limits, bot control on the public routes",
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      customResponseBodies: {
        rate_limited: {
          contentType: "APPLICATION_JSON",
          content: JSON.stringify({ error: { code: "rate_limited", message: "too many requests; wait a few minutes" } }),
        },
      },
      rules: [
        managed(0, "AWSManagedRulesAmazonIpReputationList"),
        managed(1, "AWSManagedRulesKnownBadInputsRuleSet"),
        managed(2, "AWSManagedRulesCommonRuleSet", ["SizeRestrictions_BODY"]),
        {
          name: "PublicRoutesPerAddress",
          priority: 3,
          action: rateLimited,
          statement: {
            rateBasedStatement: { limit: 100, evaluationWindowSec: 300, aggregateKeyType: "IP", scopeDownStatement: anyOf(PUBLIC_POSTS.map(pathStartsWith)) },
          },
          visibilityConfig: visibility("PublicRoutesPerAddress"),
        },
        {
          name: "AllRoutesPerAddress",
          priority: 4,
          action: rateLimited,
          statement: {
            rateBasedStatement: {
              limit: 1000,
              evaluationWindowSec: 300,
              aggregateKeyType: "IP",
              scopeDownStatement: { notStatement: { statement: pathStartsWith("/profile/") } },
            },
          },
          visibilityConfig: visibility("AllRoutesPerAddress"),
        },
        managed(5, "AWSManagedRulesBotControlRuleSet", [], anyOf(PUBLIC_POSTS.map(pathStartsWith))),
      ],
      visibilityConfig: visibility("LqApiAcl"),
    });
    this.webAclArn = acl.attrArn;
  }
}
