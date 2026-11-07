import { Node } from "constructs";

/**
 * Context for the org-name gateway (`services/org-gateway`, OrgGatewayStack). Kept apart from
 * config.ts: the stack is opt-in (`-c orgGateway=true`) and nothing else reads these keys.
 *
 * HTTPS, one of:
 *  (a) orgGatewayDomainName with orgGatewayCertificateArn, or with orgGatewayHostedZoneId +
 *      orgGatewayHostedZoneName (the stack issues the certificate and the alias record);
 *  (b) orgGatewayCloudFront=true: CloudFront's default *.cloudfront.net certificate in front of an
 *      HTTP ALB (allowed in prod: viewers still get HTTPS; the ALB forwards only requests carrying
 *      the secret origin header, optionally only from CloudFront's prefix list).
 * Neither is accepted only with allowInsecureHttp=true outside prod. Wallets refuse plain-HTTP
 * CCIP-Read gateways from an HTTPS page, so a resolver must never point at one.
 */
export interface OrgGatewayConfig {
  readonly enabled: boolean;
  readonly domainName?: string;
  readonly certificateArn?: string;
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
  /** The ALB terminates TLS (mode a). */
  readonly albHttps: boolean;
  /** CloudFront default domain in front of the HTTP ALB (mode b). */
  readonly cloudFront: boolean;
  readonly cloudFrontPrefixListId?: string;
  readonly imageTag: string;
  readonly desiredCount: number;
  /** ORG_RESOLVER: VaradaOrgResolver on Ethereum (picks the build by root(), refuses other senders). */
  readonly resolver?: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const ACM_ARN = /^arn:aws[a-z-]*:acm:[a-z0-9-]+:\d{12}:certificate\/[0-9a-f-]+$/;
export const ORG_GATEWAY_MAX_TASKS = 4;

const str = (node: Node, key: string): string | undefined => {
  const v = node.tryGetContext(key);
  return v === undefined || v === null || v === "" ? undefined : String(v);
};

const bool = (node: Node, key: string): boolean => {
  const v = str(node, key);
  if (v === undefined) return false;
  if (v !== "true" && v !== "false") throw new Error(`context "${key}" must be true or false`);
  return v === "true";
};

export function loadOrgGatewayConfig(node: Node, opts: { isProd: boolean; allowInsecureHttp: boolean }): OrgGatewayConfig {
  const enabled = bool(node, "orgGateway");
  const domainName = str(node, "orgGatewayDomainName")?.toLowerCase();
  const certificateArn = str(node, "orgGatewayCertificateArn");
  const hostedZoneId = str(node, "orgGatewayHostedZoneId");
  const hostedZoneName = str(node, "orgGatewayHostedZoneName")?.toLowerCase();
  const cloudFront = bool(node, "orgGatewayCloudFront");
  const cloudFrontPrefixListId = str(node, "orgGatewayCloudFrontPrefixListId");
  const resolver = str(node, "orgGatewayResolver");
  const imageTag = str(node, "orgGatewayImageTag") ?? "initial";
  const countRaw = str(node, "orgGatewayDesiredCount");
  const desiredCount = countRaw === undefined ? 1 : Number(countRaw);

  if (!enabled) {
    return { enabled, albHttps: false, cloudFront: false, imageTag, desiredCount: 0 };
  }
  if (domainName && !HOSTNAME.test(domainName)) throw new Error('context "orgGatewayDomainName" must be a valid hostname');
  if (certificateArn && !ACM_ARN.test(certificateArn)) throw new Error('context "orgGatewayCertificateArn" must be an ACM certificate ARN');
  if (Boolean(hostedZoneId) !== Boolean(hostedZoneName)) {
    throw new Error('"orgGatewayHostedZoneId" and "orgGatewayHostedZoneName" must be given together');
  }
  if (hostedZoneName && domainName && domainName !== hostedZoneName && !domainName.endsWith(`.${hostedZoneName}`)) {
    throw new Error('"orgGatewayDomainName" must be inside the hosted zone "orgGatewayHostedZoneName"');
  }
  const albHttps = Boolean(certificateArn || hostedZoneId);
  if (albHttps && !domainName) throw new Error('HTTPS needs context "orgGatewayDomainName" (the hostname the certificate covers).');
  if (domainName && !albHttps) {
    throw new Error('"orgGatewayDomainName" needs either "orgGatewayCertificateArn" or "orgGatewayHostedZoneId"+"orgGatewayHostedZoneName".');
  }
  if (albHttps && cloudFront) throw new Error('"orgGatewayCloudFront" contradicts the ALB certificate settings; use one HTTPS mode');
  if (!albHttps && !cloudFront && (opts.isProd || !opts.allowInsecureHttp)) {
    throw new Error(
      "The org gateway must be served over HTTPS (wallets call it from HTTPS pages for CCIP-Read). Pass orgGatewayDomainName " +
        "with orgGatewayCertificateArn or orgGatewayHostedZoneId + orgGatewayHostedZoneName, or -c orgGatewayCloudFront=true" +
        (opts.isProd ? "." : ", or -c allowInsecureHttp=true for a throwaway non-prod environment."),
    );
  }
  if (cloudFrontPrefixListId && !/^pl-[0-9a-f]+$/.test(cloudFrontPrefixListId)) {
    throw new Error('context "orgGatewayCloudFrontPrefixListId" must be a managed prefix list id like pl-0123abcd');
  }
  if (cloudFrontPrefixListId && !cloudFront) throw new Error('"orgGatewayCloudFrontPrefixListId" needs orgGatewayCloudFront=true');
  if (resolver !== undefined && !ADDRESS.test(resolver)) throw new Error('context "orgGatewayResolver" must be a 0x-prefixed 20-byte address');
  if (!Number.isInteger(desiredCount) || desiredCount < 0 || desiredCount > ORG_GATEWAY_MAX_TASKS) {
    throw new Error(`context "orgGatewayDesiredCount" must be an integer from 0 to ${ORG_GATEWAY_MAX_TASKS}`);
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(imageTag)) throw new Error('context "orgGatewayImageTag" is not a valid image tag');
  return { enabled, domainName, certificateArn, hostedZoneId, hostedZoneName, albHttps, cloudFront, cloudFrontPrefixListId, imageTag, desiredCount, resolver };
}
