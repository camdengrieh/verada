# @varada/publisher

Small Hono service (Node 22) that uploads token logos, token metadata and signed curator reports to
Swarm through Varada's swarm-gateway, reports postage status, optionally settles the indexer's
mainnet x402 payments, and runs background jobs (the tally keeper, and Arkiv mirroring of public
records). It is the only Varada server that accepts writes, so it keeps no state and logs no request
bodies, file names, IPs or addresses (see `docs/PRIVACY.md`).

## Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | | `{ status: "ok", uploads }` (`uploads` is false until the gateway, batch and public gateway are configured) |
| POST | `/uploads/logo` | `multipart/form-data`, field `file` | `201 { reference, bzz: "bzz://<ref>", url: "<PUBLIC_GATEWAY_URL>/bzz/<ref>/" }` |
| POST | `/uploads/metadata` | `application/json`, a `TokenMetadata` document | `201 { reference, uri: "bzz://<ref>", url }` |
| GET | `/site` | | `{ gateway, batchId, stamp: { usable, batchTTL, ttlDays, utilization, utilizationRatio, depth, bucketDepth, amount, immutable } \| null, feedOwner?, feedManifest?, stampError? }` |
| POST | `/agents/reports` | `application/json` `{ report }` (other fields are ignored), header `x-curator-signature` | `201 { reference, reportRef: "0x<ref>", reportHash, url, regions: [{ region, picksRoot, count, weight }] }` (see "Curator reports") |
| GET | `/x402/supported` | | the facilitator's supported kinds. Only with the facilitator on (see "x402 facilitator") |
| POST | `/x402/verify`, `/x402/settle` | `application/json` `{ x402Version, paymentPayload, paymentRequirements }` | x402 verify / settle responses |

Logo rules: the type is detected from magic bytes only (PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG
`FF D8 FF`, WebP `RIFF....WEBP`). The client's declared type and file name are ignored. SVG and
everything else get `415`, files over `MAX_LOGO_BYTES` get `413`. Logos are stored as `logo.png`,
`logo.jpg` or `logo.webp` with the sniffed content type.

`TokenMetadata` (strict, so unknown keys get `400`): `name` (1–64), `symbol` (1–16, letters, digits,
`$._-`), `description?` (≤ 2000), `logoRef` (64 hex, lowercased), `website?` (http(s) URL ≤ 256),
`twitter?`, `telegram?` (≤ 64, no whitespace or quotes), `discord?` (≤ 256), `launcher?` (address,
checksummed; the only address the document may carry, and only if the creator includes it). The
document is stored as canonical JSON (keys sorted, no whitespace), named `metadata.json`, so the same
metadata always gives the same reference.

Errors are JSON `{ error }`: `400 invalid_request` (with `issues`), `405`, `413 payload_too_large`,
`415 unsupported_media_type`, `429 rate_limited` (`Retry-After`), `502 upstream_unavailable`,
`503 uploads_unavailable`. `/agents/reports` adds `401 missing_signature` / `401 bad_signature`,
`403 unknown_agent` / `403 agent_inactive` and `503 reports_unavailable`; `/x402/*` adds
`401 unauthorized`.

Uploads call `POST {BEE_GATEWAY_URL}/bzz?name=<file>` with `Authorization: <BEE_GATEWAY_AUTH_SECRET>`
(sent as is: swarm-gateway compares the header to its `AUTH_SECRET` exactly, so do not add `Bearer `
unless the gateway's secret includes it), `Content-Type`, `swarm-postage-batch-id`, `swarm-pin: true`,
`swarm-deferred-upload: false`. Encrypted (128-hex) references are refused.

## Curator reports

`POST /agents/reports` (code: `src/agents.ts`) takes a curator agent's weekly report, the body that
`varada-curator publish` sends (`packages/curator`). The publisher never trusts uploaded trees: it
parses `report` with the curator package's `ReportSchema`, rebuilds every region's pick tree from the
report itself, and hashes the canonical report. `x-curator-signature` (65-byte hex) must be an EIP-191
signature over that hash, over either the 32 raw bytes or the 66-character hex string, that recovers
to the category's signer in `CuratorRegistry` (`agentOf`), and the agent must be active. Only then is
the canonical `{ report, regions }` uploaded, as `<category>-<epoch>.json`. The agent passes the returned
`reportRef` to `CuratorRegistry.submitCurations`; the indexer serves the picks from that upload.

Catalogue membership is not checked here: the governor checks it on chain when a ballot is prepared.
Bodies over `MAX_REPORT_BYTES` get `413`. The route answers `503 reports_unavailable` unless uploads are
configured (`BEE_GATEWAY_URL`, `SWARM_BATCH_ID`, `PUBLIC_GATEWAY_URL`) and `CURATOR_REGISTRY_ADDRESS` and
`ETH_RPC_URL` are set. It shares the per-IP rate limit with `/uploads/*`.

## x402 facilitator

Coinbase CDP does not settle x402 payments on Ethereum mainnet, so the indexer's mainnet paid routes
(`/x402/v1/*`) use this service as their facilitator (code: `src/facilitator.ts`). It is mounted only
when `X402_FACILITATOR_ENABLED=true` and `X402_FACILITATOR_TOKEN`, `X402_FACILITATOR_PAY_TO`,
`ETH_RPC_URL` and a settlement key (1Claw, or `X402_FACILITATOR_PRIVATE_KEY` in development) are all
set; otherwise start-up logs a warning and `/x402/*` does not exist.

- Every `/x402/*` request needs `Authorization: Bearer <X402_FACILITATOR_TOKEN>` (the indexer sends its
  `X402_MAINNET_FACILITATOR_TOKEN`, so the two must be the same value); responses are `no-store`.
- It settles only `exact` payments on `X402_FACILITATOR_NETWORK` to `X402_FACILITATOR_PAY_TO` (the
  platform's mainnet treasury, the indexer's `X402_MAINNET_PAY_TO`). Anything else gets
  `unsupported_network`, `unsupported_scheme` or `payee_not_allowed` without touching the chain, because
  the facilitator pays the gas. Bodies are limited to 64 KiB.
- The settlement key is a 1Claw agent (`X402_ONECLAW_AGENT_ID`, `X402_ONECLAW_API_KEY`,
  `ONECLAW_BASE_URL`) whose 1Claw policy allows only the USDC contract. The signer also refuses any call
  other than USDC `transferWithAuthorization` (`X402_FACILITATOR_USDC`, mainnet USDC by default).
  Settlement simulates first; smart-wallet (ERC-6492) deployment is disabled. Fund the key with ETH for
  gas. Settlements log `x402 settlement` with the result and transaction hash.

The indexer's base URL for it is `https://<publisher host>/x402`.

## How the launch form uses it

1. The creator picks a logo. The form posts it to `/uploads/logo` and shows `url` as a preview.
2. The form posts `{ name, symbol, description, logoRef: <reference from step 1>, website, ... }` to
   `/uploads/metadata`.
3. The launch transaction uses `uri` as the token's metadata URI and `swarmReferenceToBytes32(logoRef)`
   as the on-chain logo reference.

The form needs nothing from the wallet for these calls. Only the optional `launcher` field ties an
address to the upload, and the form should leave it out unless the creator asks for it.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `42070` | |
| `BEE_GATEWAY_URL` | none | swarm-gateway base URL (internal) |
| `BEE_GATEWAY_AUTH_SECRET` | none | secret, sent as the `Authorization` header |
| `BEE_STAMPS_URL` | `BEE_GATEWAY_URL` | serves `GET /stamps/{batchId}`. swarm-gateway does not proxy `/stamps`, so point this at the Bee API (port 1633, internal only) |
| `SWARM_BATCH_ID` | none | secret, 64-hex postage batch id (`0x` optional) |
| `PUBLIC_GATEWAY_URL` | none | gateway browsers read from, e.g. `https://gw.varada.xyz` |
| `INDEXER_URL` | none | public indexer API, read by `arkiv-mirror` |
| `CHAIN_ID` | `1` | Ethereum chain id of the mirrored records |
| `ARKIV_ENABLED` | `false` | turn on the Arkiv jobs |
| `ARKIV_DRY_RUN` | `false` | plan and log Arkiv writes without sending them |
| `ARKIV_CHAIN` | `rabdi` | `rabdi` (testnet) or `localhost` |
| `ARKIV_ACCESS_KEY` | none | secret. It goes in the RPC URL path, so RPC errors are redacted before logging |
| `ARKIV_PRIVATE_KEY` | none | secret, platform signer; its address is the `$creator` readers must trust |
| `ARKIV_RPC_URL` | chain default | override |
| `CORS_ALLOWED_ORIGINS` | any | comma list: exact origins or `*.` suffixes, optionally scheme-qualified (`https://*.eth.limo`) |
| `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` | `1` / `20` | per-IP token bucket on `/uploads/*`, `/site` and `/agents/*` (in memory only) |
| `TRUST_PROXY_HOPS` | `1` | trusted proxies in `X-Forwarded-For` (ALB = 1) |
| `MAX_LOGO_BYTES` | `2097152` (2 MiB) | |
| `MAX_METADATA_BYTES` | `65536` (64 KiB) | |
| `JOB_INTERVAL_SECONDS` | `60` | mirror interval; `stamp-watch` runs at most every 10 min, `arkiv-extend` at most hourly |
| `SITE_FEED_OWNER`, `SITE_FEED_MANIFEST` | none | passed through by `GET /site` |
| `KEEPER_ENABLED` | `false` | turn on the tally keeper (see "Tally keeper") |
| `KEEPER_DRY_RUN` | `false` | estimate and log keeper transactions; never decrypt or send |
| `KEEPER_PRIVATE_KEY` | none | secret, keeper signer (0x + 32 bytes); needs ETH for gas only |
| `ETH_RPC_URL` | none | secret, Ethereum RPC URL or comma list (viem fallback, JSON-RPC batching). Must serve `eth_getLogs` for at least the last `KEEPER_LOOKBACK_EPOCHS` epochs (a full node with logs, not a pruned or free public endpoint) unless `INDEXER_URL` is set; see "Tally keeper" |
| `EPOCH_GOVERNOR_ADDRESS`, `VOTING_SCHEME_ADDRESS`, `TAKEOVER_GOVERNOR_ADDRESS` | none | required by the keeper; the scheme is the `ZamaVotingScheme` it decrypts for |
| `FEE_VAULT_ADDRESS`, `DONATION_DISTRIBUTOR_ADDRESS` | none | with both set, the keeper also settles (`FeeVault.settle`) and donates (`DonationDistributor.distribute`) every finalized epoch in its lookback (see "Tally keeper", step 4). Unset: finalized epochs are left for anyone to settle and donate (the web app's "Send this epoch's donation" card) |
| `ROTATION_GOVERNOR_ADDRESS` | none | live mode's `RotationGovernor`: the keeper also drives live tokens' rotation rounds and the governor's period-change proposals (see "Tally keeper", step 2). Unset: both are left alone |
| `FACTORY_ADDRESS`, `FACTORY_DEPLOY_BLOCK` | none | keeper token discovery fallback (`TokenCreated` logs) when the indexer is down; both needed. `FACTORY_ADDRESS` alone also locates the LP locker for the idle check (without it every epoch is opened) |
| `KEEPER_MAX_TX_PER_RUN` | `10` | transactions per run (dry run: planned transactions) |
| `KEEPER_LOOKBACK_EPOCHS` | `4` | epochs `[current - n, current)` checked per token (1 to 500). Epochs are owner-set and can be minutes long: size it in time, not epochs (it should span `tallyGrace` and `settleGrace` plus an outage margin; the keeper warns when it does not). See "Epoch schedule" |
| `KEEPER_LOOKBACK_ROUNDS` | `24` | rotation rounds `[next - n, next]` checked per live token, `next = currentRotation + 1` (1 to 720); an unfinished round seen in that range is followed past it while the process runs |
| `KEEPER_IDLE_EPOCHS` | `2` | a token with no fees, ballots, curation-skip request, pin change or launch in epochs `[current - n, current]` and no uncollected LP fees is idle and its current epoch is not opened; `0` opens every epoch |
| `KEEPER_INDEXER_MAX_LAG_SECONDS` | `600` | when the indexer's last indexed block (Ponder `/status`) is older than this, the idle check is off for the run and every epoch is opened |
| `KEEPER_INTERVAL_SECONDS` | `300` | keeper run interval (30 to 86400). Recommended `60`-`120` for the 45 minute test cycle (30 min trading, 15 min voting); `300` still works there. See "Epoch schedule" |
| `ZAMA_RELAYER_URL` | chain preset | override of the Zama relayer (`https://relayer.mainnet.zama.org`) |
| `ZAMA_RELAYER_API_KEY` | none | secret, Zama relayer API key (API-key header). Required on mainnet |
| `CURATOR_REGISTRY_ADDRESS` | none | `CuratorRegistry`; with `ETH_RPC_URL`, enables `POST /agents/reports` |
| `MAX_REPORT_BYTES` | `524288` (512 KiB) | body limit of `POST /agents/reports` (4 KiB to 4 MiB) |
| `X402_FACILITATOR_ENABLED` | `false` | mount the mainnet x402 facilitator (see "x402 facilitator") |
| `X402_FACILITATOR_TOKEN` | none | secret, bearer token the indexer sends (its `X402_MAINNET_FACILITATOR_TOKEN`) |
| `X402_FACILITATOR_PAY_TO` | none | the only payee settled for: the platform's mainnet treasury |
| `X402_FACILITATOR_NETWORK` | `eip155:1` | CAIP-2 network settled on |
| `X402_FACILITATOR_USDC` | mainnet USDC | the only contract the settlement signer calls |
| `X402_ONECLAW_AGENT_ID`, `X402_ONECLAW_API_KEY` | none | the 1Claw agent holding the settlement key; the API key is a secret |
| `ONECLAW_BASE_URL` | 1Claw default | 1Claw API override |
| `X402_FACILITATOR_PRIVATE_KEY` | none | secret, development and fork tests only: a local settlement key instead of 1Claw |

Invalid configuration fails start-up with the variable names only, never their values.

## Jobs

Each job runs on its own interval, once shortly after start, never overlapping itself, and only when
its configuration is present.

- `arkiv-mirror` (`ARKIV_ENABLED`, `ARKIV_PRIVATE_KEY`, `INDEXER_URL`): reads `/api/tokens` (all pages)
  and `/api/causes`, reads the platform's entities from Arkiv, runs `planReconcile`, and applies the plan
  with `@varada/arkiv-registry`. Idempotent: an unchanged indexer gives no writes. At most 50 new tokens
  per run.
- `arkiv-extend` (`ARKIV_ENABLED`, `ARKIV_PRIVATE_KEY`): extends every platform entity expiring within 30
  days to the maximum lifetime (about 182 days).
- `stamp-watch` (`BEE_GATEWAY_URL`, `SWARM_BATCH_ID`): logs `postage batch needs attention` at `warn` when
  `batchTTL` is under 30 days, utilization is over 70% or the batch is unusable. Alarm on that message.
- `tally-keeper` (`KEEPER_ENABLED`, `KEEPER_PRIVATE_KEY`, `ETH_RPC_URL`, the three governance addresses;
  `ROTATION_GOVERNOR_ADDRESS` adds live mode; `FEE_VAULT_ADDRESS` with `DONATION_DISTRIBUTOR_ADDRESS`
  adds settling and donating): see below.

## Tally keeper

Ballots on `ZamaVotingScheme` are encrypted, so an epoch, takeover or rotation poll only ends once
someone closes it, relays the public decryption of its result, and finalizes it. All of those calls
are permissionless; the keeper makes them so nobody has to. Code: `src/jobs/tally-keeper.ts` and
`src/keeper/` (`plan.ts` holds every decision as a pure function).

**Flow.** Each run reads everything from chain state, so runs are idempotent and a restart loses only
backoff timers.

1. Takeovers, ids `1..proposalCount` (first, because of the execution window), by `state(id)`:
   `Closing` and not closed: `closeProposal`. Closed and the scheme tally not final: decrypt and
   `submitTally(takeoverGovernor, token, id, ...)`. Tally final, not tallied: `recordTally`.
   `Succeeded`: `execute`. `Active` waits; `Defeated`, `Executed`, `Canceled`, `Expired` are
   never read again.
2. Rotation rounds of live tokens, with `ROTATION_GOVERNOR_ADDRESS` (before the weekly steps: a
   round's windows are minutes to hours). Live tokens come from the same token list as weekly ones
   (indexer `/api/tokens`, or the factory's `TokenCreated` logs): a token is live when
   `RotationGovernor.isRegistered` says so, and weekly when `EpochGovernor.isRegistered` does. The
   factory registers each token with exactly one of them in its creation transaction, so both
   answers are read once per token (concurrently, so the RPC batches them); only a token
   registered with neither yet (an RPC behind the indexer) is re-checked each run. For each live
   token, with `next = currentRotation + 1`, the rounds
   `[next - KEEPER_LOOKBACK_ROUNDS, next]`, oldest first, skipping rounds already in a final state:
   - round `next`, not prepared, before its vote end: prepared with the SDK's `planRoundOpening`,
     the weekly planner (`CatalogBallotLib`: pins, curated picks, rotation draws seeded by the
     target rotation) over the governor's views, the indexer's catalogue entries and the curator
     agents' picks of the weekly epoch containing the round's vote start (`curationEpochOf`).
     `openRound` when pins fill the ballot or there is no pool, `prepareCuratedRound` when curated
     picks take slots, `prepareRound` otherwise. Needs `INDEXER_URL`; without it rounds are still
     closed and finalized. When a usable curation's picks cannot be fetched the step fails with
     `CuratedPicksUnavailable` for the round's whole vote window: the builder requires the curated
     draws for as long as the curation is usable, so a rotation-only round would revert
     `IncompleteCuratedBallot` (see "Failure handling"). The entries come from the round's own
     catalogue version, the one in effect at the start of that weekly epoch (`poolOf`), which
     every round keeps until the next epoch even when a new version is published mid-week; the
     keeper asks the indexer for it by root (`/api/catalog/entries?root=`). After a mid-week
     `setVersion`, the indexer must keep serving the previous snapshot as well
     (`CATALOG_SOURCE=<new>,<previous>`, see `services/indexer/README.md`) until the next weekly
     epoch starts; otherwise every remaining round of that week fails with `CatalogMismatch`
     (`indexer serves no catalogue snapshot with root ...`) and gets no ballot;
   - open, voting ended, with ballots: `closeRound` (below the governor's `minVoters` this ends the
     round `NoChange`, with nothing decrypted). Without ballots the round is left open: nothing
     would change and nothing is decrypted, so the transaction is saved, as for an epoch without
     ballots;
   - closed, outcome not final: the scheme's `outcomeHandle` (the encrypted winner index, the only
     value a rotation poll ever reveals) → Zama `publicDecrypt` → `submitOutcome`;
   - closed, outcome final: `finalizeRound` (the winner applies from the next rotation boundary).
   A round never prepared, a final round, or an open round that ended without ballots is never read
   again. A round that leaves the lookback unfinished (closed, its outcome not decrypted or not
   finalized, for example during a Zama relayer outage or with the keeper account out of ETH) is
   still followed until it is final, and logged once at `warn` (`keeper is following an
   unfinished round past its lookback`): a late `finalizeRound` is `Stale` only when a later
   round of the token was applied first, otherwise it still applies the voted winner, from the
   next boundary. At most 64 such rounds are followed per token; dropping one logs `keeper
   stopped following an unfinished round` at `error`. This list lives in memory: after a restart
   the keeper only finds rounds inside the lookback, so after a long outage raise
   `KEEPER_LOOKBACK_ROUNDS` (or call `closeRound` / `finalizeRound` by hand) before restarting.

   Then the rotation governor's period-change proposals (`proposalCount`, ids from 1), driven like
   takeovers. `Ended`: `closePeriodProposal` (below `minVoters` this defeats it, with nothing
   decrypted). `Closed`, outcome not final: the scheme's `outcomeHandle` for scope
   `PollScopeLib.encode(2, id)` → `publicDecrypt` → `submitOutcome`. `Closed`, outcome final:
   `executePeriodProposal` (schedules the new period when FOR won). `Closed` past its
   `executionDeadline` without a final outcome (another scheme, or a relayer outage longer than
   the execution window): `executePeriodProposal`, which expires it and frees the token's slot
   for that period. `Active` waits; `Defeated`, `Executed`, `Expired`, `Canceled` are never read
   again.
3. The current epoch's ballot, for every registered token, when it is not prepared. Ballots are
   rejected until the epoch is opened, and nothing opens it but this step (or a volunteer). When
   the ballot needs rotation draws (pins do not fill it and the focus pool is not empty) the keeper
   computes them with the SDK's `planRotation` (the governor's algorithm), fetches those entries
   and their Merkle proofs from the indexer's `/api/catalog/entries`, refuses them unless the
   indexer's root is the on-chain root of the epoch's catalogue version, and sends
   `prepareBallot`; otherwise it sends `openEpoch`. Needs `INDEXER_URL`. The planning is the
   SDK's `planBallotOpening`, the same code the web app's "Open this epoch's ballot" button runs.

   Idle tokens are skipped: before the token loop the keeper asks the indexer's
   `/api/active-tokens?sinceEpoch=current-KEEPER_IDLE_EPOCHS&sinceTime=epochStart(sinceEpoch)` for
   tokens with fees credited to a pool of those epochs, ballots or a curation-skip request in them,
   a pin change or a launch since then. Fees count there only once collected, and LP trading fees
   stay in the locked position until someone collects them, so for every other token the keeper
   also simulates `VaradaLpLocker.collectFees` (an `eth_call`; the locker is `locker()` of
   `FACTORY_ADDRESS`): any uncollected fee, or a failed read, opens the epoch. The rest stay
   closed (`keeper skipped idle epoch`, logged once per token and epoch; `idleSkipped` in the run
   summary). The checks are re-run every run, so an epoch opens on the first run after a trade, a
   ballot or a pin change, and anyone can open it from the web app before that. Every epoch is
   opened, as before, if the indexer call fails, if its `/status` is more than
   `KEEPER_INDEXER_MAX_LAG_SECONDS` behind the wall clock (re-sync or lag), or without
   `FACTORY_ADDRESS`. Ended epochs of idle tokens are still finalized (step 4).

   When a curator agent's picks cannot be fetched, the keeper sends nothing and retries until the
   picks turn up or the curator registry owner voids that epoch's curation
   (`CuratorRegistry.voidCurations`); then it prepares with rotation only. There is no skip:
   `requestCurationSkip` always reverts, and so would a rotation-only ballot while the curation
   is usable.
4. Epochs, for every token (indexer `/api/tokens`, all pages; `TokenCreated` logs of `FACTORY_ADDRESS`
   from `FACTORY_DEPLOY_BLOCK` when the indexer fails) and every epoch in
   `[current - KEEPER_LOOKBACK_EPOCHS, current)`, skipping unregistered tokens and epochs already
   done (finalized, or with the donation addresses donated):
   - never opened, or opened with `voterCount == 0`: `finalizeEpoch` (the default cause wins; the
     epoch is not closed, which saves a public decryption);
   - opened with ballots, not closed: `closeEpoch` (makes the tallies publicly decryptable);
   - closed, `tallyOf` not final: `tallyHandles` → Zama `publicDecrypt` → `submitTally`;
   - closed, tally final: `finalizeEpoch` with the ballot's org ids as calldata. The governor keeps
     only a commitment to them, so the keeper takes them from the indexer
     (`/api/epochs/:token/:epoch` `optionOrgIds`, when `INDEXER_URL` is set) or else from the
     epoch's `BallotPrepared` log (`eth_getLogs` by token and epoch, between the blocks of the
     epoch's start and end, found by binary search from `FACTORY_DEPLOY_BLOCK` or block 0), and
     checks them against `ballotCommitment` before sending, so neither source is trusted. A voted
     epoch whose tally is final has no timeout: if neither source answers it is never finalized,
     and the step fails with `BallotUnavailable: ballot org ids unavailable: ...` naming both
     causes. Epochs without ballots finalize with an empty list and need neither.
   - finalized, with `FEE_VAULT_ADDRESS` and `DONATION_DISTRIBUTOR_ADDRESS` set: the SDK's
     `planDonation` (`src/keeper/donate.ts`; the web app's donation card runs the same plan) over
     chain state, including a simulated `settle` or `distribute`. Not settled: `FeeVault.settle`,
     which first brings the epoch's outstanding fees in; while it would revert `FeesPending` the
     epoch waits (until `FeeVault.settleGrace()`, owner-set, 7 days by default, after its end at the latest). `NothingToSettle` (an
     empty pool) is logged once at `info` but does not end the epoch: `FeeVault.depositFees`
     credits late fees to the oldest unsettled epoch at or after their accrual epoch, so the epoch
     can still fill up, and it is re-read every run while in the lookback. Settled: `DonationDistributor.distribute`
     to the winning Endaoment org. `OrgNotActive` and `OrgAddressMismatch` need the owner or
     Endaoment, so they are logged once at `warn` (`keeper cannot donate the epoch`) and the epoch
     is re-read every run until they clear. The epoch is done once donated. Without the two
     addresses a finalized epoch is done, as before. Keep `KEEPER_LOOKBACK_EPOCHS` long enough in time (at least
     `settleGrace` plus one epoch) so an epoch whose fees stay pending is still in range when its
     settle grace ends.

   An item takes up to four steps in one run (close → submit → finalize), re-reading state before
   each. Polls on a scheme other than `VOTING_SCHEME_ADDRESS` are never decrypted.

   Every live token's next round is prepared, traded or not: the epoch idle check (step 3) has no
   live counterpart yet, so each live token costs one preparation per rotation (24 a day for an
   hourly token), plus a close, an outcome submission and a finalize for each round with ballots.

**Epoch schedule.** The keeper never assumes an epoch length. The epoch length, the voting window
(ballots are accepted only in the last `votingWindow` seconds, from `votingOpensAt`), the hold
window and the graces (`tallyGrace`, `curationGrace`, `launchSnapshotDelay` on the governor,
`settleGrace` on the vault) are owner-set; every run reads `currentEpoch`, `epochStart`,
`votingOpensAt`, `epochScheduleFor`, `tallyGrace` and (with `FEE_VAULT_ADDRESS`) `settleGrace` from
the chain, logs them (`keeper epoch schedule`, and `timing` in the run summary) and warns once per
distinct schedule when its own settings do not fit it:

- `KEEPER_INTERVAL_SECONDS` more than half of the time before voting opens (the trading phase,
  or the whole epoch when voting is open all of it): a ballot can only be prepared at a run, and
  voters cannot vote until it is. The first production cycle is 45 minutes, 30 of trading then 15
  of voting; `KEEPER_INTERVAL_SECONDS=60` to `120` keeps the opening well inside the trading phase
  and the tally (close, decrypt, submit, finalize, settle, distribute, up to four steps per item
  and run) within a few minutes of the epoch's end. The default `300` also works for that cycle
  (a failed step is retried after at most 5 minutes; the backoff base is the run interval when that
  is shorter).
- `KEEPER_LOOKBACK_EPOCHS` spanning less than 6 hours, or less than `tallyGrace + epochLength` or
  `settleGrace + epochLength`: an epoch leaves the lookback before its fallbacks can apply. At 45
  minutes, 4 epochs are 3 hours; set `KEEPER_LOOKBACK_EPOCHS=8` (6 hours) or more, and keep the
  graces short on the test cycle (or accept that an epoch stuck longer than the lookback is left
  for volunteers). Epochs with no ballots still need a `finalizeEpoch` each (the default cause
  wins), so a token costs about one transaction per epoch per step: expect many more transactions
  per hour than with weekly epochs, and raise `KEEPER_MAX_TX_PER_RUN` accordingly.
- `KEEPER_IDLE_EPOCHS` counts epochs: 2 is 90 minutes of inactivity at 45 minutes per epoch.
  Raise it (for example 8) so tokens are not skipped during quiet half-hours; 0 opens every epoch.

A schedule change applies from the next epoch (epochs already started keep theirs), so the next
run after it simply reads the new values. The read is informational: if it fails the keeper logs it
once and carries on, as every decision still comes from `currentEpoch` and `epochStart`.

**Decryption.** `@zama-fhe/sdk` (Node transport over `@fhevm/sdk`, loaded lazily, no signer):
`sdk.decryption.decryptPublicValues(handles)` returns `{ clearValues, abiEncodedClearValues,
decryptionProof }`. The keeper checks that `abiEncodedClearValues` is one 32-byte word per handle,
each within `uint64` and equal to that handle's clear value, then submits those bytes unchanged
(the KMS signed exactly them, in handle order). The first decryption also fetches the FHE public key
(about 50 MB) and loads WASM, so give the task headroom (1 GiB or more).

**Transactions.** One viem wallet client and one account, one transaction at a time: gas estimate
(a revert here costs nothing), send with 120% of the estimate, wait for the receipt. At most
`KEEPER_MAX_TX_PER_RUN` per run. A send or receipt failure stops the run so no second nonce is
used while one may be pending. After such a failure, and once after a start, the keeper compares
the account's `pending` and `latest` nonces before its next send and stops the run (`keeper has a
transaction pending`, at `warn`) while they differ, so a step whose receipt timed out is not sent
again while it can still be mined. Run a single publisher task.

**Failure handling.** A failed step backs its item off in memory: 5 min, doubling to 6 h, reset on
success; the item is retried on the first run after its backoff ends. One exception is capped: when a
ballot or round has usable on-chain curations whose picks the indexer does not serve
(`CuratedPicksUnavailable`, `src/keeper/ballot.ts`), the backoff never exceeds 15 minutes
(`PICKS_RETRY_MAX_MS` in `src/keeper/keeper.ts`), since the picks can be served, or the curation
voided, at any time. Nothing falls back on its own: both governors require the picks for as long as
the curation is usable, so every weekly ballot and rotation round in that agent's focus waits until
the agent serves them or the curator registry owner calls `CuratorRegistry.voidCurations(epoch,
buckets)` (runbook and deadlines in `agents/README.md`, "Keeper reports
`CuratedPicksUnavailable`"). The failure logs at `error` only the first time each message is seen
(it names the agent, the region and the epoch, and the remedy), and at `warn` with
`awaitingCuratedPicks: true` after that. Treat that first `error` as a page for the registry owner.
Failures log `keeper step failed` at `error` with the item, the step and the decoded revert name
(never its arguments) or a redacted message (no URLs, no addresses). Alarm on `error` lines
whose msg starts with `keeper`/`tally keeper` and on `job tally-keeper failed` (whole run failed,
e.g. RPC down). The one expected failure, `NoVotes` (an epoch without ballots while no default
cause is set), logs at `warn`: the owner fixes it with `EpochGovernor.setDefaultCause`, and the
backoff keeps it from retrying every run. `keeper reached its per-run transaction cap` (warn) means
the backlog exceeds the cap; it drains over the next runs. Each run ends with `tally keeper run`
(counts: txs, decrypted, failed, backedOff, capped, halted, liveTokens, roundsChecked,
periodProposalsChecked).

**Funding.**
- ETH on the keeper account for gas. Rough costs: `closeEpoch`/`closeProposal` call the scheme's
  `requestTally` (one ACL write per option), `submitTally` verifies KMS signatures on-chain
  (`FHE.checkSignatures`), `finalizeEpoch` loops over at most 32 options (taken as calldata) and materializes the winner, `prepareBallot` (about
  0.7M gas less than before for a 32-option ballot: it stores one commitment instead of the options) opens the poll. Measure on a mainnet fork or with
  `scripts/zama-e2e.ts`; budget `KEEPER_MAX_TX_PER_RUN` transactions per run at peak. Every
  registered token gets a `finalizeEpoch` each epoch, ballots or not. Live tokens: every rotation
  gets a round preparation (which opens its poll); `closeRound` runs the scheme's
  `requestOutcome` (an encrypted argmax over at most 10 options), and `submitOutcome` verifies the
  KMS signature over one handle, only for rounds with ballots.
- An RPC that serves `eth_getLogs` about two epochs back (100k+ blocks at weekly epochs; far fewer at 45 minutes), or a reachable indexer.
  Free public endpoints refuse old log ranges (for example "Archive requests require a personal
  token"); with one of those and the indexer down, voted epochs stay unfinalized and their cause
  pools unsettled until a source returns.
- Zama protocol fees: public decryption is priced in USD and paid in $ZAMA by the relayer account
  (the account behind `ZAMA_RELAYER_API_KEY` on Zama's relayer, or your own relayer when
  `ZAMA_RELAYER_URL` points at one). The keeper account holds no $ZAMA. Keep that relayer account
  funded; one decryption per closed poll that had ballots (epochs without ballots are never
  decrypted). Unfunded or unauthorized relayer requests show up as `op: "decrypt"` errors.

**Privacy.** The keeper never reads voters or ballots, and for rotation rounds and period-change
proposals decrypts only the winner index, never per-option counts. Logs carry token addresses, epochs, rounds, proposal ids,
option counts, tx hashes and the keeper's own address.

**Rollout.** Start with `KEEPER_ENABLED=true KEEPER_DRY_RUN=true` and check the `keeper dry run`
lines (planned transaction, gas estimate; decryption is skipped), then turn dry run off.

**Manual mainnet check** (spends real gas and Zama fees; try `E2E_DRY_RUN=true` first) of the decrypt + submit path for one closed poll:

```sh
ETH_RPC_URL=... KEEPER_PRIVATE_KEY=0x... VOTING_SCHEME_ADDRESS=0x... \
E2E_GOVERNOR=0x... E2E_TOKEN=0x... E2E_SCOPE=<epoch or proposal id> \
pnpm --filter @varada/publisher e2e:zama
# optional: ZAMA_RELAYER_URL, ZAMA_RELAYER_API_KEY, E2E_DRY_RUN=true (decrypt and estimate only)
```

Opening and voting on a poll is out of scope: close it first (`closeEpoch` after the epoch ends, or
`closeProposal` after `end`). The script prints the handle count, decryption time, the decrypted
totals, the gas estimate, then the `submitTally` hash, status and `gasUsed`.

## Ops notes

- **Stamps.** Use an immutable batch for site feeds: a mutable batch overwrites the oldest chunks when
  full, which silently breaks old feed updates and uploads. Keep `batchTTL` above 30 days by topping up,
  and dilute (raise the depth) before utilization passes 70%. `GET /site` and `stamp-watch` report both.
- **Arkiv is testnet only** (Rabdi). Entities expire after at most about 182.5 days unless extended, and
  the testnet may be reset. The mirror is a convenience copy; Ethereum and Swarm stay the source of
  truth. Fund the platform signer with tGLM from https://hub.arkiv.network/faucet. Start with
  `ARKIV_DRY_RUN=true` and check the planned writes in the logs.
- **One task.** Run a single instance: the Arkiv signer and the keeper each use one nonce sequence.
- **Privacy.** No access logs. Logs carry Swarm references, sizes, entity keys and token addresses, never
  IPs, file names, bodies or secrets.

## Build and run

```sh
pnpm --filter @varada/publisher test
pnpm --filter @varada/publisher typecheck
pnpm --filter @varada/publisher dev        # tsx watch src/index.ts

# Image (build context: repository root)
docker build -f services/publisher/Dockerfile .
```
