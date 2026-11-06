import { describe, expect, it } from "vitest";
import { encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { epochGovernorAbi, rotationGovernorAbi } from "../src/abis/index.js";
import { BUCKET_COUNT, bucketId, categoryMaskOf, regionMaskOf } from "../src/catalog.js";
import {
  ballotCall,
  createBallotReader,
  createRoundReader,
  planBallotOpening,
  planRoundOpening,
  ROUND_CURATION_GRACE,
  roundCall,
  roundCurationGraceEnd,
  rotationPollScope,
  type BallotReader,
  type RoundReader,
} from "../src/ballot-prep.js";

const EG = "0x00000000000000000000000000000000000000e1" as Address;
const T = "0x00000000000000000000000000000000000000a1" as Address;
const ORG = `0x${"11".repeat(32)}` as Hex;

describe("ballotCall", () => {
  it("encodes each opening on the epoch governor", () => {
    const open = ballotCall({ kind: "openEpoch", token: T, epoch: 3n }, EG);
    expect(open.address).toBe(EG);
    expect(open.functionName).toBe("openEpoch");
    const skip = ballotCall({ kind: "requestCurationSkip", token: T, epoch: 3n }, EG);
    expect(skip).toMatchObject({ functionName: "requestCurationSkip", args: [T, 3n] });
    expect(() => encodeFunctionData(open as never)).not.toThrow();
    const prep = ballotCall({ kind: "prepareBallot", token: T, epoch: 3n, draws: [{ orgId: ORG, proof: [] }] }, EG);
    expect(prep.args).toEqual([T, 3n, [{ orgId: ORG, proof: [] }]]);
    expect(() => encodeFunctionData(prep as never)).not.toThrow();
    const cur = ballotCall(
      { kind: "prepareCuratedBallot", token: T, epoch: 3n, curated: [{ catalogIndex: 1, pickOrgId: ORG, pickProof: [], entryOrgId: ORG, entryProof: [] }], draws: [] },
      EG,
    );
    expect(cur.functionName).toBe("prepareCuratedBallot");
    expect(() => encodeFunctionData(cur as never)).not.toThrow();
  });
});

describe("planBallotOpening", () => {
  const base: BallotReader = {
    isPrepared: async () => false,
    poolOf: async () => ({ version: 0, poolSize: 0n }),
    pinned: async () => [],
    ballotSize: async () => 32,
    focusOf: async () => ({ categoryMask: 0n, regionMask: 0 }),
    bucketSizes: async () => [],
    catalogRoot: async () => ORG,
    isBlocked: async () => false,
  };
  const entries = { entries: async () => ({ root: ORG, items: [] }) };

  it("is terminal once prepared, and opens directly without a catalogue pool", async () => {
    expect(await planBallotOpening({ reader: { ...base, isPrepared: async () => true }, entries }, T, 1n)).toEqual({
      type: "none",
      reason: "ballot prepared",
      terminal: true,
    });
    expect(await planBallotOpening({ reader: base, entries }, T, 1n)).toEqual({ type: "send", action: { kind: "openEpoch", token: T, epoch: 1n } });
  });
});

describe("createBallotReader", () => {
  it("reads the governor and its linked contracts through one client", async () => {
    const calls: string[] = [];
    const client = {
      async readContract(a: { address: Address; functionName: string; args?: readonly unknown[] }) {
        calls.push(`${a.address}:${a.functionName}`);
        switch (a.functionName) {
          case "isPrepared":
            return true;
          case "poolOf":
            return [2, 40n];
          case "ballotSize":
            return 32n;
          case "profileRegistry":
            return "0x00000000000000000000000000000000000000f1";
          case "catalog":
          case "registry":
            return "0x00000000000000000000000000000000000000f2";
          case "focusOf":
            return [4n, 1];
          case "curationSkipAt":
            return 22_600n;
          case "curators":
            return zeroAddress;
          default:
            throw new Error(`unexpected ${a.functionName}`);
        }
      },
      async getBlock() {
        return { timestamp: 2000n };
      },
    };
    const r = createBallotReader(client as never, EG);
    expect(await r.isPrepared(T, 1n)).toBe(true);
    expect(await r.poolOf(T, 1n)).toEqual({ version: 2, poolSize: 40n });
    expect(await r.ballotSize()).toBe(32);
    expect(await r.focusOf(T)).toEqual({ categoryMask: 4n, regionMask: 1 });
    expect(await r.curationSkipAt!(T, 1n)).toBe(22_600n);
    expect(await r.now!()).toBe(2000n);
    expect(await r.curationsFor!(1n, 2, [3])).toEqual([]);
    // Links are read once.
    expect(calls.filter((c) => c.endsWith(":profileRegistry"))).toHaveLength(1);
    expect(epochGovernorAbi.some((x) => x.type === "function" && x.name === "openEpoch")).toBe(true);
  });
});

const RG = "0x00000000000000000000000000000000000000e3" as Address;

describe("roundCall", () => {
  it("encodes each preparation on the rotation governor", () => {
    const open = roundCall({ kind: "openRound", token: T, target: 5n }, RG);
    // `openRound` derives the target on chain.
    expect(open).toMatchObject({ address: RG, functionName: "openRound", args: [T] });
    expect(() => encodeFunctionData(open as never)).not.toThrow();
    const prep = roundCall({ kind: "prepareRound", token: T, target: 5n, draws: [{ orgId: ORG, proof: [] }] }, RG);
    expect(prep.args).toEqual([T, 5n, [{ orgId: ORG, proof: [] }]]);
    expect(() => encodeFunctionData(prep as never)).not.toThrow();
    const cur = roundCall(
      { kind: "prepareCuratedRound", token: T, target: 5n, curated: [{ catalogIndex: 1, pickOrgId: ORG, pickProof: [], entryOrgId: ORG, entryProof: [] }], draws: [] },
      RG,
    );
    expect(cur.functionName).toBe("prepareCuratedRound");
    expect(() => encodeFunctionData(cur as never)).not.toThrow();
    expect(rotationGovernorAbi.some((x) => x.type === "function" && x.name === "prepareCuratedRound")).toBe(true);
  });
});

describe("roundCurationGraceEnd", () => {
  // Vote window = period - min(6h, period / 4); the grace is min(6h, window / 3) from the vote start.
  const window = (period: bigint) => period - (period / 4n < 21_600n ? period / 4n : 21_600n);
  it("mirrors CatalogBallotBuilder.curationGraceEnd: the close buffer of each period", () => {
    expect(roundCurationGraceEnd(1_000n, 1_000n + window(3_600n))).toBe(1_000n + 900n);
    expect(roundCurationGraceEnd(1_000n, 1_000n + window(43_200n))).toBe(1_000n + 10_800n);
    expect(roundCurationGraceEnd(1_000n, 1_000n + window(86_400n))).toBe(1_000n + ROUND_CURATION_GRACE);
    expect(roundCurationGraceEnd(1_000n, 1_000n + window(604_800n))).toBe(1_000n + ROUND_CURATION_GRACE);
    // Integer division, as in Solidity.
    expect(roundCurationGraceEnd(0n, 10n)).toBe(3n);
  });
});

describe("rotationPollScope", () => {
  it("mirrors PollScopeLib.encode(KIND_ROTATION, target)", () => {
    expect(rotationPollScope(5n)).toBe(0x0100000000000000000000000000000000000000000000000000000000000005n);
    expect(() => rotationPollScope(1n << 64n)).toThrow(RangeError);
  });
});

describe("planRoundOpening", () => {
  const base: RoundReader = {
    roundStatus: async () => "None",
    currentRotation: async () => 4n,
    pollWindow: async () => ({ snapshot: 9_999n, voteStart: 10_000n, voteEnd: 12_700n }),
    curationEpochOf: async () => ({ ok: true, epoch: 2n }),
    now: async () => 10_100n,
    poolOf: async () => ({ version: 0, poolSize: 0n }),
    pinned: async () => [],
    ballotSize: async () => 10,
    focusOf: async () => ({ categoryMask: 0n, regionMask: 0 }),
    bucketSizes: async () => [],
    catalogRoot: async () => ORG,
    isBlocked: async () => false,
  };
  const entries = { entries: async () => ({ root: ORG, items: [] }) };
  const plan = (over: Partial<RoundReader>, target = 5n) => planRoundOpening({ reader: { ...base, ...over }, entries }, T, target);

  it("opens the next rotation's round without a pool, and only that round, only in its vote window", async () => {
    expect(await plan({})).toEqual({ type: "send", action: { kind: "openRound", token: T, target: 5n } });
    expect(await plan({ roundStatus: async () => "Open" })).toEqual({ type: "none", reason: "round prepared", terminal: true });
    expect(await plan({ roundStatus: async () => "NoBallot" })).toMatchObject({ type: "none", terminal: true });
    expect(await plan({}, 4n)).toMatchObject({ type: "none", reason: "round can no longer be prepared", terminal: true });
    expect(await plan({}, 6n)).toMatchObject({ type: "none", terminal: false });
    expect(await plan({ now: async () => 12_700n })).toMatchObject({ type: "none", reason: "round's vote window ended", terminal: false });
    expect(await plan({ pollWindow: async () => ({ snapshot: 0n, voteStart: 0n, voteEnd: 0n }) })).toMatchObject({ type: "none", terminal: true });
  });

  it("asks the entry source for the round's catalogue version and root, not the latest", async () => {
    // A version published mid-week: the round keeps the epoch-start version 3 and its root.
    const OLD_ROOT = `0x${"33".repeat(32)}` as Hex;
    const b = bucketId(2, 0);
    const sizes = Array.from({ length: BUCKET_COUNT }, (_, i) => (i === b ? 5 : 0));
    const asked: ({ version: number; root: Hex } | undefined)[] = [];
    const src = {
      async entries(at: { bucket: number; index: number }[], catalog?: { version: number; root: Hex }) {
        asked.push(catalog);
        return { root: OLD_ROOT, items: at.map((e) => ({ ...e, orgId: `0x${(e.index + 1).toString(16).padStart(64, "0")}` as Hex, proof: [] })) };
      },
    };
    const reader: RoundReader = {
      ...base,
      poolOf: async () => ({ version: 3, poolSize: 5n }),
      focusOf: async () => ({ categoryMask: categoryMaskOf(["hunger"]), regionMask: regionMaskOf(["africa"]) }),
      bucketSizes: async (v) => (v === 3 ? sizes : []),
      catalogRoot: async (v) => (v === 3 ? OLD_ROOT : ORG),
    };
    const step = await planRoundOpening({ reader, entries: src }, T, 5n);
    expect(step).toMatchObject({ type: "send", action: { kind: "prepareRound", target: 5n } });
    expect(asked.length).toBeGreaterThan(0);
    for (const c of asked) expect(c).toEqual({ version: 3, root: OLD_ROOT });
  });
});

describe("createRoundReader", () => {
  it("reads the rotation governor and its linked contracts through one client", async () => {
    const calls: string[] = [];
    let curators: Address = zeroAddress;
    const client = {
      async readContract(a: { address: Address; functionName: string; args?: readonly unknown[] }) {
        calls.push(`${a.address}:${a.functionName}`);
        switch (a.functionName) {
          case "roundOf":
            return [2, 0, 0, 0, ORG, 0n, []];
          case "currentRotation":
            return 7n;
          case "pollWindow":
            return [999, 1000, 3700];
          case "curationEpochOf":
            return [true, 3n];
          case "poolOf":
            return [2, 40n];
          case "shortlistFor":
            return [ORG];
          case "ballotSize":
            return 10n;
          case "profileRegistry":
            return "0x00000000000000000000000000000000000000f1";
          case "catalog":
          case "causeRegistry":
            return "0x00000000000000000000000000000000000000f2";
          case "focusOf":
            return [4n, 1];
          case "curators":
            return curators;
          case "curationsFor":
            return [{ picksRoot: ORG, count: 3, weight: 10_000 }];
          default:
            throw new Error(`unexpected ${a.functionName}`);
        }
      },
      async getBlock() {
        return { timestamp: 2000n };
      },
    };
    const r = createRoundReader(client as never, RG);
    expect(await r.roundStatus(T, 8n)).toBe("Closed");
    expect(await r.currentRotation(T)).toBe(7n);
    expect(await r.pollWindow(T, 8n)).toEqual({ snapshot: 999n, voteStart: 1000n, voteEnd: 3700n });
    expect(await r.curationEpochOf(T, 8n)).toEqual({ ok: true, epoch: 3n });
    expect(await r.poolOf(T, 8n)).toEqual({ version: 2, poolSize: 40n });
    expect(await r.pinned(T, 8n)).toEqual([ORG]);
    expect(await r.ballotSize()).toBe(10);
    expect(await r.focusOf(T)).toEqual({ categoryMask: 4n, regionMask: 1 });
    expect(await r.now()).toBe(2000n);
    // No curator registry yet: no curated phase; once set, it is read and kept.
    expect(await r.curationsFor!(3n, 2, [33])).toEqual([]);
    curators = "0x00000000000000000000000000000000000000f3";
    expect(await r.curationsFor!(3n, 2, [33])).toEqual([{ bucket: 33, picksRoot: ORG, count: 3, weight: 10_000 }]);
    await r.curationsFor!(3n, 2, [33]);
    expect(calls.filter((c) => c.endsWith(":curators"))).toHaveLength(2);
    expect(calls.filter((c) => c.endsWith(":profileRegistry"))).toHaveLength(1);
  });
});
