---
title: Deploying to Ethereum mainnet
description: The exact command sequence, checklist, pause and rollback procedures for deploying the Varada contracts to Ethereum mainnet, rehearsed on a mainnet fork.
---

# Deploying to Ethereum mainnet

Varada deploys only to Ethereum mainnet. Every deployment is rehearsed first on a mainnet fork, with
the same scripts.

> **This deployment has no third-party audit.** It ships on the team's own AI-assisted reviews only
> ([Security and audit coverage](SECURITY.md)), the mainnet-fork test suites, and the rehearsal
> recorded below. What that does and does not cover is in
> [Launching without an independent audit](#launching-without-an-independent-audit). Read it before
> you broadcast.

The deployment is two owner-run scripts and a handful of manual owner transactions:

| Step | Script | Sender | What it does |
| --- | --- | --- | --- |
| Deploy | `contracts/script/DeployV3Routes.s.sol` (`runV3()`) | deployer | deploys and wires all 18 contracts (weekly and live mode), starts the ownership transfers, writes the manifest |
| Configure | `contracts/script/ConfigureRoutes.s.sol` (`run()`) | `OWNER` | accepts ownership, registers the quote assets with their routes, seeds the price references, sets the fallback cause |
| ENS | `contracts/script/SetParentResolver.s.sol` | owner of `varada.eth` | points `varada.eth` at the new resolver (last step) |

`DeployV3Routes` is `DeployLive` (which is `Deploy` plus live mode) with the safeguards a mainnet run
needs. `Deploy.s.sol` and `DeployLive.s.sol` are unchanged and remain the source of the constructor
wiring.

## What must be redeployed, and why

The route format of `QuoteRegistry` and the hops of `FeeConsolidator` change (Uniswap v3 and v2 hops
next to v4 hops). Almost every contract holds one of the two as an immutable, so nothing can be
repointed in place: **the whole system is deployed fresh from one deployer nonce sequence.**

| Contract | Changed by the route change | Reason it is redeployed |
| --- | --- | --- |
| `QuoteRegistry` | yes | new route format |
| `FeeConsolidator` | yes | executes the new hops; holds the registry, vault and governor as immutables |
| `VaradaHook` | no | `feeConsolidator` is immutable, and the hook address is re-mined (flags `BEFORE_INITIALIZE`, `BEFORE_SWAP`, `AFTER_SWAP`, `AFTER_SWAP_RETURNS_DELTA`) because its init code hash changes |
| `VaradaLiveHook` | no | `consolidator` and `quoteRegistry` are immutable; re-mined (adds `BEFORE_SWAP_RETURNS_DELTA`, `BEFORE_DONATE`) |
| `VaradaLpLocker` | no | `feeConsolidator` is immutable |
| `VaradaFactory` | no | `quoteRegistry`, `hook`, `locker` are immutable |
| `FeeVault` | no | `factory` is immutable (and the factory address changes) |
| `TokenProfileRegistry` | no | `factory` is immutable; so labels start empty |
| `EpochGovernor`, `RotationGovernor`, `TakeoverGovernor`, `CuratorRegistry` | no | hold the profile registry as an immutable |
| `VaradaResolver` | no | holds the profile registry and curator registry; `varada.eth` must be pointed at it |
| `LiveDonationVault`, `DonationDistributor` | no | tied to the governors, the factory and the consolidator |
| `CauseRegistry`, `CauseCatalog`, `ZamaVotingScheme` | no | no dependency on the changed contracts, but they are wired to the new governors and owned by the same owner, so they are deployed with the rest. The catalogue is republished and the causes re-added. |

Two consequences:

- **Hook salts are mined inside the script** (`_mineHook`, `_mineLiveHook`, CREATE2 through the
  deterministic deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`), against the init code that
  includes the final constructor arguments. Nothing is mined by hand and no salt is passed in. If a
  contract's constructor changes, the next dry run mines the new salt.
- **There is no migration.** If an earlier deployment ever carried live tokens, they stay on the old
  contracts and are not moved. (No mainnet record exists in this repository yet; the only prior runs
  are fork rehearsals.)

When the v3 route format lands on `main`, run a fresh dry run first. If a constructor or the
`QuoteRegistry` route struct changed, `Deploy.deploy` and `ConfigureRoutes._hop` are the only places
to adapt; the safeguards, manifest and sequence below do not change.

## What you provide at the one-command step

| Needed | Detail |
| --- | --- |
| deployer key | a **fresh** key used only for this deployment, in a Foundry keystore (`cast wallet import varada-deployer --interactive`) or a Ledger. Never a file in the repository, never `--private-key`. |
| deployer funds | **0.15 ETH** on the deployer. The rehearsal used 49.6M gas for the deploy plus 1.5M for configuration, which is 0.1 ETH at 2 gwei. The script refuses to run below `MIN_DEPLOYER_BALANCE_WEI` (default 0.1 ETH). |
| `OWNER` | the address that will own every admin contract (EOA now, multisig later). If it is not the deployer, it needs ETH for about 24 configuration transactions (0.02 ETH is plenty) and must accept ownership. |
| `PLATFORM_TREASURY` | the address that receives the platform's 10% share; also the `addr` of `varada.eth` |
| `ETH_RPC_URL` | a mainnet RPC (a paid or private one; the public nodes drop old state, which breaks fork rehearsals after a few minutes). Not stored anywhere by the scripts. |
| `ETHERSCAN_API_KEY` | optional, for `--verify` |
| `SITE_SWARM_REF` | optional: the Swarm reference of the site feed manifest (the default contenthash). It can be set later. |
| fallback cause | the cause that wins an epoch with no votes: `FALLBACK_CAUSE_ID`, `FALLBACK_ORG_ID`, `FALLBACK_ORG_ADDRESS` (Endaoment org). **Required before the first payout.** |
| the `varada.eth` owner | whoever owns `varada.eth` on ENS must run the last step, with their own key or Ledger |
| the cause catalogue | calldata from `varada-catalog calldata` (the owner publishes it) |

Keep keys out of the repository and out of shell history. The scripts never read a key from the
environment or from a file; the sender is whatever account forge is given.

## 0. Prepare

From `contracts/`, at the exact commit you will deploy:

```sh
forge clean && forge build
export ETH_RPC_URL=<mainnet RPC>
export OWNER=<owner> PLATFORM_TREASURY=<treasury>
export DEPLOYER=$(cast wallet address --account varada-deployer)
```

The addresses depend on the deployer's nonce, so nothing else may send from the deployer between the
dry run and the broadcast.

## 1. Dry run on a fork (nothing is sent)

```sh
forge script script/DeployV3Routes.s.sol --sig "runV3()" \
  --rpc-url $ETH_RPC_URL --sender $DEPLOYER
```

Without `--broadcast` forge only simulates. A dry run does not touch `deployments/1.json` or
`1-live.json`; it writes `deployments/1-manifest-dryrun.json`. Check that:

- the script ends with `Script ran successfully`;
- all 18 addresses are logged and the manifest is printed;
- the estimated gas fits the deployer's balance.

## 2. Rehearse on an anvil fork (recommended, no funds at risk)

```sh
anvil --fork-url $ETH_RPC_URL --chain-id 1 --port 28545
# in another shell, with fresh test keys (cast wallet new) for deployer, owner and trader
forge script script/DeployV3Routes.s.sol --sig "runV3()" --rpc-url http://127.0.0.1:28545 \
  --private-key <TEST KEY> --broadcast --slow          # reverts: ConfirmationMissing (expected)
CONFIRM_MAINNET_DEPLOY=I-HAVE-RUN-THE-FORK-REHEARSAL \
forge script script/DeployV3Routes.s.sol --sig "runV3()" --rpc-url http://127.0.0.1:28545 \
  --private-key <TEST KEY> --broadcast --slow
```

then configure (step 4) and, to exercise the lifecycle, the rehearsal script
`script/RehearseFork.s.sol` (`REHEARSAL_FORK=yes`; test keys only; phases `catalog()`, `trade()`,
`collect()`, `settle()`). See [Rehearsal results](#rehearsal-results).

## 3. Broadcast the deployment

```sh
CONFIRM_MAINNET_DEPLOY=I-HAVE-RUN-THE-FORK-REHEARSAL GIT_COMMIT=$(git rev-parse --short HEAD) \
forge script script/DeployV3Routes.s.sol --sig "runV3()" \
  --rpc-url $ETH_RPC_URL --account varada-deployer --broadcast --slow \
  --verify --etherscan-api-key $ETHERSCAN_API_KEY
```

- `--broadcast` without `CONFIRM_MAINNET_DEPLOY` reverts with `ConfirmationMissing`. The phrase is a
  deliberate speed bump, not a secret.
- `--slow` sends each transaction only after the previous one is mined, so a failure stops the run at
  a known point. If the run stops part-way, rerun with `--resume` instead of starting again.
- Output: `deployments/1.json`, `deployments/1-live.json` and `deployments/1-manifest.json` (all
  git-ignored). The manifest holds every address, the deploy block, the deployer, owner and treasury,
  the commit, and ready-made `indexerEnv` and `webConfig` objects. Review it, then force-add the
  mainnet record deliberately.

## 4. Configure (as `OWNER`)

```sh
FALLBACK_CAUSE_ID=<keccak256(abi.encode(orgId))> FALLBACK_ORG_ID=<bytes32 EIN> \
FALLBACK_ORG_ADDRESS=<Endaoment org address> \
forge script script/ConfigureRoutes.s.sol --sig "run()" \
  --rpc-url $ETH_RPC_URL --account varada-owner            # dry run first
# then the same command with --broadcast --slow
```

It reads `deployments/1.json`, `1-live.json` and `script/config/mainnet-routes.json`, and:

1. accepts ownership of the 13 owned contracts where `OWNER` is the pending owner (skips the rest);
2. registers each quote asset with its route (`QuoteRegistry.addQuoteAssetWithRoute`), skipping any
   already registered;
3. seeds the price reference of every route pool (`FeeConsolidator.seedReferences`). **Required:**
   until then every hop reverts and fees stay held;
4. adds the fallback cause and makes it the default (`CauseRegistry.addCause`,
   `EpochGovernor.setDefaultCause`) when the `FALLBACK_*` variables are set.

It is safe to rerun. `mainnet-routes.json` currently lists WETH, WBTC, AMZNon and SLVon, each with a
single v4 hop to USDC. Every pool in it was checked to be initialised on mainnet. To add a quote asset
(the other Ondo stocks, more crypto assets), append an entry. **Seed references only when the pool
trades at a fair price**, and never add a quote asset whose balances can shrink (rebasing tokens).
Confirm every pool id and its liquidity before adding it; the file's `_comment` lists the Ondo
stocks that are still to be added.

Ondo stocks pause and trade only in market hours; a re-anchor of the reference
(`FeeConsolidator.setReference`) is the owner's tool after a legitimate large gap (for example the
market reopening).

## 5. Remaining owner steps

In this order, after step 4:

1. **Publish the cause catalogue:** `CauseCatalog.setVersion`, calldata from `varada-catalog calldata`.
   Launches revert until a version exists with at least two entries for the launch focus.
2. **Register the curator agents** in `CuratorRegistry` and link each agent wallet (`linkAgentWallet`).
3. **Fund the Zama fee account** used by the tally keeper (see `services/publisher`).
4. **Set the site contenthash** with `TokenProfileRegistry.setDefaultContenthash`, if `SITE_SWARM_REF`
   was not known at deploy time.
5. **Point `varada.eth` at the new resolver** (last, because it is the step users can see):
   `forge script script/SetParentResolver.s.sol --rpc-url $ETH_RPC_URL --broadcast --account <ens-owner>`.
   It reads the resolver from `deployments/1.json` and checks everything first.

## 6. Point the services at the new deployment

`node contracts/script/manifest-to-config.mjs contracts/deployments/1-manifest.json indexer` prints the
indexer environment; `... web` prints the web configuration. Both come from the manifest, so they match
the deployment exactly.

| Where | Setting | Value |
| --- | --- | --- |
| `services/indexer` | `START_BLOCK` | the manifest's `deployBlock` (the chain head when the script simulated, so at or before the first deployment transaction; indexing from it is safe, and a little early). Must be greater than 0. |
| `services/indexer` | `FACTORY_ADDRESS`, `FEE_VAULT_ADDRESS`, `FEE_CONSOLIDATOR_ADDRESS`, `QUOTE_REGISTRY_ADDRESS`, `CAUSE_REGISTRY_ADDRESS`, `EPOCH_GOVERNOR_ADDRESS`, `DONATION_DISTRIBUTOR_ADDRESS`, `TOKEN_REGISTRY_ADDRESS`, `CAUSE_CATALOG_ADDRESS`, `CURATOR_REGISTRY_ADDRESS`, `VOTING_SCHEME_ADDRESS`, `TAKEOVER_GOVERNOR_ADDRESS`, `ROTATION_GOVERNOR_ADDRESS` | from `indexerEnv` (`ROTATION_GOVERNOR_ADDRESS` is what turns on live-donation tokens) |
| `services/indexer` | `DATABASE_SCHEMA` | **a new value** (for example `varada_v3`). The old schema indexes different contracts; never reuse it. |
| `apps/web` (`public/config.json` or `NEXT_PUBLIC_*`) | `factoryAddress`, `factoryDeployBlock`, `vaultAddress`, `governorAddress`, `profileRegistryAddress`, `votingSchemeAddress`, `takeoverGovernorAddress`, `curatorRegistryAddress` | from `webConfig` |
| `services/publisher`, SDK, keepers | the same addresses | from `deployments/1.json` and `1-live.json` |

The full variable reference is in [ENV.md](ENV.md).

## Rehearsal results

Recorded on an anvil mainnet fork (block 26358789, chain id 1) on 2026-11-07, at the commit this
document ships with, using fresh throwaway keys for a deployer, an `OWNER` that is a different account
(so the two-step transfer was exercised) and a trader, with real mainnet addresses. Gas is the
receipts' `gasUsed`.

| Phase | Result | Txs | Gas |
| --- | --- | --- | --- |
| Dry run | `Script ran successfully`; `--broadcast` without the phrase reverted `ConfirmationMissing` | 0 | estimate 65.4M |
| Deploy (`runV3`) | all 18 contracts, both hooks mined to the right flags, ownership transfers started; largest tx 7.27M gas | 54 | **49.63M** |
| Configure (`ConfigureRoutes`) | 13 ownership acceptances, WETH, WBTC, AMZNon and SLVon registered with routes and references seeded, fallback cause added and set | 23 | 1.53M |
| Catalogue (`setVersion`, 2 entries) | published | 1 | 0.44M |
| Launches | three weekly tokens (WETH, AMZNon, WBTC quote) at 2.80-2.86M gas each; two live tokens (WETH, WBTC quote) at 2.73-2.75M each | 5 | 14.0M |
| Trades | weekly buys 0.29-0.37M gas; live buys (fee converted to USDC and pushed to the Endaoment org inside the swap) 0.47-0.61M gas | 9 | 4.1M |
| Collect (`collectFees` x3, 8 days later) | LP fees collected and consolidated into the vault | 3 | 1.50M (0.45-0.53M each) |
| Settle (3 tokens: `finalizeEpoch`, `settle`, `distribute`, then `withdrawPlatform`) | no ballots, so the fallback cause won; the donation reached the Endaoment org | 10 | 1.36M (`finalizeEpoch` 81k, `settle` 195k, `distribute` 153k, `withdrawPlatform` 74k) |

Outcome: the vault held 248.45 USDC of consolidated weekly fees after collection; settlement paid
139.16 USDC to the Wikimedia Foundation's Endaoment org (net of Endaoment's own fee) and the live tokens
pushed a further ~299.6 USDC to it in-swap (total org balance 438.77 USDC). No transaction failed.

Findings from the rehearsal that matter in production:

- **Live-mode swaps need `eth_estimateGas`, not a fixed gas limit.** `VaradaLiveHook` reverts
  `InsufficientGas(required, available)` with under `LIVE_GAS_REQUIRED` left at `afterSwap`, and a
  limit set from a simulation that ran with plenty of gas can be too low (the first rehearsal swap
  failed this way with a 810k limit and was fixed by a larger one). Every client that sends a swap on
  a live pool (the web app, bots, the SDK) must estimate gas against the node.
- **The public mainnet RPCs do not keep old state.** A fork pinned to an old block stops working after
  a few minutes; use a paid or private node for rehearsals.

What the rehearsal did **not** cover: the Zama (FHE) vote and tally (a fork has no relayer, so epochs
were settled through the no-ballot fallback), a rotation poll in live mode, the `varada.eth` ENS
pointing step (an ENS owner key), the v3 and v2 route hops (the branches that add them were not on
`main` when this was written), and any of the ten Ondo stocks beyond AMZNon and SLVon.

## Checklist

Before broadcasting:

- [ ] `forge clean && forge build` at the exact commit; commit hash noted (`GIT_COMMIT`).
- [ ] Dry run on a fork succeeded; anvil rehearsal repeated at this commit.
- [ ] Deployer is a fresh key in a keystore or Ledger, funded with 0.15 ETH, and nothing else sends from it.
- [ ] `OWNER` and `PLATFORM_TREASURY` are the intended addresses (read them back from the dry run's manifest).
- [ ] `script/config/mainnet-routes.json` reviewed: every pool id exists and is liquid; nothing in it is a rebasing token.
- [ ] Fallback cause chosen and its Endaoment org address confirmed.
- [ ] Private RPC network ready for launches (a token label can be taken from the mempool otherwise).
- [ ] [Launching without an independent audit](#launching-without-an-independent-audit) read and accepted by the owner.

After broadcasting:

- [ ] `deployments/1-manifest.json` reviewed; sources verified on Etherscan.
- [ ] `OWNER` accepted ownership of all 13 contracts (`pendingOwner` is zero everywhere).
- [ ] Quote assets registered, references seeded, fallback cause set, catalogue published.
- [ ] A small launch and a small buy on each quote asset, then a `collectFees` and a `retry`/`settle` on the first epoch.
- [ ] Indexer on a **new** schema, started at `START_BLOCK`; web `config.json` updated; keepers started.
- [ ] `varada.eth` pointed at the new resolver.
- [ ] Monitoring: alarms on `CuratedPicksUnavailable`, `ConsolidationFailed` events, and held fees that do not shrink.

## Pause and rollback

There is **no global pause switch** in the contracts, and most wiring is immutable, so the controls
are narrow. Know them before you need them.

| Situation | Action | Effect | Rehearsed |
| --- | --- | --- | --- |
| A quote asset misbehaves (paused or depegged Ondo token, drained pool) | `QuoteRegistry.deactivateQuoteAsset(asset)` | no new launch against it; existing pools keep trading and consolidating | unit tests only |
| A route pool is bad (manipulated, illiquid) | the consolidator holds fees rather than selling at a bad price (guards fail closed); `FeeConsolidator.setMaxSlippageBps`, `setMaxDeviationTicks`, `setInSwapBounds` tighten the guards; `QuoteRegistry.setRoute` points the asset at a better pool | held fees convert later with `retry` | guards in tests; route swap not rehearsed |
| A reference is stale after a legitimate move | `FeeConsolidator.setReference` / `seedReferences` | re-anchors the guard | seeding rehearsed |
| A cause turns out wrong | `CauseRegistry.deactivateCause`; set another default with `EpochGovernor.setDefaultCause` | it can no longer win a fallback | not rehearsed |
| An owner key is suspected compromised | `transferOwnership(newOwner)` on every owned contract, then `acceptOwnership()` from the new owner | two-step, so a typo cannot lose the contracts | hand-over rehearsed |
| Stop fee intake into the consolidator | `FeeConsolidator.setSource(hook, false)` | **blunt:** the hooks call the consolidator, which then reverts `NotAuthorized`, so swaps on those pools revert. Liquidity is locked in the locker and cannot be pulled out. Use only as a last resort. | **not rehearsed** |

**Rolling back a deployment.** Before step 5.5 (`varada.eth` pointed) nothing is user-visible, so
abandoning is free: do not point the name, and the contracts sit unused. After it, you cannot
unwind the deployment in place because the contracts are immutable. Repoint `varada.eth` (or the
web app's `config.json`) at the previous resolver and factory if one exists, and leave the new tokens
trading on the contracts they were launched on; their locked liquidity and accrued fees stay where
they are. Fees held by the consolidator can only be recovered by `retry` or the owner's
`rescueExcess` for balances not owed to any token.

## Launching without an independent audit

The product is deployed without a third-party audit because of time. This is a decision, recorded
here so that nobody reads the deployment as audited.

**What was reviewed.** Three AI-assisted reviews run by the team (core contracts, targeted side
reviews, a full-repository quick scan), covering the contracts at the commits listed in
[SECURITY.md](SECURITY.md), with every confirmed finding fixed. The consolidator's guards, the live
hook's invariants and the fee-split accounting are covered by unit, fuzz and invariant tests, and by
mainnet-fork suites against the real PoolManager, real Ondo tokens and a real Endaoment org. The
sequence above was rehearsed end to end on a fork.

**What was not reviewed.** No independent human audit. The v3 and v2 hops, the new route format and
the script changes in this document were written and rehearsed after the last review pass and were
**not** part of any review. The Zama voting path was not exercised on a fork. There is no bug bounty.

**Mitigations that exist.** Fee conversion fails closed (a failed or guard-violating route holds the
fees; it never sells at a bad price). Quote assets and routes are an owner-controlled allowlist
(`QuoteRegistry`), and a new asset starts only with an owner-seeded reference. Admin contracts are
two-step owned and can move to a multisig. Liquidity is locked at launch. The platform takes 10% of
fees and 90% goes to the winning cause.

**Mitigations to put in place before real money.** A multisig as `OWNER` (not a single hot key); small
size at first (limited quote assets, watch the first epochs by hand); the monitoring in the checklist;
a published statement that the contracts are unaudited; a bug-bounty or disclosure channel
([SECURITY.md](SECURITY.md#reporting-a-vulnerability)); and an independent audit scheduled after
launch. Expect users to read the unaudited status; the web app should say it too.

See [Security and audit coverage](SECURITY.md) for the reviews and the operational requirements the
contracts rely on.
