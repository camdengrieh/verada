import { existsSync } from "node:fs";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { NagSuppressions } from "cdk-nag";
import { Construct } from "constructs";

/** Compiled handler (`pnpm --filter @varada/org-gateway build:lambda`). */
export const ORG_L2_PROXY_ASSET = join(__dirname, "..", "..", "services", "org-gateway", "dist-lambda");

export interface OrgL2ProxyStackProps extends cdk.StackProps {
  readonly envName: string;
  readonly isProd: boolean;
  /** VaradaOrgResolver; when set, other CCIP senders get 404. */
  readonly resolver?: string;
  /** Upstream proof gateways (default in code: the public Unruggable Optimism gateways). */
  readonly upstreams?: string;
  /** Override for tests (skips the built-asset check). */
  readonly code?: lambda.Code;
}

/**
 * The org names' Optimism proof proxy (docs/ORG_NAMES.md): one stateless Lambda behind a Function
 * URL (HTTPS on *.lambda-url.<region>.on.aws, no VPC, no load balancer). It fans a CCIP-Read
 * `proveRequest` out to the public Unruggable gateways within ~3 s and answers "0x" when none is
 * quick enough, which sends VaradaOrgResolver to its Swarm-hosted Merkle fallback. Nothing it
 * returns is trusted: the resolver verifies every proof on Ethereum.
 */
export class OrgL2ProxyStack extends cdk.Stack {
  public readonly fn: lambda.Function;
  public readonly url: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: OrgL2ProxyStackProps) {
    super(scope, id, props);
    if (props.resolver !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(props.resolver)) {
      throw new Error('context "orgResolver" must be a 0x address');
    }
    const code =
      props.code ??
      (() => {
        if (!existsSync(join(ORG_L2_PROXY_ASSET, "lambda.js"))) {
          throw new Error(`missing ${ORG_L2_PROXY_ASSET}/lambda.js: run pnpm --filter @varada/org-gateway build:lambda`);
        }
        return lambda.Code.fromAsset(ORG_L2_PROXY_ASSET);
      })();

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: props.isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const environment: Record<string, string> = { L2_BUDGET_MS: "3000" };
    if (props.resolver) environment.ORG_RESOLVER = props.resolver;
    if (props.upstreams) environment.L2_UPSTREAMS = props.upstreams;

    this.fn = new lambda.Function(this, "Fn", {
      functionName: `varada-${props.envName}-org-l2-proxy`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "lambda.handler",
      code,
      memorySize: 256,
      // 3 s upstream budget plus cold start and response.
      timeout: cdk.Duration.seconds(10),
      environment,
      logGroup,
      description: "Varada org names: Optimism proof proxy for CCIP-Read (stateless)",
    });
    this.url = this.fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        allowedHeaders: ["content-type"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // Since late 2025 a public Function URL also needs lambda:InvokeFunction for "*", limited to
    // calls made through the URL (InvokedViaFunctionUrl); CDK 2.170 only adds InvokeFunctionUrl.
    const viaUrl = new lambda.CfnPermission(this, "InvokeViaFunctionUrl", {
      action: "lambda:InvokeFunction",
      functionName: this.fn.functionArn,
      principal: "*",
    });
    viaUrl.addPropertyOverride("InvokedViaFunctionUrl", true);

    NagSuppressions.addResourceSuppressions(
      this.fn,
      [
        {
          id: "AwsSolutions-IAM4",
          reason: "Only the AWS-managed basic execution role (CloudWatch Logs); the function calls no AWS APIs.",
          appliesTo: ["Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
        },
      ],
      true,
    );

    new cdk.CfnOutput(this, "L2ProxyUrl", { value: this.url.url });
    new cdk.CfnOutput(this, "L2ProxyTemplate", {
      value: cdk.Fn.join("", [this.url.url, "l2/{sender}/{data}.json"]),
      description: "ORG_L2_GATEWAY_URLS entry for SetupOrgNames (first)",
    });
  }
}
