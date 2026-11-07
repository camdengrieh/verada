import { describe, expect, it } from "vitest";
import {
  DEFAULT_EPOCH_LENGTH,
  alignToThursday,
  applyScheduleChange,
  epochAt,
  epochCountdown,
  epochEnd,
  epochPhase,
  epochStart,
  epochWindowOf,
  epochZeroStart,
  hasTradingPhase,
  isEpochEnded,
  readEpochWindow,
  secondsRemaining,
  singleSegmentSchedule,
  votingOpensAt,
  type EpochSchedule,
} from "../src/epoch.js";
import { epochGovernorAbi } from "../src/abis/index.js";
import { encodeFunctionResult, type Abi, type Address } from "viem";

// 2024-01-04T00:00:00Z was a Thursday.
const THURSDAY = BigInt(Date.UTC(2024, 0, 4) / 1000);
const MIN = 60n;
const WEEK = DEFAULT_EPOCH_LENGTH;

describe("epoch math (single default segment)", () => {
  it("aligns to Thursday 00:00 UTC", () => {
    const aligned = alignToThursday(THURSDAY + 3n * 86_400n + 12_345n);
    expect(aligned).toBe(THURSDAY);
    expect(new Date(Number(aligned) * 1000).getUTCDay()).toBe(4);
    expect(aligned % 86_400n).toBe(0n);
  });

  it("leaves an aligned timestamp unchanged", () => {
    expect(alignToThursday(THURSDAY)).toBe(THURSDAY);
    expect(epochZeroStart(THURSDAY)).toBe(THURSDAY);
  });

  it("computes epoch index and boundaries", () => {
    const s = singleSegmentSchedule(THURSDAY);
    expect(epochAt(THURSDAY, s)).toBe(0n);
    expect(epochAt(THURSDAY + WEEK - 1n, s)).toBe(0n);
    expect(epochAt(THURSDAY + WEEK, s)).toBe(1n);
    expect(epochStart(3n, s)).toBe(THURSDAY + 3n * WEEK);
    expect(epochEnd(3n, s)).toBe(THURSDAY + 4n * WEEK);
    // Voting open the whole epoch by default.
    expect(votingOpensAt(3n, s)).toBe(epochStart(3n, s));
  });

  it("tracks epoch end and remaining time", () => {
    const s = singleSegmentSchedule(THURSDAY);
    expect(isEpochEnded(0n, s, THURSDAY + WEEK - 1n)).toBe(false);
    expect(isEpochEnded(0n, s, THURSDAY + WEEK)).toBe(true);
    expect(secondsRemaining(THURSDAY + 100n, s)).toBe(WEEK - 100n);
  });

  it("rejects timestamps before epoch zero", () => {
    expect(() => epochAt(THURSDAY - 1n, singleSegmentSchedule(THURSDAY))).toThrow(RangeError);
  });

  it("rejects a voting window longer than the epoch", () => {
    expect(() => singleSegmentSchedule(THURSDAY, 45n * MIN, 46n * MIN)).toThrow(RangeError);
    expect(() => singleSegmentSchedule(THURSDAY, 0n)).toThrow(RangeError);
  });
});

describe("epoch math (45 minute cycle: 30 trading, 15 voting)", () => {
  const Z = THURSDAY;
  const s = singleSegmentSchedule(Z, 45n * MIN, 15n * MIN, 45n * MIN);

  it("opens voting in the last 15 minutes of each epoch", () => {
    expect(epochStart(2n, s)).toBe(Z + 90n * MIN);
    expect(epochEnd(2n, s)).toBe(Z + 135n * MIN);
    expect(votingOpensAt(2n, s)).toBe(Z + 120n * MIN);
    expect(epochWindowOf(s, 2n)).toEqual({
      epoch: 2n,
      start: Z + 90n * MIN,
      end: Z + 135n * MIN,
      votingOpensAt: Z + 120n * MIN,
      length: 45n * MIN,
      votingWindow: 15n * MIN,
      holdWindow: 45n * MIN,
    });
  });

  it("walks trading, voting and ended", () => {
    const w = epochWindowOf(s, 0n);
    expect(hasTradingPhase(w)).toBe(true);
    expect(epochPhase(w, Z)).toBe("trading");
    expect(epochPhase(w, Z + 30n * MIN - 1n)).toBe("trading");
    expect(epochPhase(w, Z + 30n * MIN)).toBe("voting");
    expect(epochPhase(w, Z + 45n * MIN - 1n)).toBe("voting");
    expect(epochPhase(w, Z + 45n * MIN)).toBe("ended");
    expect(epochCountdown(w, Z + 10n * MIN)).toEqual({ phase: "trading", nextAt: Z + 30n * MIN, secondsToNext: 20n * MIN, secondsToEnd: 35n * MIN });
    expect(epochCountdown(w, Z + 40n * MIN)).toEqual({ phase: "voting", nextAt: Z + 45n * MIN, secondsToNext: 5n * MIN, secondsToEnd: 5n * MIN });
    expect(epochCountdown(w, Z + 50n * MIN)).toEqual({ phase: "ended", secondsToEnd: 0n });
  });

  it("a whole-epoch voting window has no trading phase", () => {
    expect(hasTradingPhase(epochWindowOf(singleSegmentSchedule(Z), 0n))).toBe(false);
  });
});

describe("schedule changes (segments)", () => {
  const Z = THURSDAY;
  const weekly = singleSegmentSchedule(Z);
  // The owner changes the schedule during week 2: it applies from epoch 3 (start Z + 3 weeks).
  const changed = applyScheduleChange(weekly, {
    startEpoch: 3n,
    startTime: Z + 3n * WEEK,
    length: 45n * MIN,
    votingWindow: 15n * MIN,
    holdWindow: 45n * MIN,
  });

  it("keeps earlier epochs and counts the new ones from the segment start", () => {
    expect(changed).toHaveLength(2);
    expect(epochStart(2n, changed)).toBe(Z + 2n * WEEK);
    expect(epochEnd(2n, changed)).toBe(Z + 3n * WEEK);
    expect(votingOpensAt(2n, changed)).toBe(Z + 2n * WEEK);
    expect(epochStart(3n, changed)).toBe(Z + 3n * WEEK);
    expect(epochStart(5n, changed)).toBe(Z + 3n * WEEK + 90n * MIN);
    expect(epochEnd(5n, changed)).toBe(Z + 3n * WEEK + 135n * MIN);
    expect(votingOpensAt(5n, changed)).toBe(Z + 3n * WEEK + 120n * MIN);
    // epochZero + n * length is NOT the start of epoch 5 any more.
    expect(epochStart(5n, changed)).not.toBe(Z + 5n * WEEK);
  });

  it("finds the epoch of a timestamp across the change", () => {
    expect(epochAt(Z + 3n * WEEK - 1n, changed)).toBe(2n);
    expect(epochAt(Z + 3n * WEEK, changed)).toBe(3n);
    expect(epochAt(Z + 3n * WEEK + 45n * MIN, changed)).toBe(4n);
    expect(epochAt(Z + 3n * WEEK + 134n * MIN, changed)).toBe(5n);
  });

  it("replaces the last segment while it is pending or re-anchored (same start epoch)", () => {
    const again = applyScheduleChange(changed, { startEpoch: 3n, startTime: Z + 3n * WEEK, length: 60n * MIN, votingWindow: 20n * MIN, holdWindow: 60n * MIN });
    expect(again).toHaveLength(2);
    expect(epochEnd(3n, again)).toBe(Z + 3n * WEEK + 60n * MIN);
    // Before any token: epoch zero re-anchored.
    const first = applyScheduleChange(weekly, { startEpoch: 0n, startTime: Z, length: 45n * MIN, votingWindow: 15n * MIN, holdWindow: 45n * MIN });
    expect(first).toHaveLength(1);
    expect(epochAt(Z + 46n * MIN, first)).toBe(1n);
  });

  it("refuses a change that reaches back", () => {
    expect(() => applyScheduleChange(changed, { startEpoch: 2n, startTime: Z + 2n * WEEK, length: WEEK, votingWindow: WEEK, holdWindow: WEEK })).toThrow(RangeError);
  });

  it("an empty schedule has no epochs", () => {
    const none: EpochSchedule = [];
    expect(() => epochStart(0n, none)).toThrow(RangeError);
  });
});

describe("readEpochWindow", () => {
  const GOV = "0x00000000000000000000000000000000000000aa" as Address;
  const Z = 1_800_000_000n;
  const s = singleSegmentSchedule(Z, 45n * MIN, 15n * MIN, 45n * MIN);

  function client(opts: { legacy?: boolean; failWith?: Error } = {}) {
    const calls: string[] = [];
    return {
      calls,
      async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
        calls.push(functionName);
        const e = (args?.[0] ?? 0n) as bigint;
        if (functionName === "currentEpoch") return 7n;
        if (functionName === "epochStart") return epochStart(e, s);
        if (opts.failWith && functionName === "votingOpensAt") throw opts.failWith;
        if (opts.legacy) {
          const err = Object.assign(new Error("reverted"), { name: "ContractFunctionRevertedError" });
          throw err;
        }
        if (functionName === "votingOpensAt") return votingOpensAt(e, s);
        if (functionName === "epochScheduleFor") return [45n * MIN, 15n * MIN, 45n * MIN];
        throw new Error(`unexpected ${functionName}`);
      },
    };
  }

  it("takes every boundary from the governor, the current epoch by default", async () => {
    const c = client();
    const w = await readEpochWindow(c, GOV);
    expect(w).toEqual(epochWindowOf(s, 7n));
    expect(c.calls).toContain("currentEpoch");
    expect((await readEpochWindow(client(), GOV, 2n)).votingOpensAt).toBe(votingOpensAt(2n, s));
  });

  it("falls back to voting open the whole epoch on a governor without the schedule getters", async () => {
    const w = await readEpochWindow(client({ legacy: true }), GOV, 3n);
    expect(w).toMatchObject({ start: epochStart(3n, s), end: epochEnd(3n, s), votingOpensAt: epochStart(3n, s), votingWindow: 45n * MIN, length: 45n * MIN });
  });

  it("does not mistake a network failure for a legacy governor", async () => {
    await expect(readEpochWindow(client({ failWith: new Error("network down") }), GOV, 3n)).rejects.toThrow("network down");
  });

  it("the ABI carries the new views and no removed constant", () => {
    const names = (epochGovernorAbi as Abi).flatMap((e) => ("name" in e ? [e.name] : []));
    for (const n of ["epochLength", "votingWindow", "holdWindow", "epochScheduleFor", "votingOpensAt", "tallyGrace", "launchSnapshotDelay", "curationGrace", "setEpochSchedule", "EpochScheduleSet", "VotingNotOpen"]) {
      expect(names).toContain(n);
    }
    for (const n of ["EPOCH_LENGTH", "HOLD_WINDOW", "TALLY_GRACE", "CURATION_GRACE", "LAUNCH_SNAPSHOT_DELAY"]) expect(names).not.toContain(n);
    // The tuple of epochScheduleFor decodes as the SDK reads it.
    const enc = encodeFunctionResult({ abi: epochGovernorAbi as Abi, functionName: "epochScheduleFor", result: [1n, 2n, 3n] });
    expect(enc.length).toBe(2 + 3 * 64);
  });
});
