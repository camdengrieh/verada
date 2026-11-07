import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { loadConfig } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { IndexerStack } from "../lib/indexer-stack";
import { OrgGatewayStack } from "../lib/org-gateway-stack";
import { loadOrgGatewayConfig } from "../lib/org-gateway-config";
import { applySuppressions } from "../lib/suppressions";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const CHAIN_CTX = {
  startBlock: "1000",
  factoryAddress: A(1),
  feeVaultAddress: A(2),
  causeRegistryAddress: A(3),
  epochGovernorAddress: A(4),
  donationDistributorAddress: A(5),
  feeConsolidatorAddress: A(6),
  quoteRegistryAddress: A(7),
};
const CERT = "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000";
const RESOLVER = "0x7eD3c5f3712b1EF457c83D02fD52D3B16E6234A2";

/** Mirrors bin/varada.ts for the stacks the org gateway needs (plus Data/Indexer for suppressions). */
function build(ctx: Record<string, string> = {}) {
  const app = new cdk.App({
    context: {
      account: "111111111111",
      region: "us-east-1",
      availabilityZones: "us-east-1a,us-east-1b",
      allowInsecureHttp: "true",
      ...CHAIN_CTX,
      ...ctx,
    },
  });
  const config = loadConfig(app.node);
  const og = loadOrgGatewayConfig(app.node, { isProd: config.isProd, allowInsecureHttp: config.allowInsecureHttp });
  const common = { env: { account: config.account, region: config.region }, config };
  const network = new NetworkStack(app, "Network", common);
  const data = new DataStack(app, "Data", { ...common, vpc: network.vpc });
  const indexer = new IndexerStack(app, "Indexer", {
    ...common,
    vpc: network.vpc,
    dbSecret: data.secret,
    dbSecurityGroup: data.securityGroup,
    dbName: data.databaseName,
  });
  const orgGateway = og.enabled ? new OrgGatewayStack(app, "OrgGateway", { ...common, orgGateway: og, vpc: network.vpc }) : undefined;
  applySuppressions({ config, data, indexer, orgGateway });
  Aspects.of(app).add(new AwsSolutionsChecks());
  return { app, orgGateway, og };
}

const edge = (extra: Record<string, string> = {}) => build({ orgGateway: "true", orgGatewayCloudFront: "true", ...extra });

describe("org gateway config", () => {
  test("off by default: no stack", () => {
    const { orgGateway, og } = build();
    expect(og.enabled).toBe(false);
    expect(orgGateway).toBeUndefined();
  });
  test("needs HTTPS unless allowInsecureHttp, and one HTTPS mode only", () => {
    expect(() => build({ orgGateway: "true", allowInsecureHttp: "", indexerDomainName: "api.example.com", indexerCertificateArn: CERT })).toThrow(
      /must be served over HTTPS/,
    );
    expect(() =>
      edge({ orgGatewayDomainName: "names.example.com", orgGatewayCertificateArn: CERT }),
    ).toThrow(/contradicts/);
    expect(() => build({ orgGateway: "true", orgGatewayDomainName: "names.example.com" })).toThrow(/needs either/);
  });
  test("prod accepts the CloudFront mode and rejects plain HTTP", () => {
    const node = (ctx: Record<string, string>) => new cdk.App({ context: ctx }).node;
    expect(loadOrgGatewayConfig(node({ orgGateway: "true", orgGatewayCloudFront: "true" }), { isProd: true, allowInsecureHttp: false }).cloudFront).toBe(true);
    expect(() => loadOrgGatewayConfig(node({ orgGateway: "true" }), { isProd: true, allowInsecureHttp: false })).toThrow(/HTTPS/);
  });
  test("validates resolver, desired count, prefix list and image tag", () => {
    expect(() => edge({ orgGatewayResolver: "0x1234" })).toThrow(/orgGatewayResolver/);
    expect(() => edge({ orgGatewayDesiredCount: "9" })).toThrow(/orgGatewayDesiredCount/);
    expect(() => edge({ orgGatewayCloudFrontPrefixListId: "cloudfront" })).toThrow(/prefix list/);
    expect(() => build({ orgGateway: "true", orgGatewayCloudFrontPrefixListId: "pl-fab65393" })).toThrow(/needs orgGatewayCloudFront/);
    expect(() => edge({ orgGatewayImageTag: "bad tag" })).toThrow(/image tag/);
  });
});

describe("org gateway stack", () => {
  test("task: 1 vCPU / 4 GiB, baked build dir, resolver, RPC from the secret, node health check, 180 s grace", () => {
    const t = Template.fromStack(edge({ orgGatewayResolver: RESOLVER, orgGatewayImageTag: "abc123" }).orgGateway!);
    t.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: "varada-dev-org-gateway",
      ImageTagMutability: "IMMUTABLE",
      ImageScanningConfiguration: { ScanOnPush: true },
    });
    t.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "1024",
      Memory: "4096",
      ContainerDefinitions: [
        Match.objectLike({
          Image: Match.objectLike({ "Fn::Join": Match.arrayWith([Match.arrayWith([":abc123"])]) }),
          PortMappings: [Match.objectLike({ ContainerPort: 8790 })],
          Environment: Match.arrayWith([
            { Name: "PORT", Value: "8790" },
            { Name: "ORG_BUILD_DIRS", Value: "/app/catalog-build" },
            { Name: "NODE_OPTIONS", Value: "--max-old-space-size=3072" },
            { Name: "ORG_RESOLVER", Value: RESOLVER },
          ]),
          Secrets: [Match.objectLike({ Name: "ETH_RPC_URL" })],
          HealthCheck: Match.objectLike({ Command: Match.arrayWith(["CMD", "node"]) }),
        }),
      ],
    });
    t.hasResourceProperties("AWS::ECS::Service", {
      HealthCheckGracePeriodSeconds: 180,
      DeploymentConfiguration: Match.objectLike({ DeploymentCircuitBreaker: { Enable: true, Rollback: true } }),
    });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", { HealthCheckPath: "/health" });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      LoadBalancerAttributes: Match.arrayWith([{ Key: "routing.http.drop_invalid_header_fields.enabled", Value: "true" }]),
    });
    const lb = JSON.stringify(t.findResources("AWS::ElasticLoadBalancingV2::LoadBalancer"));
    expect(lb).not.toContain("access_logs.s3.enabled");
  });

  test("CloudFront: HTTPS, every method, no caching except /ccip/* and /orgs* by origin headers, 403 without the header", () => {
    const t = Template.fromStack(edge({ orgGatewayCloudFrontPrefixListId: "pl-fab65393" }).orgGateway!);
    const disabled = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"; // managed CachingDisabled
    const allViewerNoHost = "b689b0a8-53d0-40ab-baf2-68738e2966ac"; // managed AllViewerExceptHostHeader
    t.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "https-only",
          AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
          CachePolicyId: disabled,
          OriginRequestPolicyId: allViewerNoHost,
        }),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: "/ccip/*", AllowedMethods: Match.arrayWith(["POST"]), OriginRequestPolicyId: allViewerNoHost }),
          Match.objectLike({ PathPattern: "/orgs*" }),
        ]),
        Origins: [Match.objectLike({ OriginCustomHeaders: [Match.objectLike({ HeaderName: "X-Varada-Origin" })] })],
      }),
    });
    t.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({ DefaultTTL: 0, MinTTL: 0, MaxTTL: 300 }),
    });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { DefaultActions: [Match.objectLike({ Type: "fixed-response" })] });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", { Priority: 1, Conditions: [Match.objectLike({ Field: "http-header" })] });
    expect(JSON.stringify(t.findResources("AWS::EC2::SecurityGroupIngress"))).not.toContain("0.0.0.0/0");
    expect(JSON.stringify(t.findOutputs("OrgGatewayUrl").OrgGatewayUrl?.Value)).toContain("DomainName");
  });

  test("custom domain: HTTPS listener with redirect, no CloudFront", () => {
    const t = Template.fromStack(
      build({ orgGateway: "true", orgGatewayDomainName: "names.example.com", orgGatewayCertificateArn: CERT }).orgGateway!,
    );
    t.resourceCountIs("AWS::CloudFront::Distribution", 0);
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Protocol: "HTTPS", Certificates: [{ CertificateArn: CERT }] });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Protocol: "HTTP",
      DefaultActions: [Match.objectLike({ Type: "redirect" })],
    });
    expect(t.findOutputs("OrgGatewayUrl").OrgGatewayUrl?.Value).toBe("https://names.example.com");
  });

  test("desiredCount 0 parks the service without autoscaling; default scales 1 to 4 on CPU", () => {
    const parked = Template.fromStack(edge({ orgGatewayDesiredCount: "0" }).orgGateway!);
    parked.hasResourceProperties("AWS::ECS::Service", { DesiredCount: 0 });
    parked.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
    const on = Template.fromStack(edge().orgGateway!);
    on.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", { MinCapacity: 1, MaxCapacity: 4 });
  });

  test("warns without a resolver; cdk-nag finds nothing unsuppressed", () => {
    const stack = edge().orgGateway!;
    expect(Annotations.fromStack(stack).findWarning("*", Match.stringLikeRegexp("No orgGatewayResolver"))).toHaveLength(1);
    expect(Annotations.fromStack(stack).findError("*", Match.anyValue())).toHaveLength(0);
    const custom = build({ orgGateway: "true", orgGatewayDomainName: "names.example.com", orgGatewayCertificateArn: CERT }).orgGateway!;
    expect(Annotations.fromStack(custom).findError("*", Match.anyValue())).toHaveLength(0);
  });
});
