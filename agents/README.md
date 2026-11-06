# Curator agents: operations

How to provision, schedule, watch and recover the curator agents: ten agents, each running two
related causes, so all twenty causes are curated. What the agents are and
how their picks reach ballots is in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#curator-agents);
what they publish and what that reveals is in [docs/PRIVACY.md](../docs/PRIVACY.md).

Each agent is three things:

- a **1Claw agent** holding its Ethereum key in an HSM, with policies that limit what the key may do
  (the 1Claw Pro plan allows ten agents, hence ten pairs; decision 2026-11-07);
- **two on-chain registrations** in `CuratorRegistry`, one per cause, both with the agent's one
  signer. Each cause keeps its own ERC-8004 identity, `AgentVault` and name
  `<label>.agent.varada.eth`; the contracts check the signer per cause, so nothing on chain changes;
- a **Claude scheduled cloud routine** that starts every day and, every third day, evaluates one of
  its two causes in all regions, alternating (so each cause is curated every 6 days, at least once
  in every 7-day epoch). It drives the `varada-curator` CLI (`packages/curator`), which sends every
  signature and transaction through 1Claw.

## The ten agents

The pairs, day offsets and times are `CURATORS` in `packages/curator/src/curators.ts`; the 1Claw
agent ids and signers are in [`curators.json`](curators.json). `varada-curator curators` prints
the schedule with the next runs, and `varada-curator due --agent <name>` says whether today is a
run day and for which cause.

| Agent | Causes (labels) | Signer | Daily routine (UTC) | Cron (UTC) |
|---|---|---|---|---|
| `relief` | `disaster`, `hunger` | `0x022a78435c5fa6a2a0f5c616732e823eb8def355` | 06:00 | `0 6 * * *` |
| `housing` | `homeless`, `poverty` | `0x09a5614e47bc6dcb59d723fa9edc12eb2452fdaf` | 06:30 | `30 6 * * *` |
| `youth` | `children`, `education` | `0x8a04a428895f71655908b3dea9678d7a43ff273c` | 07:00 | `0 7 * * *` |
| `health` | `disease`, `health` | `0xb4df9e078228f6c38225d8a61df1522d5caaee1c` | 07:30 | `30 7 * * *` |
| `research` | `cancer`, `research` | `0x1fa8fad0e3302be041c44ebbcb07182a0e75b256` | 08:00 | `0 8 * * *` |
| `animals` | `wildlife`, `animals` | `0x26c8eb9e686447231fefbdd14cf1a2eadd11a6ef` | 08:30 | `30 8 * * *` |
| `planet` | `environment`, `water` | `0x89fe096edeea1b9412388f4b3f101ef25fa41e04` | 09:00 | `0 9 * * *` |
| `mind` | `mental-health`, `veterans` | `0xf96103b8945bb64473a1133a0d435b008856ec18` | 09:30 | `30 9 * * *` |
| `rights` | `human-rights`, `women` | `0x8f72f2422e50a0f4c22d880d3132ff271828a35f` | 10:00 | `0 10 * * *` |
| `justice` | `justice`, `refugees` | `0x6932eb18abe7ca1e01e758f0ae7840c8c0488646` | 10:30 | `30 10 * * *` |

Rotation: on UTC day `d` (Unix days), an agent with offset `o` runs when `(d - o) % 3 == 0`, and
evaluates its first cause on even runs (`(d - o) / 3`) and its second on odd ones. Offsets spread
the agents 4/3/3 over the three days.

## The causes

One per category in `packages/sdk/src/catalog.ts` that has an `ensLabel` (every category except
`other`, bit 19). The label is permanent once registered. The agent column says which of the ten agents runs it.

| Bit | Category | Label | Name | Agent |
|---|---|---|---|---|
| 0 | `disaster-relief` | `disaster` | `disaster.agent.varada.eth` | `relief` |
| 1 | `homelessness` | `homeless` | `homeless.agent.varada.eth` | `housing` |
| 2 | `hunger` | `hunger` | `hunger.agent.varada.eth` | `relief` |
| 3 | `children-youth` | `children` | `children.agent.varada.eth` | `youth` |
| 4 | `disease` | `disease` | `disease.agent.varada.eth` | `health` |
| 5 | `cancer-research` | `cancer` | `cancer.agent.varada.eth` | `research` |
| 6 | `endangered-species` | `wildlife` | `wildlife.agent.varada.eth` | `animals` |
| 7 | `animal-welfare` | `animals` | `animals.agent.varada.eth` | `animals` |
| 8 | `environment-climate` | `environment` | `environment.agent.varada.eth` | `planet` |
| 9 | `clean-water` | `water` | `water.agent.varada.eth` | `planet` |
| 10 | `health-care` | `health` | `health.agent.varada.eth` | `health` |
| 11 | `mental-health` | `mental-health` | `mental-health.agent.varada.eth` | `mind` |
| 12 | `medical-research` | `research` | `research.agent.varada.eth` | `research` |
| 13 | `education` | `education` | `education.agent.varada.eth` | `youth` |
| 14 | `refugees` | `refugees` | `refugees.agent.varada.eth` | `justice` |
| 15 | `human-rights` | `human-rights` | `human-rights.agent.varada.eth` | `rights` |
| 16 | `women-girls` | `women` | `women.agent.varada.eth` | `rights` |
| 17 | `poverty` | `poverty` | `poverty.agent.varada.eth` | `housing` |
| 18 | `veterans` | `veterans` | `veterans.agent.varada.eth` | `mind` |
| 20 | `justice` | `justice` | `justice.agent.varada.eth` | `justice` |

Regions (bits 0-7): `africa`, `asia`, `europe`, `middle-east`, `north-america`, `latin-america`,
`oceania`, `global`. Category bit `c` in region `r` is bucket `c * 16 + r`.

## 1. Provision the 1Claw agents

Done on 2026-11-07 (records in [`curators.json`](curators.json)). The ten 1Claw agents are
`varada-<agent>-curator`, each with one server-custody Ethereum key (its signer). Each agent's
one-time API key went straight into the 1Claw vault `varada-curator-api-keys` at
`agents/<agent>/api-key`; no agent can read that vault. The agents themselves may read only the
vault `varada-curators` (non-secret shared config). Never share a key between agents: the publisher
and the vaults identify a cause's agent by its signer, so a shared key would let one agent act for
the other's causes.

Set at creation, for every agent:

- Intents (signing) **off** until the contracts are on mainnet (below).
- Ethereum only (`tx_allowed_chains`), zero value per transaction and per day, at most 5
  transactions a day. A cause runs every 6 days, so a normal run day is one `submitCurations`,
  perhaps a resubmission and a gift or two; 5 is ample (a suggestion, not a measured need).
- Simulation failures and unlisted EIP-712 typed data are denied (`simulation_failure_policy`,
  `typed_data_policy`); unlimited approvals and EIP-7702 are blocked.

Still to do, after the mainnet deploy and registration, in this order:

1. **Raw signing to `deny`** (done 2026-11-07 for all ten). 1Claw ignores `raw_signing_policy` on
   create and leaves it at `allow`; changing it is a guardrail edit that needs the account
   password as `X-Auth-Confirm` (purpose `security.guardrail.edit`). It was set with a PATCH per
   agent from the operator's own terminal. Raw digest signing bypasses every transaction
   guardrail, so check it is still `deny` before turning signing on, and set it on any new agent.
2. **Allowlists.** `tx_to_allowlist`: the `CuratorRegistry` address and the agent's **two**
   `AgentVault`s (known after [registration](#2-register-on-chain)). Allow the ERC-8004 EIP-712
   domain (`ERC8004IdentityRegistry`, version `1`, chain 1, verifying contract
   `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`) for the one-time wallet link per cause, and
   personal_sign (EIP-191) for report signatures. Widening a guardrail goes through 1Claw's
   approval flow.
3. Human approval for gifts above a USD threshold (`tx_approval_policy`). Gifts are USDC (6
   decimals) passed as the `amount` argument of `AgentVault.give`.
4. Turn intents on, then fund each signer with ETH for gas. The signer pays for `submitCurations`
   and gifts; the vaults pay nothing.

`packages/curator` reads `ONECLAW_AGENT_ID` and `ONECLAW_API_KEY`; the routine gets them as in
[Secrets and environment](#secrets-and-environment).

## 2. Register on chain

All of these are `onlyOwner` on `CuratorRegistry`, whose owner is the platform (`OWNER` in
`contracts/script/Deploy.s.sol`; the registry is `Ownable2Step`, so the owner must have accepted
ownership). The deploy script already linked the registry and the governor
(`setCuratorRegistry`, `setGovernor`) and reserved the label `agent` in `TokenProfileRegistry`.
Examples use `cast calldata`, so the owner can send them from any wallet or multisig.

### registerAgent

Twenty calls, one per cause, each with the signer of the cause's agent.
`varada-curator register-calls` prints all twenty (cause, category bit, signer, `agentURI`,
description and the calldata), built from [`curators.json`](curators.json); the `agentURI` is the
cause's ERC-8004 registration file as a `data:` URI (`varada-curator registration --category
<label>` shows it). After registration, set each file's `registrations` entry with
`setAgentURI(categoryBit, <registration --agent-id N --uri>)`. For `relief`
(`disaster`, bit 0, and `hunger`, bit 2):

```sh
cast calldata "registerAgent(uint8,string,address,string,string)" \
  0 disaster 0x022a78435c5fa6a2a0f5c616732e823eb8def355 "<agentURI>" "<description>"
cast calldata "registerAgent(uint8,string,address,string,string)" \
  2 hunger   0x022a78435c5fa6a2a0f5c616732e823eb8def355 "<agentURI>" "<description>"
```

- `categoryBit` and `label` must match the cause table above (`ensLabel` in the SDK); the label is
  validated and can never change. The signer must be the one in [`curators.json`](curators.json)
  for the cause's agent. The registry does not require distinct signers; it checks the signer per
  cause, so the same key submits for both causes and gives from both vaults.
- `agentURI` is the agent's ERC-8004 registration URI; `description` becomes the ENS `description`
  text record. Both can be changed later (`setAgentURI`, `setDescription`).
- The call deploys the `AgentVault` (CREATE2, salt = category bit), registers the ERC-8004
  identity (owned by the registry) and emits `AgentRegistered(categoryBit, agentId, label, signer,
  vault)`. Read the vault from the event or `agentOf(categoryBit)`, then add it to the agent's
  1Claw `tx_to_allowlist` (each agent lists both of its vaults).

### linkAgentWallet

Makes the vault the identity's ERC-8004 agent wallet. The signer signs EIP-712 typed data in the
Identity Registry's domain:

- domain: `name "ERC8004IdentityRegistry"`, `version "1"`, `chainId 1`,
  `verifyingContract 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`;
- type: `AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)`;
- values: the agent id, `newWallet` = the vault, `owner` = the `CuratorRegistry` address, and a
  `deadline` **at most 5 minutes ahead**.

Then the owner sends, inside that window:

```sh
cast calldata "linkAgentWallet(uint8,uint256,bytes)" 2 <deadline> <signature>
```

The Identity Registry checks the signature through the vault's ERC-1271 `isValidSignature`, which
accepts the agent's current signer only for the Identity Registry, only during this call, and
never while the vault is paused. Any other signature check (a USDC permit, for example) fails. Check `getAgentWallet(agentId)` on the Identity Registry
returns the vault. With a multisig owner, have the transaction ready to execute before the signer
signs, because of the 5-minute deadline.

### setMaxGivePerEpoch

On the agent's `AgentVault`, callable by the registry owner:

```sh
cast calldata "setMaxGivePerEpoch(uint256)" 500000000   # 500 USDC per epoch
```

The cap is the total the agent may give in one epoch across all regions, in USDC units
(6 decimals). It starts at zero, which allows no gifts. It is the hard limit on what a misused key
could move in a week; 1Claw's approval threshold sits below it.

### setSigner, setActive

```sh
cast calldata "setSigner(uint8,address)" 2 0x<new signer>
cast calldata "setActive(uint8,bool)" 2 false
```

- `setSigner` takes effect at once for submissions, gifts, report uploads and the vault's ERC-1271
  check. The ERC-8004 wallet stays the vault, so no new wallet link is needed.
- `setActive(false)` pauses the agent: `submitCurations` reverts, the governor ignores its
  curations (including one already submitted for the next epoch, if the ballot is not yet
  prepared), and the publisher answers `agent_inactive`. It does **not** stop gifts; use
  `AgentVault.setPaused(true)` for that.

## 3. Timing

From `EpochGovernor`:

- `EPOCH_LENGTH` is 7 days. `epochZeroStart` is `floor(deployTime / 7 days) * 7 days`, a Thursday
  00:00 UTC (Unix time 0 was a Thursday). Epoch `k` starts at `epochZeroStart + k * 604800`, so
  **every epoch starts on a Thursday at 00:00 UTC**.
- `CuratorRegistry.submitCurations` accepts only `epoch == currentEpoch() + 1`. Curations for the
  epoch starting next Thursday can be sent any time during the current epoch, and replaced until
  that Thursday 00:00 UTC.
- The keeper opens ballots shortly after Thursday 00:00 UTC (it runs every
  `KEEPER_INTERVAL_SECONDS`, 300 by default). By then the report must be on Swarm, the submission
  mined, and both indexed. If they are not, the keeper fails with `CuratedPicksUnavailable` and
  keeps retrying (backoff from 5 minutes, doubling, at most 15 minutes), and sends nothing. There
  is no grace and no rotation fallback: both governors take no ballot or round without the
  published picks of a usable curation (`requestCurationSkip` always reverts). Picks that turn up
  later are used on the next retry, so a quiet token whose ballot is opened late in the week
  still gets your picks. If they never turn up, the platform voids that epoch's curation
  (`CuratorRegistry.voidCurations`, see the runbook below) and rotation fills the ballots.
- A curation counts only under the catalogue version in effect at the epoch's start: the last
  `CauseCatalog.setVersion` before Thursday 00:00 UTC. Runs happen on every day of the week, so
  publish catalogue versions right after an epoch starts (Thursday morning, before the 06:00 UTC
  routine). A version set later voids every submission already made for the next epoch; rerun
  those causes before Thursday 00:00 UTC (see [Reruns](#reruns)).
- Gift caps (`givenIn[epoch]`) reset at each epoch start.

Schedule: **every day, one routine every 30 minutes from 06:00 UTC, the last at 10:30 UTC**
([table](#the-ten-agents)). Each routine first runs `varada-curator due --agent <name>`; on two days
out of three it has nothing to do and stops. On its run day it evaluates one cause in all eight
regions and submits for `currentEpoch() + 1`. Each cause therefore runs every 6 days, which puts
at least one run of every cause inside every 7-day epoch; when two land in the same epoch, the
second replaces the first. The latest a run can start is Wednesday 10:30 UTC, 13.5 hours before
the epoch starts, which leaves room to rerun a failed routine. About 3-4 real runs a day (24 a
week; 70 routine starts including the ones that stop at once) is far below the 100 runs per hour
per account limit; the stagger is for 1Claw, the publisher (its `/agents/*` routes are rate
limited per client IP) and the RPC behind them.

A failed run is not retried by the rotation: the cause's next run is 6 days later. If the failed
run was the cause's only one in the epoch, the next epoch has no curation from it and its buckets
fall back to the other agents' picks and rotation. Rerun it by hand the same day.

### Reruns

To run a cause outside its rotation (a failed run, or a catalogue version set mid-epoch), start
the agent's routine by hand with the prompt `run the curator skill for agent <name>, cause
<label> (rerun)`. The skill then skips the `due` check for that run. It replaces the cause's
curation for the next epoch.

Read the numbers a routine needs:

```sh
cast call $EPOCH_GOVERNOR "currentEpoch()(uint256)"            # submit for this + 1
cast call $EPOCH_GOVERNOR "epochStart(uint256)(uint256)" <n>   # unix start of epoch n
cast call $CAUSE_CATALOG  "latestVersion()(uint32)"            # --catalog-version
```

## 4. Create the routines

One routine per agent (ten), on the repository, daily at its cron time, with the prompt
`run the curator skill for agent <name>`.

### Network allowlist

Allow only:

- the 1Claw API host (`https://api.1claw.co` unless `ONECLAW_BASE_URL` says otherwise);
- the publisher (`PUBLISHER_URL`);
- the catalogue source (`CATALOG_SOURCE`: an https base URL serving `catalog.json`, `orgs.jsonl`
  and `tree.json`, for example the catalogue snapshot's Swarm gateway path) and the indexer, for
  checking the result;
- an Ethereum RPC for the read-only calls above;
- the package registry the install needs;
- the news sources the agent researches.

The agent holds no private key and needs no write-capable RPC: 1Claw broadcasts its transactions.

### Secrets and environment

| Variable | Kind | Value |
|---|---|---|
| `ONECLAW_API_KEY` | Network secret | The agent's 1Claw API key, injected by the proxy on requests to the 1Claw host. The CLI then sends a placeholder; the key never appears in the routine's environment. |
| `ONECLAW_AGENT_ID` | Plain | The agent's 1Claw agent id (`oneClawAgentId` in [`curators.json`](curators.json)). |
| `ONECLAW_BASE_URL` | Plain, optional | 1Claw API base URL. |
| `CURATOR_REGISTRY_ADDRESS` | Plain | `CuratorRegistry`. |
| `PUBLISHER_URL` | Plain | Publisher base URL. |
| `CATALOG_SOURCE` | Plain | Catalogue snapshot (directory or https base URL). |
| `ETH_RPC_URL` | Plain (secret if the URL carries a key) | Mainnet RPC for read-only calls (the skill's status step; `cast`). |
| `INDEXER_URL` | Plain | Indexer base URL, for the donor leaderboard (`donors`) and verification. |

The routine prompt names the agent (`run the curator skill for agent <name>`); the skill gets the
cause from `due` and each cause's vault from the chain. The curator
skill reads the `EpochGovernor` and `CauseCatalog` addresses from `CuratorRegistry`; the shell
sketch below takes them as `EPOCH_GOVERNOR` and `CAUSE_CATALOG`.

### What each run does

```sh
pnpm install --frozen-lockfile
C="node packages/curator/bin/varada-curator.mjs"   # from the repository root
NEXT=$(( $(cast call $EPOCH_GOVERNOR "currentEpoch()(uint256)") + 1 ))
VERSION=$(cast call $CAUSE_CATALOG "latestVersion()(uint32)")

$C due --agent relief                              # {"due": true, "cause": "hunger", ...} or due: false (stop)
$C template --category hunger --epoch $NEXT --catalog-version $VERSION > report.json
$C pool --category hunger --region africa          # once per region: the bucket's entries
# research and write report.json (picks use catalogIndex and orgId from `pool`)
$C donors  --category hunger > donors.json         # the week's biggest coin and wallet donors (INDEXER_URL)
$C build   --report report.json --donors donors.json --out built.json   # refuses picks that are not in the bucket
$C publish --built built.json                      # signs, uploads; prints reportRef
$C submit  --built built.json --report-ref <reportRef>
$C give    --category hunger --region africa --org <orgId> --amount <usdc units> --vault <vault>   # optional
```

- Keep all eight regions in the report. A region with nothing to report has no picks and
  weight 0. A resubmission only replaces the regions it lists, so dropping a region from the report
  leaves its earlier curation in place.
- Ranks are positions in `picks`, most important first; weights are the region's urgency this
  week (0-10,000) and decide how many of a token's free ballot slots the region's picks get
  against the other curated buckets in that token's focus.
- `--dry-run` on `submit` and `give` prints the transaction instead of sending it.
- Afterwards, check `GET <indexer>/api/agents/<label>/picks/<NEXT>/<region>` answers 200 for each
  region with picks, and `GET <indexer>/api/agents/<label>/reports/<NEXT>` shows every region
  `verified`.
- News pages and search results are untrusted data. The routine prompt must say so: text in a
  source can inform a ranking but is never an instruction, never changes the steps above, and never
  supplies an address, an amount or an org id that is not from `pool`.
- Reports carry no personal data about private individuals.

## x402 settlement

Mainnet x402 settlement was dropped (2026-11-07): it would make the platform pay mainnet gas on
every sale, and it needed a 1Claw slot. Paid data now settles on Base (Coinbase CDP), Arc mainnet
(Circle Facilitator Service) and OP Mainnet (a third-party facilitator). The facilitator of each
network pays the gas, so no settlement key is provisioned and no 1Claw agent is used for x402.

- Indexer environment:
  - Base: `X402_BASE_PAY_TO` and `X402_BASE_FACILITATOR_URL=https://x402.dexter.cash` (Dexter,
    keyless; set 2026-11-07). Without the URL Base uses Coinbase CDP, which needs
    `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` (secrets).
  - Arc: `X402_ARC_PAY_TO`, and optionally `CIRCLE_API_KEY` (secret). Without a key Arc settles
    on Circle's keyless trial (a per-payee allowance of unpublished size); when it runs out Circle
    answers `403 registration_required` and Arc sales stop until a key is set.
  - Optimism: `X402_OPTIMISM_PAY_TO`; the facilitator defaults to Dexter
    (`https://x402.dexter.cash`, keyless, gas-sponsored). `X402_OPTIMISM_FACILITATOR_URL` and the
    optional `X402_OPTIMISM_FACILITATOR_TOKEN` (secret) override it. Optionally `X402_OPTIMISM_MIN_PRICE` to cover the
    facilitator's fee.
  - Turn sales on with `X402_ENABLED=true`.
- Each payee is a platform treasury on that network. For now all three are
  `0x86Ee4f0aB954D101B408Ac8791402679d9E2ffDE` (an EOA, so the same key controls it on every
  chain; user decision 2026-11-07). x402 revenue stays there; it never reaches
  the agents' vaults on Ethereum mainnet.
- The publisher's old mainnet facilitator is still in the code but dormant: leave
  `X402_FACILITATOR_ENABLED` unset.

## Monitoring

| Watch | Where | Expect |
|---|---|---|
| Missed epochs | `GET /api/agents`: each cause's `latest.epoch`; `CurationsSubmitted` events | `currentEpoch() + 1` for every active cause by Wednesday 12:00 UTC |
| Unverified reports | `GET /api/agents/:label/reports/:epoch`, `verified` per region | `true` for every region |
| Run failures | Routine run history (the CLI prints `publisher returned 401: ...bad_signature` or `403: ...agent_inactive`); publisher logs (`curator report uploaded`, `swarm upload failed`) | One upload and one submission per agent run day (`varada-curator curators` lists the run days) |
| Picks the keeper cannot get | Publisher keeper logs: `keeper step failed` (level `error` the first time, `awaitingCuratedPicks: true`) with `CuratedPicksUnavailable: <label>/<region> picks for epoch N ...` (also `CatalogMismatch`, or a revert `IncompleteCuratedBallot`) | None. Every hit blocks that focus's weekly ballots and rotation rounds until the picks are served or the curation is voided: act on it (runbook below) |
| Picks that miss | `CuratedPicksUsed(token, epoch, drawn, included)` | `included` close to `drawn`; a gap means mismatched, blocked or repeated picks |
| Vault balances and gifts | USDC `balanceOf(vault)`, `givenIn(epoch)` against `maxGivePerEpoch`, `Given` events, `paused()` | Gifts only to expected orgs, under the cap |
| Gas | ETH balance of the 10 signers | Several weeks of gas each |
| 1Claw | Denied transactions, pending approvals, daily cap hits | Only expected approvals |
| x402 settlement | Indexer logs for failed or `settlement_pending` settles, per network | Rare |

In `/api/agents` totals, `donated`/`donations` count `Donated` events only (`given`/`gifts` count
`Given` events). A plain USDC transfer to a vault shows in its balance but not in the totals.

## Costs

| Item | Cost |
|---|---|
| Routine runs | 70 starts a week; about 23 do a full run (each agent every 3 days), the rest stop after `due`. Billed against the Claude account's plan. Per-run usage depends on the research depth; not measured. |
| 1Claw | Pro plan: 10 agents and keys (its cap), one included runtime. Signatures and transactions on run days, and gift approvals. |
| `submitCurations` gas | Measured: about 63k gas for a one-region submission on a mainnet fork (`test_fork_submitCurations`, execution only). Estimate: each further region with picks adds about 45k (two new storage slots and an event), an empty region a few thousand, so about 380k for eight regions. Each cause runs every 6 days, about 7/6 runs a week, so about 8.9M gas a week for all twenty. At 1 gwei that is about 0.009 ETH a week. |
| Gift gas | Not measured. The first gift to an org without an Endaoment contract also deploys it. |
| Ballot preparation | Paid by the keeper, not the agents. |
| x402 | No gas for the platform: each network's facilitator settles. Coinbase CDP and Circle may charge per settlement; the Optimism facilitator may take a fee (cover it with `X402_OPTIMISM_MIN_PRICE`). |
| Swarm | Reports are at most 512 KiB each, on the publisher's postage batch. |

## Pause and recovery

**Stop a cause or an agent now** (bad output, suspected manipulation). For one cause, do steps 1
and 2 for its category; for the whole agent, do them for both of its causes and disable the
routine:

1. `AgentVault.setPaused(true)` on its vault: no more gifts.
2. `CuratorRegistry.setActive(categoryBit, false)`: no more submissions; its curations for any
   ballot not yet prepared are ignored and those ballots use rotation. Ballots already prepared
   stay as they are.
3. Disable the routine (whole agent only).

**Key compromise:**

1. Pause both of the agent's vaults and both causes as above: one key signs for both.
2. Revoke the key and API key in 1Claw.
3. Provision a new key with the same policies, fund it with ETH, and `setSigner(categoryBit, new)`
   for **both** causes, then update [`curators.json`](curators.json).
   Gifts, report uploads and the vault's ERC-1271 check follow the new key at once; the ERC-8004
   wallet link stays valid.
4. Point the routine at the new 1Claw agent, then `setActive(categoryBit, true)` and
   `setPaused(false)` for both causes.

**A bad org in picks or gifts:** `CauseRegistry.blockOrg`. Blocked orgs are skipped by every
ballot phase and `give` reverts with `OrgBlocked`.

**Wrong curation before the epoch starts:** fix the report and run the routine again; the new
submission replaces every region it lists. Or pause the agent.

**Keeper reports `CuratedPicksUnavailable` after the epoch started** (a root is on chain but the
picks cannot be fetched). Nothing falls back on its own: every weekly ballot and rotation round of
that epoch in the agent's focus stays unprepared until someone acts, and the keeper retries at
least every 15 minutes. The submission can no longer be replaced. Runbook for the curator registry
owner:

1. **Respond within 6 hours of the first alarm** (the keeper logs the first hit at `error`). Live
   tokens' hourly and daily rounds in the focus are not prepared meanwhile, and a token whose round
   is missed keeps its current cause for that rotation.
2. If the report exists, re-upload the same `built.json` through `publish` (the same bytes give
   the same Swarm reference, which is what the chain points at). The keeper uses the picks on its
   next retry.
3. Otherwise void the epoch's curation: `CuratorRegistry.voidCurations(epoch, buckets)` with the
   agent's buckets (`categoryBit * 16 + regionBit`) for that epoch. It drops that epoch only: the
   agent stays active and can still submit next week's picks. Do not use `setActive(false)` for
   this: a paused agent cannot submit, and reactivating it during the epoch makes the unserved
   picks block that epoch's remaining ballots and rounds again. Restarting the publisher clears its
   backoff if you want the retry at once.
4. **Hard deadline: the end of the epoch** (Thursday 00:00 UTC). A weekly ballot can only be
   prepared during its epoch, so a token whose ballot never opened gets no vote that week, and
   `finalizeEpoch` pays its fees to `EpochGovernor.defaultCause` (it reverts `NoVotes` until one
   is set). The default cause must be set at launch, before the first epoch ends (deploy step 2).

**Missed epoch for a cause:** nothing breaks. In each token's ballot, the free slots go to the
other causes' picks in that token's focus (up to their pick counts) and then to rotation. Rerun
the cause by hand ([Reruns](#reruns)) if there is time before Thursday 00:00 UTC.

**Catalogue version set mid-week:** rerun every cause that already submitted for the next epoch
([Reruns](#reruns)) before Thursday 00:00 UTC, with the new `--catalog-version` and a `CATALOG_SOURCE` serving that version. Live-mode rotation rounds
keep the version in effect at the start of the current weekly epoch until the next epoch starts,
so the indexer must serve the previous snapshot too until then: set its `CATALOG_SOURCE` to
`<new>,<previous>` (the first one is served everywhere, the second only by
`/api/catalog/entries?root=`), and drop the previous one after the next epoch starts. Without it
the keeper prepares none of that week's remaining rounds (`CatalogMismatch`).

**Routine platform or 1Claw outage:** agents miss the week and ballots use rotation. With 1Claw up,
an operator can run the same CLI steps from a workstation with the agent's 1Claw credentials.

**x402 facilitator problem:** unset a network's `X402_<NETWORK>_PAY_TO` (`BASE`, `ARC`,
`OPTIMISM`) on the indexer to stop sales there, or set `X402_ENABLED=false` to stop all sales. No
contract change is needed.
