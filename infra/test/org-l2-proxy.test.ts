import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { AwsSolutionsChecks } from "cdk-nag";
import { OrgL2ProxyStack } from "../lib/org-l2-proxy-stack";

const env = { account: "123456789012", region: "eu-north-1" };
const code = lambda.Code.fromInline("export const handler = async () => ({ statusCode: 200, body: '' });");

describe("OrgL2ProxyStack", () => {
  test("a public Function URL with CORS, Node 22 on arm64, resolver gating", () => {
    const app = new cdk.App();
    const stack = new OrgL2ProxyStack(app, "Varada-dev-OrgL2Proxy", {
      env,
      envName: "dev",
      isProd: false,
      resolver: "0x1111111111111111111111111111111111111111",
      code,
    });
    cdk.Aspects.of(app).add(new AwsSolutionsChecks());
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
      Handler: "lambda.handler",
      Timeout: 10,
      Environment: { Variables: Match.objectLike({ ORG_RESOLVER: "0x1111111111111111111111111111111111111111" }) },
    });
    t.hasResourceProperties("AWS::Lambda::Url", {
      AuthType: "NONE",
      Cors: Match.objectLike({ AllowOrigins: ["*"], AllowMethods: ["GET", "POST"] }),
    });
    t.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "*",
      InvokedViaFunctionUrl: true,
    });
    t.hasOutput("L2ProxyTemplate", {});
    expect(Annotations.fromStack(stack).findError("*", Match.stringLikeRegexp("AwsSolutions-.*"))).toHaveLength(0);
  });

  test("rejects a malformed resolver", () => {
    expect(
      () => new OrgL2ProxyStack(new cdk.App(), "X", { env, envName: "dev", isProd: false, resolver: "0x12", code }),
    ).toThrow(/orgResolver/);
  });
});
