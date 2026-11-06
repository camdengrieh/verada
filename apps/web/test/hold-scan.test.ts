import { describe, expect, it, vi } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import { epochGovernorAbi, takeoverGovernorAbi } from "@varada/sdk/abis";
import { runHoldScanStep } from "@/lib/hold-scan";

const G = "0x00000000000000000000000000000000000000e1" as Address;
const T = "0x00000000000000000000000000000000000000a1" as Address;
const V = "0x00000000000000000000000000000000000000b2" as Address;

/** A voter with `n` checkpoints, one per second from t=1000, and a fixed window. */
function client(n: number, holdFrom: number, snapshot: number, status: "success" | "reverted" = "success") {
  return {
    readContract: vi.fn(async (a: { functionName: string; args?: readonly unknown[] }) => {
      switch (a.functionName) {
        case "numCheckpoints":
          return n;
        case "checkpoints":
          return { key: 1_000 + Number(a.args![1]), value: 1n };
        case "getProposal":
          return { lookbackSnapshot: holdFrom, snapshot };
        case "holdFromFor":
          return BigInt(holdFrom);
        case "snapshotFor":
          return BigInt(snapshot);
        case "params":
          return { lookback: snapshot - holdFrom };
      }
      throw new Error(a.functionName);
    }),
    waitForTransactionReceipt: vi.fn(async () => ({ status })),
  } as unknown as PublicClient;
}

describe("runHoldScanStep", () => {
  it("runs a griefed voter's scan ahead from their wallet before the ballot", async () => {
    const write = vi.fn(async () => "0x01" as Hex);
    const chunks: number[] = [];
    const n = await runHoldScanStep({
      client: client(4_500, 900, 10_000),
      governor: G,
      token: T,
      voter: V,
      target: { kind: "takeover", proposalId: 4n },
      chainId: 1,
      write,
      onChunk: (d) => chunks.push(d),
    });
    expect(n).toBe(3);
    expect(chunks).toEqual([0, 1, 2]);
    expect(write).toHaveBeenCalledWith({ address: G, abi: takeoverGovernorAbi, functionName: "advanceHoldScan", args: [4n, V, 2_000n], chainId: 1 });
  });

  it("uses the epoch governor's call, and sends nothing for a short scan", async () => {
    const write = vi.fn(async () => "0x01" as Hex);
    expect(await runHoldScanStep({ client: client(20, 900, 10_000), governor: G, token: T, voter: V, target: { kind: "epoch", token: T, epoch: 2n }, chainId: 1, write })).toBe(0);
    expect(write).not.toHaveBeenCalled();
    await runHoldScanStep({ client: client(3_000, 900, 10_000), governor: G, token: T, voter: V, target: { kind: "epoch", token: T, epoch: 2n }, chainId: 1, write });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ abi: epochGovernorAbi, args: [T, 2n, V, 2_000n] }));
  });

  it("scans the proposeAt window, and stops on a reverted chunk", async () => {
    const write = vi.fn(async () => "0x01" as Hex);
    await expect(
      runHoldScanStep({ client: client(4_000, 900, 10_000, "reverted"), governor: G, token: T, voter: V, target: { kind: "takeoverPropose", token: T, snapshot: 10_000n }, chainId: 1, write }),
    ).rejects.toThrow(/reverted/);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "advanceProposeScan", args: [T, V, 10_000, 2_000n] }));
  });
});
