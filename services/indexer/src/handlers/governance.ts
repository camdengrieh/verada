import type { Context, Event } from "ponder:registry";
import { DEFAULT_EPOCH_LENGTH, MAX_BALLOT_OPTIONS, causeIdOfOrg, effectiveBallotSize } from "@varada/sdk";
import {
  ballotSizeCap,
  donation,
  epoch,
  epochOption,
  epochSchedule,
  orgDeployment,
  poll,
  shortlist,
  timingSetting,
  tokenBallotSize,
  vote,
} from "ponder:schema";

type EpochDb = Context["db"];
type Hex = `0x${string}`;

/** Returns the `(token, epoch)` row, inserting an empty one first if needed. */
export async function ensureEpoch(db: EpochDb, token: Hex, epochNo: bigint) {
  const key = { token, epoch: epochNo };
  const row = await db.find(epoch, key);
  if (row) return row;
  await db.insert(epoch).values({
    ...key,
    voteCount: 0,
    opened: false,
    closed: false,
    voterCount: 0,
    fallbackApplied: false,
    fallbackReason: null,
    closeFailed: false,
    causeAttributed: 0n,
  });
  return (await db.find(epoch, key))!;
}

/**
 * Makes sure segment 0 of the epoch schedule exists: the constructor's default, anchored at the
 * governor's immutable `epochZeroStart` (read from the chain; nothing here assumes a length or a
 * week alignment beyond the 7 day defaults the constructor applies, which an `EpochScheduleSet`
 * for epoch 0 overwrites). Called by every handler that proves the governor is live; a failed read
 * is retried by the next one, and the API reports no timing until then.
 */
async function ensureSchedule(
  context: { db: EpochDb; client: Context["client"]; contracts: Context["contracts"] },
  governor: Hex,
) {
  if (await context.db.find(epochSchedule, { startEpoch: 0n })) return;
  let zero: bigint;
  try {
    zero = BigInt(
      (await context.client.readContract({
        abi: context.contracts.EpochGovernor.abi,
        address: governor,
        functionName: "epochZeroStart",
      })) as bigint,
    );
  } catch {
    return;
  }
  await context.db
    .insert(epochSchedule)
    .values({
      startEpoch: 0n,
      startTime: zero,
      length: DEFAULT_EPOCH_LENGTH,
      votingWindow: DEFAULT_EPOCH_LENGTH,
      holdWindow: DEFAULT_EPOCH_LENGTH,
      setAt: null,
    })
    .onConflictDoNothing();
}

/**
 * `EpochScheduleSet(startEpoch, startTime, length, votingWindow, holdWindow)`: from epoch
 * `startEpoch` the epochs last `length`, accept ballots in their last `votingWindow` and weigh over
 * `holdWindow`. Mirrors `setEpochSchedule`: a change for the same `startEpoch` replaces the stored
 * segment (the pending one, or epoch zero re-anchored before any token registered), any other adds
 * one. A segment past epoch 0 needs the constructor default under it, so that is ensured first.
 */
export async function onEpochScheduleSet({
  event,
  context,
}: {
  event: Event<"EpochGovernor:EpochScheduleSet">;
  context: Context<"EpochGovernor:EpochScheduleSet">;
}) {
  const { startEpoch, startTime, length, votingWindow, holdWindow } = event.args;
  if (startEpoch > 0n) await ensureSchedule(context, event.log.address);
  const values = { startTime, length, votingWindow, holdWindow, setAt: event.block.timestamp };
  if (await context.db.find(epochSchedule, { startEpoch })) {
    await context.db.update(epochSchedule, { startEpoch }).set(values);
  } else {
    await context.db.insert(epochSchedule).values({ startEpoch, ...values });
  }
}

async function setTiming(db: EpochDb, id: string, value: bigint, at: bigint) {
  if (await db.find(timingSetting, { id })) await db.update(timingSetting, { id }).set({ value, setAt: at });
  else await db.insert(timingSetting).values({ id, value, setAt: at });
}

/** `TallyGraceSet(grace)`: applies at once. */
export async function onTallyGraceSet({
  event,
  context,
}: {
  event: Event<"EpochGovernor:TallyGraceSet">;
  context: Context<"EpochGovernor:TallyGraceSet">;
}) {
  await setTiming(context.db, "tallyGrace", event.args.grace, event.block.timestamp);
}

/** `LaunchSnapshotDelaySet(delay)`: applies to tokens registered afterwards. */
export async function onLaunchSnapshotDelaySet({
  event,
  context,
}: {
  event: Event<"EpochGovernor:LaunchSnapshotDelaySet">;
  context: Context<"EpochGovernor:LaunchSnapshotDelaySet">;
}) {
  await setTiming(context.db, "launchSnapshotDelay", event.args.delay, event.block.timestamp);
}

/** `CurationGraceSet(grace)`. */
export async function onCurationGraceSet({
  event,
  context,
}: {
  event: Event<"EpochGovernor:CurationGraceSet">;
  context: Context<"EpochGovernor:CurationGraceSet">;
}) {
  await setTiming(context.db, "curationGrace", event.args.grace, event.block.timestamp);
}

/** `FeeVault.SettleGraceSet(grace)`: applies at once. */
export async function onSettleGraceSet({
  event,
  context,
}: {
  event: Event<"FeeVault:SettleGraceSet">;
  context: Context<"FeeVault:SettleGraceSet">;
}) {
  await setTiming(context.db, "settleGrace", event.args.grace, event.block.timestamp);
}

export async function onVoteCast({
  event,
  context,
}: {
  event: Event<"EpochGovernor:VoteCast">;
  context: Context<"EpochGovernor:VoteCast">;
}) {
  const { token, epoch: epochNo, voteRef } = event.args;
  await context.db.insert(vote).values({
    id: event.id,
    token,
    epoch: epochNo,
    voteRef,
    timestamp: event.block.timestamp,
  });
  const row = await ensureEpoch(context.db, token, epochNo);
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ voteCount: row.voteCount + 1, voterCount: row.voterCount + 1 });
  await ensureSchedule(context, event.log.address);
}

export async function onEpochOpened({
  event,
  context,
}: {
  event: Event<"EpochGovernor:EpochOpened">;
  context: Context<"EpochGovernor:EpochOpened">;
}) {
  const { token, epoch: epochNo, options } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  for (const [index, causeId] of options.entries()) {
    await context.db
      .insert(epochOption)
      .values({ token, epoch: epochNo, index, causeId })
      .onConflictDoNothing();
  }
  // The scheme opened its poll just before, in the same call; null if that scheme is not indexed.
  const p = await context.db.find(poll, { governor: event.log.address, token, scope: epochNo });
  await context.db.update(epoch, { token, epoch: epochNo }).set({
    opened: true,
    openedAt: event.block.timestamp,
    governor: event.log.address,
    scheme: p?.scheme ?? null,
  });
  await ensureSchedule(context, event.log.address);
}

/**
 * A token registered without supply at its launch epoch's regular snapshot gets a snapshot inside
 * that epoch; `snapshotFor(token, epoch)` returns it instead of `snapshotOf(epoch)`. Emitted by
 * `registerToken` during the epoch it names, so it also anchors the schedule.
 */
export async function onLaunchSnapshotSet({
  event,
  context,
}: {
  event: Event<"EpochGovernor:LaunchSnapshotSet">;
  context: Context<"EpochGovernor:LaunchSnapshotSet">;
}) {
  const { token, epoch: epochNo, snapshot } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  await context.db.update(epoch, { token, epoch: epochNo }).set({ launchSnapshot: snapshot });
  await ensureSchedule(context, event.log.address);
}

/**
 * Curated phase of the ballot: `drawn` picks were checked and `included` of them placed right
 * after the pins. Emitted only when the phase consumed a pick, just before `BallotPrepared` in the
 * same transaction.
 */
export async function onCuratedPicksUsed({
  event,
  context,
}: {
  event: Event<"EpochGovernor:CuratedPicksUsed">;
  context: Context<"EpochGovernor:CuratedPicksUsed">;
}) {
  const { token, epoch: epochNo, drawn, included } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ curatedDrawn: Number(drawn), curatedCount: Number(included) });
}

/**
 * Someone asked for the epoch's ballot to skip curator picks they could not obtain; the skip applies
 * from `skipAt`. Counts as activity, so the keeper prepares the curated ballot first when it can.
 */
export async function onCurationSkipRequested({
  event,
  context,
}: {
  event: Event<"EpochGovernor:CurationSkipRequested">;
  context: Context<"EpochGovernor:CurationSkipRequested">;
}) {
  const { token, epoch: epochNo, skipAt } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  await context.db.update(epoch, { token, epoch: epochNo }).set({ curationSkipAt: skipAt });
}

/**
 * The epoch's ballot is fixed: pins first, then curated picks, then rotation draws. The event
 * carries the options' catalogue org ids (the governor keeps only their commitment, so this log is
 * where they live); cause ids are `keccak256(orgId)`. Options are stored here as well as on
 * `EpochOpened`, because a ballot with fewer than two options is prepared but never opened. A
 * `CuratedPicksUsed` earlier in the transaction already stored the curated counts; without one no curated pick was used, so they are 0.
 */
export async function onBallotPrepared({
  event,
  context,
}: {
  event: Event<"EpochGovernor:BallotPrepared">;
  context: Context<"EpochGovernor:BallotPrepared">;
}) {
  const { token, epoch: epochNo, catalogVersion, poolSize, pinned, orgIds } = event.args;
  const row = await ensureEpoch(context.db, token, epochNo);
  // The governor reads the cap and the token's choice in this same transaction.
  const cap = (await context.db.find(ballotSizeCap, { id: BALLOT_SIZE_CAP_ID }))?.cap ?? MAX_BALLOT_OPTIONS;
  const choice = (await context.db.find(tokenBallotSize, { token }))?.choice ?? 0;
  for (const [index, orgId] of orgIds.entries()) {
    await context.db
      .insert(epochOption)
      .values({ token, epoch: epochNo, index, causeId: causeIdOfOrg(orgId), orgId })
      .onConflictDoNothing();
  }
  await context.db.update(epoch, { token, epoch: epochNo }).set({
    prepared: true,
    preparedAt: event.block.timestamp,
    catalogVersion: Number(catalogVersion),
    poolSize,
    pinnedCount: Number(pinned),
    ballotSize: effectiveBallotSize({ cap, choice }),
    curatedDrawn: row.curatedDrawn ?? 0,
    curatedCount: row.curatedCount ?? 0,
  });
  await ensureSchedule(context, event.log.address);
}

export async function onEpochClosed({
  event,
  context,
}: {
  event: Event<"EpochGovernor:EpochClosed">;
  context: Context<"EpochGovernor:EpochClosed">;
}) {
  const { token, epoch: epochNo } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  // A successful (re)close requests the tally; it clears an earlier failure.
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ closed: true, closedAt: event.block.timestamp, closeFailed: false });
}

export async function onEpochCloseFailed({
  event,
  context,
}: {
  event: Event<"EpochGovernor:EpochCloseFailed">;
  context: Context<"EpochGovernor:EpochCloseFailed">;
}) {
  const { token, epoch: epochNo } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  // On-chain the epoch counts as closed but may be closed again; no tally was requested.
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ closed: true, closeFailed: true });
}

export async function onNoVoteFallbackApplied({
  event,
  context,
}: {
  event: Event<"EpochGovernor:NoVoteFallbackApplied">;
  context: Context<"EpochGovernor:NoVoteFallbackApplied">;
}) {
  const { token, epoch: epochNo } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  // `EpochFinalized` follows in the same transaction and stores the winner.
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ fallbackApplied: true, fallbackReason: "no_votes" });
}

export async function onTallyTimeoutFallbackApplied({
  event,
  context,
}: {
  event: Event<"EpochGovernor:TallyTimeoutFallbackApplied">;
  context: Context<"EpochGovernor:TallyTimeoutFallbackApplied">;
}) {
  const { token, epoch: epochNo } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  // Ballots were cast but no valid tally arrived within the grace period.
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ fallbackApplied: true, fallbackReason: "timeout" });
}

interface Schedule {
  causeIds: Hex[];
  effectiveFrom: bigint | null;
  previousCauseIds: Hex[];
}

/**
 * Applies a `*Scheduled(effectiveFrom, causes)` to the stored schedule like `_schedule` does.
 * The governor returns the current epoch (immediate) or the next one, so the current epoch is
 * at least `effectiveFrom - 1`: an older list scheduled from before that is in effect now and
 * becomes the previous list; otherwise the previous list stays (an unapplied list is replaced).
 */
export function nextSchedule(old: Schedule | null, causes: readonly Hex[], from: bigint): Schedule {
  const oldInEffect = old?.effectiveFrom != null && old.effectiveFrom <= from - 1n;
  return {
    causeIds: [...causes],
    effectiveFrom: from,
    previousCauseIds: oldInEffect ? old!.causeIds : (old?.previousCauseIds ?? []),
  };
}

export const BALLOT_SIZE_CAP_ID = "epoch_governor";

export async function onBallotSizeCapSet({
  event,
  context,
}: {
  event: Event<"EpochGovernor:BallotSizeCapSet">;
  context: Context<"EpochGovernor:BallotSizeCapSet">;
}) {
  const key = { id: BALLOT_SIZE_CAP_ID };
  const values = { cap: Number(event.args.cap), setAt: event.block.timestamp };
  if (await context.db.find(ballotSizeCap, key)) await context.db.update(ballotSizeCap, key).set(values);
  else await context.db.insert(ballotSizeCap).values({ ...key, ...values });
}

export async function onBallotSizeSet({
  event,
  context,
}: {
  event: Event<"EpochGovernor:BallotSizeSet">;
  context: Context<"EpochGovernor:BallotSizeSet">;
}) {
  const { token, size, effectiveFrom } = event.args;
  const values = { choice: Number(size), effectiveFrom, updatedAt: event.block.timestamp };
  if (await context.db.find(tokenBallotSize, { token })) await context.db.update(tokenBallotSize, { token }).set(values);
  else await context.db.insert(tokenBallotSize).values({ token, ...values });
}

/** Legacy event, emitted just before `ShortlistScheduled`; only used until that is seen. */
export async function onShortlistSet({
  event,
  context,
}: {
  event: Event<"EpochGovernor:ShortlistSet">;
  context: Context<"EpochGovernor:ShortlistSet">;
}) {
  const { token, causes } = event.args;
  const row = await context.db.find(shortlist, { token });
  if (row?.scheduled) return;
  const patch = { causeIds: [...causes], updatedAt: event.block.timestamp };
  if (row) await context.db.update(shortlist, { token }).set(patch);
  else {
    await context.db
      .insert(shortlist)
      .values({ token, ...patch, effectiveFrom: null, previousCauseIds: [], scheduled: false });
  }
}

export async function onShortlistScheduled({
  event,
  context,
}: {
  event: Event<"EpochGovernor:ShortlistScheduled">;
  context: Context<"EpochGovernor:ShortlistScheduled">;
}) {
  const { token, effectiveFrom, causes } = event.args;
  const row = await context.db.find(shortlist, { token });
  const next = { ...nextSchedule(row, causes, effectiveFrom), scheduled: true, updatedAt: event.block.timestamp };
  if (row) await context.db.update(shortlist, { token }).set(next);
  else await context.db.insert(shortlist).values({ token, ...next });
  await ensureSchedule(context, event.log.address);
}

export async function onEpochFinalized({
  event,
  context,
}: {
  event: Event<"EpochGovernor:EpochFinalized">;
  context: Context<"EpochGovernor:EpochFinalized">;
}) {
  const { token, epoch: epochNo, causeId } = event.args;
  await ensureEpoch(context.db, token, epochNo);
  await context.db
    .update(epoch, { token, epoch: epochNo })
    .set({ winningCauseId: causeId, finalizedAt: event.block.timestamp });
}

export async function onDonated({
  event,
  context,
}: {
  event: Event<"DonationDistributor:Donated">;
  context: Context<"DonationDistributor:Donated">;
}) {
  const { token, epoch: epochNo, causeId, payout, amount } = event.args;
  await context.db.insert(donation).values({
    id: event.id,
    token,
    epoch: epochNo,
    causeId,
    payout,
    amount,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  const row = await ensureEpoch(context.db, token, epochNo);
  await context.db.update(epoch, { token, epoch: epochNo }).set({
    donatedAmount: (row.donatedAmount ?? 0n) + amount,
    donatedPayout: payout,
    donatedAt: event.block.timestamp,
  });
}

export async function onOrgDeployed({
  event,
  context,
}: {
  event: Event<"DonationDistributor:OrgDeployed">;
  context: Context<"DonationDistributor:OrgDeployed">;
}) {
  const { orgId, org } = event.args;
  await context.db
    .insert(orgDeployment)
    .values({ orgId, org, deployedAt: event.block.timestamp, txHash: event.transaction.hash })
    .onConflictDoNothing();
}
