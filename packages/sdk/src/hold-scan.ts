import { parseAbi, type Address, type PublicClient } from "viem";
import { epochGovernorAbi } from "./abis/EpochGovernor.js";
import { takeoverGovernorAbi } from "./abis/TakeoverGovernor.js";

/**
 * Hold-weight scans. A governor reads every vote checkpoint of the voter inside the hold window
 * (`HoldWeightLib`, about 4.4k gas each), so a heavy trader, or a holder sent dust, can need more
 * gas than one transaction allows. `advanceHoldScan` runs the scan ahead in chunks; the ballot
 * (or `proposeAt`) then reads the cached result.
 */

/** Rough gas per checkpoint read by a scan (cold storage). */
export const HOLD_SCAN_GAS_PER_READ = 4_400;
/** Reads per `advanceHoldScan` transaction: about 9M gas. */
export const HOLD_SCAN_CHUNK = 2_000;
/** Scans longer than this are run ahead before the ballot (about 6.6M gas inline). */
export const HOLD_SCAN_INLINE_MAX = 1_500;

const checkpointsAbi = parseAbi([
  "function numCheckpoints(address account) view returns (uint32)",
  "function checkpoints(address account, uint32 pos) view returns ((uint48 key, uint208 value))",
]);

/** The read call `holdScanReads` needs. */
export type CheckpointReader = Pick<PublicClient, "readContract">;

/**
 * Checkpoint reads a scan of `account` over `[holdFrom, snapshot]` makes: every checkpoint keyed in
 * `(holdFrom, snapshot]` plus the one in effect at `holdFrom`. Binary searches, so it costs
 * O(log n) RPC reads. An upper bound: the scan stops early once it reads a zero balance.
 */
export async function holdScanReads(
  client: CheckpointReader,
  token: Address,
  account: Address,
  holdFrom: bigint,
  snapshot: bigint,
): Promise<number> {
  const n = Number(await client.readContract({ address: token, abi: checkpointsAbi, functionName: "numCheckpoints", args: [account] }));
  const keyAt = async (i: number): Promise<bigint> => {
    const cp = await client.readContract({ address: token, abi: checkpointsAbi, functionName: "checkpoints", args: [account, i] });
    return BigInt(cp.key);
  };
  // First index whose key is above `bound`.
  const upper = async (bound: bigint): Promise<number> => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((await keyAt(mid)) > bound) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const end = await upper(snapshot);
  if (end === 0) return 0;
  const start = await upper(holdFrom);
  // Indexes [start, end) are inside the window; one more read reaches the checkpoint at holdFrom.
  return end - start + (start > 0 ? 1 : 0);
}

/** `advanceHoldScan` transactions to send before the ballot (zero when the scan fits inline). */
export function holdScanChunks(reads: number, opts: { chunk?: number; inlineMax?: number } = {}): number {
  const chunk = opts.chunk ?? HOLD_SCAN_CHUNK;
  if (reads <= (opts.inlineMax ?? HOLD_SCAN_INLINE_MAX)) return 0;
  return Math.ceil(reads / chunk);
}

/** The poll a ballot is for, which fixes the `advanceHoldScan` call. */
export type HoldScanTarget =
  | { kind: "epoch"; token: Address; epoch: bigint }
  | { kind: "takeover"; proposalId: bigint }
  | { kind: "takeoverPropose"; token: Address; snapshot: bigint }
  | { kind: "rotation"; token: Address; holdFrom: bigint; snapshot: bigint };

/** `functionName` and `args` of one scan chunk on the target's governor. */
export function advanceHoldScanCall(
  target: HoldScanTarget,
  account: Address,
  maxReads: number = HOLD_SCAN_CHUNK,
): { functionName: "advanceHoldScan" | "advanceProposeScan"; args: readonly unknown[] } {
  const reads = BigInt(maxReads);
  switch (target.kind) {
    case "epoch":
      return { functionName: "advanceHoldScan", args: [target.token, target.epoch, account, reads] };
    case "takeover":
      return { functionName: "advanceHoldScan", args: [target.proposalId, account, reads] };
    case "takeoverPropose":
      return { functionName: "advanceProposeScan", args: [target.token, account, Number(target.snapshot), reads] };
    case "rotation":
      return { functionName: "advanceHoldScan", args: [target.token, target.holdFrom, target.snapshot, account, reads] };
  }
}

/**
 * Runs the scan ahead when it is too long for one ballot: sends `advanceHoldScan` chunks one after
 * another (`send` should wait for each receipt) and returns how many were sent.
 */
export async function runHoldScanAhead(opts: {
  reads: number;
  target: HoldScanTarget;
  account: Address;
  send: (call: ReturnType<typeof advanceHoldScanCall>) => Promise<void>;
  chunk?: number;
  inlineMax?: number;
  onChunk?: (done: number, total: number) => void;
}): Promise<number> {
  const total = holdScanChunks(opts.reads, opts);
  for (let i = 0; i < total; i++) {
    opts.onChunk?.(i, total);
    await opts.send(advanceHoldScanCall(opts.target, opts.account, opts.chunk ?? HOLD_SCAN_CHUNK));
  }
  return total;
}

/** The hold window `[holdFrom, snapshot]` the target's governor scans. */
export async function holdWindowOf(
  client: CheckpointReader,
  governor: Address,
  target: HoldScanTarget,
): Promise<{ holdFrom: bigint; snapshot: bigint }> {
  switch (target.kind) {
    case "epoch": {
      const g = { address: governor, abi: epochGovernorAbi } as const;
      const [holdFrom, snapshot] = await Promise.all([
        client.readContract({ ...g, functionName: "holdFromFor", args: [target.token, target.epoch] }),
        client.readContract({ ...g, functionName: "snapshotFor", args: [target.token, target.epoch] }),
      ]);
      return { holdFrom: BigInt(holdFrom), snapshot: BigInt(snapshot) };
    }
    case "takeover": {
      const p = await client.readContract({ address: governor, abi: takeoverGovernorAbi, functionName: "getProposal", args: [target.proposalId] });
      return { holdFrom: BigInt(p.lookbackSnapshot), snapshot: BigInt(p.snapshot) };
    }
    case "takeoverPropose": {
      const p = await client.readContract({ address: governor, abi: takeoverGovernorAbi, functionName: "params" });
      return { holdFrom: target.snapshot - BigInt(p.lookback), snapshot: target.snapshot };
    }
    case "rotation":
      return { holdFrom: target.holdFrom, snapshot: target.snapshot };
  }
}

/**
 * Before a ballot: counts the voter's scan and, when it is too long for one transaction, runs it
 * ahead (`send` sends one call to the governor and waits for its receipt). Returns the chunks sent.
 */
export async function prepareHoldScan(opts: {
  client: CheckpointReader;
  governor: Address;
  token: Address;
  account: Address;
  target: HoldScanTarget;
  send: (call: ReturnType<typeof advanceHoldScanCall>) => Promise<void>;
  onChunk?: (done: number, total: number) => void;
}): Promise<number> {
  const { holdFrom, snapshot } = await holdWindowOf(opts.client, opts.governor, opts.target);
  const reads = await holdScanReads(opts.client, opts.token, opts.account, holdFrom, snapshot);
  return runHoldScanAhead({ reads, target: opts.target, account: opts.account, send: opts.send, onChunk: opts.onChunk });
}
