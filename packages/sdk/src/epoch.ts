/**
 * Epoch timing. The epoch length, voting window and hold window are owner-set on `EpochGovernor`
 * (`setEpochSchedule`) and change over time, so boundaries are NOT `epochZeroStart + n * length`
 * for any constant: the governor keeps a list of segments and `epochStart(epoch)` is the only
 * correct source. Everything here is one of two things:
 *
 *  - pure math over an {@link EpochSchedule} (the segments, as the contract keeps them), for code that
 *    follows `EpochScheduleSet` events (the indexer) or wants to reason about a hypothetical schedule;
 *  - chain reads ({@link readEpochWindow}) that take every boundary from the governor itself.
 *
 * An epoch has two phases: TRADING (`[start, votingOpensAt)`, ballots refused with `VotingNotOpen`)
 * then VOTING (`[votingOpensAt, end)`). Weights are fixed at the snapshot before the epoch starts, so
 * trading cannot change them. After `end` the epoch is in its TALLY phase (close, decrypt, finalize,
 * settle), which is the keeper's work and not part of the schedule.
 */
import type { Abi, Address } from "viem";
import { epochGovernorAbi } from "./abis/index.js";
import { isRevertError } from "./donation.js";

/**
 * Epoch length (and default voting and hold window) of a freshly deployed governor, in seconds: 7 days.
 * Only the constructor's default. The live length is `epochLength()` / `epochScheduleFor(epoch)`.
 */
export const DEFAULT_EPOCH_LENGTH = 604_800n;

/**
 * Unix time 0 is Thursday 00:00 UTC, so any multiple of one week since the unix epoch starts on a
 * Thursday at 00:00 UTC. The governor's constructor aligns `epochZeroStart` this way.
 */
export function alignToThursday(timestamp: bigint): bigint {
  if (timestamp < 0n) throw new RangeError("timestamp must be non-negative");
  return timestamp - (timestamp % DEFAULT_EPOCH_LENGTH);
}

/** `epochZeroStart` of a governor deployed at `deployTimestamp` (immutable on chain: read it there). */
export function epochZeroStart(deployTimestamp: bigint): bigint {
  return alignToThursday(deployTimestamp);
}

// ---------------------------------------------------------------- schedule math

/**
 * One schedule segment, as `EpochGovernor` keeps it and `EpochScheduleSet` reports it: from epoch
 * `startEpoch`, which starts at `startTime`, epochs last `length`, accept ballots in their last
 * `votingWindow` and weigh over `holdWindow`. All seconds.
 */
export interface EpochSegment {
  startEpoch: bigint;
  startTime: bigint;
  length: bigint;
  votingWindow: bigint;
  holdWindow: bigint;
}

/** Segments sorted by `startEpoch` and `startTime` (the governor never lets a change reach back). */
export type EpochSchedule = readonly EpochSegment[];

/** A schedule of one segment: epoch zero at `zeroStart`, voting open the whole epoch by default. */
export function singleSegmentSchedule(
  zeroStart: bigint,
  length: bigint = DEFAULT_EPOCH_LENGTH,
  votingWindow: bigint = length,
  holdWindow: bigint = length,
): EpochSchedule {
  assertSegment({ startEpoch: 0n, startTime: zeroStart, length, votingWindow, holdWindow });
  return [{ startEpoch: 0n, startTime: zeroStart, length, votingWindow, holdWindow }];
}

function assertSegment(s: EpochSegment): void {
  if (s.startEpoch < 0n || s.startTime < 0n) throw new RangeError("segment start must be non-negative");
  if (s.length <= 0n) throw new RangeError("epoch length must be positive");
  if (s.votingWindow <= 0n || s.votingWindow > s.length) throw new RangeError("voting window must be in (0, length]");
  if (s.holdWindow < 0n) throw new RangeError("hold window must be non-negative");
}

/**
 * The schedule after an `EpochScheduleSet` event. Mirrors `EpochGovernor.setEpochSchedule`: a change
 * for the same `startEpoch` as the last segment replaces it (a change made while the last was still
 * pending, or epoch zero re-anchored before any token registered), any other is appended.
 */
export function applyScheduleChange(schedule: EpochSchedule, change: EpochSegment): EpochSchedule {
  assertSegment(change);
  const last = schedule[schedule.length - 1];
  if (last === undefined) return [change];
  if (change.startEpoch < last.startEpoch) throw new RangeError("schedule change reaches back before the last segment");
  if (change.startEpoch === last.startEpoch) return [...schedule.slice(0, -1), change];
  return [...schedule, change];
}

/** Segment `epoch` belongs to: the last one starting at or before it. */
export function segmentOfEpoch(schedule: EpochSchedule, epoch: bigint): EpochSegment {
  if (epoch < 0n) throw new RangeError("epoch must be non-negative");
  for (let i = schedule.length - 1; i >= 0; i--) {
    const s = schedule[i]!;
    if (s.startEpoch <= epoch) return s;
  }
  throw new RangeError("empty schedule");
}

/** Segment in force at `timestamp`: the last one that has started by then. */
export function segmentAt(schedule: EpochSchedule, timestamp: bigint): EpochSegment {
  for (let i = schedule.length - 1; i >= 0; i--) {
    const s = schedule[i]!;
    if (s.startTime <= timestamp) return s;
  }
  throw new RangeError("timestamp precedes epoch zero");
}

/** Epoch index containing `timestamp`; throws if it precedes epoch zero. */
export function epochAt(timestamp: bigint, schedule: EpochSchedule): bigint {
  const s = segmentAt(schedule, timestamp);
  return s.startEpoch + (timestamp - s.startTime) / s.length;
}

/** Start time of `epoch` (`EpochGovernor.epochStart`). */
export function epochStart(epoch: bigint, schedule: EpochSchedule): bigint {
  const s = segmentOfEpoch(schedule, epoch);
  return s.startTime + (epoch - s.startEpoch) * s.length;
}

/** Exclusive end time of the epoch: the start of the next one. */
export function epochEnd(epoch: bigint, schedule: EpochSchedule): bigint {
  return epochStart(epoch + 1n, schedule);
}

/**
 * Time from which ballots of `epoch` are accepted (`EpochGovernor.votingOpensAt`): the epoch's end
 * minus its voting window, with the window of the segment the epoch belongs to.
 */
export function votingOpensAt(epoch: bigint, schedule: EpochSchedule): bigint {
  const s = segmentOfEpoch(schedule, epoch);
  return s.startTime + (epoch + 1n - s.startEpoch) * s.length - s.votingWindow;
}

/** Whether the epoch has ended and can be finalized at `timestamp`. */
export function isEpochEnded(epoch: bigint, schedule: EpochSchedule, timestamp: bigint): boolean {
  return timestamp >= epochEnd(epoch, schedule);
}

/** Seconds left in the epoch containing `timestamp`. */
export function secondsRemaining(timestamp: bigint, schedule: EpochSchedule): bigint {
  const epoch = epochAt(timestamp, schedule);
  return epochEnd(epoch, schedule) - timestamp;
}

// ---------------------------------------------------------------- window and phase

/** One epoch's timing: all seconds. `end` is exclusive (the next epoch's `start`). */
export interface EpochWindow {
  epoch: bigint;
  start: bigint;
  end: bigint;
  /** First second a ballot is accepted (`votingOpensAt`). Equals `start` when voting is open all epoch. */
  votingOpensAt: bigint;
  length: bigint;
  votingWindow: bigint;
  holdWindow: bigint;
}

/** `trading`: ballots refused; `voting`: ballots accepted; `ended`: the tally phase (close, finalize, settle). */
export type EpochPhase = "trading" | "voting" | "ended";

/** The window of `epoch` under a schedule. */
export function epochWindowOf(schedule: EpochSchedule, epoch: bigint): EpochWindow {
  const s = segmentOfEpoch(schedule, epoch);
  const start = epochStart(epoch, schedule);
  return {
    epoch,
    start,
    end: epochEnd(epoch, schedule),
    votingOpensAt: votingOpensAt(epoch, schedule),
    length: s.length,
    votingWindow: s.votingWindow,
    holdWindow: s.holdWindow,
  };
}

/** Phase of an epoch at `now`. A not yet started epoch counts as `trading`. */
export function epochPhase(w: Pick<EpochWindow, "votingOpensAt" | "end">, now: bigint): EpochPhase {
  if (now >= w.end) return "ended";
  return now >= w.votingOpensAt ? "voting" : "trading";
}

/**
 * Where an epoch stands at `now` and when its phase changes next: `nextAt` is `votingOpensAt` while
 * trading, `end` while voting, and undefined once ended. `secondsToNext` never goes below zero.
 */
export function epochCountdown(
  w: Pick<EpochWindow, "votingOpensAt" | "end">,
  now: bigint,
): { phase: EpochPhase; nextAt?: bigint; secondsToNext?: bigint; secondsToEnd: bigint } {
  const phase = epochPhase(w, now);
  const secondsToEnd = w.end > now ? w.end - now : 0n;
  if (phase === "ended") return { phase, secondsToEnd };
  const nextAt = phase === "trading" ? w.votingOpensAt : w.end;
  return { phase, nextAt, secondsToNext: nextAt > now ? nextAt - now : 0n, secondsToEnd };
}

/** Whether `votingOpensAt` is after the epoch's start, i.e. the epoch has a trading phase. */
export function hasTradingPhase(w: Pick<EpochWindow, "votingOpensAt" | "start">): boolean {
  return w.votingOpensAt > w.start;
}

// ---------------------------------------------------------------- chain reads

/** The viem `PublicClient` method the epoch reads use. */
export interface EpochReadClient {
  readContract(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

/** A call to a function the contract does not have: it reverts, or returns no data. */
function isMissingGetter(err: unknown): boolean {
  if (isRevertError(err)) return true;
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 32; depth++) {
    if ((e as { name?: unknown }).name === "ContractFunctionZeroDataError") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Reads one epoch's window from the governor: `epochStart(epoch)`, `epochStart(epoch + 1)` (the end,
 * correct across a schedule change), `votingOpensAt(epoch)` and `epochScheduleFor(epoch)`. `epoch`
 * defaults to `currentEpoch()`. A governor without the schedule getters (deployed before
 * `setEpochSchedule`) has a single schedule where voting is open the whole epoch, so `votingOpensAt`
 * is the start and the windows are the length; its epochs are still read from `epochStart`.
 */
export async function readEpochWindow(client: EpochReadClient, governor: Address, epoch?: bigint): Promise<EpochWindow> {
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: governor, abi: epochGovernorAbi as Abi, functionName, args } as never) as Promise<T>;
  const e = epoch ?? (await read<bigint>("currentEpoch"));
  const [start, end] = await Promise.all([read<bigint>("epochStart", [e]), read<bigint>("epochStart", [e + 1n])]);
  const legacy = {
    votingOpensAt: start,
    length: end - start,
    votingWindow: end - start,
    holdWindow: end - start,
  };
  // Only a governor that lacks the getter falls back; a network failure must not look like one.
  const orLegacy = <T>(p: Promise<T>) =>
    p.catch((err: unknown) => {
      if (isMissingGetter(err)) return undefined;
      throw err;
    });
  const [opens, schedule] = await Promise.all([
    orLegacy(read<bigint>("votingOpensAt", [e])),
    orLegacy(read<readonly [bigint, bigint, bigint]>("epochScheduleFor", [e])),
  ]);
  return {
    epoch: e,
    start,
    end,
    votingOpensAt: opens ?? legacy.votingOpensAt,
    length: schedule?.[0] ?? legacy.length,
    votingWindow: schedule?.[1] ?? legacy.votingWindow,
    holdWindow: schedule?.[2] ?? legacy.holdWindow,
  };
}
