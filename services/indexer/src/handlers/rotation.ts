import type { Context, Event } from "ponder:registry";
import { liveBallot, liveCauseSchedule, liveRound, liveSchedule } from "ponder:schema";
import { sync } from "../rotation-schedule";

// RotationGovernor: the events that move a live token's designated cause or its rotation period,
// plus each round's frozen ballot. Votes, poll opening/closing and period proposals are not
// indexed here. Keep every RotationGovernor handler in this file.

/** `IRotationGovernor.RoundStatus` enum order. */
export const ROUND_STATUSES = ["None", "Open", "Closed", "NoChange", "Applied", "Stale", "InactiveWinner", "NoBallot"] as const;

/** Registration fixes rotation 0: the initial cause, the period and the schedule anchor. */
export async function onRotationTokenRegistered({ event, context }: { event: Event<"RotationGovernor:TokenRegistered">; context: Context<"RotationGovernor:TokenRegistered"> }) {
  const { token, initialCause, period, anchorTime } = event.args;
  await context.db
    .insert(liveSchedule)
    .values({
      token,
      anchorTime,
      anchorIndex: 0n,
      period: Number(period),
      hasPending: false,
      pendingPeriod: 0,
      pendingFrom: 0n,
      switchAt: null,
      periodChanges: 0,
    })
    .onConflictDoNothing();
  await context.db
    .insert(liveCauseSchedule)
    .values({ token, fromRotation: 0n, causeId: initialCause, startsAt: anchorTime, scheduledAt: event.block.timestamp, txHash: event.transaction.hash })
    .onConflictDoNothing();
}

/** `causeId` receives the fees from `fromRotation`. Re-scheduling the same boundary replaces it. */
export async function onCauseScheduled({ event, context }: { event: Event<"RotationGovernor:CauseScheduled">; context: Context<"RotationGovernor:CauseScheduled"> }) {
  const { token, causeId, fromRotation, startsAt } = event.args;
  const key = { token, fromRotation };
  const row = { causeId, startsAt, scheduledAt: event.block.timestamp, txHash: event.transaction.hash };
  if (await context.db.find(liveCauseSchedule, key)) await context.db.update(liveCauseSchedule, key).set(row);
  else await context.db.insert(liveCauseSchedule).values({ ...key, ...row });
}

export async function onRoundFinalized({ event, context }: { event: Event<"RotationGovernor:RoundFinalized">; context: Context<"RotationGovernor:RoundFinalized"> }) {
  const { token, target, status, winner, effectiveFrom } = event.args;
  const key = { token, target };
  const row = {
    status: ROUND_STATUSES[Number(status)] ?? String(status),
    winner,
    effectiveFrom,
    finalizedAt: event.block.timestamp,
    txHash: event.transaction.hash,
  };
  if (await context.db.find(liveRound, key)) await context.db.update(liveRound, key).set(row);
  else await context.db.insert(liveRound).values({ ...key, ...row });
}

/**
 * A passed period proposal: `newPeriod` applies from rotation `fromRotation` (starting at
 * `switchAt`). Mirrors `RotationScheduleLib.schedule`: sync, then replace any pending change.
 */
export async function onPeriodChangeScheduled({ event, context }: { event: Event<"RotationGovernor:PeriodChangeScheduled">; context: Context<"RotationGovernor:PeriodChangeScheduled"> }) {
  const { token, newPeriod, fromRotation, switchAt } = event.args;
  const cur = await context.db.find(liveSchedule, { token });
  if (!cur) return;
  const s = sync(cur, event.block.timestamp);
  await context.db.update(liveSchedule, { token }).set({
    anchorTime: s.anchorTime,
    anchorIndex: s.anchorIndex,
    period: s.period,
    hasPending: true,
    pendingPeriod: Number(newPeriod),
    pendingFrom: fromRotation,
    switchAt,
    periodChanges: cur.periodChanges + 1,
  });
}

/**
 * Curated phase of round `target`: `drawn` picks checked, `included` placed after the pins, from
 * weekly epoch `curationEpoch`. Emitted only when the phase consumed a pick, just before
 * `BallotPrepared` in the same transaction, which fills in the rest of the row.
 */
export async function onRotationCuratedPicksUsed({ event, context }: { event: Event<"RotationGovernor:CuratedPicksUsed">; context: Context<"RotationGovernor:CuratedPicksUsed"> }) {
  const { token, target, curationEpoch, drawn, included } = event.args;
  const key = { token, target };
  const curated = { curationEpoch, curatedDrawn: Number(drawn), curatedIncluded: Number(included) };
  if (await context.db.find(liveBallot, key)) await context.db.update(liveBallot, key).set(curated);
  else
    await context.db.insert(liveBallot).values({
      ...key,
      ...curated,
      catalogVersion: 0,
      poolSize: 0n,
      pinned: 0,
      options: [],
      preparedAt: event.block.timestamp,
      txHash: event.transaction.hash,
    });
}

/**
 * Round `target`'s ballot is frozen (`prepareRound` / `prepareCuratedRound`): `options` are cause
 * ids, pins first, then curated picks, then rotation draws. Prepared once per round; a ballot with
 * fewer than two options is followed by `RoundFinalized(NoBallot)`.
 */
export async function onRotationBallotPrepared({ event, context }: { event: Event<"RotationGovernor:BallotPrepared">; context: Context<"RotationGovernor:BallotPrepared"> }) {
  const { token, target, catalogVersion, poolSize, pinned, options } = event.args;
  const key = { token, target };
  const row = {
    catalogVersion: Number(catalogVersion),
    poolSize,
    pinned: Number(pinned),
    options: [...options],
    preparedAt: event.block.timestamp,
    txHash: event.transaction.hash,
  };
  if (await context.db.find(liveBallot, key)) await context.db.update(liveBallot, key).set(row);
  else await context.db.insert(liveBallot).values({ ...key, ...row, curationEpoch: null, curatedDrawn: 0, curatedIncluded: 0 });
}
