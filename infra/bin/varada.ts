#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { loadConfig } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { IndexerStack } from "../lib/indexer-stack";
import { ObservabilityStack } from "../lib/observability-stack";
import { SwarmStack } from "../lib/swarm-stack";
import { PublisherStack } from "../lib/publisher-stack";
import { OrgGatewayStack } from "../lib/org-gateway-stack";
import { loadOrgGatewayConfig } from "../lib/org-gateway-config";
import { OrgL2ProxyStack } from "../lib/org-l2-proxy-stack";
import { applySuppressions } from "../lib/suppressions";

const app = new cdk.App();
const config = loadConfig(app.node);
const env: cdk.Environment = { account: config.account, region: config.region };
const prefix = `Varada-${config.envName}`;
const common = { env, config, tags: { Project: "varada", Environment: config.envName } };

const network = new NetworkStack(app, `${prefix}-Network`, common);
const data = new DataStack(app, `${prefix}-Data`, {
  ...common,
  vpc: network.vpc,
  terminationProtection: config.isProd,
});
const indexer = new IndexerStack(app, `${prefix}-Indexer`, {
  ...common,
  vpc: network.vpc,
  dbSecret: data.secret,
  dbSecurityGroup: data.securityGroup,
  dbName: data.databaseName,
});
// Swarm before Publisher. The publisher reaches the gateway by its public URL from context, and the Bee
// API by its private DNS name; it imports only the Swarm task security group (for the 1633 rule).
const swarm = new SwarmStack(app, `${prefix}-Swarm`, { ...common, vpc: network.vpc });
const publisher = new PublisherStack(app, `${prefix}-Publisher`, { ...common, vpc: network.vpc, bee: swarm.beeApi });
publisher.addDependency(swarm, "deploy the gateway before the service that uploads through it");
// Org names' Optimism proof proxy (Lambda Function URL): opt in with -c orgL2Proxy=true.
if (["true", true].includes(app.node.tryGetContext("orgL2Proxy"))) {
  new OrgL2ProxyStack(app, `${prefix}-OrgL2Proxy`, {
    env,
    envName: config.envName,
    isProd: config.isProd,
    resolver: app.node.tryGetContext("orgResolver") || undefined,
    upstreams: app.node.tryGetContext("orgL2Upstreams") || undefined,
    tags: { Project: "varada", Environment: config.envName },
  });
}
// Org-name CCIP-Read gateway (docs/ORG_NAMES.md): opt in with -c orgGateway=true.
const orgGatewayConfig = loadOrgGatewayConfig(app.node, { isProd: config.isProd, allowInsecureHttp: config.allowInsecureHttp });
const orgGateway = orgGatewayConfig.enabled
  ? new OrgGatewayStack(app, `${prefix}-OrgGateway`, { ...common, orgGateway: orgGatewayConfig, vpc: network.vpc })
  : undefined;
new ObservabilityStack(app, `${prefix}-Observability`, {
  ...common,
  indexer,
  database: data.metrics,
  services: [
    { id: "Swarm", label: "Swarm gateway", service: swarm.service },
    { id: "Publisher", label: "Publisher", service: publisher.service, logAlarms: publisher.logAlarms },
    ...(orgGateway ? [{ id: "OrgGateway", label: "Org name gateway", service: orgGateway.service }] : []),
  ],
});

applySuppressions({ config, data, indexer, swarm, publisher, orgGateway });
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
