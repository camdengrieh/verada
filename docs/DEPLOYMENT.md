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
   quote asset whose balances can shrink. Any ERC-20 qualifies: the registry needs only the asset,
   a label (`Kind`, which nothing reads but the UI) and a hookless v4 route of at most three hops
   that ends in USDC. Adding a new asset is configuration, never a contract change; the factory
   only reads `isAllowed` and `decimals`, and the consolidator only follows the route.
   `script/AddQuoteAssets.s.sol` does this for the curated set (see "Quote assets" below).
6. **Seed the route price references:** `FeeConsolidator.seedReferences` (or `setReference`) for every
   route pool. **Required:** until then, every route hop reverts and fees stay held.
   `AddQuoteAssets` seeds the pools it uses that have no reference yet.
7. **Register the curator agents** in `CuratorRegistry`, and link each agent wallet
   (`linkAgentWallet`).
8. **Fund the Zama fee account** used by the tally keeper (see `services/publisher`).
9. **Set the site contenthash** with `TokenProfileRegistry.setDefaultContenthash`, after the first site
   publish, if `SITE_SWARM_REF` was not known at deploy time.

### Quote assets

Tokens accrue fees in their quote asset and consolidate to USDC; the quote asset can be WETH, any
other liquid crypto asset, or an Ondo token. USD pricing for the UI comes from the same on-chain
pools (no oracle), and the pickers order assets by route depth.

```bash
# Dry run (default; reads the live registry and pools, broadcasts nothing even with --broadcast):
QUOTE_REGISTRY=0x.. FEE_CONSOLIDATOR=0x.. forge script script/AddQuoteAssets.s.sol --rpc-url $ETH_RPC_URL
# Apply (the signer must own both contracts; use a keystore or hardware wallet):
APPLY=1 QUOTE_REGISTRY=0x.. FEE_CONSOLIDATOR=0x.. forge script script/AddQuoteAssets.s.sol \
  --rpc-url $ETH_RPC_URL --broadcast --account <owner keystore>
# ASSETS=WBTC,cbBTC limits the run to those symbols.
```

Survey (Ethereum mainnet, hookless v4 pools, price impact of a swap to USDC along the best route,
from `V4Quoter`, 7 Nov 2026):

| Asset | Route | $10k | $100k | Verdict |
| --- | --- | --- | --- | --- |
| WBTC | WBTC/USDC 0.3% | about 0% | 0.2% | included |
| cbBTC | cbBTC/USDC 0.3% | about 0% | 0.1% | included |
| wstETH | wstETH/ETH 0.01%, ETH/USDC 0.05% | 0.1% | 2.2% | included |
| UNI | UNI/USDC 0.3% | 0.2% | 2.3% | included |
| AAVE | AAVE/USDC 0.3% | 0.3% | 2.7% | included |
| LINK | LINK/ETH 0.3%, ETH/USDC 0.05% | 0.6% | 2.7% | included (the direct USDC pool is 12% at $100k) |
| USDT | USDT/USDC 0.01% | 0.01% | 9% | left out: fine for small trades, thin beyond $50k |
| DAI | via ETH (the USDC pools are out of range) | 4.5% | 18% | left out |

The bar is 3% at $100k. Ondo tokens: of the 451 in the SDK list, only AMZNon, TSLAon, GOOGLon, USOon,
USDon (USDC pools) and SPYon (through ETH) have a hookless pool; all are thin (a $1k swap moves the
price 2% to 9%), so they are registered for completeness and the web app gates their launches on depth.
CRCLon and SLVon have a pool but no quotable depth and are skipped. Re-run the dry run before
applying: it re-checks every hop and skips (and logs) what has gone.

## 4. After launch

- Point the SDK, indexer, publisher and web app at `deployments/1.json` and `1-live.json`.
- Start the keepers. The keeper alarms on `CuratedPicksUnavailable`; see the owner runbook in
  `agents/README.md`.
- Launch tokens through a private RPC, so that a token label cannot be taken from the mempool.
- Move ownership to a multisig when it is ready: `transferOwnership(multisig)` on each owned
  contract, then `acceptOwnership()` from the multisig.

See [Security and audit coverage](SECURITY.md) for what has been reviewed and the operational
requirements the contracts rely on.
