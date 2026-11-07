import { describe, expect, it } from "vitest";
import { epochStart, singleSegmentSchedule } from "../src/epoch.js";
import {
  MAX_BALLOT_OPTIONS,
  WEIGHT_UNIT,
  argmax,
  bpsOfSupply,
  decodeFheBallot,
  encodeFheBallot,
  encodePlainBallot,
  epochSnapshot,
  epochVotingEnd,
  takeoverSucceeded,
  toWeightWhole,
} from "../src/governance.js";

const ZERO = singleSegmentSchedule(1_700_000_000n);
const SHORT = singleSegmentSchedule(1_700_000_000n, 2_700n, 900n);

describe("weights and snapshots", () => {
  it("counts whole tokens", () => {
    expect(toWeightWhole(0n)).toBe(0n);
    expect(toWeightWhole(WEIGHT_UNIT - 1n)).toBe(0n);
    expect(toWeightWhole(5n * WEIGHT_UNIT + 1n)).toBe(5n);
    expect(toWeightWhole(100_000_000_000n * WEIGHT_UNIT)).toBe(100_000_000_000n);
    expect(() => toWeightWhole(-1n)).toThrow(RangeError);
  });

  it("snapshot is one second before the epoch start", () => {
    expect(epochSnapshot(3n, ZERO)).toBe(epochStart(3n, ZERO) - 1n);
    expect(epochVotingEnd(3n, ZERO)).toBe(epochStart(3n, ZERO) + 604_800n);
    expect(epochSnapshot(3n, SHORT)).toBe(1_700_000_000n + 3n * 2_700n - 1n);
    expect(epochVotingEnd(3n, SHORT)).toBe(1_700_000_000n + 4n * 2_700n);
  });
});

describe("ballots", () => {
  it("encodes and decodes FHE ballots", () => {
    const handle = `0x${"ab".repeat(32)}` as const;
    const proof = "0x0102030405" as const;
    const ballot = encodeFheBallot(handle, proof);
    expect(decodeFheBallot(ballot)).toEqual({ handle, inputProof: proof });
    expect(() => encodeFheBallot("0x1234", proof)).toThrow(/32 bytes/);
  });

  it("encodes plaintext ballots for the mock scheme", () => {
    expect(encodePlainBallot(3)).toBe(`0x${"0".repeat(63)}3`);
    expect(() => encodePlainBallot(MAX_BALLOT_OPTIONS)).toThrow(RangeError);
    expect(() => encodePlainBallot(-1)).toThrow(RangeError);
  });
});

describe("outcomes", () => {
  it("argmax picks the lowest index on ties", () => {
    expect(argmax([1n, 3n, 3n])).toBe(1);
    expect(argmax([0n, 0n])).toBe(0);
    expect(argmax([])).toBe(-1);
  });

  it("takeover needs quorum and a strict majority", () => {
    expect(takeoverSucceeded({ forWeight: 10n, againstWeight: 9n, quorumWeight: 10n })).toBe(true);
    expect(takeoverSucceeded({ forWeight: 9n, againstWeight: 1n, quorumWeight: 10n })).toBe(false);
    expect(takeoverSucceeded({ forWeight: 10n, againstWeight: 10n, quorumWeight: 10n })).toBe(false);
  });

  it("bps of supply rounds down", () => {
    expect(bpsOfSupply(100_000_000_000n, 300)).toBe(3_000_000_000n);
    expect(bpsOfSupply(3n, 2500)).toBe(0n);
    expect(() => bpsOfSupply(1n, 10_001)).toThrow(RangeError);
  });
});

describe("packed tallies", () => {
  it("counts words and unpacks three 40-bit counters per word", async () => {
    const { tallyWordCount, unpackTallyWords, MAX_BALLOT_OPTIONS } = await import("../src/governance.js");
    expect(MAX_BALLOT_OPTIONS).toBe(32);
    expect(tallyWordCount(2)).toBe(1);
    expect(tallyWordCount(32)).toBe(11);
    const max = (1n << 40n) - 1n;
    const words = [5n | (7n << 40n) | (max << 80n), 9n];
    expect(unpackTallyWords(words, 4)).toEqual([5n, 7n, max, 9n]);
    expect(() => unpackTallyWords([1n], 4)).toThrow(RangeError);
  });
});

describe("ballot sizes", () => {
  it("bounds a token's choice by the protocol cap and the scheme, as EpochGovernor._sizeOf", async () => {
    const { effectiveBallotSize, isBallotSize, MIN_BALLOT_OPTIONS } = await import("../src/governance.js");
    expect(MIN_BALLOT_OPTIONS).toBe(2);
    expect(effectiveBallotSize({ cap: 32, choice: 0 })).toBe(32);
    expect(effectiveBallotSize({ cap: 32, choice: 9 })).toBe(9);
    // A choice above the cap gets the cap.
    expect(effectiveBallotSize({ cap: 8, choice: 30 })).toBe(8);
    expect(effectiveBallotSize({ cap: 8, choice: 0 })).toBe(8);
    expect(effectiveBallotSize({ cap: 32, choice: 30, schemeMax: 10 })).toBe(10);
    expect([1, 2, 3, 32, 33, 2.5, 0].map(isBallotSize)).toEqual([false, true, true, true, false, false, false]);
  });

  it("hints that multiples of 3 waste no tally counter and each 3 fewer options save ~86k gas", async () => {
    const { ballotGasHint, BALLOT_GAS_PER_TALLY_WORD } = await import("../src/governance.js");
    expect(BALLOT_GAS_PER_TALLY_WORD).toBe(86_000);
    expect(ballotGasHint(32)).toEqual({ words: 11, unusedCounters: 1, savedPerVoter: 0 });
    expect(ballotGasHint(30)).toEqual({ words: 10, unusedCounters: 0, savedPerVoter: 86_000 });
    expect(ballotGasHint(3)).toEqual({ words: 1, unusedCounters: 0, savedPerVoter: 860_000 });
    expect(ballotGasHint(2)).toEqual({ words: 1, unusedCounters: 1, savedPerVoter: 860_000 });
  });
});
