import type { Context, Event } from "ponder:registry";
import { liveCauseSchedule, liveRound, liveSchedule } from "ponder:schema";
import { sync } from "../rotation-schedule";

// RotationGovernor: only the events that move a live token's designated cause or its rotation
// period. Ballots, polls and period proposals are not indexed here. Keep every RotationGovernor
// handler in this file; the governor's candidate selection is being reworked and these
// signatures are to be re-checked against the regenerated ABI.

/** `RoundStatus` enum order. */
export const ROUND_STATUSES = ["None", "Open", "Closed", "NoChange", "Applied", "Stale", "InactiveWinner"] as const;

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
