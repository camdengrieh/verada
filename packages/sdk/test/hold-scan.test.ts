import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address } from "viem";
import { epochGovernorAbi, rotationGovernorAbi, takeoverGovernorAbi } from "../src/abis/index.js";
import {
  advanceHoldScanCall,
  holdScanChunks,
  holdScanReads,
  prepareHoldScan,
  runHoldScanAhead,
  type CheckpointReader,
} from "../src/hold-scan.js";

const T = "0x00000000000000000000000000000000000000a1" as Address;
const V = "0x00000000000000000000000000000000000000b2" as Address;

/** Checkpoint keys of one account, read the way the token answers. */
function reader(keys: number[]): CheckpointReader & { calls: number } {
  const r = {
    calls: 0,
    async readContract(args: { functionName: string; args?: readonly unknown[] }) {
      r.calls++;
      if (args.functionName === "numCheckpoints") return keys.length;
      const i = Number(args.args![1]);
      return { key: keys[i]!, value: 1n };
    },
  };
  return r as never;
}

/** The reads `HoldWeightLib._scan` makes, done the slow way. */
function scanReads(keys: number[], holdFrom: number, snapshot: number): number {
  let i = keys.filter((k) => k <= snapshot).length;
  let reads = 0;
  while (i > 0) {
    i--;
    reads++;
    if (keys[i]! <= holdFrom) break;
  }
  return reads;
}

describe("holdScanReads", () => {
  it("counts what the contract's scan reads, in O(log n) RPC calls", async () => {
    const keys = Array.from({ length: 5_000 }, (_, i) => 1_000 + i * 3);
    for (const [from, snap] of [
      [0, 500],
      [500, 2_000],
      [1_000, 1_000],
      [2_000, 9_000],
      [5_000, 20_000],
      [20_000, 30_000],
      [2_001, 2_002],
    ] as const) {
      const r = reader(keys);
      expect(await holdScanReads(r, T, V, BigInt(from), BigInt(snap))).toBe(scanReads(keys, from, snap));
      expect(r.calls).toBeLessThan(40);
    }
  });

  it("is zero for an account without checkpoints", async () => {
    expect(await holdScanReads(reader([]), T, V, 0n, 100n)).toBe(0);
  });
});

describe("holdScanChunks", () => {
  it("runs a scan ahead only when it is too long for one ballot", () => {
    expect(holdScanChunks(1_500)).toBe(0);
    expect(holdScanChunks(1_501)).toBe(1);
    expect(holdScanChunks(5_001)).toBe(3);
    expect(holdScanChunks(100, { inlineMax: 10, chunk: 30 })).toBe(4);
  });
});

describe("advanceHoldScanCall", () => {
  it("encodes against each governor's ABI", () => {
    const e = advanceHoldScanCall({ kind: "epoch", token: T, epoch: 4n }, V, 7);
    expect(() => encodeFunctionData({ abi: epochGovernorAbi, ...e } as never)).not.toThrow();
    expect(e.args).toEqual([T, 4n, V, 7n]);
    const t = advanceHoldScanCall({ kind: "takeover", proposalId: 9n }, V);
    expect(() => encodeFunctionData({ abi: takeoverGovernorAbi, ...t } as never)).not.toThrow();
    const p = advanceHoldScanCall({ kind: "takeoverPropose", token: T, snapshot: 1_000n }, V);
    expect(p.functionName).toBe("advanceProposeScan");
    expect(() => encodeFunctionData({ abi: takeoverGovernorAbi, ...p } as never)).not.toThrow();
    const r = advanceHoldScanCall({ kind: "rotation", token: T, holdFrom: 1n, snapshot: 2n }, V);
    expect(() => encodeFunctionData({ abi: rotationGovernorAbi, ...r } as never)).not.toThrow();
  });
});

describe("runHoldScanAhead", () => {
  it("sends one chunk per 2000 reads, in order", async () => {
    const sent: unknown[] = [];
    const n = await runHoldScanAhead({
      reads: 4_001,
      target: { kind: "takeover", proposalId: 1n },
      account: V,
      send: async (c) => void sent.push(c.args),
    });
    expect(n).toBe(3);
    expect(sent).toEqual([[1n, V, 2_000n], [1n, V, 2_000n], [1n, V, 2_000n]]);
    expect(await runHoldScanAhead({ reads: 10, target: { kind: "takeover", proposalId: 1n }, account: V, send: async () => { throw new Error("no"); } })).toBe(0);
  });
});

describe("prepareHoldScan", () => {
  const G = "0x00000000000000000000000000000000000000e1" as Address;
  const keys = Array.from({ length: 5_000 }, (_, i) => 1_000 + i);
  const client = (snapshot: number, lookbackSnapshot: number) => {
    const base = reader(keys).readContract as unknown as (a: unknown) => Promise<unknown>;
    return {
      async readContract(args: { functionName: string; args?: readonly unknown[] }) {
        if (args.functionName === "getProposal") return { snapshot, lookbackSnapshot };
        if (args.functionName === "holdFromFor") return BigInt(lookbackSnapshot);
        if (args.functionName === "snapshotFor") return BigInt(snapshot);
        return base(args);
      },
    } as never;
  };

  it("runs a dusted voter's takeover scan ahead before the ballot", async () => {
    const sent: unknown[] = [];
    const n = await prepareHoldScan({
      client: client(10_000, 500),
      governor: G,
      token: T,
      account: V,
      target: { kind: "takeover", proposalId: 3n },
      send: async (c) => void sent.push(c),
    });
    expect(n).toBe(3); // 5000 checkpoints in the window
    expect(sent[0]).toEqual({ functionName: "advanceHoldScan", args: [3n, V, 2_000n] });
  });

  it("sends nothing for a short epoch scan", async () => {
    const n = await prepareHoldScan({
      client: client(1_500, 1_200),
      governor: G,
      token: T,
      account: V,
      target: { kind: "epoch", token: T, epoch: 2n },
      send: async () => {
        throw new Error("unexpected");
      },
    });
    expect(n).toBe(0);
  });
});
