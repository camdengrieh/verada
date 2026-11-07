# Timing

Every duration of the epoch cycle is owner-set on chain. Nothing off chain (SDK, indexer, keeper,
web app, curator tooling) may assume 7 days, a Thursday, or `zero + n * length`: boundaries come
from the contracts (`epochStart`, `votingOpensAt`, `epochScheduleFor`) or from the indexer's copy of
their events.

This page lists every parameter, how it is set and when a change takes effect, the values of the
first production test cycle, and what the web app, the indexer and the keeper do with them. The
Solidity source is the authority (`contracts/src/EpochGovernor.sol`, `FeeVault.sol`,
`TakeoverGovernor.sol`, `RotationGovernor.sol`); the scripts are `script/Deploy.s.sol` (sets the
schedule and the settle grace at deploy) and `script/ConfigureTiming.s.sol` (owner, any time).

## The cycle

An epoch has three phases:

| Phase | From to | What happens |
| --- | --- | --- |
| TRADING | `epochStart(e)` to `votingOpensAt(e)` | Ballots are refused (`VotingNotOpen(epoch, opensAt)`). Weights cannot change: they are fixed at the snapshot one second before `epochStart(e)`, over the hold window before it, so trading in this phase counts from a later epoch. |
| VOTING | `votingOpensAt(e)` to `epochStart(e + 1)` | Ballots are accepted (the last `votingWindow` seconds of the epoch). A ballot also needs the epoch opened (`openEpoch` or `prepareBallot`). |
| TALLY | after `epochStart(e + 1)` | The keeper (or anyone) closes the poll, the tally is decrypted and submitted, `finalizeEpoch`, `FeeVault.settle`, `DonationDistributor.distribute`. Bounded by the graces below. |

`votingOpensAt(e) = epochStart(e + 1) - votingWindow(e)`. With the default `votingWindow ==
length`, `votingOpensAt == epochStart`: there is no trading phase and voting is open throughout.

First production test cycle (45 minutes): 30 minutes of TRADING, then 15 minutes of VOTING, a hold
window of 30 minutes, graces of 30 min (tally), 45 min (settle), 5 min (curation, launch snapshot).

## Parameters

All bounds are `MIN_DURATION = 5 minutes` to `MAX_DURATION = 30 days` unless stated. All setters are
owner only (`Ownable2Step`). Values are seconds on chain.

### EpochGovernor

| Parameter | Getter | Setter | Default | Bounds | Takes effect | Prod-test value |
| --- | --- | --- | --- | --- | --- | --- |
| Epoch length | `epochLength()` (current epoch), `epochScheduleFor(e)` | `setEpochSchedule(length, votingWindow, holdWindow)` | 7 days | `MIN_DURATION`..`MAX_DURATION` | From the NEXT epoch (see below) | 2700 (45 min) |
| Voting window | `votingWindow()`, `epochScheduleFor(e)`, `votingOpensAt(e)` | `setEpochSchedule` | 7 days (the whole epoch) | `MIN_DURATION`..`length` | From the next epoch | 900 (15 min) |
| Hold window | `holdWindow()`, `epochScheduleFor(e)`, `holdFromFor(token, e)` | `setEpochSchedule` | 7 days | `MIN_DURATION`..`MAX_DURATION` | From the next epoch | 1800 (30 min, the trading phase) |
| Tally grace | `tallyGrace()` | `setTallyGrace(grace)` | 14 days | `MIN_DURATION`..`MAX_DURATION` | At once | 1800 (30 min) |
| Launch snapshot delay | `launchSnapshotDelay()` | `setLaunchSnapshotDelay(delay)` | 1 day | `MIN_DURATION`..`MAX_DURATION` | For tokens registered afterwards (a token's launch hold window is fixed at registration) | 300 (5 min) |
| Curation grace | `curationGrace()` | `setCurationGrace(grace)` | 6 hours | `MIN_DURATION`..`MAX_DURATION` | At once | 300 (5 min) |

Events: `EpochScheduleSet(startEpoch, startTime, length, votingWindow, holdWindow)`,
`TallyGraceSet(grace)`, `LaunchSnapshotDelaySet(delay)`, `CurationGraceSet(grace)`. Errors:
`DurationOutOfRange(value, min, max)`, `VotingNotOpen(epoch, opensAt)`.

What each does:

- **Schedule** (`length`, `votingWindow`, `holdWindow`): described under "Schedule semantics".
- **Tally grace**: how long after an epoch's end its final tally may still arrive. Past it, an epoch
  with ballots but no valid final tally finalizes to the default cause (`TallyTimeoutFallbackApplied`,
  the votes are discarded). A longer grace only delays that fallback.
- **Launch snapshot delay**: the wait after a token's registration before its launch snapshot (shorter
  when the launch epoch ends sooner: then halfway to its end).
- **Curation grace**: kept for compatibility. `requestCurationSkip` always reverts and a ballot with
  usable curator picks always needs its curated draws, so this value no longer changes behaviour.

### FeeVault

| Parameter | Getter | Setter | Default | Bounds | Takes effect | Prod-test value |
| --- | --- | --- | --- | --- | --- | --- |
| Settle grace | `settleGrace()` | `setSettleGrace(grace)` | 7 days | `MIN_SETTLE_GRACE` 5 min to `MAX_SETTLE_GRACE` 30 days | At once | 2700 (45 min; set by `Deploy.s.sol`) |

Event `SettleGraceSet(grace)`, error `SettleGraceOutOfRange(grace, min, max)`. `settle(token, epoch)`
reverts `FeesPending` while fees earned in that epoch are still outside the vault (uncollected LP
fees, held fees whose route fails), until `settleGrace` after the epoch's end; after it, it pays what
is there and later fees go to a later epoch.

### Removed constants

`EpochGovernor.EPOCH_LENGTH`, `HOLD_WINDOW`, `TALLY_GRACE`, `CURATION_GRACE` and
`LAUNCH_SNAPSHOT_DELAY`, and `FeeVault.SETTLE_GRACE`, no longer exist (removed, not aliased):

| Was | Now |
| --- | --- |
| `EPOCH_LENGTH()` | `epochLength()`, `epochScheduleFor(epoch)`, or `epochStart(epoch + 1) - epochStart(epoch)` |
| `HOLD_WINDOW()` | `holdWindow()`, `epochScheduleFor(epoch)` |
| `TALLY_GRACE()` | `tallyGrace()` |
| `CURATION_GRACE()` | `curationGrace()` |
| `LAUNCH_SNAPSHOT_DELAY()` | `launchSnapshotDelay()` |
| `FeeVault.SETTLE_GRACE()` | `FeeVault.settleGrace()` |

### Other governors (per-deployment parameters, not epoch schedule)

| Parameter | Where | Bounds | Notes |
| --- | --- | --- | --- |
| Takeover `votingPeriod`, `executionWindow`, `lookback` | `TakeoverGovernor.Params` (`setParams`) | period 5 min to 30 days; execution window from 5 min; lookback 5 min to 90 days | Floors were 1 day / 2 days / 1 day. Deploy defaults are unchanged (7 days each, cooldown and minimum token age 14 days). |
| Rotation `votingPeriod`, `executionWindow` | `RotationGovernor.Params` (`setParams`) | voting 5 min to 7 days; execution window 5 min to 14 days | Floors were 1 hour. |

Round and proposal times are chain values (`voteEnd`, `executionDeadline`, takeover `end`): the web
app and the keeper read them, nothing derives them from the epoch.

## Schedule semantics

The governor keeps a list of segments, `{startEpoch, startTime, length, votingWindow, holdWindow}`.
Epoch `e` belongs to the last segment with `startEpoch <= e`:

```
epochStart(e)    = seg.startTime + (e - seg.startEpoch) * seg.length
votingOpensAt(e) = seg.startTime + (e + 1 - seg.startEpoch) * seg.length - seg.votingWindow
epochEnd(e)      = epochStart(e + 1)          // the next epoch's start, correct across a change
```

`epochStart(epoch)` is the only correct source. After a schedule change, `zero + n * length` is wrong
for every later epoch.

- **After the first token registered**, `setEpochSchedule` adds a segment starting at the next epoch's
  start. The current and every earlier epoch keep their start, end, voting window and hold window. A
  change made while that segment is still pending replaces it (same `startEpoch`).
- **Before any token registered** no epoch holds state, so `setEpochSchedule` re-anchors epoch zero
  (`startEpoch` 0, `startTime = epochZeroStart`) and the first cycle can already be short. This is how
  `Deploy.s.sol` sets the 45 minute cycle. `epochZeroStart` is the Thursday 00:00 UTC at or before the
  deployment, so with 45 minute epochs the first epoch numbers are in the hundreds: epoch 0 started
  up to a week before launch. Epoch numbers shown in the web app and keeper logs are therefore not
  small.
- **`epochZeroStart`** is immutable and never changes. It is only the start of segment 0.
- **The rotation ballot builder** (`CatalogBallotBuilder.setCurators(registry, zero, length)`) caches
  the epoch length once, in `RotationGovernor.setCuratorRegistry`. `Deploy.s.sol` sets the schedule
  before that call so it caches the 45 minute length; later schedule changes do not reach it.
- **Weights** are the lowest vote checkpoint over `[holdFromFor(token, e), snapshotFor(token, e)]`,
  `snapshotFor` being one second before `epochStart(e)` (or the token's launch snapshot in its launch
  epoch). The hold window is the segment's `holdWindow`.

## Who reads what

### SDK (`packages/sdk/src/epoch.ts`)

Pure math over an `EpochSchedule` (segments): `epochAt`, `epochStart`, `epochEnd`, `votingOpensAt`,
`epochWindowOf`, `epochPhase`, `epochCountdown`, `applyScheduleChange` (mirrors `setEpochSchedule`).
Chain reads: `readEpochWindow(client, governor, epoch?)` reads `epochStart(e)`, `epochStart(e + 1)`,
`votingOpensAt(e)` and `epochScheduleFor(e)`. A governor without the schedule getters (reverts, or no
data) is read as one with voting open all epoch; a network failure is never read that way.
`createDonationReader` reads `tallyGrace()` and `settleGrace()` (falling back to the old constants
only on a revert). `DEFAULT_EPOCH_LENGTH` (7 days) is the constructor default only; `EPOCH_LENGTH`
no longer exists.

### Indexer (`services/indexer`)

- `epoch_schedule` (one row per segment) from `EpochScheduleSet`: segment 0 is the constructor default,
  anchored at `epochZeroStart` read from the chain by the first handler that proves the governor live
  (7 day defaults, `setAt` null) and overwritten by an `EpochScheduleSet` for epoch 0. Later events add
  a segment or replace the one with the same `startEpoch`. A failed `epochZeroStart` read leaves the
  schedule empty until the next event retries; timing fields are then null.
- `timing_setting` from `TallyGraceSet`, `LaunchSnapshotDelaySet`, `CurationGraceSet` and
  `FeeVault.SettleGraceSet` (last value; defaults reported while no setter ran).
- API: `GET /api/epochs/:token/:epoch` adds `votingOpensAt`, `length`, `votingWindow`, `holdWindow` to
  `start`, `end`, `snapshot`; `GET /api/tokens/:address` adds `currentEpoch { epoch, start, end,
  votingOpensAt, length, votingWindow, holdWindow }`; `GET /api/epoch-schedule` returns the segments,
  the current epoch and the graces. All seconds, as strings.
- Reindex after deploying this version (new tables and events): the indexer's schema changed.

### Keeper (`services/publisher`)

Every decision is read from the chain (`currentEpoch`, `epochStart`, per-epoch state), as before. New:
each run reads the schedule (`currentEpoch`, `epochStart`, `votingOpensAt`, `epochScheduleFor`,
`tallyGrace`, and `settleGrace` with `FEE_VAULT_ADDRESS`), logs it (`keeper epoch schedule`, `timing`
in the run summary) and warns once per distinct schedule when its settings do not fit it:

- `KEEPER_INTERVAL_SECONDS` more than half the time before voting opens (the trading phase, or the
  whole epoch when there is none);
- `KEEPER_LOOKBACK_EPOCHS` spanning less than 6 hours, or less than `tallyGrace + epochLength` /
  `settleGrace + epochLength`.

Recommended for the 45 minute cycle:

| Variable | Value | Why |
| --- | --- | --- |
| `KEEPER_INTERVAL_SECONDS` | `60` to `120` (default `300` still works) | A ballot can only be opened at a run, and voting opens 30 minutes into the epoch; after the epoch ends the tally steps (close, decrypt, submit, finalize, settle, distribute) finish within a few runs. The backoff base follows a shorter interval. |
| `KEEPER_LOOKBACK_EPOCHS` | `8` or more (6 hours) | The default 4 is 3 hours. An epoch must stay in range until its tally and settle graces have passed. |
| `KEEPER_IDLE_EPOCHS` | `8` or `0` | Counts epochs: the default 2 is 90 minutes of inactivity. |
| `KEEPER_MAX_TX_PER_RUN` | raise with the token count | Every registered token needs a `finalizeEpoch` each epoch (the default cause wins an empty one), so there are many more transactions per hour than with weekly epochs. |

Keep the graces short on the test cycle, or the lookback must span them (a 14 day tally grace is 448
epochs of 45 minutes; the keeper then follows the newest `KEEPER_LOOKBACK_EPOCHS` only and an older
stuck epoch is left to volunteers).

### Web app (`apps/web`)

- The current epoch's window comes from `readEpochWindow` (chain); an epoch's detail from the indexer's
  `start`, `end`, `votingOpensAt` (or, without the indexer, the same chain read). A source without
  `votingOpensAt` (an older indexer) is read as voting open from the start.
- Governance and token pages show the phase of the epoch (Trading, Voting, Tally) with a countdown to
  `votingOpensAt` while trading and to the epoch's end while voting, the real times, and the cycle
  ("Epochs last 45 minutes: 30 minutes of trading, then 15 minutes of voting").
- The vote button is off before voting opens, with the reason "Voting is not open yet. Ballots are
  accepted from <time>; until then holders trade." (the contract would revert `VotingNotOpen`; that
  revert is also named in wallet errors by its selector), off after the end ("Voting has closed"), and
  after the ballot is cast.
- The board counts tokens with a prepared ballot in trading or voting as live; "Voting" and "Trading"
  badges tell them apart.
- The launch wizard says "each epoch" and shows the governor's current length (nothing is promised
  while it cannot be read). "Weekly pool" is now "Epoch pool" in labels (the mode key stays
  `weekly`).
- The takeover card shows `votingPeriod` and `lookback` as read from the chain (minutes, hours or days).
- The donation card shows the real tally grace in the fallback note.

### Curator tooling (`packages/curator`)

`curator status` reads `epochStart(next)` as before (the deadline for mining a curation is the start of
the next epoch, so at most one epoch length away: 45 minutes on the test cycle) and now also reports
`nextEpochLengthSeconds` and `nextEpochVotingOpensAt`. Agents publish one report per epoch; the
`reports` text still says "weekly" in places, and an agent run takes longer than a 45 minute epoch
unless it is scripted.

## Changing the schedule (runbook)

1. Choose values within the bounds. `votingWindow <= length`; `holdWindow` any `MIN_DURATION`..`MAX_DURATION`.
2. `forge script script/ConfigureTiming.s.sol --sig "run()" --rpc-url $ETH_RPC_URL --account <owner> --broadcast`
   with `EPOCH_LENGTH_SECONDS`, `VOTING_WINDOW_SECONDS`, `HOLD_WINDOW_SECONDS`, `TALLY_GRACE_SECONDS`,
   `CURATION_GRACE_SECONDS`, `LAUNCH_SNAPSHOT_DELAY_SECONDS`, `SETTLE_GRACE_SECONDS` as needed. Values
   that already match are skipped. The script runs as the owner of the governor and the vault.
3. A schedule change applies from the next epoch; the current one finishes as it was. Graces apply at
   once (launch snapshot delay: to later registrations).
4. Check: `epochScheduleFor(currentEpoch() + 1)`, then watch `keeper epoch schedule` in the keeper log
   and `GET /api/epoch-schedule` on the indexer.
5. Revisit `KEEPER_INTERVAL_SECONDS`, `KEEPER_LOOKBACK_EPOCHS` and `KEEPER_IDLE_EPOCHS` (see above).
6. Production values are the contracts' defaults: 604800 / 604800 / 604800, tally grace 1209600,
   curation grace 21600, launch snapshot delay 86400, settle grace 604800.

## Limits

- The rotation ballot builder's cached epoch length does not follow later schedule changes.
- The indexer and the web app assume at most one schedule change is pending (the contract guarantees
  it: a pending segment is replaced, never stacked).
- The keeper's idle check and lookback count epochs; their wall-clock span changes with the schedule.
