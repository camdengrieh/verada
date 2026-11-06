---
title: Deploying to Ethereum mainnet
description: How to deploy the Varada contracts to Ethereum mainnet, rehearse on a fork, and finish the owner setup.
---

# Deploying to Ethereum mainnet

Varada deploys only to Ethereum mainnet. Every deployment is rehearsed first on a mainnet fork, with
the same script and the same sender.

One script, `contracts/script/DeployLive.s.sol`, deploys the whole system in one run:

- the weekly system (`Deploy.deploy`);
- live-donation mode: the rotation governor, the live-donation vault and the mined live hook.

It wires every role, hands ownership to the final owner, and writes the addresses to
`contracts/deployments/1.json` and `contracts/deployments/1-live.json`.

## What gets deployed

| Contract | Role | Owned by `OWNER` after hand-over |
| --- | --- | --- |
| `VaradaFactory` | launches tokens, pools and locked liquidity | no |
| `VaradaHook` | weekly-mode v4 hook (address mined with CREATE2) | no |
| `VaradaLpLocker` | holds launch liquidity, collects LP fees | no |
| `VaradaResolver` | ENS resolver for `<label>.varada.eth` | no |
| `FeeVault` | holds each epoch's fees until settlement | yes |
| `FeeConsolidator` | converts fees to USDC through route pools | yes |
| `QuoteRegistry` | allowlisted quote assets and their routes | yes |
| `CauseRegistry` | causes (Endaoment orgs) and their status | yes |
| `CauseCatalog` | the published cause catalogue (Merkle root per version) | yes |
| `EpochGovernor` | weekly encrypted cause vote | yes |
| `DonationDistributor` | pays the winning cause through Endaoment | yes |
| `TokenProfileRegistry` | token labels, controllers, contenthash | yes |
| `TakeoverGovernor` | holder votes to replace a token's controller | yes |
| `ZamaVotingScheme` | FHE ballots on Zama | yes |
| `CuratorRegistry` | curator agents (ERC-8004) and their picks | yes |
| `RotationGovernor` | live-mode rotation polls | yes |
| `LiveDonationVault` | live-mode per-cause credit | yes |
| `VaradaLiveHook` | live-mode v4 hook (address mined with CREATE2) | no |

The rehearsal on 2026-11-07, at commit `2f74a99`, took **54 transactions** and about **65.4M gas**.
That is about 0.018 ETH at 0.27 gwei. The largest single transaction was `RotationGovernor` at 9.45M
gas, under the 16.7M per-transaction cap. Fund the deployer with enough for a higher gas price; 0.1
ETH covers 65.4M gas at 1.5 gwei.

## Accounts

| Variable | Meaning |
| --- | --- |
| deployer | the account that sends the 54 transactions. Use a fresh key funded only with gas, or the owner itself. |
| `OWNER` | the final owner of every admin contract. If it differs from the deployer, the script starts a two-step transfer and `OWNER` must accept each one. It can be an EOA now and a multisig later, through another two-step transfer. |
| `PLATFORM_TREASURY` | receives the platform's share of fees; also the `addr` record of `varada.eth` |
| `SITE_SWARM_REF` | optional: the Swarm reference of the site feed manifest, served as the default contenthash. It can be set later with `TokenProfileRegistry.setDefaultContenthash`. |

Keep keys out of the repository and out of shell history. Use Foundry's encrypted keystore:

```sh
cast wallet import varada-deployer --interactive   # paste the key, choose a password
cast wallet address --account varada-deployer      # prints the deployer address
```

## 1. Rehearse on a mainnet fork

Run from `contracts/`, at the exact commit you will deploy, after `forge clean && forge build`:

```sh
export ETH_RPC_URL=<mainnet RPC>
OWNER=<owner> PLATFORM_TREASURY=<treasury> \
forge script script/DeployLive.s.sol --sig "runWithLive()" \
  --fork-url $ETH_RPC_URL --sender $(cast wallet address --account varada-deployer)
```

Nothing is broadcast. Check that:

- the script ends with `Script ran successfully`;
- all 18 addresses are logged;
- the estimated gas fits the deployer's balance.

The addresses depend on the deployer's nonce, so the rehearsal must use the real sender and nothing
else may send from that account before the broadcast.

## 2. Broadcast

The command is the same, with `--rpc-url` instead of `--fork-url`, plus the wallet and `--broadcast`.
Add `--verify` with `ETHERSCAN_API_KEY` set to verify the sources on Etherscan in the same run.

```sh
OWNER=<owner> PLATFORM_TREASURY=<treasury> \
forge script script/DeployLive.s.sol --sig "runWithLive()" \
  --rpc-url $ETH_RPC_URL --account varada-deployer --broadcast --slow \
  --verify --etherscan-api-key $ETHERSCAN_API_KEY
```

`--slow` sends each transaction only after the previous one is mined, so a failure stops the run at a
known point. If the run stops part-way, rerun with `--resume` instead of starting again.

The script writes `contracts/deployments/1.json` and `1-live.json` (git-ignored). Review them, then
force-add the mainnet record deliberately.

## 3. Owner setup after deployment

These steps are owner transactions that the script cannot send. Do them in this order.

1. **Accept ownership** (only if `OWNER` differs from the deployer): call `acceptOwnership()` from
   `OWNER` on the 13 owned contracts in the table above.
2. **Point `varada.eth` at the resolver.** The owner of `varada.eth` runs
   `forge script script/SetParentResolver.s.sol --rpc-url $ETH_RPC_URL --broadcast --account <ens-owner>`.
   The script reads the resolver from `deployments/1.json` and checks everything first.
3. **Publish the cause catalogue:** `CauseCatalog.setVersion`, with calldata from
   `varada-catalog calldata`.
4. **Add a fallback cause and set it as the default:** `CauseRegistry.addCause`, then
   `EpochGovernor.setDefaultCause`. **Required:** without it, an epoch with no ballots cannot pay out.
5. **Add the quote assets and their routes:** `QuoteRegistry.addQuoteAssetWithRoute`. Do not add a
   quote asset whose balances can shrink.
6. **Seed the route price references:** `FeeConsolidator.seedReferences` (or `setReference`) for every
   route pool. **Required:** until then, every route hop reverts and fees stay held.
7. **Register the curator agents** in `CuratorRegistry`, and link each agent wallet
   (`linkAgentWallet`).
8. **Fund the Zama fee account** used by the tally keeper (see `services/publisher`).
9. **Set the site contenthash** with `TokenProfileRegistry.setDefaultContenthash`, after the first site
   publish, if `SITE_SWARM_REF` was not known at deploy time.

## 4. After launch

- Point the SDK, indexer, publisher and web app at `deployments/1.json` and `1-live.json`.
- Start the keepers. The keeper alarms on `CuratedPicksUnavailable`; see the owner runbook in
  `agents/README.md`.
- Launch tokens through a private RPC, so that a token label cannot be taken from the mempool.
- Move ownership to a multisig when it is ready: `transferOwnership(multisig)` on each owned
  contract, then `acceptOwnership()` from the multisig.

## 5. Deploy the indexer

The indexer (`services/indexer`) is the only always-on read path. Its AWS stacks are in `infra/`; the
full parameter list and secrets are in [`infra/README.md`](../infra/README.md). Nothing below runs
until you hold an AWS session for the target account; the offline checks need none.

**Start block and addresses.** Generate them from the deployment records instead of copying them:

```sh
pnpm --filter @varada/indexer deployment-env --dir ../../contracts/deployments --format cdk   # -c flags for infra
pnpm --filter @varada/indexer deployment-env --dir ../../contracts/deployments --format env   # services/indexer/.env.local
```

`START_BLOCK` is `deployBlock` from `1.json`, the block of the first deployment transaction, so the
backfill covers the whole system and nothing earlier. `ROTATION_GOVERNOR_ADDRESS` comes from
`1-live.json`; the live hook and vault are found through the factory.

**Offline checks** (no credentials):

```sh
cd infra && pnpm test && pnpm typecheck
npx cdk synth -c account=111111111111 -c region=us-east-1 -c availabilityZones=us-east-1a,us-east-1b \
  -c envName=prod -c indexerDomainName=<host> -c indexerCertificateArn=<arn> \
  -c indexerCorsOrigins=<origins> $(pnpm --silent --filter @varada/indexer deployment-env --dir ../../contracts/deployments --format cdk)
```

**Deploy order** (prerequisites and commands in `infra/README.md`, "Deploy"): bootstrap, RPC secret,
`Network`, `Data` and `Indexer` with `indexerDesiredCount=0`, push the image, redeploy with
`indexerImageTag` and the chain values from above, then point DNS at `LoadBalancerDnsName`.

**Behaviour to rely on:**

- *One writer.* `ponder start` locks its database schema, so `indexerDesiredCount` and
  `indexerMaxCount` are capped at 1. For availability run a second, independent environment (a
  mirror) and list both URLs in the web app's `indexerUrls` (`NEXT_PUBLIC_INDEXER_URLS`, or
  `config.json`). The client tries them in order and fails over on network errors and 5xx.
- *Schema per build.* `DATABASE_SCHEMA` is `varada_<hash of image tag and chain values>`. A new image
  backfills into a new schema while the old task serves, and the load balancer sends it traffic only
  once `/ready` answers 200 (up to one hour of grace). The container health check is `/health`
  (liveness only), so a backfilling task is not restarted. After a rollout, drop the previous
  schema: `DROP SCHEMA varada_<old> CASCADE`.
- *Reorgs.* Ponder reverts unfinalized blocks itself; the indexer needs no extra handling. Use an RPC
  provider with `eth_getLogs` over wide block ranges; several URLs (comma-separated in the RPC
  secret) are load-balanced.
- *CORS.* `indexerCorsOrigins` lists the origins that may read the API: the exact site origins
  (`https://varada.eth.limo`) and suffix patterns for gateways (`*.eth.limo`, `https://*.bzz.link`).
  `*` is refused in prod. Other origins receive no CORS headers.
- *Rate limits and caching.* Per-IP token bucket (`RATE_LIMIT_RPS`, `RATE_LIMIT_BURST`, with
  `TRUST_PROXY_HOPS=1` behind the ALB); `/api/*` answers carry `Cache-Control` and a weak `ETag`.
  No access logs are kept (docs/PRIVACY.md).

**Verify after deploy:**

```sh
curl -fsS https://<indexer>/health                       # 200 as soon as the process is up
curl -fsS -o /dev/null -w '%{http_code}\n' https://<indexer>/ready   # 200 once the backfill is done
curl -fsS -H 'Origin: https://varada.eth.limo' -D- https://<indexer>/api/stats | grep -i 'access-control\|cache-control\|etag'
```

Compare `/status` with the chain head to see how far behind the indexer is.

See [Security and audit coverage](SECURITY.md) for what has been reviewed and the operational
requirements the contracts rely on.
