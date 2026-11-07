# OrgGateway stack (`Varada-<env>-OrgGateway`)

Hosts `services/org-gateway`, the CCIP-Read gateway behind `<label>.org.varada.eth` (see
`docs/ORG_NAMES.md`):

- `/ccip`: Merkle fallback
- `/l2`: Optimism proof proxy with a 3 s budget
- `/l2-fallback`
- `/orgs`: ranked org API
- `/health`

It is opt-in: the stack exists only with `-c orgGateway=true`, so deploys of the other stacks are
unaffected.

| Item | Setting |
|---|---|
| ECR | `varada-<env>-org-gateway`, immutable tags, scan on push |
| Task | Fargate 1 vCPU / 4 GiB. About 240k orgs take ~3 GB in memory (measured: 514 MB RSS for 40k). `NODE_OPTIONS=--max-old-space-size=3072`. Health-check grace 180 s, because loading takes ~45 s |
| Scaling | Stateless, so it scales 1 to 4 on CPU. Deployments start the new task before stopping the old one |
| Catalogue | Baked into the image: the Dockerfile copies `.catalog/build` to `/app/catalog-build`. A new catalogue build needs a new image tag |
| ALB | Public, health `GET /health`, circuit breaker, no access logs, invalid headers dropped |
| Environment | `PORT=8790`, `ORG_BUILD_DIRS`, `ETH_RPC_URL` from the `rpcSecretName` secret (the one the indexer uses), and `ORG_RESOLVER` when given |
| HTTPS | Either (a) the ALB serves your own domain with a certificate, or (b) CloudFront's `*.cloudfront.net` domain sits in front of an HTTP ALB. In (b) the ALB forwards only requests that carry the secret origin header, optionally only from CloudFront's prefix list. CloudFront passes every method through. Only `/ccip/*` and `/orgs*` GETs are cached, per the origin's `Cache-Control` (60 s); POST and `/l2*` are never cached |

## Context keys

| Key | Default | Meaning |
|---|---|---|
| `orgGateway` | `false` | Create the stack |
| `orgGatewayCloudFront` | `false` | HTTPS on the CloudFront default domain (allowed in prod) |
| `orgGatewayCloudFrontPrefixListId` | – | CloudFront origin-facing prefix list. With it, only CloudFront can reach the ALB (`pl-fab65393` in eu-north-1) |
| `orgGatewayDomainName` + `orgGatewayCertificateArn` | – | HTTPS on your own domain with an existing ACM certificate. Point DNS at the `LoadBalancerDnsName` output |
| `orgGatewayDomainName` + `orgGatewayHostedZoneId` + `orgGatewayHostedZoneName` | – | The stack issues the certificate and creates the alias record |
| `orgGatewayImageTag` | `initial` | Image tag in the ECR repository |
| `orgGatewayDesiredCount` | `1` | 0 to 4. Use `0` for the first deploy, while the repository is empty |
| `orgGatewayResolver` | – | `VaradaOrgResolver` address. The gateway then picks the build that matches `root()` and refuses other senders |

There is no HTTPS mode only with `allowInsecureHttp=true` outside prod. A resolver must never point
at a plain-HTTP gateway, because wallets refuse to call one from an HTTPS page. The usual app
context is still needed for synth (account, region, the indexer's chain context or
`allowInsecureHttp`), exactly as for the other stacks.

## Deploy

Prerequisites:

- an AWS session (`aws login`);
- `cdk bootstrap` done in the account and region;
- the Secrets Manager secret `varada/<env>/eth-rpc-url` (plain string, an Ethereum mainnet RPC URL). It already exists if the indexer is deployed;
- the final catalogue build in `.catalog/build`.

```sh
cd infra
CTX="-c account=<id> -c region=<region> -c allowInsecureHttp=true <the app's usual chain context>"

# 1. Repository, service (parked), ALB, CloudFront
npx cdk deploy Varada-dev-OrgGateway $CTX -c orgGateway=true -c orgGatewayCloudFront=true -c orgGatewayDesiredCount=0

# 2. Image: the tag names the catalogue build (first 10 hex digits of its namesRoot)
cd ..
TAG=$(node -p "require('./.catalog/build/catalog.json').namesRoot.slice(2,12)")
REPO=$(aws cloudformation describe-stacks --stack-name Varada-dev-OrgGateway --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue" --output text)
aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
docker build --platform linux/amd64 -f services/org-gateway/Dockerfile -t "$REPO:$TAG" .
docker push "$REPO:$TAG"

# 3. Run it
cd infra && npx cdk deploy Varada-dev-OrgGateway $CTX -c orgGateway=true -c orgGatewayCloudFront=true -c orgGatewayImageTag=$TAG
curl "$(aws cloudformation describe-stacks --stack-name Varada-dev-OrgGateway --query "Stacks[0].Outputs[?OutputKey=='OrgGatewayUrl'].OutputValue" --output text)/health"

# 4. After SetupOrgNames deployed the resolver (its gateway URLs are <OrgGatewayUrl>/ccip/... and /l2/...)
npx cdk deploy Varada-dev-OrgGateway $CTX -c orgGateway=true -c orgGatewayCloudFront=true -c orgGatewayImageTag=$TAG -c orgGatewayResolver=<resolver>
```

Each new catalogue build means a new image tag (step 2), then step 3 or 4 with that tag. The
running task is replaced without a gap.
