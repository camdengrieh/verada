---
title: Security and audit coverage
description: What has been reviewed in the Varada contracts, how, what was found, what was fixed, and what is still open.
---

# Security and audit coverage

This page lists every security review of the Varada contracts so far, what each one covered, what it
found and what happened to each finding. It also lists what has **not** been reviewed, and the
operational steps that the contracts rely on.

> **Status: not audited by a third party.** Every review below is an AI-assisted review run by the
> team. None of them is a substitute for an independent human audit, a bug bounty or on-chain
> monitoring. Do not treat this page as an audit report.

## Summary

| Review | Date | Code | Method | Findings | Status |
| --- | --- | --- | --- | --- | --- |
| [Review 1: core contracts](#review-1-core-contracts) | 2026-11-06 | `19b050a` | Pashov solidity-auditor 4.1, 3 passes | 14 + 46 leads | 14 fixed |
| [Review 2: targeted side reviews](#review-2-targeted-side-reviews) | 2026-11-06 | `e3b7d39` | 45 leads, adversarial refutation | 4 low | 2 fixed, 2 operational |
| [Review 3: full repository, quick scan](#review-3-full-repository-quick-scan) | 2026-11-07 | `c1d3c4c` | Pashov solidity-auditor 4.1, 1 pass | 10 + 30 leads | 10 fixed |

All fixes from review 3 are in the commits listed in [Fix commits](#fix-commits). After the fixes, the
full test suite passes: 1,371 Foundry tests (including the mainnet-fork suites against the real
Uniswap v4, Zama, Endaoment and ENS contracts), 315 hook tests and every TypeScript package.

## Review status

Varada is deployed **without a third-party audit**, because of time. This section says exactly what
that means. It does not claim more than the rest of this page shows.

### What was reviewed

- **Automated adversarial review.** Three AI-assisted reviews run by the team (the table above), with
  the findings fixed and regression-tested. See [How the reviews work](#how-the-reviews-work).
- **Forge tests.** Unit and integration tests for every contract in `contracts/test`.
- **Fuzz and invariant tests.** Foundry invariant suites in `contracts/test`: consolidator
  (`ConsolidatorInvariants.t.sol`), live donations (`LiveInvariants.t.sol`,
  `LiveFactoryInvariants.t.sol`), vaults (`VaultInvariants.t.sol`), governance
  (`GovernanceInvariants.t.sol`, `RotationInvariants.t.sol`) and profiles (`ProfileInvariants.t.sol`).
- **Fork tests.** Suites against the real mainnet Uniswap v4, Zama, Endaoment and ENS contracts
  (`contracts/test/fork`) and the swap engine on an anvil fork ([SWAP.md](SWAP.md)).

### What was not reviewed

- **No external audit** of any kind: no audit firm, no contest, no bug bounty.
- **No review at all of the Uniswap v3 hops added to the quote registry and fee consolidator, beyond
  the same automated review, tests and fork tests.** Reviews 1 to 3 ran on commits before that change
  (`19b050a`, `e3b7d39`, `c1d3c4c`); [Chapter 5](chapters/05-quote-assets-pricing-and-routing.md) records it.
  The same holds for the v3 and v2 swap engine and the Ondo reference pricing, which are off-chain or
  display code.
- Everything listed under [Not yet covered](#not-yet-covered).

### Mitigations that exist in the code

| Mitigation | Where it is | Limit |
| --- | --- | --- |
| Hard ceilings on tunable parameters | `FeeConsolidator.MAX_SLIPPAGE_CEILING_BPS` (2000) and `MAX_HOP_FEE_BPS` (1000); `VaradaFactory.MAX_FEE_BPS` (500); `LiveDonationVault.MAX_DONATION_THRESHOLD` | Caps bound a setting, not a logic bug. |
| Price guards that fail closed | `FeeConsolidator._hop`: deviation from a reference or TWAP and a minimum output on every hop; tighter in-swap bounds | A bad reference seeded by the owner is still trusted. |
| Held-fee retry | A failed conversion keeps the raw amount, emits `ConsolidationFailed` or `FeeTaken(converted = false)`, and anyone can call `retry`, `retryAmount` or `VaradaLiveHook.retryHeld` | Fees may stay held for a long time if a route stays broken. |
| Settlement grace | `FeeVault.settle` waits up to `settleGrace` (owner-set, 7 days by default) for outstanding fees, then pays what is there | Late fees roll into a later epoch. |
| No owner custody of donations | `LiveDonationVault`: the owner can only call `setHook` once; no pause, redirect or arbitrary rescue; `skim` pays only the platform treasury and never owed USDC. `FeeVault.withdrawPlatform` pays only the treasury | `FeeConsolidator.rescueExcess` lets the owner send balances **not owed to any token** (dust, accidental transfers) to any address. |
| Two-step ownership | `Ownable2Step` on admin contracts such as `FeeConsolidator` and `QuoteRegistry`; hand-over to a multisig ([DEPLOYMENT.md](DEPLOYMENT.md)) | A multisig is operational, not enforced by the code. |
| Stoppable automation | The keeper and curator agents are separate processes and can be stopped; `AgentVault.setPaused(true)` stops gifts and `setActive(false)` stops an agent ([agents/README.md](../agents/README.md)) | **The consolidator, fee vaults and hooks have no pause switch.** Stopping the keeper does not stop fee conversion, which is permissionless. |

The mitigations lower the damage of a mistake; they are not a substitute for the audit that was not
done.

## How the reviews work

The Pashov solidity-auditor runs twelve attacker agents over the whole in-scope source. Each agent has
one specialty:

- math and precision
- access control
- economic security
- execution traces
- invariants
- periphery
- first principles
- asymmetry
- boundaries
- three "gap" hunters for the seams between those lenses: numerical gaps, trust gaps and flow gaps.

A judge then removes duplicates, checks each claim against the code, and scores it. A **finding** has a
concrete proof (numbers, a trace or quoted code) and a confidence of at least 75 out of 100. A **lead**
is a credible code smell whose full exploit path the pass could not complete; leads are not scored.

A 3-pass scan runs the twelve agents three times, and each pass is told what the earlier passes found
so it spends its effort on new ground. A 1-pass scan is faster and finds less.

Every fix in review 3 was made on its own branch, with a regression test that fails on the old code
and passes on the new code. An independent reviewer agent then tried to break each fix before the
branches were combined.

## Review 1: core contracts

- **Code:** commit `19b050a`.
- **Scope:** 18 files:
  - `CauseRegistry`, `DonationDistributor`, `EpochGovernor`, `ERC20TimestampVotes`, `FeeConsolidator`, `FeeVault`
  - `ZamaVotingScheme`, `QuoteRegistry`, `TakeoverGovernor`, `TokenProfileRegistry`
  - the factory, hook, LP locker, resolver and token
  - the `ContenthashLib`, `DnsNameLib` and `LabelLib` libraries.
- **Not in scope:** live-donation mode, the generic hooks and the curator contracts did not exist yet.
- **Method:** 3 passes, confidence threshold 75.

### Findings

All 14 findings are fixed.

| # | Finding | Status | Fix |
| --- | --- | --- | --- |
| 1 | `EpochGovernor._openEpoch` passed one option to a scheme that needs two | Fixed (`7ac5ffe`) | An epoch opens only with at least `MIN_OPTIONS` (2); otherwise it finalizes to the default cause |
| 2 | The governor accepted a one-cause shortlist that the scheme cannot open | Fixed (`7ac5ffe`) | `registerToken` reverts `PoolTooSmall`; `setBallotSize` is bounded to `MIN_OPTIONS..MAX_OPTIONS` |
| 3 | A controller could set a one-cause shortlist and stop every vote | Fixed (`7ac5ffe`) | Pins are topped up by catalogue draws; a ballot under 2 options falls back to the default cause |
| 4 | Takeover votes used a snapshot one second before the proposal | Fixed (`7ac5ffe`, `6289855`; hardened in review 3) | Lowest weight over the whole lookback |
| 5 | New epochs copied deactivated causes from the stored shortlist | Fixed (`504fa33`) | Blocked causes are skipped when pins are added; `setDefaultCause` and finalize check that the cause is active |
| 6 | `_weightAt` returned zero for a snapshot before the token existed | Fixed (`154bd93`) | `registerToken` records a launch snapshot that `snapshotFor` uses |
| 7 | Holders could not vote in the epoch their token launched | Fixed (`154bd93`) | Same as 6 |
| 8 | A ballot's option index was not bound to an option list | Fixed (`154bd93`, `bb73dad`) | Ballots only on opened epochs; the prepared ballot's hash is stored, and finalize checks it (`BallotMismatch`) |
| 9 | A price move past the anchor band stopped every hop through a pool | Fixed (`8c3ab49`) | The anchor follows the reference by up to `maxDriftTicks` per anchor period |
| 10 | Frequent hops could freeze the reference tick | Fixed (`8c3ab49`) | Elapsed time is kept when a step rounds to zero; the step is at least 1 |
| 11 | Fees landed in the epoch in which a caller collected them | Fixed (`8c3ab49`) | `FeeVault.depositFees` takes accrual epochs and rejects future ones; settlement brings in pending fees first |
| 12 | One holder could keep a token's single takeover slot busy | Fixed (`7ac5ffe`, `6289855`) | Pending and cooldown limits apply per proposer, with a minimum threshold |
| 13 | Quorum counted the supply that the pool manager holds | Fixed (`7ac5ffe`) | Quorum and threshold use circulating supply (total supply minus pool manager votes) |
| 14 | A zero-value transfer undid a holder's `delegate(0)` opt-out | Fixed (`0d1347e`, `55aeecf`) | Auto-delegation applies only to non-zero transfers to accounts that have not opted out |

### Leads

| Lead | Status |
| --- | --- |
| The first ballot freezes the shortlist as it stands in that block | Fixed (`154bd93`, `7ac5ffe`): pin changes after preparation apply from the next epoch |
| A buyer holds tokens across the epoch boundary for one block | Fixed in review 3 (`d59dd91`) |
| The epoch snapshot time is known a week ahead | Fixed in review 3 (`d59dd91`) |
| An epoch with ballots cannot finalize without a decrypted tally | Fixed (`7ac5ffe`): falls back to the default cause after `tallyGrace` (14 days by default; since owner-set, see `docs/TIMING.md`) |
| A removed governor cannot close the polls it opened | Fixed (`7ac5ffe`): `closeEpoch` uses try/catch, then the `tallyGrace` fallback |
| Canceled takeover proposals start the full cooldown for everyone | Fixed (`7ac5ffe`): the cooldown is per proposer, from cancel time |
| Dust hops at a pushed price drag the reference | Fixed, bounded (`8c3ab49`): the anchor is rate-limited |
| `setMaxDeviationTicks` does not rescale `maxDriftTicks` | Fixed (`8c3ab49`) |
| The TWAP rounds toward zero for negative ticks | Fixed (`40c8392`): rounds toward negative infinity |
| The caller of `collectFees` picks the epoch that receives old fees | Fixed (`8c3ab49`): fees are split over their accrual epochs |
| Ten-option ballots may exceed the FHE complexity limit | Fixed (`504fa33`): packed ballot words |
| The controller orders the shortlist, and ties go to the first option | Accepted, by design |
| `execute` does not check the controller at vote time | Accepted, by design: an incumbent cannot void a running takeover by handing the profile to another account |
| Every route hop reverts until the owner seeds a reference | Operational: post-deploy step |
| An epoch with no ballots cannot finalize without a default cause | Operational: set the default cause at launch |
| `finalizeEpoch` reads the default cause at call time | Open |
| Any caller can take a pending label first; a copied launch takes the label | Operational: launch through a private RPC, reserve labels |
| A poll with few voters shows each choice (weekly path; `BallotCast` emits the weight) | Open for the weekly path; fixed for rotation polls in review 3 |
| A reused ciphertext gives equal tally handles in two polls; identical first ballots give identical handles | Open |
| Distributor and vault do not cross-check their settlement asset; the consolidator does not cross-check WETH | Open (deploy-time configuration, checked by the deploy script's wiring) |
| An inactive Endaoment org keeps its epoch's funds in the distributor; a partial pull leaves funds with no sweep | Open |
| `_attempt` copies all revert data and has no gas guard, so a caller can pick the gas and make consolidate hold fees | Open |
| Any caller picks the time of a retry swap or of `retryAmount`, and its size | Open |
| `_hop` reads the route-pool fee from `slot0`; `_hopFeeBps` ignores a per-swap override fee | Open |
| A falling quote balance makes consolidate revert | Open: do not allowlist such quote assets |
| A paused quote asset makes every surcharge swap and the token's fee collection revert | Open |
| A late tally turns a passing takeover into `Expired` | Open (execution window is at least 2 days) |
| A controller can set the controller to address zero | Open |
| `_maxLiquidityPerTick` counts one tick fewer than the pool manager; `_mintLiquidity` can revert with a cast error first | Open (launch-time revert, no loss) |
| A creator contract can buy in the launch transaction with no surcharge when `sniperFeeStartBps` is 0 | Open |
| Any account can add liquidity to a launch pool and earn LP fees | Open (by design for now: launch liquidity is locked; outside LPs are not blocked) |
| The TWAP equals a held spot after 30 idle minutes | Open |
| An exact-output buy can revert in the sniper-fee window | Open (see review 3) |

## Review 2: targeted side reviews

Four focused reviews ran next to the main audit. They covered:

- the distributor and fee vault
- the weekly governor and the Zama voting scheme
- the hook, factory and LP locker
- the fee consolidator's price bounds.

They produced 45 leads; 13 were judged real, and an adversarial refutation round left 4 low-severity
leads:

| Lead | Status |
| --- | --- |
| Any caller can take a pending token label first, by copying a launch from the mempool | **Operational.** Launch through a private RPC; reserve well-known labels with `TokenProfileRegistry.setReservation`. A commit-reveal step is a possible later change. |
| A copied launch takes the label and makes the original launch revert | **Operational.** Same mitigation as above. |
| A buyer can hold tokens across the weekly snapshot for one block | **Fixed** in review 3 (findings 5 and 6). |
| The weekly snapshot time is known a week ahead | **Fixed** in review 3 (findings 5 and 6). |

The same reviews also produced design notes that are not bugs. They cover:

- the Zama HCU budget: outcome-only polls stay inside the mainnet limits up to 17 options;
- a proposed redesign of the consolidator's price bounds;
- gas savings for live mode.

These are tracked as engineering work.

## Review 3: full repository, quick scan

- **Code:** commit `c1d3c4c` (`cad178b` after a history rewrite that changed one doc word).
- **Scope:** every contract and library in `contracts/src` (interfaces and mocks excluded) and the deploy scripts in `contracts/script`, 53 files, including:
  - live-donation mode
  - the curator contracts
  - the catalogue ballots
  - the generic hooks under `contracts/src/hooks`.
- **Method:** 1 pass, 12 agents, confidence threshold 75. No x-ray pre-audit and no findings memory
  from earlier scans.

### Findings

| # | Confidence | Finding | Status | Fix |
| --- | --- | --- | --- | --- |
| 1 | 85 | The hold-weight scan stopped after 128 checkpoints, so a holder could hide a mid-window sale behind 128 transfers and keep full weight (`RotationGovernor._holdWeight`) | Fixed | `HoldWeightLib` reads every checkpoint in the window. Long scans can be run ahead in chunks with `advanceHoldScan` and are cached. |
| 2 | 75 | The agent vault accepted any hash its agent signer signed, so that signer could sign a USDC permit and take the whole balance past the epoch cap and the pause (`AgentVault.isValidSignature`) | Fixed | The vault answers only the ERC-8004 identity registry, only inside `CuratorRegistry.linkAgentWallet`, through a transient slot. It never answers while paused. |
| 3 | 75 | Whoever initialized a bonding-curve pool first became its admin (`BondingCurveHook`) | Fixed | Every example that grants admin powers gates initialization. |
| 4 | 75 | After the curation grace, the ballot builder accepted a ballot with or without published curator picks (`CatalogBallotBuilder.build`) | Fixed | Published picks are required for the whole vote window. |
| 5 | 75 | Weekly vote weight came from one public second, so a buyer could hold only across the snapshot (`EpochGovernor.authorizeBallot`) | Fixed | Weight is the lowest balance over a one-epoch hold window. |
| 6 | 75 | The weekly weight function read one checkpoint only (`EpochGovernor._weightAt`) | Fixed | Same fix as 5. |
| 7 | 75 | In the generic `PoolAdminHook`, the first caller of `initialize` became the pool admin | Fixed | No default rule: each concrete hook must choose who becomes admin, and the examples gate initialization. |
| 8 | 75 | After the curation grace, any caller could prepare a rotation round without the published picks (`RotationGovernor.prepareRound`) | Fixed | Same fix as 4. |
| 9 | 75 | Takeover weight read two instants and ignored the lookback between them (`TakeoverGovernor._weightAt`) | Fixed | Lowest balance over the whole lookback. `proposeAt` and `advanceProposeScan` let a proposer run a long scan ahead. |
| 10 | 75 | An out-of-range or one-token ballot counted toward the poll's voter minimum, so the revealed outcome could show a lone voter's choice (`ZamaVotingScheme.castBallot`) | Fixed | Only valid ballots at or above a per-governor counted weight count, and that weight is fixed at poll open: 10,000,000 tokens (0.01% of supply) for the rotation governor. Under the minimum, the encrypted outcome is `NO_WINNER` and nothing is revealed. |

### Leads

| Lead | Status |
| --- | --- |
| A deactivated agent can still give from its vault (`AgentVault.give`) | Fixed with finding 2 |
| The bonding-curve hook has no initializer gate | Fixed with finding 3 |
| A graduated bonding curve rejects every sell | Documented example limitation (`BondingCurveHook` is a reference example, not for production) |
| After graduation, the curve admin withdraws all raised quote | Documented example limitation |
| The first weekly preparer chooses the ballot form (`EpochGovernor.prepareBallot`) | Fixed with finding 4 |
| Any caller can start the curation skip clock (`EpochGovernor.requestCurationSkip`) | Fixed: the skip is removed and the call always reverts |
| A one-token ballot reaches `minVoters` (`RotationGovernor.closeRound`) | Fixed with finding 10 |
| An epoch with no ballots cannot finalize until the owner sets a default cause | Operational: set the default cause at launch (see [Operational requirements](#operational-requirements)) |
| The deploy scripts never seed the route price references (`FeeConsolidator.seedReferences`) | Operational: post-deploy step |
| The distributor pays a cause the owner blocked after the ballot was prepared | Open |
| An inactive Endaoment org locks its epoch's funds in the distributor | Open |
| The weekly path pays a winner blocked after preparation; the rotation path does not | Open (policy decision) |
| The live fee stream keeps crediting a blocked cause until holders vote a new one | Open (policy decision) |
| The live vault pays an org after the owner blocks it | Accepted: documented as intended in the source |
| The deviation guard ignores how long the TWAP span is (`FeeConsolidator._checkDeviation`) | Open |
| The hop fee ignores the pool manager protocol fee (`FeeConsolidator._hopFeeBps`) | Open |
| A trader can walk the reference tick with the pre-swap spot (`FeeConsolidator._moveReference`) | Open |
| Frequent `syncReference` calls slow the reference tick | Open (delay only, no loss found) |
| A quote token that lowers balances makes every deposit revert (`FeeConsolidator._receive`) | Open: do not allowlist such tokens as quote assets |
| A revert in `consolidate` reverts the trader's swap (`VaradaHook._onSwapFeeTaken`) | Open |
| Exact-output buys can revert in the sniper-fee window when the pool manager holds none of the quote asset (`VaradaHook`) | Open (known; fixing it needs the consolidator to accept ERC-6909 claims) |
| A synced currency makes the live hook hold the fee instead of converting it | Open (delay only) |
| Anyone can call `retryHeld` and choose its time, under the wider retry bounds | Open |
| A trader can force a fee onto the wider retry bounds | Open |
| A failing voting scheme keeps a period proposal open forever (`RotationGovernor.closePeriodProposal`) | Open |
| The first rotation polls have zero weight for every holder | Open (no loss found) |
| The preparer freezes pins and the curated phase together (`RotationGovernor._prepare`) | Open (mitigated: published picks are now mandatory) |
| A defeated period proposal starts the cooldown for every holder (`RotationGovernor.proposePeriod`) | Open |
| The takeover quorum rounds down to zero for a tiny supply (`TakeoverGovernor.propose`) | Open |

### Fix commits

| Commit | Change |
| --- | --- |
| `e9cbf5d` | Generic hooks: no default pool admin; every admin example gates initialization (findings 3, 7) |
| `36e262a` | Agent vault signs only for the ERC-8004 wallet link; inactive agents cannot give (finding 2) |
| `28829ad`, `1ee158b` | Zama scheme counts only valid ballots at or above a per-governor weight toward the minimum (finding 10) |
| `e0bd48f`, `b286f16` | Published curator picks are mandatory; owner-only `CuratorRegistry.voidCurations`; keeper and web updated (findings 4, 8) |
| `d59dd91` | Vote weight is the lowest balance over the whole hold window, through `HoldWeightLib` (findings 1, 5, 6, 9) |
| `8c10864` | `TakeoverGovernor.proposeAt` so a proposer with many checkpoints can scan ahead |
| `99f72a4` | Keeper pages again every two hours while curator picks stay missing |
| `da90e24` | SDK and web run long hold scans ahead before voting or proposing |

### Behaviour changes from the fixes

- **Voting delay for new buyers:** a holder who buys during an epoch first votes in the epoch after the
  next one, because weight is the lowest balance over the previous epoch.
- **Old snapshots for takeover proposals:** a proposer can pick a snapshot up to one day old with
  `proposeAt`, so tokens sold during that day still count for the vote.
- **Picks that block an epoch:** curator picks that were published but never served now block that
  epoch's ballots until the owner calls `CuratorRegistry.voidCurations`. There is no automatic
  fallback any more. Picks that are provably invalid (wrong org, index past the bucket, blocked cause)
  are still skipped on-chain.
- **Removed and stubbed functions:** `RotationGovernor.weightAt` and `MAX_HOLD_SCAN` are removed.
  `EpochGovernor.requestCurationSkip` always reverts with `CurationSkipDisabled`.
- **Size headroom:** `RotationGovernor` is 24,154 bytes, 422 bytes under the mainnet contract size
  limit.

## Not yet covered

- **No independent human audit** and no bug bounty.
- **Review 3 was a single pass.** It ran without the x-ray pre-audit and without findings memory, so
  it will have missed things a 3-pass scan finds.
- **Final repairs not re-reviewed:** the repairs in `8c10864`, `99f72a4` and `da90e24` were not
  re-reviewed by an independent agent. Their own tests and the full suite pass.
- **No formal verification.** Beyond the existing Foundry invariant and fuzz suites, there is no
  invariant fuzzing campaign (Echidna or Medusa).
- **Off-chain code was out of scope for the security review:** the publisher keeper, the indexer, the
  SDK, the web app and the curator agents. Their tests ran, but no security review covered them.
- **Dependencies were trusted, not reviewed:** Uniswap v4 core and periphery, OpenZeppelin, the Zama
  FHEVM contracts, Endaoment, ENS and the ERC-8004 registry.

## Operational requirements

The contracts assume these steps. Missing one delays funds or blocks a flow; none of them loses funds.

1. **Set a default cause at launch:** `CauseRegistry.addCause`, then `EpochGovernor.setDefaultCause`.
   Without it, an epoch with no ballots, or one that was never prepared, cannot pay out until the
   owner sets one.
2. **Seed the route price references:** `FeeConsolidator.seedReferences` or `setReference`, for every
   quote route. Until then every route hop reverts and every fee stays held.
3. **Respond to missing curator picks:** if the keeper pages with `CuratedPicksUnavailable`, re-upload
   the curator's report, or call `CuratorRegistry.voidCurations(epoch, buckets)` for that epoch. Aim
   to respond within 6 hours; the hard deadline is the end of the epoch. Do not pause the agent for
   this.
4. **Launch through a private RPC**, so that a token's label cannot be taken from the mempool.
5. **Hand ownership to a multisig** and accept every two-step ownership transfer.
6. **Allowlist quote assets carefully:** do not allowlist a quote asset whose balances can shrink
   (rebasing down or with a balance multiplier).

## Reporting a vulnerability

Please do not open a public issue for a security problem. Contact the team privately through the
project's GitHub security advisories.
