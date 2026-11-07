import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";
import { resolveTls } from "./alb-tls";
import { VaradaConfig } from "./config";
import { ORG_GATEWAY_MAX_TASKS, OrgGatewayConfig } from "./org-gateway-config";

export interface OrgGatewayStackProps extends cdk.StackProps {
  readonly config: VaradaConfig;
  readonly orgGateway: OrgGatewayConfig;
  readonly vpc: ec2.IVpc;
}

export const ORG_GATEWAY_PORT = 8790;
export const ORG_GATEWAY_HEALTH_PATH = "/health";
/** Where the Dockerfile bakes the catalogue build (services/org-gateway/Dockerfile). */
export const ORG_GATEWAY_BUILD_DIR = "/app/catalog-build";
/** Header CloudFront adds to every origin request; the ALB forwards only requests that carry it. */
export const ORG_GATEWAY_ORIGIN_HEADER = "X-Varada-Origin";

/**
 * services/org-gateway on Fargate behind a public ALB: the CCIP-Read gateway for
 * `<label>.org.varada.eth` (/ccip Merkle fallback, /l2 Optimism proof proxy, /l2-fallback) and the
 * ranked org API (/orgs). Stateless: the catalogue build is baked into the image, so tasks can be
 * replaced and scaled freely. HTTPS on the ALB (custom domain) or on CloudFront's default domain.
 */
export class OrgGatewayStack extends cdk.Stack {
  public readonly repository: ecr.Repository;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecsPatterns.ApplicationLoadBalancedFargateService;
  public readonly logGroup: logs.LogGroup;
  /** Present with orgGatewayCloudFront=true. */
  public readonly distribution?: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: OrgGatewayStackProps) {
    super(scope, id, props);
    const { config, orgGateway: og, vpc } = props;
    if (!og.resolver) {
      cdk.Annotations.of(this).addWarning(
        "No orgGatewayResolver: the gateway serves the newest build and answers CCIP requests from any sender. Redeploy with the VaradaOrgResolver address once it exists.",
      );
    }

    this.repository = new ecr.Repository(this, "Repo", {
      repositoryName: `varada-${config.envName}-org-gateway`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: config.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: !config.isProd,
      lifecycleRules: [{ maxImageCount: 20, description: "keep the 20 most recent images (one per catalogue build)" }],
    });

    this.cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsights: true });
    const rpcSecret = secretsmanager.Secret.fromSecretNameV2(this, "RpcSecret", config.rpcSecretName);
    const logGroup = (this.logGroup = new logs.LogGroup(this, "Logs", {
      retention: config.isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }));

    const environment: Record<string, string> = {
      NODE_ENV: "production",
      PORT: String(ORG_GATEWAY_PORT),
      ORG_BUILD_DIRS: ORG_GATEWAY_BUILD_DIR,
      // ~240k orgs take ~3 GB once loaded (measured ~514 MB RSS for 40k); the task has 4 GiB.
      NODE_OPTIONS: "--max-old-space-size=3072",
    };
    if (og.resolver) environment.ORG_RESOLVER = og.resolver;

    const edge = og.cloudFront;
    const { zone, certificate } = resolveTls(this, { ...og, httpsEnabled: og.albHttps });
    this.service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster: this.cluster,
      cpu: 1024,
      memoryLimitMiB: 4096,
      // The pattern rejects 0; the real value (including 0 for a first deploy) is applied below.
      desiredCount: Math.max(1, og.desiredCount),
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskSubnets: { subnetType: config.privateEgress ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PUBLIC },
      assignPublicIp: !config.privateEgress,
      publicLoadBalancer: true,
      // Behind CloudFront with a known origin-facing prefix list, only CloudFront may reach the listener.
      openListener: !(edge && og.cloudFrontPrefixListId),
      protocol: og.albHttps ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      certificate,
      domainName: zone ? og.domainName : undefined,
      domainZone: zone,
      redirectHTTP: og.albHttps,
      circuitBreaker: { enable: true, rollback: true },
      // Stateless: start the new task before stopping the old one so lookups never see a gap.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Loading the full catalogue takes ~45 s before /health answers.
      healthCheckGracePeriod: cdk.Duration.seconds(180),
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(this.repository, og.imageTag),
        containerName: "org-gateway",
        containerPort: ORG_GATEWAY_PORT,
        enableLogging: true,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "org-gateway", logGroup }),
        environment,
        secrets: { ETH_RPC_URL: ecs.Secret.fromSecretsManager(rpcSecret) },
      },
    });
    // No ALB access logs, by design (docs/PRIVACY.md): they would record which names people resolve.
    this.service.loadBalancer.setAttribute("routing.http.drop_invalid_header_fields.enabled", "true");
    this.service.targetGroup.configureHealthCheck({
      path: ORG_GATEWAY_HEALTH_PATH,
      healthyHttpCodes: "200",
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });
    this.service.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "30");

    const cfnTask = this.service.taskDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTask.addPropertyOverride("ContainerDefinitions.0.HealthCheck", {
      Command: [
        "CMD",
        "node",
        "-e",
        `fetch('http://127.0.0.1:${ORG_GATEWAY_PORT}${ORG_GATEWAY_HEALTH_PATH}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
      ],
      Interval: 30,
      Timeout: 5,
      Retries: 3,
      StartPeriod: 120,
    });

    if (og.desiredCount === 0) {
      (this.service.service.node.defaultChild as ecs.CfnService).desiredCount = 0;
    } else {
      const scaling = this.service.service.autoScaleTaskCount({ minCapacity: og.desiredCount, maxCapacity: ORG_GATEWAY_MAX_TASKS });
      scaling.scaleOnCpuUtilization("Cpu", {
        targetUtilizationPercent: 60,
        scaleInCooldown: cdk.Duration.minutes(10),
        scaleOutCooldown: cdk.Duration.minutes(3),
      });
    }

    if (edge) this.distribution = this.addCloudFront(config.envName, og.cloudFrontPrefixListId);

    new cdk.CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri });
    const url = this.distribution
      ? `https://${this.distribution.distributionDomainName}`
      : `${og.albHttps ? "https" : "http"}://${og.domainName ?? this.service.loadBalancer.loadBalancerDnsName}`;
    new cdk.CfnOutput(this, "OrgGatewayUrl", {
      value: url,
      description: "Base URL for the resolver: <url>/ccip/{sender}/{data}.json and <url>/l2/{sender}/{data}.json",
    });
    new cdk.CfnOutput(this, "LoadBalancerDnsName", { value: this.service.loadBalancer.loadBalancerDnsName });
  }

  /**
   * CloudFront in front of the HTTP ALB, as in the indexer stack: the ALB answers 403 unless the
   * request carries the origin header (this stack's UUID, never published). Every method passes
   * through (CCIP-Read POSTs JSON). Only /ccip/* and /orgs* may be cached, for as long as the origin's
   * Cache-Control says (60 s); POST is never cached, and everything else, /l2 included, is not cached.
   */
  private addCloudFront(envName: string, prefixListId?: string): cloudfront.Distribution {
    const token = cdk.Fn.select(2, cdk.Fn.split("/", this.stackId));
    const listener = this.service.listener;
    if (prefixListId) {
      this.service.loadBalancer.connections.allowFrom(ec2.Peer.prefixList(prefixListId), ec2.Port.tcp(80), "CloudFront origin-facing");
    }
    new elbv2.ApplicationListenerRule(this, "FromCloudFront", {
      listener,
      priority: 1,
      conditions: [elbv2.ListenerCondition.httpHeader(ORG_GATEWAY_ORIGIN_HEADER, [token])],
      action: elbv2.ListenerAction.forward([this.service.targetGroup]),
    });
    (listener.node.defaultChild as elbv2.CfnListener).defaultActions = [
      { type: "fixed-response", fixedResponseConfig: { statusCode: "403", contentType: "text/plain", messageBody: "forbidden" } },
    ];

    const origin = new origins.LoadBalancerV2Origin(this.service.loadBalancer, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      customHeaders: { [ORG_GATEWAY_ORIGIN_HEADER]: token },
      readTimeout: cdk.Duration.seconds(30),
      keepaliveTimeout: cdk.Duration.seconds(30),
    });
    const live: cloudfront.BehaviorOptions = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Forwards Origin (the gateway answers CORS with *), query strings and the request body.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      compress: true,
    };
    const honourOrigin = new cloudfront.CachePolicy(this, "HonourOriginCache", {
      comment: `Varada ${envName} org gateway: cache per Cache-Control (60 s for /ccip and /orgs)`,
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.minutes(5),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const cached: cloudfront.BehaviorOptions = { ...live, cachePolicy: honourOrigin };
    const distribution = new cloudfront.Distribution(this, "Edge", {
      comment: `Varada ${envName} org-name gateway`,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: live,
      additionalBehaviors: { "/ccip/*": cached, "/orgs*": cached },
    });
    NagSuppressions.addResourceSuppressions(distribution, [
      { id: "AwsSolutions-CFR1", reason: "Public read-only gateway for ENS resolution worldwide; no geo restriction." },
      { id: "AwsSolutions-CFR2", reason: "No WAF on the gateway: answers are public and verified on-chain, so abuse costs only bandwidth." },
      { id: "AwsSolutions-CFR3", reason: "No access logs, matching the ALB: which names people resolve is not retained." },
      { id: "AwsSolutions-CFR4", reason: "Default *.cloudfront.net certificate (no custom domain); TLS policy is CloudFront-managed." },
      { id: "AwsSolutions-CFR5", reason: "Origin hop is HTTP to the ALB, which only forwards requests carrying the secret origin header." },
    ]);
    return distribution;
  }
}
