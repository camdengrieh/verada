# Varada Architecture

Varada is a memecoin launchpad on Ethereum mainnet (chain id 1). Every token launches into a
Uniswap v4 pool paired with an approved quote asset (any ERC-20 the registry lists: WETH, other liquid crypto assets, or an Ondo token), with single-sided
liquidity that is locked permanently. Trading fees are consolidated to USDC and split between the
platform and a per-token cause pool. Each token chooses a cause focus at launch (categories such as
hunger or endangered species, and regions such as Africa), and its holders vote weekly, with hidden
choices, on which Endaoment-listed nonprofit inside that focus receives the accumulated cause funds. Every token gets an ENS subname
(`<label>.varada.eth`) with an editable profile and a page on the Swarm-hosted dApp. Twenty
curator agents, one per cause (`<label>.agent.varada.eth`), publish weekly ranked picks that fill
part of each ballot; see [Curator agents](#curator-agents).

A token can instead launch in live mode: every swap's fee is converted to USDC inside the swap and
donated to the cause active at that moment, and holders rotate that cause by private vote on a
period the creator picks (hourly to weekly); see [Live donation mode](#live-donation-mode).

This page covers the contracts and the protocol rules. For the off-chain code (web app, component
library, SDK swap engine, indexer API) and how to run it, see [OVERVIEW.md](OVERVIEW.md); for
trading, [SWAP.md](SWAP.md); for what each part can see, [PRIVACY.md](PRIVACY.md).

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project (solc 0.8.26, cancun). Dependencies under `contracts/lib` as git submodules. |
| `packages/sdk` | ABIs, addresses, viem helpers, fee and ballot math, ENS and Swarm helpers, the swap engine (`src/swap`, see [SWAP.md](SWAP.md)). |
| `packages/endaoment-client` | Typed Endaoment organization search client. |
| `packages/cause-catalog` | Harvests Endaoment orgs, classifies them by cause and region, and builds the catalogue Merkle tree (`varada-catalog` CLI). |
| `packages/curator` | Curator agent tooling (`varada-curator` CLI): weekly report schema (`varada.curation/v1`), pick trees, calldata, and the 1Claw signer. |
| `services/indexer` | Ponder indexer and API over protocol events, plus the x402 paid data routes. |
| `apps/web` | Next.js app built as a static export (token list, launch, token page with trade ticket, trades and holders, causes, governance, curator agents). |
| `packages/ui` | `@varada/ui`, the component library and design tokens used by the app (gallery at `/design`). |
| `packages/publish` | Swarm upload, site feed updates and ENS contenthash tooling (dry-run by default). |
| `packages/arkiv-registry` | Arkiv entity schemas, reconcile planning and client for the token mirror. |
| `services/publisher` | Logo/metadata uploads to Swarm, signed curator report uploads, stamp watch, Arkiv mirror, the ballot and tally keeper, and the mainnet x402 facilitator. |
| `agents/` | Curator agent operations: provisioning, weekly routines, monitoring and the pause/recovery runbook (`agents/README.md`). |
| `infra/` | AWS CDK app. |

## Contracts

| Contract | Responsibility |
|---|---|
| `VaradaToken` | ERC20 with permit, burn and vote checkpoints (ERC20Votes with a timestamp clock; holders are self-delegated on first receipt). Fixed supply minted to the factory. Immutable creator and metadata URI. |
| `VaradaFactory` | `deployToken`: deploys the token via CREATE2, registers its ENS label, logo and cause focus in the profile registry, initializes the v4 pool (token/quote, dynamic fee, Varada hook), mints single-sided liquidity through the position manager, sends the position NFT to the locker, and registers the token with the fee vault and governor. `deployLiveToken` runs the same launch on the live hook and registers the token with the live vault and rotation governor instead. |
| `QuoteRegistry` | Owner-managed allowlist of quote assets, each with a hookless v4 route (at most three hops) that ends in USDC. Any ERC-20 with a connected route qualifies; `Kind` is only a label. |
| `FeeConsolidator` | Swaps collected fees into USDC through Uniswap v4 before the split. |
| `TokenProfileRegistry` | Per-token profile: ENS label, controller and editor roles, text records, logo reference, suppression flag, and the cause focus (category and region masks, written once at launch). Factory-written at launch; the takeover governor may replace a controller. |
| `VaradaResolver` | Stateless ENSIP-10 wildcard resolver for `varada.eth`: answers `addr`, `text`, `contenthash` for every `<label>.varada.eth` from the registry, and for `agent.varada.eth` and every `<label>.agent.varada.eth` from `CuratorRegistry`. |
| `TakeoverGovernor` | Community takeover votes that replace a token's profile controller. |
| `ZamaVotingScheme` | `IVotingScheme` implementation that hides ballot choices with Zama FHEVM and reveals only aggregates. |
| `VaradaHook` | Uniswap v4 hook. Sets the dynamic fee (base fee plus a decaying anti-sniper surcharge) and routes collected fees to the fee vault. |
| `VaradaLpLocker` | Holds liquidity position NFTs permanently. Principal can never be withdrawn; only accrued fees are collected and forwarded to the fee vault. |
| `FeeVault` | Splits incoming fees between platform and cause pool; tracks balances per token; releases a token's cause pool for an epoch once a winner exists. |
| `CauseCatalog` | Owner-published, versioned Merkle root over every eligible Endaoment org, bucketed by `category x region`, with per-bucket sizes and the Swarm reference of the snapshot. A version applies to epochs starting after it is set. |
| `CauseRegistry` | Causes that can be paid: `causeId` (`keccak256` of the 32-byte Endaoment org id) to the org's factory-computed address and an active flag. The governor materializes catalogue winners into it; the owner can add causes directly or block any org. |
| `EpochGovernor` | Weekly epochs. Builds each epoch's ballot from the token's pinned causes, curator agents' picks and rotation draws over its focus pool, authorizes voters by vote checkpoints, and records the winning cause from the scheme's tally on finalization. |
| `DonationDistributor` | After finalization, sends the epoch's cause funds to the winning cause's payout address. |
| `CuratorRegistry` | One curator agent per cause category: ERC-8004 identity (owned by the registry), signer, vault, active flag and ENS label. Accepts each agent's weekly curations for the next epoch. |
| `AgentVault` | Per-agent USDC donation vault. Only the agent's signer can give, only to unblocked catalogue orgs in the agent's own buckets, within a per-epoch cap. No withdrawal. |
| `VaradaLiveHook` | Uniswap v4 hook of live tokens. Takes the fee from every swap in the quote currency, converts it to USDC inside the same swap and credits it to the cause active at that moment; a failed conversion holds the fee for a permissionless retry instead of reverting the swap. No owner. |
| `LiveDonationVault` | USDC ledger of live tokens: splits every conversion 10% platform / 90% cause, keeps the cause share per `(token, cause)` and pushes it to the cause's Endaoment org once the token's donation threshold is reached, or on `flush`. |
| `RotationGovernor` | Live tokens' rotation schedule (anchor-based, period chosen at launch, changeable by vote), the private rotation polls that pick the next cause, and the private yes/no polls that change the period. |
| `IPrivateDonationAdapter` | Interface only; see Deferred work. |

### Fee model

- The pool LP fee is dynamic and set per token at launch, between 1% and 5%, plus an optional
  anti-sniper surcharge that decays to zero over a short window after launch.
- Collected fees are split by `FeeVault` using a single constant, `PLATFORM_SHARE_BPS = 1000`:
  - 10% goes to the platform treasury.
  - 90% goes to the token's cause pool.
- Basis-point math uses a denominator of 10,000 and rounds in favor of the cause pool. The split is
  defined in one place only and is never duplicated elsewhere.

```
swap -> VaradaHook (dynamic fee) -> FeeVault
LP fees -> VaradaLpLocker.collectFees -> FeeVault
FeeVault --10%--> platform treasury
FeeVault --90%--> causePool[token] --settle(epoch winner)--> DonationDistributor --> cause payout
```

### Weekly epoch governance (hidden choices)

This is the weekly mode; the live counterpart is [Live rotation governance](#live-rotation-governance-hidden-choices).

- Epochs last 7 days. Epoch 0 starts at a Thursday 00:00 UTC boundary at or before deployment.
- A token's focus is fixed at launch: a set of catalogue categories and a set of regions. Its pool
  is every catalogue entry in those `category x region` buckets, under the catalogue version in
  effect when the epoch starts. The factory rejects a focus whose pool has fewer than two entries.
- **Ballot size.** `MAX_OPTIONS` (32) is the hard ceiling of every ballot, and the scheme's own
  `MAX_OPTIONS` bounds it too (32 for `ZamaVotingScheme`). Under it the owner sets a protocol cap
  (`setBallotSizeCap`, 2..32, 32 by default, `BallotSizeCapSet`), and each token's controller, the
  same account that sets its pins, may choose its own size (`setBallotSize(token, size)`, 2..32, or
  0 to follow the cap; `BallotSizeSet(token, size, effectiveFrom)`). An epoch gets
  `min(choice or cap, cap, scheme.MAX_OPTIONS())`; a choice above the cap gets the cap and comes
  back if the cap is raised. Views: `ballotSizeCap()`, `ballotSizeChoiceOf(token)`,
  `ballotSizeFor(token, epoch)` (the size a prepared epoch was prepared with, else the size it
  would get now) and `ballotSize()` (the cap bounded by the scheme, for a token that chose none).
  The size follows the pins' timing rule: both are read when the ballot is prepared, so a change
  applies to the current epoch while its ballot is unprepared (nobody can vote before that) and
  otherwise from the next epoch. A prepared epoch stores its size and option count in its flag
  slot (no extra storage write), and voting, closing and finalizing use only that option count and
  the ballot commitment, so lowering the cap or a token's size never reshapes a running ballot.
  `setShortlist` rejects more pins than the token's current size (`ShortlistTooLong`); if the
  size is lowered later, a ballot takes the first `size` unblocked pins in order and drops the
  rest. Smaller ballots are cheaper to vote on: the scheme packs three options to an encrypted
  tally word, so multiples of 3 waste no counter and each 3 fewer options save each voter about
  86k gas per ballot (`ballotGasHint` in the SDK; the token page shows it next to the size
  control). The SDK (`effectiveBallotSize`, `planBallot`, `planBallotOpening`) and the keeper read
  `ballotSizeFor(token, epoch)`; `contracts/test/fixtures/ballot-sizes.json`, generated by the
  SDK (`gen:fixture`), replays its plans at sizes 2, 3, 8, 16, 30 and 32 on the governor
  (`BallotSizeFixtureCompat.t.sol`). The indexer stores the cap, each token's choice and the size
  each epoch was prepared with, and reports `ballotSize { cap, choice, size, choiceEffectiveFrom }`
  on `/api/tokens/:address`. Curator agents still rank up to 32 picks per region; a smaller
  ballot only uses fewer ranks.
- Each epoch's ballot holds up to its ballot size of causes (`ballotSizeFor`), filled in three
  phases (`_prepare`):
  1. **Pins.** The token's controller may pin up to 8 catalogue orgs inside the focus (with Merkle
     proofs), and no more than the token's ballot size; pins lead the ballot and change from the
     next epoch once the current ballot is prepared. Blocked pins are skipped, and pins past the
     size are dropped in order.
  2. **Curated picks.** For each focus bucket, `CuratorRegistry.curationsFor` returns the curation
     its agent submitted for this epoch (see [Curator agents](#curator-agents)), or nothing when
     the agent is inactive, submitted nothing, gave weight 0 or used another catalogue version than
     the one in effect at the epoch's start. The free slots are split by weight (`_quotas`,
     mirrored by the SDK's `curatedQuotas`; the free slots are the size minus the pins placed, possibly
     zero, in which case no curated draw is consumed): each curation first gets
     `min(count, floor(slots * weight / totalWeight))`, then leftover slots go one at a time to
     curations still below their pick count, in ascending bucket order, round after round, until
     the slots run out or every curation is at its count. Bucket by bucket, ranks
     `0..quota-1` are then taken in order.
  3. **Rotation.** The remaining slots are filled by rotation: draw `k` is pool entry
     `keccak256(abi.encode(token, epoch, version, k)) % poolSize`, skipping repeats (an org in
     several buckets, or already pinned or picked) and blocked orgs, for at most three draws per
     free slot; a pool that fits the free slots is taken whole, in order. Nobody can choose the
     draws, and over time every charity in the focus reaches a ballot.
- A curated draw (`IEpochGovernor.CuratedDraw`) carries two proofs: the pick leaf
  `(uint8 rank, uint32 catalogIndex, bytes32 orgId)` against the agent's picks root, and the
  catalogue leaf actually at `(bucket, catalogIndex)` against the catalogue root. A bad proof of
  either kind reverts (`InvalidCuratedDraw`), so whoever prepares the ballot cannot substitute
  picks. Picks are not checked when the agent submits them; at ballot time a pick is skipped when
  the catalogue entry at its index is a different org (a pick from outside the bucket, or a stale
  index), when its index is past the bucket's end (no entry proof is needed then), when the org is
  blocked, or when it repeats an earlier option. A skipped pick still uses its rank, and its slot
  passes to rotation. `CuratedPicksUsed(token, epoch, drawn, included)` records how many picks were
  checked and how many reached the ballot.
- A ballot whose focus buckets have usable curations (`curationsFor` for the epoch and its
  catalogue version) can only be prepared with its curated draws (`prepareCuratedBallot`), all
  week: `prepareBallot` and `openEpoch` revert with `IncompleteCuratedBallot`. So the first
  preparer cannot choose whether published picks appear. A ballot without usable curations needs
  no curated draws and can be prepared at any time. `requestCurationSkip` is disabled (it reverts
  `CurationSkipDisabled`; `curationSkipAt` is always 0). An agent that submits a root but never
  serves its picks keeps the epoch's ballots (and its rotation rounds) in that focus unpreparable
  until the curator registry owner voids that epoch's curation
  (`CuratorRegistry.voidCurations(epoch, buckets)`); `curationsFor` then returns nothing for those
  buckets and rotation fills the ballot. Voiding touches one epoch only, so the agent stays active
  and can submit the next epoch's picks. Pausing the agent (`setActive(categoryBit, false)`) also
  drops its picks, but for every epoch while it is paused, and a paused agent cannot submit, so
  it is for a misbehaving agent rather than one missed week.
- Liveness has no automatic bound: nothing falls back to rotation on its own. The bound is the
  owner's response. A weekly ballot can only be prepared during its epoch (`_checkPreparable`),
  so the hard deadline for `voidCurations` is the epoch's end; a ballot never prepared gets no
  ballots, and `finalizeEpoch` pays the epoch's fees to `defaultCause` (it reverts `NoVotes` until
  one is set, so funds are never lost, only delayed). The default cause cannot be set by the deploy
  script, as no cause exists yet at deploy time: the owner sets it at launch, before the first
  epoch ends (`script/Deploy.s.sol`, step 2). Response target and steps: `agents/README.md`,
  "Keeper reports `CuratedPicksUnavailable`".
- Anyone may fix the ballot with `prepareBallot(token, epoch, draws)`, supplying each drawn entry
  and its proof, or with `prepareCuratedBallot(token, epoch, curated, draws)` when the curated phase
  takes slots. A ballot that needs no draws opens with `openEpoch(token, epoch)`. Ballots are
  rejected until the epoch is opened, so a ballot's option index always refers to the frozen
  ballot. A ballot of fewer than two options opens no poll and the epoch pays the default cause.
- The governor does not store the options. `BallotPrepared` carries their catalogue org ids in
  ballot order (cause id = `keccak256(orgId)`), and the epoch keeps only a commitment,
  `keccak256(abi.encodePacked(orgIds))`, plus the option count packed into its flag slot
  (`ballotCommitment(token, epoch)`; the SDK's `ballotCommitment` computes the same hash). This
  saves about 0.7M gas per prepared 32-option ballot (33 fresh slots become one). Storing the ids
  in an SSTORE2 data contract would cost about 237k instead of about 25k, so the commitment is
  used. `finalizeEpoch(token, epoch, orgIds)` takes the org ids back as calldata when it applies a
  tally and reverts with `BallotMismatch` unless they match the commitment and count; an epoch
  without ballots, or one past its tally grace, needs none (pass an empty array). The indexer
  stores the options from `BallotPrepared` (`epoch_option`, with `orgId`) and serves them as
  `optionOrgIds`. The keeper takes the org ids from the indexer first and falls back to the log
  (`eth_getLogs` by token and epoch over that epoch's blocks), checking either against the
  commitment; a voted epoch with a final tally has no timeout, so the keeper needs one of the two
  (an RPC that serves logs about two epochs back, or the indexer). The web app's chain fallback
  scans only the current epoch's blocks in 5,000-block chunks and, if that fails, still shows the
  epoch state with the options marked unavailable.
  `test/governance/WeeklyPlatformGas.t.sol` logs the weekly keeper cost per token and a voter's
  `castBallot` against main (options in storage, eager tally words, every epoch opened).
- The publisher's keeper opens the current epoch of every registered token that is active, and
  leaves idle tokens' epochs closed. A token is idle when the indexer's `/api/active-tokens` shows
  no fees credited to its pools, no ballots and no curation-skip request in epochs
  `[current - N, current]`, no pin change and no launch since `epochStart(current - N)` (`N` =
  `KEEPER_IDLE_EPOCHS`, 2 by default; 0 opens every epoch), and its LP position holds no
  uncollected fees. The last check matters because the pool's LP fee, a token's main revenue once
  the launch surcharge has decayed, accrues inside the locked position and reaches the FeeVault
  (and `FeesAttributed`, the indexer's fee signal) only when someone calls
  `VaradaLpLocker.collectFees` or `FeeVault.settle`; the keeper therefore simulates `collectFees`
  (an `eth_call`, free) for every token the indexer calls idle, through the factory's `locker()`
  (`FACTORY_ADDRESS`), and any amount above zero, or a failed read, opens the epoch. Uncollected
  fees keep a token active until someone collects them. The set is re-read every run, so the
  epoch opens on the first run after a trade, a ballot or a pin change. The keeper opens every
  epoch, as before, when the indexer call fails, when Ponder's `/status` shows the indexer's last
  block more than `KEEPER_INDEXER_MAX_LAG_SECONDS` (600) behind the wall clock or nothing indexed
  (a re-sync or a lag answers 200 with a partial set), or when no `FACTORY_ADDRESS` is set. An
  idle epoch that nobody opens pays the default cause when finalized, exactly as an
  opened epoch without ballots does, and the keeper still finalizes it. Opening stays
  permissionless: the web app's vote panel offers "Open this week's ballot" on an unopened
  current epoch and sends the same transaction the keeper would. Skipping an idle token saves
  the whole open (about 0.82M gas with a 32-option ballot on mainnet: the governor's draws, pins,
  ballot commitment and calldata, about 0.79M, and the scheme's lazy open, about 30k); its week
  then costs the platform one `finalizeEpoch` of a never-opened epoch, about 78k
  (`test/governance/IdleEpochsGas.t.sol`). Before the ballot commitment, lazy tallies and this
  policy, the same idle week cost about 2.13M (live coprocessor figures; `WeeklyPlatformGas.t.sol`).
- For an epoch it opens, the keeper reads
  `curationsFor` for the token's focus buckets, computes the quotas, fetches each curated bucket's
  pick leaves and proofs from the indexer (`/api/agents/:label/picks/:epoch/:region`; the root
  must equal the one on chain) and the catalogue entries with proofs (the root must equal the
  epoch's version), plans the ballot locally with the SDK's `planBallotOpening` (over
  `planBallot`, which mirrors `_prepare`; the web app's button runs the same code), and sends `openEpoch`, `prepareCuratedBallot` when any slot is curated, or
  `prepareBallot`. If a usable curation's picks cannot be fetched, the step fails with
  `CuratedPicksUnavailable` and nothing is sent. The keeper retries with exponential backoff
  (5 minutes, doubling, at most 15 minutes apart for missing picks; a publisher restart clears it)
  and uses the picks once they turn up, or prepares with rotation only once the registry owner has
  voided the curation. The first failure for each agent, region and epoch logs at `error`, which
  pages the owner. The web app's button runs the same plan and, with picks missing, sends nothing
  and explains the wait.
- Voting weight is the holder's lowest vote checkpoint over a hold window ending one second
  before the epoch start (`snapshotFor`), counted in whole tokens. The window is one epoch
  (`HOLD_WINDOW`, 7 days, the same rule as a weekly rotation), so it is exactly the previous
  epoch: tokens bought during an epoch count from the epoch after next, and a position held only
  around the public snapshot carries nothing (no buy-vote-sell, flash loans or one-block holds).
  In the epoch a token launches in, the regular snapshot predates the token, so its weights are
  read at a launch snapshot one day after registration instead (halfway to the epoch's end when
  less than two days remain; `launchSnapshotOf`), over the later half of that delay. The epoch
  after launch starts its window there too, as its regular start predates the token
  (`holdFromFor`). The voter and weight are public; the choice is not.
- Ballots go to the voting scheme directly (`IVotingScheme.castBallot(governor, token, epoch,
  ballot)`), because encrypted inputs are bound to the transaction sender. The scheme calls back
  `EpochGovernor.authorizeBallot`, which checks eligibility, records the voter and emits `VoteCast`.
- `ZamaVotingScheme` packs three 40-bit counters into each encrypted `euint128` word (11 words for
  32 options) and adds the voter's weight to the counter their encrypted index selects, touching
  every word so nothing reveals the choice; one 32-option ballot costs about 971k gas of FHE work.
  The tally words are lazy: opening the poll at `prepareBallot`/`openEpoch` only records the option
  count (about 30k gas instead of 526k at 32 options on the live coprocessor), and the first ballot
  creates the 11 words (about 31k more for that voter). An epoch nobody votes in never touches the
  coprocessor; if it is closed anyway, the scheme's tally is final at once with zero counts and
  nothing is decrypted. After the epoch, `closeEpoch` makes the tallies publicly
  decryptable; the publisher's tally keeper fetches the decryption and KMS proof from Zama's relayer
  and calls `submitTally`, which verifies the proof on-chain. `finalizeEpoch`, given the ballot's org
  ids from `BallotPrepared`, then stores the winning `causeId` (ties go to the lowest ballot index; an epoch without ballots falls back to the
  owner-set default cause) and materializes a catalogue winner into `CauseRegistry` from the
  Endaoment factory's `computeOrgAddress`. If no verified tally arrives within two weeks of the epoch's end, the
  epoch also falls back to the default cause, so a cause pool can never be stranded. The fee vault
  settles that epoch's cause pool to `DonationDistributor`.
- Weekly payout. Every step from an ended week to its donation is permissionless: `closeEpoch`, the
  tally decryption plus `submitTally`, `finalizeEpoch`, `FeeVault.settle(token, epoch)` (which first
  brings the week's outstanding LP and consolidator fees in, reverts `FeesPending` until they are in
  or `SETTLE_GRACE` (7 days) after the week's end, and `NothingToSettle` when the week's pool is
  empty, which means that week has no donation), then `DonationDistributor.distribute(token, epoch)`
  to the winning Endaoment org (`OrgNotActive` and `OrgAddressMismatch` need the owner or Endaoment
  to act). The SDK's `planDonation` (`packages/sdk/src/donation.ts`) picks the next step from chain
  state, including a simulated settle or distribute. The publisher's keeper runs it after
  finalizing, so with `FEE_VAULT_ADDRESS` and `DONATION_DISTRIBUTOR_ADDRESS` set it now settles and
  distributes every finalized week itself. The token page runs the same plan in the "Send this
  week's donation" card, so any visitor can push a week through and pay the gas; the money can only
  go to the week's winner. The card leaves the decryption to the keeper, because Zama's mainnet
  relayer serves public decryption only with the keeper's API key. Once the tally grace has passed
  without a decrypted tally, the card offers "Give this week to <default charity>" and says that
  the votes will not be counted. It shows the oldest week with a step to send, before any week that
  waits or is blocked.
- The scheme is pluggable per governor. Interfold (CRISP) or a self-hosted Noir/Barretenberg scheme
  can replace Zama without changing the governors.

### Community takeover

Holders can replace an absent or unwanted profile controller. `TakeoverGovernor.propose` needs a
minimum token age, a per-proposer cooldown and a proposer weight above a threshold; it opens a
two-option poll (AGAINST, FOR) on the scheme. Several proposals for one token may run at once;
executing one supersedes the older ones. Voting weight is a holder's lowest vote checkpoint over
the whole lookback, from `lookback` before the snapshot (one week by default) to the snapshot (the
second before the proposal), so tokens bought, or lent out, for part of it carry no weight
(`HoldWeightLib`, below). The proposer's own weight is read in the `propose` transaction, whose
snapshot is that second, so it cannot be scanned ahead; a proposer whose lookback holds more
checkpoints than one block can read (over 10k) cannot propose, and another holder can. Quorum
and threshold are basis points of the circulating supply at the snapshot, which excludes the
Uniswap pool manager's locked balance.
After the voting period the proposal is closed and tallied; it succeeds when FOR reaches the
quorum and beats AGAINST, and `execute` within the execution window (at least two days, to leave
room for decryption) calls `TokenProfileRegistry.setController`. Only the proposer, or the owner
while voting is still open, may cancel.

Key events consumed by the indexer and SDK: `TokenCreated`, `FeesCollected`, `CauseAdded`,
`CauseDeactivated`, `CatalogVersionSet`, `FocusSet`, `BallotPrepared`, `EpochOpened`, `EpochClosed`,
`EpochFinalized`, `Donated`, `VoteCast`, `CuratedPicksUsed`,
`TokenRegistered`, `ControllerChanged`, `EditorChanged`, `TextChanged`,
`LogoChanged`, the scheme's `PollOpened`/`BallotCast`/`TallyRequested`/`TallySubmitted` and the
takeover governor's `TakeoverProposed`/`TakeoverVoteCast`/`TakeoverTallied`/`TakeoverExecuted`,
the curator registry's `AgentRegistered`/`SignerSet`/`ActiveSet`/`AgentWalletLinked`/`CurationSet`/`CurationsSubmitted`
and the agent vaults' `Donated`/`Given`.

### Deferred work

- **Trust-minimised private voting**: Zama's threshold KMS is the day-zero trust anchor. Interfold's
  CRISP (bonded ciphernode network) is the intended replacement once its voting program reaches
  mainnet; a self-hosted Noir/Barretenberg scheme (exponential ElGamal ballots, k-of-n committee
  decryption) was researched as the fallback. Both plug into `IVotingScheme`.
- **Private donations** are deferred. `IPrivateDonationAdapter` defines the shielded send route, with
  no implementation yet. Donations currently go directly to the cause payout address.
- **Arkiv mainnet**: the mirror runs against the Rabdi testnet until Arkiv ships a mainnet.
- **Catalogue on Arkiv**: Arkiv mirrors each token's focus, not the catalogue itself. Mirroring
  catalogue versions and per-org entries needs indexer listings for them and a measure of Arkiv
  write throughput and lifetime-extension cost for a few hundred thousand entities.

## Live donation mode

Live mode is the second way to launch a token. A weekly token accrues a cause pool that holders
assign once a week; a live token donates as it trades. The creator picks the mode at launch
(`VaradaFactory.deployLiveToken` instead of `deployToken`); it cannot be changed afterwards. The
token, its ENS name, its profile, the locked single-sided liquidity, the takeover governor and the
10% / 90% split are the same in both modes.

| | Weekly mode | Live mode |
|---|---|---|
| Hook | `VaradaHook` | `VaradaLiveHook` |
| Fee to USDC | Collected, then consolidated by `FeeConsolidator` | Converted inside the trader's swap |
| Ledger | `FeeVault` cause pool per token | `LiveDonationVault` credit per `(token, cause)` |
| Payout | Once per epoch, to the winner, through `DonationDistributor` | Continuously, to the cause active when the fee was earned |
| Governor | `EpochGovernor`, 7-day epochs | `RotationGovernor`, 1 h / 12 h / 24 h / 72 h / 7 d rotations |
| No result | Default cause | Current cause continues |
| Revealed | Per-option tallies | Winning option only |

### Launch and focus

- `deployLiveToken(params, live)` takes the same `DeployParams` as `deployToken` plus
  `LiveParams`: `initialCause` (an active `CauseRegistry` cause, which receives fees from launch),
  `rotationPeriod` and `donationThreshold`.
- Launch focus rule: both modes fix the token's cause focus (category and region masks) at launch,
  forever, under the same catalogue check: the latest catalogue must give the focus at least two
  entries, or the launch reverts (`IEpochGovernor.PoolTooSmall`). A weekly token is checked when the
  epoch governor registers it; a live token never reaches that governor, so the factory runs the
  same check itself.
- Live mode is enabled once by the factory's deployer with `configureLiveMode(liveHook,
  liveVault)`; until then `deployLiveToken` reverts `LiveModeNotConfigured`. The live hook must
  differ from the weekly hook and report the live vault as its vault.

### In-swap conversion and donation

- The pool's LP fee is overridden to 0, so the locked position earns nothing. The hook takes the fee
  itself: base fee (1% to 5%) plus the decaying launch surcharge, at most 85% of the swap's gross
  quote flow, rounded up. It is taken from the input or the output depending on which side of the
  swap is the quote currency; exact-input buys and exact-output sells must fill completely
  (`PartialFillNotSupported`).
- In `afterSwap` the hook mints itself ERC-6909 claims for the fee and, unless the router has a
  currency synced mid-settlement, makes a gas-capped self call (`inlineConvert`, 650k gas) that has
  the consolidator burn the claims and swap them to USDC along the quote's hookless registry route
  (at most three hops, including the WETH unwrap), under the consolidator's tighter in-swap price
  guards. The USDC is paid to `LiveDonationVault` and credited to the cause `RotationGovernor`
  reports as active at that moment (`FeeTaken(token, causeId, rotation, ..., converted, failure)`).
- Nothing about the conversion or the donation can revert a trader's swap. If the conversion fails
  (a route pool pushed off its reference, a synced currency, out of gas), the frame is rolled back
  and the claims stay with the hook as `heldRaw[token][cause]`, attributed to the cause active when
  they were earned. Anyone can convert them later with `retryHeld(token, causeId, amount)`; the
  credit still goes to that cause (`HeldRetried`, and `Credited` with rotation `type(uint64).max`).
- The only reverts the hook adds to a swap are `InsufficientGas`, `PartialFillNotSupported` and
  `SwapReentered`. `PoolManager.donate` to a live pool always reverts (`DonateNotAllowed`), since
  the locked position could never collect it.

### LiveDonationVault and the donation threshold

- Every credit is split once: `floor(gross * 1000 / 10000)` to the platform, the rest to the
  `(token, cause)` bucket. Credit never moves between causes; a cause rotated out keeps its bucket
  until it is paid.
- Each token has a donation threshold in USDC (6 decimals, at most 1,000,000 USDC), chosen at
  launch. When a bucket's credit reaches it, the vault pushes the whole bucket to the cause's
  Endaoment org inside the same swap, through a gas-capped self call (`executePush`, 220k gas). A
  threshold of 0 pushes on every swap.
- The UI should default to a nonzero threshold. A push inside a swap adds about 120k to 150k gas to
  that trader's swap (Endaoment registry lookup, address and active checks, approve, donate). With
  threshold 0 every trader pays it; with a threshold, only the swap that crosses it does, and the
  donations are larger and fewer.
- A push only goes to a deployed, Endaoment-active org. Any failure (undeployed or inactive org,
  address mismatch, paused USDC, out of gas) keeps the credit, sets a one-hour backoff on that
  bucket and emits `DonationDeferred`. `flush(token, causeId)` sends a bucket at any time, ignoring
  the threshold and backoff, and deploys the org through the Endaoment factory if needed.
- `withdrawPlatform` and `skim` are permissionless and only ever pay the platform treasury; `skim`
  never touches owed USDC. The vault has no pause, redirect or rescue. Its invariant is
  `usdc.balanceOf(vault) >= platformAccrued + totalPending`.

```
swap -> VaradaLiveHook (fee in quote) --inlineConvert--> FeeConsolidator (route to USDC) --> LiveDonationVault
LiveDonationVault --10%--> platform treasury
LiveDonationVault --90%--> pending[token][activeCause] --threshold reached or flush--> Endaoment org
conversion failed -> heldRaw[token][activeCause] --retryHeld--> FeeConsolidator --> LiveDonationVault
```

### Live rotation governance (hidden choices)

- Periods: one hour, 12 hours, 24 hours, 72 hours or one week (`RotationPeriod`). The creator picks
  one at launch; holders can change it by vote (below).
- Schedule: anchor-based (`RotationScheduleLib`). Rotation 0 starts at launch, and rotation `n`
  covers `[startOf(n), startOf(n + 1))`, counted from the anchor rather than from
  `block.timestamp / period`. A period change only ever applies from the next boundary, so past and
  current rotations are never renumbered, the start of the current and next rotation never move,
  and poll scopes and snapshots never collide across a change.
- During rotation `c`, holders vote on the cause for rotation `c + 1`. The poll opens at
  `startOf(c)` and closes `min(period / 4, 6 hours)` before rotation `c + 1` starts, leaving that
  buffer to close, decrypt and finalize: 15 minutes for hourly rotations, 3 hours for 12-hour
  rotations, 6 hours for longer ones. `openRound(token)` is permissionless.
- Keep-current: a winner applies from the rotation after the one in which it is finalized, never
  retroactively, so a result that arrives late applies one boundary later. With no ballots, fewer
  than `minVoters` ballots (nothing is decrypted then), no option with weight, or no result yet,
  the current cause simply keeps receiving fees. There is no fallback cause in live mode. A winner
  that is no longer active in `CauseRegistry` is recorded as `InactiveWinner` and changes nothing.
  Rounds are plurality with no quorum; ties go to the lowest option index.
- Weights: a voter's weight is the lowest vote checkpoint it held over the whole hold window
  `[snapshot - lookback, snapshot]`, with `snapshot = startOf(c) - 1` and `lookback = max(period,
  1 day)`, in whole tokens. Tokens bought during the rotation carry nothing, and a position held
  only around the public snapshot instant carries nothing either (no buy-vote-sell, flash loans or
  one-block holds). Polls in a token's first day therefore carry no weight.
- All three governors compute hold weights with `HoldWeightLib`, which reads every checkpoint in
  the window. There is no scan cap: a cap would let a holder hide a dip behind enough later
  checkpoints, and since anyone can add checkpoints to an account (a transfer to it writes one),
  zeroing or rejecting a capped scan would let a third party cancel a holder's vote with a few
  hundred dust transfers. Dust only makes the scan longer, about 4.4k gas per checkpoint, while
  each checkpoint costs its sender a transfer at a distinct second (at most one per block). So
  that no amount of dust pushes a ballot past the block gas limit, anyone can run the scan ahead
  in chunks with `advanceHoldScan`; the progress is cached per window (a past window never
  changes) and the ballot then reads only what is left.
- Privacy: polls run on the same pluggable `IVotingScheme` (`ZamaVotingScheme`), but are closed
  with `requestOutcome`, which computes the argmax under FHE and makes only the winning option index
  publicly decryptable. Per-option tallies are never decrypted: in small polls whose voters and
  weights are public, they would give individual choices away.
- Period changes: any holder whose hold weight meets the proposal threshold may
  `proposePeriod(token, newPeriod)` (not in rotation 0). It opens a private yes/no poll; quorum is
  a share of the circulating supply at the snapshot (total supply minus the pool manager's
  balance). Only the outcome is revealed (`PeriodProposalTallied(id, passed)`; FOR wins with
  `for > against` and `for >= quorum`), and a passed proposal executed within its window schedules
  the new period from the next boundary. One proposal per token and period may be active, so
  proposals for different periods run side by side. Defeats and expiries start a cooldown for that
  period; an execution starts it for every period and supersedes older pending proposals. The
  deploy defaults are a one-day vote, a three-day execution window, a seven-day cooldown, 10%
  quorum and a 0.5% proposal threshold.

### Live ballot candidates

Live rotation polls build their candidates exactly as weekly ballots do, over the token's focus
pool, so a live token's causes always come from its launch focus. The ballot logic is
`CatalogBallotLib`, shared by `EpochGovernor` and `RotationGovernor`; the rotation governor runs it
through `CatalogBallotBuilder`, a view contract it deploys in its constructor (which keeps the
governor under the contract size limit). A round's options come in three phases:

1. **Pins.** The controller's catalogue pins inside the focus (`setShortlist(token, pins)`, up to
   `PINNED_MAX` with Merkle proofs, checked by `CatalogBallotBuilder.validatePins`) lead the
   ballot.
2. **Curated picks.** The curator agents' curations for the focus buckets fill part of the
   remaining slots, with the same weighted quotas (`CatalogBallotLib.quotas`) and pick checks as a
   weekly ballot. The curations are those of the weekly epoch containing the round's vote start
   (`curationEpochOf`), on the curator registry's weekly clock, which `setCuratorRegistry` copies
   once into the builder (`setCurators`).
3. **Rotation.** Deterministic draws over the focus pool fill the rest: draw `k` is pool entry
   `keccak256(abi.encode(token, target, version, k)) % poolSize` (`drawIndex`), skipping repeats
   and blocked orgs under the same draw budget (`DRAW_FACTOR`), so nobody can choose them.

Preparing a round (all permissionless, only for the next rotation's round, `target = current + 1`,
and only before its vote end):

- `openRound(token)` prepares it with no draws: enough when the pins fill the ballot or the pool is
  empty, as the weekly `openEpoch`.
- `prepareRound(token, target, draws)` supplies the rotation draws and their proofs.
- `prepareCuratedRound(token, target, curated, draws)` also supplies the curated draws, when the
  curated phase takes slots.

The builder requires exactly the curated and rotation draws the ballot consumes
(`TooManyCuratedDraws`, `TooManyDraws`, `IncompleteCuratedBallot` and `InvalidCuratedDraw`, with
`IEpochGovernor`'s error signatures, bubbled unchanged). A round with fewer than `MIN_OPTIONS` (2)
options is recorded as `NoBallot` and takes no ballots; otherwise its poll opens at once
(`BallotPrepared`, `CuratedPicksUsed` when picks were drawn, `RoundOpened`).

- **Freezing.** The options are frozen when the round is prepared, before its first ballot, so an
  option index always refers to a list fixed by an earlier transaction, and pins or curations
  changed later apply from the next round. Blocked orgs are skipped in every phase. Only the
  winner is materialized into `CauseRegistry`, with the Endaoment factory's computed address,
  before it receives fees.
- **Catalogue version.** A round uses the catalogue version that the weekly ballots of its
  containing epoch use: the version in effect at that epoch's start
  (`CatalogBallotBuilder.versionOf(voteStart)`; `poolOf` shows the round's version and pool size).
  Curations carry a version no newer than that one and count only under it, so a version published
  mid-week does not drop the week's curated phase from later rounds, and a round matches that
  week's weekly ballot. Without a curator clock, or when no version was in effect at the epoch's
  start, the version at the vote start is used. Off chain this means the catalogue snapshot of the
  previous version stays in use for the rest of the week: after a mid-week `setVersion` the
  indexer serves both (`CATALOG_SOURCE=<new>,<previous>`), and the keeper asks for a round's
  entries by its version's root (`/api/catalog/entries?root=`).
- **Published picks.** A round whose buckets have usable curations needs its curated draws for
  its whole vote window, as a weekly epoch does: `openRound` and `prepareRound` revert
  `IncompleteCuratedBallot`, so the first preparer cannot leave the picks off. A round without
  them prepares at any time. `CatalogBallotBuilder.curationGraceEnd` is kept as a view but no
  longer gates the build. Picks committed but never served hold rounds until the registry owner
  voids that epoch's curation (`CuratorRegistry.voidCurations`); a round whose vote window ends
  first is not prepared, and the token keeps its current cause for that rotation.
- **Round size.** `maxOptions()` is `min(RotationGovernor.MAX_OPTIONS, scheme.MAX_OPTIONS())`, so
  at most 10 options against the weekly ballot's 32. The pin limit is the same, but with fewer free
  slots the curated quotas can split differently from the weekly ballot of the same epoch, so a
  round is not simply a prefix of it. The cap comes from the outcome-only close:
  `ZamaVotingScheme.requestOutcome` runs an encrypted comparison and two selects per option in one
  transaction, which is safe up to 17 options under the mainnet coprocessor's HCU depth limit of
  5M per transaction; 10 leaves a margin.
- **Rotation keeper.** With `ROTATION_GOVERNOR_ADDRESS` set, the publisher's tally keeper drives
  every live token's rounds (`services/publisher/README.md`, "Tally keeper", step 2). It prepares
  the next rotation's round with the SDK's `planRoundOpening`, the weekly planner run over the
  rotation governor's views (pins, then the curated picks of `curationEpochOf`, then draws seeded by
  the target rotation). When a usable curation's picks are not served yet the step fails with
  `CuratedPicksUnavailable` and is retried at least every 15 minutes until the picks are served or
  the curation is voided; it never sends a rotation-only round that would revert. It then closes
  each ended round that got ballots, relays the public
  decryption of the winner only (`outcomeHandle`, `submitOutcome`) and calls `finalizeRound`.
  Rounds that ended without ballots are left open: nothing would change. A round still unfinished
  when it leaves the keeper's lookback is followed until it is final, since a late finalize is
  `Stale` only once a later round was applied. The keeper also drives period-change proposals:
  `closePeriodProposal`, the winner's decryption and `submitOutcome`, then
  `executePeriodProposal` (which also expires a proposal left without an outcome past its
  execution window). Anyone can still call the functions above themselves.

Key live events: the factory's `LiveModeConfigured`; the hook's `TokenConfigured`,
`PoolRegistered`, `FeeTaken`, `HeldRetried`; the vault's `LiveTokenRegistered`, `Credited`,
`Donated`, `DonationDeferred`, `PlatformWithdrawn`, `Skimmed`; the governor's `TokenRegistered`,
`BallotPrepared`, `CuratedPicksUsed`, `RoundOpened`, `RotationVoteCast`, `RoundClosed`, `RoundFinalized`, `CauseScheduled`,
`PeriodProposed`, `PeriodVoteCast`, `PeriodProposalClosed`, `PeriodProposalTallied`,
`PeriodProposalExpired`, `PeriodChangeScheduled`, `PeriodProposalCanceled`.

### Live mode operator notes

- **Swap gas.** A swap that owes a fee needs `LIVE_GAS_REQUIRED` (770,317) gas left at
  `afterSwap`, or it reverts `InsufficientGas` rather than silently skipping the donation. In
  practice that is a gas limit of about 0.86M to 0.89M per swap, of which the swap uses about 0.29M
  (no push) to 0.40M (push in the swap); the rest is refunded. The requirement does not depend on
  state, so `eth_estimateGas` finds it.
- **Aggregators and routers.** An integrator that sizes the gas limit from a simulation of the
  swap's actual usage, or forwards a fixed per-hop budget, can leave too little at `afterSwap` and
  hit `InsufficientGas`. Live pools need the full limit above; tell integrators so.
- **Hourly periods.** The poll closes 15 minutes before the next rotation. In that window someone
  must call `closeRound`, have the outcome decrypted through Zama's relayer and call
  `finalizeRound`; anything later applies one rotation late. The keeper runs every
  `KEEPER_INTERVAL_SECONDS` (300 by default), so it has about three runs in that window, each
  also spending its `KEEPER_MAX_TX_PER_RUN` budget on other items. Watch hourly tokens closely,
  and shorten the interval if many live tokens are hourly.
- **First fee of a new WETH-quoted pool.** It may be held rather than converted (`FeeTaken` with
  `converted = false`). It stays attributed to the cause active when it was earned; call
  `retryHeld` (or let the keeper do it) to convert it. Watch `totalHeld` and `heldRaw`.
- **Deferred pushes.** `DonationDeferred` buckets retry inside a swap after the one-hour backoff;
  `flush` pays them now and deploys an undeployed org.

## Token profiles and ENS subnames

Every launch registers a label in `TokenProfileRegistry`; `<label>.varada.eth` exists exactly when
the token exists, with no per-name ENS transaction. `varada.eth` is registered on ENSv2 and its
resolver is `VaradaResolver`, an ENSIP-10 wildcard resolver that the Universal Resolver reaches
for every subname. Records: `addr` is the token address and can never change; `contenthash` is always the
registry's default (the dApp's Swarm feed manifest), so every subname is the one site; text
records (`url`, `description`, `avatar`, `com.twitter`, `org.telegram`, `com.discord`) are edited by
the controller or an appointed editor; `varada.logo` is synthesized from the on-chain logo
reference. The registry owner can reserve labels and suppress a profile (the resolver then answers
empty values while the label stays taken).

## Curator agents

Twenty curator agents, one per cause category (every category except `other`), research their
cause each week and publish ranked picks for the next epoch's ballots. They are run by the
platform. They cannot pin causes or vote, and no ballot depends on them: rotation fills any slot
they leave empty. Operating them is described in [`agents/README.md`](../agents/README.md).

### Identities and names

- `CuratorRegistry` (owned by the platform) holds one agent per category bit: its ERC-8004 agent
  id, signer, vault, active flag, ENS label and description. `registerAgent(categoryBit, label,
  signer, agentURI, description)` deploys the agent's `AgentVault` (CREATE2, salt = category bit)
  and registers an identity on the ERC-8004 Identity Registry on mainnet
  (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`) with metadata `varada.category` and
  `varada.vault`. The registry owns the identity NFT. The registry is the source of truth; ERC-8004
  (a Draft standard behind an upgradeable proxy) is the public identity layer, and no Varada
  contract depends on its state after registration.
- `linkAgentWallet` makes the vault the identity's ERC-8004 agent wallet. The Identity Registry
  checks the signer's EIP-712 `AgentWalletSet(agentId, newWallet, owner, deadline)` signature
  through the vault's ERC-1271 `isValidSignature`. The vault accepts the agent's current signer
  only for the Identity Registry, only during `linkAgentWallet`, and never while paused, so the
  signer cannot approve a USDC permit for the vault. The deadline may be at most 5 minutes ahead.
- The signer is a 1Claw HSM key. The owner can replace it (`setSigner`), pause or resume the agent
  (`setActive`), void one epoch's curations of some buckets (`voidCurations`, for picks that are
  never served), and update the agent URI and description. A paused agent cannot submit, its
  curations are ignored by the governor, and the publisher rejects its reports.
- Names are `<ensLabel>.agent.varada.eth`, with the labels from `packages/sdk/src/catalog.ts`
  (`homeless`, `wildlife`, `mental-health`, ...); a label is permanent once registered. The deploy
  script reserves the label `agent` in `TokenProfileRegistry`, so no token can take it.
  `VaradaResolver` answers the agent namespace from `CuratorRegistry`, with no ENS write per
  agent: `addr` is the agent's vault (`agent.varada.eth` itself resolves to the registry), text
  records are `url` (`https://<label>.agent.varada.eth.limo`), `description`, `varada.category` and
  `agent-registration` (`eip155:1:<identity registry>:<agentId>`), and the contenthash is the
  site default. A label under `agent` that no agent holds resolves to the zero address and empty
  text records (its contenthash is still the site default); it never falls through to a token.

### Weekly curations

- `submitCurations(categoryBit, epoch, catalogVersion, reportRef, curations)` is accepted only
  from the agent's signer, only while the agent is active, and only for `currentEpoch() + 1`.
  `catalogVersion` must be between 1 and the latest catalogue version. Per region it stores a
  picks root, a pick count (at most 32; zero exactly when the root is zero) and an urgency weight
  (at most 10,000), and emits `CurationSet`; the submission emits `CurationsSubmitted` with
  `reportRef`, the Swarm reference of the full report. A submission replaces the regions it lists
  and can be repeated until the epoch starts, so a running epoch's ballot can never be reshaped.
- A pick leaf is the OpenZeppelin standard-tree leaf of `(uint8 rank, uint32 catalogIndex,
  bytes32 orgId)`, ranks `0..count-1`, one tree per region. Only the root goes on chain.
- A curation counts only under the catalogue version in effect at the epoch's start. A catalogue
  version set during the week therefore voids that week's earlier submissions until the agents
  submit again.
- One region's `submitCurations` measured about 63k gas on a mainnet fork
  (`test_fork_submitCurations`).

### Reports

- `packages/curator` (`varada-curator` CLI) covers the agent's side: `pool` lists a bucket's
  catalogue entries, `template` prints an empty report, `build` validates a report and builds the
  pick trees, `publish` uploads it, `submit` sends `submitCurations`, and `give` sends a vault gift.
  Transactions and signatures go through the 1Claw signer (`--dry-run` prints the transaction
  instead).
- A report (`ReportSchema`, `schema: "varada.curation/v1"`) names the category, epoch and
  catalogue version, has a title and newsletter introduction, and per region: the urgency weight,
  a summary, the week's events with sources, up to 32 ranked picks (org id, catalogue index, name,
  score 0-100, reasons, sources) and the region's newsletter. A region without picks has weight 0.
  `build` refuses any pick whose catalogue entry is a different org, and hashes the canonical
  (sorted-key) JSON of the report.
- `publish` signs the report hash (EIP-191) and posts the report to the publisher's
  `POST /agents/reports` with an `x-curator-signature` header. The publisher validates the schema,
  rebuilds the pick trees itself (uploaded trees are never trusted), requires the signature to
  recover to the active signer of the report's category in `CuratorRegistry`, and only then
  uploads `{ report, regions }` to Swarm. The returned reference is the `reportRef` the agent
  submits. Reports are limited to `MAX_REPORT_BYTES` (512 KiB by default) and the route is rate
  limited. Catalogue membership is not checked there; the governor checks it at ballot time.
- The indexer follows the registry and vault events and reads reports from the Swarm gateway
  (`/bzz/<ref>/`). A report region is `verified` when its tree has the root and count the agent
  submitted on chain. Free routes: `/api/agents` (every agent, with totals and latest report),
  `/api/agents/:label` (profile, totals, reports, latest curations, credited donations, gifts),
  `/api/agents/:label/reports/:epoch` and `/api/agents/:label/picks/:epoch/:region` (pick leaves
  with proofs, what `prepareCuratedBallot` needs; 404 `report_mismatch` when the report's root is
  not the one on chain).

### Agent vaults

- `AgentVault` holds USDC. Anyone can `donate(amount, credit)`; `credit` opts in to being named
  (see [PRIVACY.md](PRIVACY.md)). Plain transfers add to the balance without a `Donated` event.
- `give(regionBit, orgId, catalogIndex, proof, amount)` is the only way out. It needs the agent's
  current signer, an unpaused vault, an org that is an entry of the agent's own
  `(category, region)` bucket in the latest catalogue version (Merkle proof) and is not blocked in
  `CauseRegistry`, and room under `maxGivePerEpoch` (the total for the current epoch across all
  regions; zero, the default, allows no gifts). The gift goes through the Endaoment factory
  (`deployOrgAndDonate` for an org without a contract yet, the org's `donate` otherwise), checks
  the org's computed address and clears the allowance. A gift need not be one of the agent's picks.
- There is no withdrawal, no arbitrary call and no owner of its own. The platform (the registry's
  owner) sets the per-epoch cap and can pause gifts. A vault gives only while its agent is
  active (`setActive`). Replacing the signer moves gift rights and the
  ERC-1271 check to the new key at once.

### Runtime and web

- Each agent runs as a weekly Claude scheduled cloud routine, staggered across the day before the
  epoch starts. The routine does the research and writing; every report signature and transaction
  goes through the agent's 1Claw key, whose 1Claw policies allow only the registry and the agent's
  own vault as destinations, zero value, a small daily transaction count, simulation first, and
  human approval for gifts above a USD threshold. News text is untrusted data, never instructions.
- A manipulated or compromised agent can, each epoch until it is paused, fill its buckets with
  bad picks and, by inflating its weight, take curated slots from other agents' buckets and from
  rotation on every token whose focus includes its buckets (holders still vote). It can also give
  up to the per-epoch cap to in-bucket orgs every epoch. Pausing the agent and its vault stops
  both.
- The web app has static pages at `/agent/`, `/agent/<label>/` and `/agent/<label>/<region>/`, and
  `<label>.agent.varada.eth.limo` serves the agent's page: agent names share the site contenthash,
  and the hostname selects the page.

## x402 paid data

The indexer sells packaged curator and catalogue data over x402 (version 2, `exact` scheme, USDC)
under `/x402/v1`. It is off unless `X402_ENABLED` is set; when off, every `/x402` path answers 404.

| Route | Default price | Contents |
|---|---|---|
| `GET /x402/v1/rankings/:label/:region` | $0.01 | The latest report's ranking for one cause and region: ranked picks with scores, reasons and sources, the week's events, and whether it is verified against the chain. |
| `GET /x402/v1/history/:label` | $0.10 | Every published ranking for one cause, all regions, newest first (`limit` 1-260, default 52). |
| `GET /x402/v1/newsletters/:label` | $0.02 | The newsletter archive for one agent (`limit` as above). |
| `GET /x402/v1/catalog/export` | $0.50 | The classified catalogue, filterable by `category` and `region`, paged (`offset`, `limit` up to 5,000). |

- `GET /x402/v1` is free: the price list with each route's payment options, and the free routes.
- Each route accepts USDC on Base (`eip155:8453`) first, then on Ethereum mainnet (`eip155:1`).
  Base payments are settled by Coinbase CDP's facilitator (`CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`,
  or another facilitator at `X402_BASE_FACILITATOR_URL`). CDP does not settle on Ethereum
  mainnet, so mainnet payments go to the publisher's own facilitator (`X402_MAINNET_FACILITATOR_URL`
  and a bearer token); a mainnet payee without a facilitator URL is a configuration error.
- `payTo` is always a platform treasury (`X402_BASE_PAY_TO`, `X402_MAINNET_PAY_TO`). No x402
  revenue goes to agents or vaults.
- Prices are USD decimal strings (`X402_PRICE_RANKINGS`, `X402_PRICE_HISTORY`,
  `X402_PRICE_CATALOG`, `X402_PRICE_NEWSLETTERS`). On mainnet the price is
  `max(price, X402_MAINNET_MIN_PRICE)` ($0.50 by default) so a settlement's gas is covered.
  Payments time out after 120 seconds on Base and 300 on mainnet.
- The mainnet facilitator (`/x402/supported`, `/x402/verify`, `/x402/settle` on the publisher,
  enabled by `X402_FACILITATOR_ENABLED`) answers only the indexer's bearer token, only the
  `exact` scheme on its configured network, and only requirements whose `payTo` is
  `X402_FACILITATOR_PAY_TO`, because it pays the gas. It settles EIP-3009
  `transferWithAuthorization` on USDC with simulation first; smart-wallet deployment (ERC-6492) is
  disabled. The settlement key is a 1Claw key whose policy allows only the USDC contract, and the
  signer wrapper refuses any call other than `transferWithAuthorization` on USDC as well. A local
  key is accepted for development and fork tests only.
- A handler that answers 4xx or 5xx (unknown agent or region, no report, catalogue unavailable)
  cancels the payment, so a buyer is never charged for a miss. Paid responses are
  `Cache-Control: private, no-store`; CORS exposes `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`.
- What stays free: `/api/agents/*` (agents, reports one epoch at a time, picks with proofs) and
  `/api/catalog/*`. The dApp and anyone checking a ballot need these. The paid routes sell
  convenience and depth over the same public data: ranked lists, the full history, the newsletter
  archive and the classified catalogue as one export.

## Arkiv mirror

`services/publisher` reconciles the indexer's view of tokens and causes into Arkiv entities
(`varada.token` core records made read-only with burned ownership, `varada.token-profile` records
owned by the platform key and patched when records change on mainnet, `varada.cause` records) so
other chains and apps can query the token list. Since schema version 2 the core record carries the
token's cause focus: `causeCategory` and `causeRegion` hold comma-wrapped slug lists
(`,hunger,children-youth,`, or `*` for every category or region) so one cause or region can be
matched with a glob, next to the raw `categoryMask` and `regionMask`. Readers must check `$creator` equals the platform
address; the schema tag alone is spoofable. Entities expire after at most 182 days, so the mirror
also extends them. Mainnet remains the source of truth.

## Endaoment integration

Causes are sourced from Endaoment. `packages/endaoment-client` wraps the organization search API
with typed responses, runtime validation, pagination, retries and an injectable cache. Image URLs in
API responses are ignored.

### Cause catalogue

Every compliant Endaoment org with a mainnet address is eligible, without a transaction per org:

1. **Harvest** (`varada-catalog harvest`): the search API is crawled one NTEE major group at a time
   (about 250k orgs in November 2026), checkpointed and resumable. Endaoment bans an IP for about
   ten minutes after a 429, so the crawl is throttled and backs off in minutes; for the full crawl,
   ask Endaoment for a workload-specific rate limit.
2. **Classify** (`varada-catalog build`): the shared taxonomy (`packages/sdk/src/catalog.ts`, 21
   categories and 8 regions) maps specific NTEE codes to categories. Name and description keywords
   classify orgs whose code is missing, unclassified (`Z`), major-group-only or international
   (`Q*`), which covers most non-US orgs. A few high-precision phrases apply to every org whatever
   its code: "innocence project", "wrongful conviction" or "exoneration" place an org in Justice &
   the wrongly accused even when it is filed as civil rights or left unclassified. Regions come from the HQ country; international (`Q*`)
   orgs also get Global and any region their text names. Endaoment only reports an org's HQ, not
   where it works, so `packages/cause-catalog/region-overrides.json` holds curated corrections.
   Orgs nothing places land in `other`.
3. **Tree**: an org appears once in every `category x region` bucket it belongs to, ordered by org
   id; leaves are OpenZeppelin standard-tree leaves of `(uint16 bucket, uint32 index, bytes32 orgId)`.
4. **Publish**: the snapshot (`catalog.json`, `orgs.jsonl`, `tree.json`) is uploaded to Swarm
   (`varada-catalog publish`), and the owner signs `CauseCatalog.setVersion(root, bucketSizes,
   swarmRef)` (`varada-catalog calldata` prints it; the keeper key never sets roots). The indexer
   loads the snapshot (`CATALOG_SOURCE`) and serves `/api/catalog`, `/search`, `/pool`, `/entries`
   (with proofs), `/causes` and `/orgs/:id`.

Only the winner of an epoch is written to `CauseRegistry`, with the address the Endaoment factory
computes for its org id, which the distributor checks again before paying. The registry owner can
block any org (`blockOrg`): a blocked org is skipped by rotation, cannot be pinned and is never
reactivated by materialization. When a new catalogue version drops an org, block it too.

## Hosting model

There is no web server. The frontend is a static export published to Ethereum Swarm and reached
through ENS: `varada.eth` and every `<label>.varada.eth` resolve to the same contenthash, a Swarm
feed manifest that the publish tool points at the latest release. The always-on services are the
indexer with its Postgres database, the Bee node with its gateway (uploads), and the publisher, all
on AWS.

```
browser --ENS name--> gateway (eth.limo, bzz.link) --contenthash (feed manifest)--> Swarm feed --> release manifest --> static files
   |     (hostname label -> token page; `varada.com/<label>` for the plain-DNS deployment)
   |--HTTPS JSON + SSE--> indexer (ALB -> ECS Fargate) --> Postgres
   |--HTTPS multipart----> publisher (uploads: logo, metadata) --> swarm-gateway --> Bee light node
   |--JSON-RPC (anon-rpc transports)--> Ethereum node   (chain reads fallback, and all wallet writes)
```

### Static frontend

- `apps/web` uses `output: "export"`. Every route is pre-rendered; the token page is a single
  static route that reads the address from the query string, so no route depends on a server.
- All asset references are relative so the same files work under a subdomain gateway and a
  `/bzz/<ref>/` path gateway. Binary files ship only as optimised assets under `assets/`
  (`pnpm --filter @varada/web assets` writes them to `public/assets/` from `apps/web/assets-src/`,
  whose originals are stored in Git LFS; run `git lfs install` and `git lfs pull` before regenerating):
  `.webp`, `.avif`, `.svg`, `.woff2` or `.png`, at most 400 KB each (100 KB for `.png`) and 5 MB in
  total. `verify:export` and the publish tool both enforce this budget and reject binaries anywhere
  else.
- Large or growing art sets (stock logos, later art packs) stay out of the bundle. The same script
  builds them into `apps/web/packs/<name>/` (not tracked) with an `index.json`;
  `varada-publish upload-pack --dir apps/web/packs/<name>` uploads each once as its own Swarm
  collection, and the app loads it from `<swarmGatewayUrl>/bzz/<ref>/` like token logos, using the
  reference in config.json `assetPacks` (`NEXT_PUBLIC_STOCK_LOGOS_REF` for stocks). Packs have only
  the per-file limit and are not re-uploaded with each site release.
- `verify:export` expands dynamic segments against the built directories (at least one per level,
  each with an `index.html`) and requires `agent/<ensLabel>/` and `agent/<ensLabel>/<region>/` for
  every curator agent and region, read from the SDK's `catalog.ts`, with nothing extra under
  `agent/`.
- Runtime settings (indexer URLs, RPC URL, chain id, contract addresses) come from `config.json` in
  the bundle, with build-time defaults from `NEXT_PUBLIC_*`. They are public values; no secrets.
  Changing indexer URLs therefore needs a new Swarm reference and a contenthash update.
- Swarm content is immutable per reference. A release is: build, validate, upload, append the new
  reference to the site feed (`varada-publish feed-update`). The contenthash points at the feed
  manifest and does not change. The previous reference stays addressable while its stamp lasts.

### Swarm and ENS contenthash

- `packages/publish` validates the export, estimates stamp depth and cost, uploads through a Bee
  node (only with `--execute`), and encodes the reference as an ENS contenthash.
- Encoding is ENSIP-7 / EIP-1577 for Swarm: `0xe40101fa011b20` followed by the 32-byte reference
  (swarm-ns, CIDv1, swarm-manifest, keccak-256, 32 bytes). The tool prints the exact calldata, either
  `TokenProfileRegistry.setDefaultContenthash(bytes)` for the Varada resolver or
  `setContenthash(bytes32,bytes)` for a standard resolver; it never signs or sends it.
- Postage stamps (xBZZ on Gnosis Chain) and the ENS transaction are paid by the operator. Content
  expires when its stamp does, so the batch must be topped up.
- The `publish-swarm` workflow only builds, validates and attaches the export as a build artifact.
  It holds no keys, stamp or ENS credentials; upload and the contenthash update are manual.

### Indexer API

The indexer exposes JSON over HTTPS with CORS, cursor pagination and bigint values as decimal
strings: `/health`, `/api/tokens` (rows now carry `name`, `symbol` and the ENS profile columns
`label`, `controller`, `editor`, `logoRef`, `suppressed`), `/api/tokens/:address`
(plus `profile` with text records, `shortlist` (pinned causes) and `focus`), `/api/tokens/by-label/:label`,
`/api/activity` (filterable, newest first; kinds include `token_registered`, `profile_updated`,
`epoch_opened`, `epoch_closed`, `takeover_proposed`, `takeover_executed`, `tally_submitted`, `live_donation`),
`/api/activity/stream` (Server-Sent Events with `Last-Event-ID` resume), `/api/causes`,
`/api/causes/search` (cached server-side proxy of Endaoment search, never returning image URLs),
`/api/epochs/:token[/:epoch]` (with the frozen `options`, the scheme `poll` state and counts, `start`,
`end`, `snapshot`; the single-epoch route also returns `pinnedCount`, `curatedDrawn` and
`curatedCount` (curated picks checked and placed, from `CuratedPicksUsed`; null until the ballot is
prepared, 0 when it was prepared without any), `optionOrgIds` (the options' catalogue org ids from
`BallotPrepared`, which the keeper checks against `ballotCommitment` before finalizing) and
`optionSources`, one entry per option in ballot order: `pinned`, `curated` or `rotation`, or null
until the ballot is prepared), `/api/takeovers/:token[/:id]` (proposals with a derived `state`),
`/api/polls/:governor/:token/:scope` and `/api/stats` (USDC totals, 6 decimals). There is no route
keyed by voter address.

### Data flow

1. Contracts emit events on mainnet. The indexer ingests them over RPC into Postgres.
2. The browser loads the static bundle from Swarm, reads `config.json`, and calls the indexer for
   lists, activity, causes and stats, and subscribes to the activity stream.
3. If the indexer is unreachable, the app falls back to reading the chain directly through
   wagmi/viem for the core views, using the configured RPC.
4. Writes (launch, vote, donate) are transactions from the user's wallet; the indexer is read-only
   from the browser's point of view.
5. The cause picker queries the indexer's Endaoment proxy, so the browser never calls Endaoment or
   loads its images.

### CORS and gateways

The indexer only answers listed origins (`indexerCorsOrigins` in CDK, `CORS_ALLOWED_ORIGINS` in the
service). A Swarm site is served from the origin of whichever gateway is used, for example an
ENS-gateway hostname for the name, so each gateway origin you intend to support must be listed.
Production does not allow `*`. The API is rate limited per client.

### Intentionally not decentralised yet

- The indexer is a single operator-run AWS service. It is a convenience and performance layer, not
  a source of truth: the chain is, and the frontend can read it directly. Anyone can run their own
  indexer and point `config.json` at it (multiple indexer URLs are tried in order).
- The ENS name is controlled by one account, which decides what the contenthash points to.
- Postage stamps are bought and renewed by the operator; availability depends on them.
- Gateways used to open the ENS name are third-party; users who run their own Bee node and ENS
  resolution avoid them.
- RPC access defaults to one configured endpoint.
- The Endaoment search proxy is operated by the indexer host.
- Curator agents are platform-run: one account's scheduled routines and one key custodian (1Claw),
  and only the registry owner can register or replace a signer. Pins and rotation keep every
  ballot working without them.
- Mainnet x402 settlement runs through the platform's own facilitator in the publisher.

## AWS topology

Defined in `infra/` with CDK (TypeScript). The indexer, the Bee node with its gateway and the
publisher live on AWS; there are no web hosting resources (no S3 site bucket, CloudFront or web
service).

| Stack | Resources |
|---|---|
| `NetworkStack` | VPC across two availability zones with a no-NAT default network and optional private egress. |
| `DataStack` | PostgreSQL for the indexer: RDS (dev default) or Aurora Serverless v2 (prod default), credentials in Secrets Manager. |
| `IndexerStack` | ECR repository, ECS Fargate service behind an Application Load Balancer that must terminate HTTPS, autoscaling, log groups. |
| `SwarmStack` | Bee light node (`ethersphere/bee`) with its data directory on EFS plus `swarm-gateway` (public reads, authenticated uploads) behind an HTTPS ALB. |
| `PublisherStack` | ECR repository and Fargate service for `services/publisher` behind an HTTPS ALB. |
| `ObservabilityStack` | Alarms and a dashboard for the services and database. |

Stack ids are `Varada-<env>-<Name>`. Configuration comes from CDK context and Secrets Manager; no
secrets live in code, and IAM is least-privilege. `cdk synth` runs offline in CI with dummy context.

## CI and deployment

- `.github/workflows/ci.yml`: Foundry format, build and test; pnpm install, typecheck and test; a
  static export job (publish tool tests, web tests, export build, export validation, upload dry run
  that sends nothing); an infra job (typecheck, jest, `cdk synth` with dummy context and no AWS
  credentials); and an asset placement check: binary files are tracked only in
  `apps/web/assets-src/` (originals, never published) and `apps/web/public/assets/` (optimised
  copies from `pnpm --filter @varada/web assets`, the only art that reaches Swarm).
- `.github/workflows/deploy-aws.yml`: manual dispatch. Deploys only the network, data, indexer and
  observability stacks for a chosen environment name. It assumes an AWS role through GitHub OIDC
  (no long-lived keys) and needs the repository variables `AWS_ACCOUNT_ID`, `AWS_REGION` and
  `AWS_DEPLOY_ROLE_NAME`, plus non-secret settings such as the indexer domain or certificate,
  allowed CORS origins and contract addresses.
- `.github/workflows/publish-swarm.yml`: manual dispatch. Builds and validates the static export and
  attaches it (with the dry-run report) as a build artifact. It has read-only repository access, no
  secrets, and never uploads to Swarm or touches ENS.
