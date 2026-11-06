import { index, onchainTable, primaryKey, relations } from "ponder";

export const token = onchainTable(
  "token",
  (t) => ({
    address: t.hex().primaryKey(),
    creator: t.hex().notNull(),
    pool: t.hex().notNull(),
    hook: t.hex().notNull(),
    lpTokenId: t.bigint().notNull(),
    feeBps: t.integer().notNull(),
    metadataUri: t.text().notNull(),
    createdAt: t.bigint().notNull(),
    createdBlock: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    /** ERC-20 metadata read at launch; empty when the read failed. */
    name: t.text().notNull().default(""),
    symbol: t.text().notNull().default(""),
    /**
     * Profile fields mirrored from `token_profile` (null until the registry has registered the
     * token).
     */
    label: t.text(),
    labelhash: t.hex(),
    controller: t.hex(),
    editor: t.hex(),
    logoRef: t.hex(),
    suppressed: t.boolean().notNull().default(false),
    registeredAt: t.bigint(),
    /** Cause focus mirrored from `token_focus` (null until known). */
    categoryMask: t.bigint(),
    regionMask: t.integer(),
  }),
  (table) => ({
    creatorIdx: index().on(table.creator),
    createdAtIdx: index().on(table.createdAt),
    labelIdx: index().on(table.label),
    controllerIdx: index().on(table.controller),
  }),
);

/**
 * Profile state from `TokenProfileRegistry`, kept on its own because the registry registers a
 * token (and emits its logo) earlier in the launch transaction than the factory's `TokenCreated`.
 * Every change is mirrored onto the `token` row once it exists.
 */
export const tokenProfile = onchainTable("token_profile", (t) => ({
  token: t.hex().primaryKey(),
  label: t.text().notNull(),
  labelhash: t.hex().notNull(),
  controller: t.hex(),
  editor: t.hex(),
  logoRef: t.hex(),
  suppressed: t.boolean().notNull(),
  registeredAt: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/** Current value of each ENS text record a token's profile has set. */
export const tokenTextRecord = onchainTable(
  "token_text_record",
  (t) => ({
    token: t.hex().notNull(),
    key: t.text().notNull(),
    value: t.text().notNull(),
    updatedAt: t.bigint().notNull(),
    updatedBlock: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.key] }),
  }),
);

/**
 * One profile change, for the activity feed. `field` is `controller`, `editor`, `text` or
 * `logo`; `key` is the text record key (text only) and `value` the new value.
 */
export const profileUpdate = onchainTable(
  "profile_update",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    field: t.text().notNull(),
    key: t.text(),
    value: t.text().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
  }),
);

/**
 * Running fee totals per token. Everything is denominated in the settlement asset (USDC,
 * 6 decimals), so a single row per token is the full accounting picture.
 */
export const feeTotal = onchainTable(
  "fee_total",
  (t) => ({
    token: t.hex().primaryKey(),
    /** Settlement asset the amounts are denominated in (USDC). */
    settlementAsset: t.hex().notNull(),
    platformAmount: t.bigint().notNull(),
    causeAmount: t.bigint().notNull(),
    collections: t.integer().notNull(),
    lastCollectedAt: t.bigint().notNull(),
  }),
);

/** One `FeesCollected`: a single deposit into the vault, with its platform and cause totals. */
export const feeCollection = onchainTable(
  "fee_collection",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    /** Settlement asset (USDC). */
    currency: t.hex().notNull(),
    platformAmount: t.bigint().notNull(),
    causeAmount: t.bigint().notNull(),
    /** 1-based deposit number of the token (`fee_total.collections` after this deposit). */
    depositSeq: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
  }),
);

/**
 * One `FeesAttributed`: part of a deposit's cause share credited to the pool of `epoch`, earned in
 * `accrualEpoch` (the same epoch, or an earlier one whose pool was already settled). The vault
 * emits the parts of a deposit just before its `FeesCollected`; they share its `depositSeq` and
 * sum to its `causeAmount`.
 */
export const feeAttribution = onchainTable(
  "fee_attribution",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    accrualEpoch: t.bigint().notNull(),
    causeAmount: t.bigint().notNull(),
    depositSeq: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenEpochIdx: index().on(table.token, table.epoch),
    tokenDepositIdx: index().on(table.token, table.depositSeq),
  }),
);

/**
 * Cause pool of `(token, epoch)` by accrual epoch: the running sum of `FeesAttributed` parts
 * credited to the pool of `epoch` from fees earned in `accrualEpoch`. The rows of one epoch sum to
 * `epoch.causeAttributed`.
 */
export const causePoolAttribution = onchainTable(
  "cause_pool_attribution",
  (t) => ({
    token: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    accrualEpoch: t.bigint().notNull(),
    causeAmount: t.bigint().notNull(),
    parts: t.integer().notNull(),
    firstAttributedAt: t.bigint().notNull(),
    lastAttributedAt: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.epoch, table.accrualEpoch] }),
    accrualIdx: index().on(table.token, table.accrualEpoch),
  }),
);

/** One successful swap of collected fees (token side or quote side) into the settlement asset. */
export const feeConsolidation = onchainTable(
  "fee_consolidation",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    currencyIn: t.hex().notNull(),
    amountIn: t.bigint().notNull(),
    settlementOut: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
  }),
);

/** A failed consolidation route. The fees stay held in the consolidator for retry. */
export const consolidationFailure = onchainTable(
  "consolidation_failure",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    currencyIn: t.hex().notNull(),
    amountIn: t.bigint().notNull(),
    reason: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
  }),
);

/**
 * Cumulative consolidation counters per (token, input currency). The authoritative held balance
 * is `FeeConsolidator.heldFees(token, currency)` on-chain; `failedAmountIn - recoveredAmountIn`
 * is not tracked because a successful event does not say whether it came from a retry.
 */
export const consolidationTotal = onchainTable(
  "consolidation_total",
  (t) => ({
    token: t.hex().notNull(),
    currencyIn: t.hex().notNull(),
    consolidatedAmountIn: t.bigint().notNull(),
    settlementOut: t.bigint().notNull(),
    consolidations: t.integer().notNull(),
    failedAmountIn: t.bigint().notNull(),
    failures: t.integer().notNull(),
    lastFailureAt: t.bigint(),
    lastConsolidatedAt: t.bigint(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.currencyIn] }),
  }),
);

/** Allowlisted quote assets (WETH and Ondo tokenized assets) from the quote registry. */
export const quoteAsset = onchainTable("quote_asset", (t) => ({
  asset: t.hex().primaryKey(),
  decimals: t.integer().notNull(),
  /** 0 = Native (WETH), 1 = Ondo. */
  kind: t.integer().notNull(),
  active: t.boolean().notNull(),
  addedAt: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/** Endaoment orgs deployed by the distributor on first donation. */
export const orgDeployment = onchainTable("org_deployment", (t) => ({
  orgId: t.hex().primaryKey(),
  org: t.hex().notNull(),
  deployedAt: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

export const cause = onchainTable("cause", (t) => ({
  causeId: t.hex().primaryKey(),
  /** The nonprofit's Endaoment org address (deterministic CREATE2 address, may not be deployed yet). */
  payout: t.hex().notNull(),
  active: t.boolean().notNull(),
  addedAt: t.bigint().notNull(),
  deactivatedAt: t.bigint(),
}));

export const epoch = onchainTable(
  "epoch",
  (t) => ({
    token: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    winningCauseId: t.hex(),
    finalizedAt: t.bigint(),
    voteCount: t.integer().notNull(),
    donatedAmount: t.bigint(),
    donatedPayout: t.hex(),
    donatedAt: t.bigint(),
    /** Poll opened (options frozen) / closed (tally requested). */
    opened: t.boolean().notNull().default(false),
    openedAt: t.bigint(),
    closed: t.boolean().notNull().default(false),
    closedAt: t.bigint(),
    /** Ballots authorized by the governor (equals `voteCount`; named after the contract view). */
    voterCount: t.integer().notNull().default(0),
    /** Finalized with the default cause: nobody voted, or the tally never became final. */
    fallbackApplied: t.boolean().notNull().default(false),
    /** `no_votes` (`NoVoteFallbackApplied`) or `timeout` (`TallyTimeoutFallbackApplied`). */
    fallbackReason: t.text(),
    /**
     * The last `closeEpoch` could not request the tally (`EpochCloseFailed`); `closed` is still
     * true, as on-chain, and a later successful close clears this.
     */
    closeFailed: t.boolean().notNull().default(false),
    /** Governor that opened the epoch and the scheme its poll lives on (null until opened). */
    governor: t.hex(),
    scheme: t.hex(),
    /** Ballot fixed by `BallotPrepared`: catalogue version, focus pool size and pinned count. */
    prepared: t.boolean().notNull().default(false),
    preparedAt: t.bigint(),
    catalogVersion: t.integer(),
    poolSize: t.bigint(),
    pinnedCount: t.integer(),
    /**
     * Ballot size the epoch was prepared with: the token's choice bounded by the protocol cap, as
     * in force at `BallotPrepared` (the governor reads both then; `ballotSizeFor`). The ballot holds
     * up to this many options (fewer on a small pool). Null until prepared.
     */
    ballotSize: t.integer(),
    /**
     * Curated phase (`CuratedPicksUsed`, emitted just before `BallotPrepared`): picks checked
     * (`curatedDrawn`) and placed on the ballot (`curatedCount`), right after the pins. Null until
     * known; `BallotPrepared` sets both to 0 when no curated phase ran (no event is emitted then).
     */
    curatedDrawn: t.integer(),
    curatedCount: t.integer(),
    /**
     * `CurationSkipRequested`: from this time `prepareBallot` / `openEpoch` may skip the curated
     * phase (null: not requested). Until then a curated ballot should be prepared if the picks exist.
     */
    curationSkipAt: t.bigint(),
    /**
     * `LaunchSnapshotSet`: the token was registered in this epoch without supply at the regular
     * snapshot, so its weights for this epoch are read here (`snapshotFor(token, epoch)`).
     */
    launchSnapshot: t.bigint(),
    /** Cause share credited to this epoch's pool by `FeesAttributed` (all accrual epochs). */
    causeAttributed: t.bigint().notNull().default(0n),
    /** `Settled`: the pool paid to the distributor (null until settled). */
    settledAmount: t.bigint(),
    settledAt: t.bigint(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.epoch] }),
    winnerIdx: index().on(table.winningCauseId),
  }),
);

export const donation = onchainTable(
  "donation",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    causeId: t.hex().notNull(),
    payout: t.hex().notNull(),
    /** Gross USDC (6 decimals) sent to the org, before Endaoment's own fee. */
    amount: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
    causeIdx: index().on(table.causeId),
  }),
);

export const vote = onchainTable(
  "vote",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    voteRef: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    tokenEpochIdx: index().on(table.token, table.epoch),
  }),
);

/**
 * Epoch clock of the epoch governor. `epochZeroStart` is derived from the first `EpochOpened` or
 * `VoteCast`: both only happen during the current epoch, and epoch starts are multiples of one
 * week, so `floor(timestamp / week) * week - epoch * week` equals the contract's immutable.
 */
export const epochClock = onchainTable("epoch_clock", (t) => ({
  id: t.text().primaryKey(),
  epochZeroStart: t.bigint().notNull(),
  epochLength: t.bigint().notNull(),
}));

/**
 * Options frozen when an epoch's ballot was prepared, by ballot index. `orgId` is the catalogue org
 * id from `BallotPrepared` (`finalizeEpoch` of a voted epoch takes these back as calldata); it is
 * null only for a row first written by `EpochOpened`, which carries cause ids alone.
 */
export const epochOption = onchainTable(
  "epoch_option",
  (t) => ({
    token: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    index: t.integer().notNull(),
    causeId: t.hex().notNull(),
    orgId: t.hex(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.epoch, table.index] }),
  }),
);

/**
 * A token's own cause shortlist schedule, mirroring the governor: `causeIds` is the latest list
 * set, applying from epoch `effectiveFrom`; `previousCauseIds` applies before that. These are the
 * controller's pinned causes; the rest of each ballot is drawn from the token's focus pool. `effectiveFrom` is null only for rows written by the legacy
 * `ShortlistSet` before any `ShortlistScheduled` was seen (`scheduled` false).
 */
export const shortlist = onchainTable("shortlist", (t) => ({
  token: t.hex().primaryKey(),
  causeIds: t.hex().array().notNull(),
  effectiveFrom: t.bigint(),
  previousCauseIds: t.hex().array().notNull(),
  scheduled: t.boolean().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/**
 * The epoch governor's protocol ballot size cap (`BallotSizeCapSet`, 2..32; also emitted at
 * deployment). Absent: the default of 32.
 */
export const ballotSizeCap = onchainTable("ballot_size_cap", (t) => ({
  id: t.text().primaryKey(),
  cap: t.integer().notNull(),
  setAt: t.bigint().notNull(),
}));

/**
 * A token's own ballot size (`BallotSizeSet`): `choice` 0 follows the protocol cap, otherwise
 * 2..32 bounded by the cap. Like pins it is read when a ballot is prepared: it applies from epoch
 * `effectiveFrom` (the current one when its ballot was not prepared yet, else the next).
 */
export const tokenBallotSize = onchainTable("token_ballot_size", (t) => ({
  token: t.hex().primaryKey(),
  choice: t.integer().notNull(),
  effectiveFrom: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/** A published `CauseCatalog` version. It applies to epochs that start after `setAt`. */
export const catalogVersion = onchainTable("catalog_version", (t) => ({
  version: t.integer().primaryKey(),
  root: t.hex().notNull(),
  swarmRef: t.hex().notNull(),
  entries: t.bigint().notNull(),
  setAt: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/** A curator agent (`CuratorRegistry`), one per cause category. */
export const agent = onchainTable("agent", (t) => ({
  categoryBit: t.integer().primaryKey(),
  agentId: t.bigint().notNull(),
  /** ENS label under `agent.<parent>`. */
  label: t.text().notNull(),
  signer: t.hex().notNull(),
  vault: t.hex().notNull(),
  active: t.boolean().notNull(),
  description: t.text().notNull(),
  agentURI: t.text(),
  walletLinked: t.boolean().notNull().default(false),
  registeredAt: t.bigint().notNull(),
}));

/** Vault address -> category, so vault events find their agent. */
export const agentVault = onchainTable("agent_vault", (t) => ({
  vault: t.hex().primaryKey(),
  categoryBit: t.integer().notNull(),
}));

/** One region's picks root and weight for one epoch (`CurationSet`); the latest write wins. */
export const curation = onchainTable(
  "curation",
  (t) => ({
    bucket: t.integer().notNull(),
    epoch: t.bigint().notNull(),
    categoryBit: t.integer().notNull(),
    regionBit: t.integer().notNull(),
    picksRoot: t.hex().notNull(),
    count: t.integer().notNull(),
    weight: t.integer().notNull(),
    catalogVersion: t.integer().notNull(),
    submittedAt: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.bucket, table.epoch] }),
    categoryIdx: index().on(table.categoryBit, table.epoch),
  }),
);

/** An agent's weekly submission (`CurationsSubmitted`): the Swarm reference of the full report. */
export const curationReport = onchainTable(
  "curation_report",
  (t) => ({
    categoryBit: t.integer().notNull(),
    epoch: t.bigint().notNull(),
    catalogVersion: t.integer().notNull(),
    reportRef: t.hex().notNull(),
    submittedAt: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.categoryBit, table.epoch] }) }),
);

/** `AgentVault.Donated`. `donor` is stored only when the donor opted in to credit. */
export const vaultDonation = onchainTable(
  "vault_donation",
  (t) => ({
    id: t.text().primaryKey(),
    categoryBit: t.integer().notNull(),
    donor: t.hex(),
    amount: t.bigint().notNull(),
    credit: t.boolean().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ categoryIdx: index().on(table.categoryBit, table.timestamp) }),
);

/** `AgentVault.Given`: a gift to a catalogue org. */
export const vaultGift = onchainTable(
  "vault_gift",
  (t) => ({
    id: t.text().primaryKey(),
    categoryBit: t.integer().notNull(),
    epoch: t.bigint().notNull(),
    regionBit: t.integer().notNull(),
    orgId: t.hex().notNull(),
    org: t.hex().notNull(),
    amount: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({ categoryIdx: index().on(table.categoryBit, table.timestamp) }),
);

/** Running totals per agent (USDC, 6 decimals). Plain transfers to a vault are not counted here. */
export const agentTotal = onchainTable("agent_total", (t) => ({
  categoryBit: t.integer().primaryKey(),
  donated: t.bigint().notNull(),
  donations: t.integer().notNull(),
  given: t.bigint().notNull(),
  gifts: t.integer().notNull(),
}));

/** A token's cause focus, fixed at launch (`TokenProfileRegistry.FocusSet`). */
export const tokenFocus = onchainTable("token_focus", (t) => ({
  token: t.hex().primaryKey(),
  /** Category bit mask (uint64, as a decimal-safe bigint). */
  categoryMask: t.bigint().notNull(),
  regionMask: t.integer().notNull(),
  setAt: t.bigint().notNull(),
}));

/**
 * A poll on the voting scheme. `scope` is the epoch for the epoch governor and the proposal id
 * for the takeover governor. `counts` holds the verified per-option totals once final.
 */
export const poll = onchainTable(
  "poll",
  (t) => ({
    governor: t.hex().notNull(),
    token: t.hex().notNull(),
    scope: t.bigint().notNull(),
    scheme: t.hex().notNull(),
    optionCount: t.integer().notNull(),
    opened: t.boolean().notNull(),
    closed: t.boolean().notNull(),
    isFinal: t.boolean().notNull(),
    ballotCount: t.integer().notNull(),
    counts: t.bigint().array(),
    openedAt: t.bigint().notNull(),
    closedAt: t.bigint(),
    finalAt: t.bigint(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.governor, table.token, table.scope] }),
    tokenIdx: index().on(table.token),
  }),
);

/** A ballot recorded by the scheme. The voter and weight are public; the choice is not. */
export const ballot = onchainTable(
  "ballot",
  (t) => ({
    ballotRef: t.hex().primaryKey(),
    governor: t.hex().notNull(),
    token: t.hex().notNull(),
    scope: t.bigint().notNull(),
    voter: t.hex().notNull(),
    /** Whole tokens at the poll's snapshot. */
    weight: t.bigint().notNull(),
    castAt: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    pollIdx: index().on(table.governor, table.token, table.scope),
  }),
);

/**
 * A community takeover proposal. `executionDeadline` comes from `getProposal` at the proposal
 * block (falling back to `end + params().executionWindow`); null when neither read succeeded.
 * Several proposals of one token may be pending at once (the cooldown is per proposer).
 */
export const takeoverProposal = onchainTable(
  "takeover_proposal",
  (t) => ({
    proposalId: t.bigint().primaryKey(),
    token: t.hex().notNull(),
    proposer: t.hex().notNull(),
    newController: t.hex().notNull(),
    start: t.bigint().notNull(),
    end: t.bigint().notNull(),
    snapshot: t.bigint().notNull(),
    executionDeadline: t.bigint(),
    /** From `getProposal`: holding-lookback snapshot and circulating weight (null if unread). */
    lookbackSnapshot: t.bigint(),
    circulatingWeight: t.bigint(),
    quorumWeight: t.bigint().notNull(),
    forWeight: t.bigint().notNull(),
    againstWeight: t.bigint().notNull(),
    ballotCount: t.integer().notNull(),
    closed: t.boolean().notNull(),
    tallied: t.boolean().notNull(),
    executed: t.boolean().notNull(),
    canceled: t.boolean().notNull(),
    createdAt: t.bigint().notNull(),
    closedAt: t.bigint(),
    talliedAt: t.bigint(),
    executedAt: t.bigint(),
    canceledAt: t.bigint(),
    txHash: t.hex().notNull(),
    /**
     * Executions of the token's takeovers when this proposal was created. Once another proposal
     * of the token executes, `takeover_token.executions` moves past it and a still-pending
     * proposal is `Superseded`, exactly as the contract's generation check.
     */
    generation: t.integer().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
  }),
);

/** Executed takeovers per token (`TakeoverSuperseded` count). */
export const takeoverToken = onchainTable("takeover_token", (t) => ({
  token: t.hex().primaryKey(),
  executions: t.integer().notNull(),
  lastExecutedProposalId: t.bigint(),
}));

export const takeoverVote = onchainTable(
  "takeover_vote",
  (t) => ({
    voteRef: t.hex().primaryKey(),
    token: t.hex().notNull(),
    proposalId: t.bigint().notNull(),
    castAt: t.bigint().notNull(),
  }),
  (table) => ({
    proposalIdx: index().on(table.proposalId),
  }),
);

// ---- live-donation mode

/** The factory's live-donation mode (`LiveModeConfigured`, emitted once). */
export const liveMode = onchainTable("live_mode", (t) => ({
  id: t.text().primaryKey(),
  liveHook: t.hex().notNull(),
  liveVault: t.hex().notNull(),
  configuredAt: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/**
 * A live-donation token. Created by whichever launch event comes first: the hook's
 * `TokenConfigured`, then the vault's `LiveTokenRegistered`, then the hook's `PoolRegistered`, all
 * before the factory's `TokenCreated` in the same transaction. Totals are in `live_cause_total`.
 */
export const liveToken = onchainTable("live_token", (t) => ({
  token: t.hex().primaryKey(),
  /** Hook fee configuration (`TokenConfigured`). */
  baseFeeBps: t.integer(),
  launchSurchargeBps: t.integer(),
  surchargeDecaySeconds: t.integer(),
  launchTimestamp: t.bigint(),
  /** Vault registration (`LiveTokenRegistered`): cause credit at which a swap pushes; 0 = every swap. */
  threshold: t.bigint(),
  initialCause: t.hex(),
  /** `RotationPeriod` chosen at launch (0 = 1h, 1 = 12h, 2 = 1d, 3 = 3d, 4 = 1w). */
  initialPeriod: t.integer(),
  registeredAt: t.bigint(),
  /** Pool (`PoolRegistered`). */
  quote: t.hex(),
  poolId: t.hex(),
  createdAt: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/**
 * Per (token, cause) ledger: `causeShare` credited (`Credited`), `donated` sent to the org
 * (`Donated`), `pending = causeShare - donated` still in the vault, and the quote held by the
 * hook for that cause (`FeeTaken` not converted, minus `HeldRetried`).
 */
export const liveCauseTotal = onchainTable(
  "live_cause_total",
  (t) => ({
    token: t.hex().notNull(),
    causeId: t.hex().notNull(),
    gross: t.bigint().notNull(),
    platform: t.bigint().notNull(),
    causeShare: t.bigint().notNull(),
    credits: t.integer().notNull(),
    donated: t.bigint().notNull(),
    donations: t.integer().notNull(),
    heldQuote: t.bigint().notNull(),
    deferrals: t.integer().notNull(),
    lastDeferReason: t.hex(),
    lastCreditedAt: t.bigint(),
    lastDonatedAt: t.bigint(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.causeId] }),
    tokenIdx: index().on(table.token),
  }),
);

/** One swap fee of a live token (`FeeTaken`): converted to `usdcOut`, or held (`failure`). */
export const liveFee = onchainTable(
  "live_fee",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    causeId: t.hex().notNull(),
    rotation: t.bigint().notNull(),
    quote: t.hex().notNull(),
    quoteAmount: t.bigint().notNull(),
    usdcOut: t.bigint().notNull(),
    converted: t.boolean().notNull(),
    failure: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token, table.timestamp),
  }),
);

/** A held fee converted later (`HeldRetried`). */
export const liveHeldRetry = onchainTable(
  "live_held_retry",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    causeId: t.hex().notNull(),
    caller: t.hex().notNull(),
    quoteIn: t.bigint().notNull(),
    usdcOut: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token),
  }),
);

/** A donation from the live vault to a cause's org (`Donated`), in a swap or by `flush`. */
export const liveDonation = onchainTable(
  "live_donation",
  (t) => ({
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    causeId: t.hex().notNull(),
    org: t.hex().notNull(),
    amount: t.bigint().notNull(),
    orgDeployed: t.boolean().notNull(),
    inSwap: t.boolean().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenIdx: index().on(table.token, table.timestamp),
    causeIdx: index().on(table.causeId),
  }),
);

/** Live vault platform share: accrued from `Credited`, withdrawn by `PlatformWithdrawn`. */
export const liveVaultTotal = onchainTable("live_vault_total", (t) => ({
  id: t.text().primaryKey(),
  platformAccrued: t.bigint().notNull(),
  platformWithdrawn: t.bigint().notNull(),
  withdrawals: t.integer().notNull(),
  skims: t.integer().notNull(),
}));

/** `FeeConsolidator.ClaimsConverted`: a source's ERC-6909 claims paid out as USDC. */
export const claimsConversion = onchainTable(
  "claims_conversion",
  (t) => ({
    id: t.text().primaryKey(),
    source: t.hex().notNull(),
    currency: t.hex().notNull(),
    to: t.hex().notNull(),
    amountIn: t.bigint().notNull(),
    settlementOut: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    sourceIdx: index().on(table.source),
  }),
);

/**
 * Rotation schedule of a live token, mirroring `RotationScheduleLib.Schedule` (RotationGovernor
 * `TokenRegistered` and `PeriodChangeScheduled`). Rotation `n` starts at `startOf(n)`.
 */
export const liveSchedule = onchainTable("live_schedule", (t) => ({
  token: t.hex().primaryKey(),
  anchorTime: t.bigint().notNull(),
  anchorIndex: t.bigint().notNull(),
  period: t.integer().notNull(),
  hasPending: t.boolean().notNull(),
  pendingPeriod: t.integer().notNull(),
  pendingFrom: t.bigint().notNull(),
  /** Start of rotation `pendingFrom` (null without a pending change). */
  switchAt: t.bigint(),
  periodChanges: t.integer().notNull(),
}));

/**
 * The cause that receives a live token's fees from rotation `fromRotation` on (`startsAt`): the
 * initial cause at rotation 0 (`TokenRegistered`), then each `CauseScheduled`. A later schedule
 * for the same rotation replaces the row.
 */
export const liveCauseSchedule = onchainTable(
  "live_cause_schedule",
  (t) => ({
    token: t.hex().notNull(),
    fromRotation: t.bigint().notNull(),
    causeId: t.hex().notNull(),
    startsAt: t.bigint().notNull(),
    scheduledAt: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.fromRotation] }),
  }),
);

/** Outcome of a rotation poll (`RoundFinalized`). `status` is the `RoundStatus` name. */
export const liveRound = onchainTable(
  "live_round",
  (t) => ({
    token: t.hex().notNull(),
    target: t.bigint().notNull(),
    status: t.text().notNull(),
    winner: t.hex().notNull(),
    effectiveFrom: t.bigint().notNull(),
    finalizedAt: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.target] }),
  }),
);

/**
 * Frozen ballot of a rotation poll (`BallotPrepared`): `options` are cause ids, the first
 * `pinned` of them the token's pins, then `curatedIncluded` curated picks, then rotation draws.
 * The curated counts come from a `CuratedPicksUsed` earlier in the same transaction (0 without
 * one, and `curationEpoch` null). With fewer than two options the round ends `NoBallot`.
 */
export const liveBallot = onchainTable(
  "live_ballot",
  (t) => ({
    token: t.hex().notNull(),
    target: t.bigint().notNull(),
    catalogVersion: t.integer().notNull(),
    poolSize: t.bigint().notNull(),
    pinned: t.integer().notNull(),
    options: t.hex().array().notNull(),
    curationEpoch: t.bigint(),
    curatedDrawn: t.integer().notNull(),
    curatedIncluded: t.integer().notNull(),
    preparedAt: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.target] }),
  }),
);

export const tokenRelations = relations(token, ({ many, one }) => ({
  feeTotals: many(feeTotal),
  epochs: many(epoch),
  donations: many(donation),
  textRecords: many(tokenTextRecord),
  takeovers: many(takeoverProposal),
  profile: one(tokenProfile, { fields: [token.address], references: [tokenProfile.token] }),
  shortlist: one(shortlist, { fields: [token.address], references: [shortlist.token] }),
}));

export const tokenTextRecordRelations = relations(tokenTextRecord, ({ one }) => ({
  tokenRef: one(token, { fields: [tokenTextRecord.token], references: [token.address] }),
}));

export const takeoverProposalRelations = relations(takeoverProposal, ({ one, many }) => ({
  tokenRef: one(token, { fields: [takeoverProposal.token], references: [token.address] }),
  votes: many(takeoverVote),
}));

export const takeoverVoteRelations = relations(takeoverVote, ({ one }) => ({
  proposal: one(takeoverProposal, {
    fields: [takeoverVote.proposalId],
    references: [takeoverProposal.proposalId],
  }),
}));

export const epochOptionRelations = relations(epochOption, ({ one }) => ({
  causeRef: one(cause, { fields: [epochOption.causeId], references: [cause.causeId] }),
}));

export const feeTotalRelations = relations(feeTotal, ({ one }) => ({
  tokenRef: one(token, { fields: [feeTotal.token], references: [token.address] }),
}));

export const epochRelations = relations(epoch, ({ one }) => ({
  tokenRef: one(token, { fields: [epoch.token], references: [token.address] }),
  winnerCause: one(cause, { fields: [epoch.winningCauseId], references: [cause.causeId] }),
}));

export const donationRelations = relations(donation, ({ one }) => ({
  tokenRef: one(token, { fields: [donation.token], references: [token.address] }),
  causeRef: one(cause, { fields: [donation.causeId], references: [cause.causeId] }),
}));

// ---- Market data: holders and trades, from each Varada token's own `Transfer` events.

/**
 * Running balance of every account that has held a Varada token. Rows that fall to zero are kept
 * (so `firstSeenAt` survives a sell-out and re-buy); `holder_stat.holders` counts nonzero rows.
 * Mints and burns (the zero address) only move `holder_stat.supply`.
 */
export const holder = onchainTable(
  "holder",
  (t) => ({
    token: t.hex().notNull(),
    account: t.hex().notNull(),
    balance: t.bigint().notNull(),
    firstSeenAt: t.bigint().notNull(),
    lastActiveAt: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.account] }),
    tokenBalanceIdx: index().on(table.token, table.balance),
  }),
);

/** Per-token holder totals. */
export const holderStat = onchainTable("holder_stat", (t) => ({
  token: t.hex().primaryKey(),
  /** Accounts with a nonzero balance (contracts included; the API labels the known ones). */
  holders: t.integer().notNull(),
  transfers: t.integer().notNull(),
  /** Minted minus burned. */
  supply: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
}));

/** Holder count at the end of each UTC day that saw a transfer (gaps carry the last value). */
export const holderDay = onchainTable(
  "holder_day",
  (t) => ({
    token: t.hex().notNull(),
    /** Unix seconds of 00:00 UTC. */
    day: t.bigint().notNull(),
    holders: t.integer().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.token, table.day] }) }),
);

/**
 * Pool side of a token, resolved on its first trade: the quote asset (`VaradaFactory.quoteAssetOf`)
 * and whether the token sorts as currency0 of the v4 pool.
 */
export const tokenMarket = onchainTable("token_market", (t) => ({
  token: t.hex().primaryKey(),
  pool: t.hex().notNull(),
  quote: t.hex().notNull(),
  tokenIsCurrency0: t.boolean().notNull(),
}));

/**
 * One PoolManager `Swap` on a Varada pool, found in the receipt of a transaction that moved the
 * token in or out of the PoolManager. Amounts are unsigned and before hook fees taken as deltas.
 * `trader` is the transaction sender (for a smart account that is the bundler); `sender` is the
 * contract that called `swap` (router, fee consolidator…).
 */
export const trade = onchainTable(
  "trade",
  (t) => ({
    /** `<txHash>-<logIndex>` of the Swap log. */
    id: t.text().primaryKey(),
    token: t.hex().notNull(),
    pool: t.hex().notNull(),
    /** "buy" (token out of the pool) or "sell". */
    side: t.text().notNull(),
    trader: t.hex().notNull(),
    sender: t.hex().notNull(),
    tokenAmount: t.bigint().notNull(),
    quote: t.hex().notNull(),
    quoteAmount: t.bigint().notNull(),
    sqrtPriceX96: t.bigint().notNull(),
    tick: t.integer().notNull(),
    /** LP fee of the swap, hundredths of a bip. */
    feePips: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    tokenTsIdx: index().on(table.token, table.timestamp),
    traderIdx: index().on(table.trader),
  }),
);

/** Trades per token per UTC hour: counts, volumes and the tick range (for candles and pressure). */
export const tradeHour = onchainTable(
  "trade_hour",
  (t) => ({
    token: t.hex().notNull(),
    /** Unix seconds at the start of the hour. */
    hour: t.bigint().notNull(),
    buys: t.integer().notNull(),
    sells: t.integer().notNull(),
    buyQuote: t.bigint().notNull(),
    sellQuote: t.bigint().notNull(),
    buyToken: t.bigint().notNull(),
    sellToken: t.bigint().notNull(),
    openTick: t.integer().notNull(),
    highTick: t.integer().notNull(),
    lowTick: t.integer().notNull(),
    closeTick: t.integer().notNull(),
    closeSqrtPriceX96: t.bigint().notNull(),
  }),
  (table) => ({ pk: primaryKey({ columns: [table.token, table.hour] }) }),
);

/** Lifetime trade totals and the latest pool price per token. */
export const tradeStat = onchainTable("trade_stat", (t) => ({
  token: t.hex().primaryKey(),
  trades: t.integer().notNull(),
  buys: t.integer().notNull(),
  sells: t.integer().notNull(),
  volumeQuote: t.bigint().notNull(),
  volumeToken: t.bigint().notNull(),
  lastSqrtPriceX96: t.bigint().notNull(),
  lastTick: t.integer().notNull(),
  lastTradeAt: t.bigint().notNull(),
}));
