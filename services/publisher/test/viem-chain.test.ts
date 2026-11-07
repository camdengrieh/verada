import { ballotCommitment, periodPollScope, rotationPollScope } from "@varada/sdk";
import { epochGovernorAbi, feeVaultAbi, rotationGovernorAbi, zamaVotingSchemeAbi } from "@varada/sdk/abis";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  hexToBigInt,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { KeeperRevert, type KeeperAction } from "../src/keeper/chain.js";
import { describe, expect, it } from "vitest";
import { BallotUnavailable, createViemChain } from "../src/keeper/viem-chain.js";

const EG = "0x00000000000000000000000000000000000000e1" as Address;
const TOKEN = "0x000000000000000000000000000000000000aa01" as Address;
const KEY = `0x${"11".repeat(32)}` as Hex;
const ORGS = [0, 1, 2].map((i) => keccak256(toHex(`org-${i}`)));

/**
 * A chain of 12-second blocks from timestamp 1000 with 100-block epochs. The governor's
 * `BallotPrepared` for (TOKEN, 2) is in block 250, inside epoch 2 (blocks 200..299).
 */
function fakeRpc(opts: { commitment?: Hex; logBlock?: bigint; logsPruned?: boolean } = {}) {
  const latest = 1_000n;
  const logBlock = opts.logBlock ?? 250n;
  const ts = (n: bigint) => 1_000n + 12n * n;
  const ranges: [bigint, bigint][] = [];
  const topics = encodeEventTopics({ abi: epochGovernorAbi, eventName: "BallotPrepared", args: { token: TOKEN, epoch: 2n } });
  const transport = custom({
    async request({ method, params }: { method: string; params: unknown[] }) {
      switch (method) {
        case "eth_chainId":
          return toHex(31337);
        case "eth_blockNumber":
          return toHex(latest);
        case "eth_getBlockByNumber": {
          const n = hexToBigInt(params[0] as Hex);
          return { number: toHex(n), timestamp: toHex(ts(n)), hash: keccak256(toHex(n)), parentHash: keccak256(toHex(n - 1n)), transactions: [] };
        }
        case "eth_call": {
          const { data } = params[0] as { data: Hex };
          const call = decodeFunctionData({ abi: epochGovernorAbi, data });
          if (call.functionName === "epochStart") {
            return encodeFunctionResult({ abi: epochGovernorAbi, functionName: "epochStart", result: 1_000n + (call.args![0] as bigint) * 1_200n });
          }
          if (call.functionName === "ballotCommitment") {
            return encodeFunctionResult({ abi: epochGovernorAbi, functionName: "ballotCommitment", result: [opts.commitment ?? ballotCommitment(ORGS), ORGS.length] });
          }
          throw new Error(`unexpected call ${call.functionName}`);
        }
        case "eth_getLogs": {
          const f = params[0] as { fromBlock: Hex; toBlock: Hex; topics: (Hex | null)[] };
          const from = hexToBigInt(f.fromBlock);
          const to = hexToBigInt(f.toBlock);
          ranges.push([from, to]);
          expect(f.topics).toEqual(topics);
          if (opts.logsPruned) throw new Error("Archive requests require a personal token");
          if (logBlock < from || logBlock > to) return [];
          return [
            {
              address: EG,
              topics,
              data: encodeAbiParameters(
                [{ type: "uint32" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32[]" }],
                [1, 50n, 0, ORGS],
              ),
              blockNumber: toHex(logBlock),
              blockHash: keccak256(toHex(logBlock)),
              transactionHash: keccak256(toHex("tx")),
              transactionIndex: "0x0",
              logIndex: "0x0",
              removed: false,
            },
          ];
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  });
  return { transport, ranges };
}

const chainWith = (rpc: ReturnType<typeof fakeRpc>, fromBlock?: bigint, ballotSource?: (token: Address, epoch: bigint) => Promise<readonly Hex[] | null>) =>
  createViemChain({
    chainId: 31337,
    rpcUrls: ["http://unused"],
    privateKey: KEY,
    epochGovernor: EG,
    takeoverGovernor: EG,
    logChunk: 30n,
    fromBlock,
    ballotSource,
    transport: rpc.transport,
  });

describe("viem chain: ballotOrgIds", () => {
  it("finds the BallotPrepared log within the epoch's blocks, chunk by chunk", async () => {
    const rpc = fakeRpc();
    const { reader } = chainWith(rpc);
    expect(await reader.ballotOrgIds(TOKEN, 2n)).toEqual(ORGS);
    // Epoch 2 starts at block 200 (timestamp 3400); the scan stops at the chunk holding block 250.
    expect(rpc.ranges).toEqual([
      [200n, 229n],
      [230n, 259n],
    ]);
  });

  it("rejects a log that does not match the ballot commitment", async () => {
    const { reader } = chainWith(fakeRpc({ commitment: keccak256("0x01") }));
    await expect(reader.ballotOrgIds(TOKEN, 2n)).rejects.toThrow(/does not match the ballot commitment/);
  });

  it("fails when the epoch's blocks hold no ballot log", async () => {
    const rpc = fakeRpc({ logBlock: 300n });
    const { reader } = chainWith(rpc, 100n);
    await expect(reader.ballotOrgIds(TOKEN, 2n)).rejects.toThrow(/not found/);
    // Searched exactly epoch 2: blocks 200..299.
    expect(rpc.ranges.at(0)?.[0]).toBe(200n);
    expect(rpc.ranges.at(-1)?.[1]).toBe(299n);
  });
});

describe("viem chain: ballotOrgIds with an indexer source", () => {
  it("uses the indexer's org ids when they match the commitment, without scanning logs", async () => {
    const rpc = fakeRpc({ logsPruned: true });
    const { reader } = chainWith(rpc, undefined, async () => ORGS);
    expect(await reader.ballotOrgIds(TOKEN, 2n)).toEqual(ORGS);
    expect(rpc.ranges).toEqual([]);
  });

  it("falls back to the logs when the indexer's org ids do not match", async () => {
    const rpc = fakeRpc();
    const { reader } = chainWith(rpc, undefined, async () => [ORGS[1]!, ORGS[0]!, ORGS[2]!]);
    expect(await reader.ballotOrgIds(TOKEN, 2n)).toEqual(ORGS);
    expect(rpc.ranges.length).toBeGreaterThan(0);
  });

  it("names both sources when the indexer is down and the RPC refuses old logs", async () => {
    const { reader } = chainWith(fakeRpc({ logsPruned: true }), undefined, async () => {
      throw new Error("indexer /api/epochs/... returned HTTP 503");
    });
    const err = (await reader.ballotOrgIds(TOKEN, 2n).then(
      () => undefined,
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(BallotUnavailable);
    expect(err.message).toMatch(/^ballot org ids unavailable: indexer: indexer \/api\/epochs\/\.\.\. returned HTTP 503; BallotPrepared log read failed \(the keeper RPC must serve eth_getLogs/);
  });

  it("reports a pruned RPC without an indexer", async () => {
    const { reader } = chainWith(fakeRpc({ logsPruned: true }));
    await expect(reader.ballotOrgIds(TOKEN, 2n)).rejects.toThrow(/no indexer; BallotPrepared log read failed/);
  });
});

describe("viem chain: pending transactions", () => {
  it("compares the account's pending and latest nonces", async () => {
    const nonces = { pending: 5n, latest: 4n };
    const seen: string[] = [];
    const transport = custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        if (method === "eth_chainId") return toHex(31337);
        if (method !== "eth_getTransactionCount") throw new Error(`unexpected ${method}`);
        const tag = params[1] as "pending" | "latest";
        seen.push(tag);
        return toHex(nonces[tag]);
      },
    });
    const { writer } = createViemChain({ chainId: 31337, rpcUrls: ["http://unused"], privateKey: KEY, epochGovernor: EG, takeoverGovernor: EG, transport });
    expect(await writer.hasPendingTx!()).toBe(true);
    nonces.latest = 5n;
    expect(await writer.hasPendingTx!()).toBe(false);
    expect(seen.sort()).toEqual(["latest", "latest", "pending", "pending"]);
  });
});

const RG = "0x00000000000000000000000000000000000000e3" as Address;
const ZAMA = "0x00000000000000000000000000000000000000a1" as Address;
const HANDLE = keccak256(toHex("outcome"));
const ZERO32 = `0x${"0".repeat(64)}` as Hex;

/** A rotation governor at `RG` and a Zama scheme at `ZAMA`, answering reads and gas estimates. */
function rotationRpc(opts: { revert?: string } = {}) {
  const calls: { to: Address; fn: string; args: readonly unknown[] }[] = [];
  const estimates: { to: Address; fn: string; args: readonly unknown[] }[] = [];
  const abiAt = (to: Address) => (to.toLowerCase() === RG ? rotationGovernorAbi : zamaVotingSchemeAbi) as Abi;
  const decode = (to: Address, data: Hex) => {
    const c = decodeFunctionData({ abi: abiAt(to), data });
    const lower = (a: unknown) => (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);
    return { to, fn: c.functionName, args: (c.args ?? []).map(lower) };
  };
  const results: Record<string, unknown> = {
    isRegistered: true,
    currentRotation: 7n,
    roundOf: [2, 999, 3700, 3, ZERO32, 0n, []],
    roundScheme: ZAMA,
    pollWindow: [999, 1000, 3700],
    outcomeOf: [false, 255],
    outcomeHandle: HANDLE,
    proposalCount: 2n,
    proposalState: 3,
    getProposal: {
      token: TOKEN,
      newPeriod: 1,
      flags: 1,
      snapshot: 900,
      end: 2_000,
      proposer: TOKEN,
      executionDeadline: 261_200,
      voters: 4,
      scheme: ZAMA,
      quorumWeight: 10n,
      fromRotation: 0n,
      holdFrom: 800,
      executionsAtProposal: 0,
    },
  };
  const transport = custom({
    async request({ method, params }: { method: string; params: unknown[] }) {
      switch (method) {
        case "eth_chainId":
          return toHex(31337);
        case "eth_blockNumber":
          return toHex(1_000n);
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_gasPrice":
        case "eth_maxPriorityFeePerGas":
          return "0x1";
        case "eth_getBlockByNumber":
          return { number: toHex(1_000n), timestamp: toHex(1_234_567n), hash: keccak256(toHex(1)), parentHash: keccak256(toHex(0)), transactions: [] };
        case "eth_call": {
          const { to, data } = params[0] as { to: Address; data: Hex };
          const c = decode(to, data);
          calls.push(c);
          if (!(c.fn in results)) throw new Error(`unexpected call ${c.fn}`);
          return encodeFunctionResult({ abi: abiAt(to), functionName: c.fn, result: results[c.fn] } as never);
        }
        case "eth_estimateGas": {
          const { to, data } = params[0] as { to: Address; data: Hex };
          estimates.push(decode(to, data));
          if (opts.revert) {
            throw { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: rotationGovernorAbi, errorName: opts.revert } as never) };
          }
          return toHex(50_000n);
        }
        case "eth_fillTransaction":
          // Not served, like most public RPCs: viem fills the transaction itself.
          throw { code: -32601, message: "the method eth_fillTransaction does not exist" };
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  });
  return { transport, calls, estimates };
}

const liveChain = (rpc: ReturnType<typeof rotationRpc>, rotationGovernor: Address | null = RG) =>
  createViemChain({
    chainId: 31337,
    rpcUrls: ["http://unused"],
    privateKey: KEY,
    epochGovernor: EG,
    takeoverGovernor: EG,
    rotationGovernor: rotationGovernor ?? undefined,
    transport: rpc.transport,
  });

describe("viem chain: rotation rounds", () => {
  it("reads round state, its scheme and the outcome from the governor and the scheme", async () => {
    const rpc = rotationRpc();
    const { rotation } = liveChain(rpc);
    expect(await rotation!.isRegistered(TOKEN)).toBe(true);
    expect(await rotation!.currentRotation(TOKEN)).toBe(7n);
    const round = await rotation!.round(TOKEN, 8n);
    expect(round).toMatchObject({ status: "Closed", voteEnd: 3700n, voters: 3n });
    expect(round.scheme.toLowerCase()).toBe(ZAMA);
    const scope = rotationPollScope(8n);
    expect(await rotation!.outcomeOf(ZAMA, RG, TOKEN, scope)).toEqual({ isFinal: false, winner: 255 });
    expect(await rotation!.outcomeHandle(ZAMA, RG, TOKEN, scope)).toBe(HANDLE);
    expect(await rotation!.now()).toBe(1_234_567n);
    expect(rpc.calls.find((c) => c.fn === "roundOf")).toMatchObject({ to: RG, args: [TOKEN, 8n] });
    expect(rpc.calls.find((c) => c.fn === "roundScheme")).toMatchObject({ to: RG, args: [TOKEN, 8n] });
    expect(rpc.calls.find((c) => c.fn === "outcomeOf")).toMatchObject({ to: ZAMA, args: [RG, TOKEN, scope] });
  });

  it("reads period-change proposals from the rotation governor", async () => {
    const rpc = rotationRpc();
    const { rotation } = liveChain(rpc);
    expect(await rotation!.proposalCount()).toBe(2n);
    const p = await rotation!.periodProposal(2n);
    expect(p).toMatchObject({ state: "Closed", executionDeadline: 261_200n });
    expect(p.token.toLowerCase()).toBe(TOKEN);
    expect(p.scheme.toLowerCase()).toBe(ZAMA);
    expect(rpc.calls.find((c) => c.fn === "proposalState")).toMatchObject({ to: RG, args: [2n] });
    expect(rpc.calls.find((c) => c.fn === "getProposal")).toMatchObject({ to: RG, args: [2n] });
  });

  it("sends period-change proposal calls to the rotation governor", async () => {
    const rpc = rotationRpc();
    const { writer } = liveChain(rpc);
    expect(await writer.estimate({ kind: "closePeriodProposal", id: 2n })).toBe(50_000n);
    expect(await writer.estimate({ kind: "executePeriodProposal", id: 2n })).toBe(50_000n);
    const cleartexts = encodeAbiParameters([{ type: "uint256" }], [1n]);
    await writer.estimate({ kind: "submitOutcome", scheme: ZAMA, governor: RG, token: TOKEN, scope: periodPollScope(2n), cleartexts, proof: "0x5eed" });
    expect(rpc.estimates.map((e) => [e.to, e.fn, e.args])).toEqual([
      [RG, "closePeriodProposal", [2n]],
      [RG, "executePeriodProposal", [2n]],
      [ZAMA, "submitOutcome", [RG, TOKEN, periodPollScope(2n), cleartexts, "0x5eed"]],
    ]);
  });

  it("gives the round preparer its reads through the same client", async () => {
    const { rounds } = liveChain(rotationRpc());
    expect(await rounds!.roundStatus(TOKEN, 8n)).toBe("Closed");
    expect(await rounds!.pollWindow(TOKEN, 8n)).toEqual({ snapshot: 999n, voteStart: 1000n, voteEnd: 3700n });
    expect(await rounds!.now()).toBe(1_234_567n);
  });

  it("sends round calls to the rotation governor and the outcome to the scheme", async () => {
    const rpc = rotationRpc();
    const { writer } = liveChain(rpc);
    const draws = [{ orgId: HANDLE, proof: [HANDLE] }];
    const curated = [{ catalogIndex: 3, pickOrgId: HANDLE, pickProof: [HANDLE], entryOrgId: HANDLE, entryProof: [HANDLE] }];
    const actions: KeeperAction[] = [
      { kind: "openRound", token: TOKEN, target: 8n },
      { kind: "prepareRound", token: TOKEN, target: 8n, draws },
      { kind: "prepareCuratedRound", token: TOKEN, target: 8n, curated, draws },
      { kind: "closeRound", token: TOKEN, target: 7n },
      { kind: "finalizeRound", token: TOKEN, target: 7n },
      { kind: "submitOutcome", scheme: ZAMA, governor: RG, token: TOKEN, scope: rotationPollScope(7n), cleartexts: encodeAbiParameters([{ type: "uint256" }], [1n]), proof: "0x5eed" },
    ];
    for (const a of actions) expect(await writer.estimate(a)).toBe(50_000n);
    expect(rpc.estimates.map((e) => [e.to, e.fn])).toEqual([
      [RG, "openRound"],
      [RG, "prepareRound"],
      [RG, "prepareCuratedRound"],
      [RG, "closeRound"],
      [RG, "finalizeRound"],
      [ZAMA, "submitOutcome"],
    ]);
    // openRound derives the target on chain; the others name it.
    expect(rpc.estimates[0]!.args).toEqual([TOKEN]);
    expect(rpc.estimates[1]!.args).toEqual([TOKEN, 8n, draws]);
    expect(rpc.estimates[3]!.args).toEqual([TOKEN, 7n]);
    expect(rpc.estimates[5]!.args).toEqual([RG, TOKEN, rotationPollScope(7n), encodeAbiParameters([{ type: "uint256" }], [1n]), "0x5eed"]);
  });

  it("decodes a round call's revert", async () => {
    const { writer } = liveChain(rotationRpc({ revert: "VotingNotEnded" }));
    const err = await writer.estimate({ kind: "closeRound", token: TOKEN, target: 7n }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeeperRevert);
    expect((err as KeeperRevert).errorName).toBe("VotingNotEnded");
  });

  it("has no rotation reader without a rotation governor, and refuses round calls", async () => {
    const chain = liveChain(rotationRpc(), null);
    expect(chain.rotation).toBeUndefined();
    expect(chain.rounds).toBeUndefined();
    await expect(chain.writer.estimate({ kind: "closeRound", token: TOKEN, target: 7n })).rejects.toThrow(/no rotation governor configured/);
  });
});

describe("viem chain: epoch schedule", () => {
  const FV = "0x00000000000000000000000000000000000000f1" as Address;
  // Epoch 7 of a 45 minute cycle (30 trading, 15 voting) anchored at 1_000_000.
  const ZERO = 1_000_000n;
  const LEN = 2_700n;
  const VOTING = 900n;
  const NOW = ZERO + 7n * LEN + 600n;

  function scheduleRpc(opts: { withoutGetters?: boolean } = {}) {
    const calls: string[] = [];
    const transport = custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        switch (method) {
          case "eth_chainId":
            return toHex(31337);
          case "eth_getBlockByNumber":
            return { number: toHex(5n), timestamp: toHex(NOW), hash: keccak256(toHex(5n)), parentHash: keccak256(toHex(4n)), transactions: [] };
          case "eth_call": {
            const { data, to } = params[0] as { data: Hex; to: Address };
            if (to.toLowerCase() === FV.toLowerCase()) {
              calls.push("settleGrace");
              return encodeFunctionResult({ abi: feeVaultAbi, functionName: "settleGrace", result: 600n });
            }
            const call = decodeFunctionData({ abi: epochGovernorAbi, data });
            calls.push(call.functionName);
            const e = call.args?.[0] as bigint;
            switch (call.functionName) {
              case "currentEpoch":
                return encodeFunctionResult({ abi: epochGovernorAbi, functionName: "currentEpoch", result: 7n });
              case "epochStart":
                return encodeFunctionResult({ abi: epochGovernorAbi, functionName: "epochStart", result: ZERO + e * LEN });
              case "votingOpensAt":
                if (opts.withoutGetters) throw new Error("execution reverted");
                return encodeFunctionResult({ abi: epochGovernorAbi, functionName: "votingOpensAt", result: ZERO + (e + 1n) * LEN - VOTING });
              case "epochScheduleFor":
                if (opts.withoutGetters) throw new Error("execution reverted");
                return encodeFunctionResult({ abi: epochGovernorAbi, functionName: "epochScheduleFor", result: [LEN, VOTING, LEN] });
              case "tallyGrace":
                return encodeFunctionResult({ abi: epochGovernorAbi, functionName: "tallyGrace", result: 900n });
              default:
                throw new Error(`unexpected call ${call.functionName}`);
            }
          }
          default:
            throw new Error(`unexpected ${method}`);
        }
      },
    });
    return { transport, calls };
  }

  const timingOf = (rpc: ReturnType<typeof scheduleRpc>, feeVault?: Address) =>
    createViemChain({ chainId: 31337, rpcUrls: ["http://unused"], privateKey: KEY, epochGovernor: EG, takeoverGovernor: EG, feeVault, transport: rpc.transport }).reader.timing!();

  it("reads the window and graces from the governor and the vault, not from constants", async () => {
    const rpc = scheduleRpc();
    const t = await timingOf(rpc, FV);
    expect(t).toEqual({
      now: NOW,
      window: {
        epoch: 7n,
        start: ZERO + 7n * LEN,
        end: ZERO + 8n * LEN,
        votingOpensAt: ZERO + 8n * LEN - VOTING,
        length: LEN,
        votingWindow: VOTING,
        holdWindow: LEN,
      },
      tallyGrace: 900n,
      settleGrace: 600n,
    });
    expect(rpc.calls).toEqual(expect.arrayContaining(["currentEpoch", "epochStart", "votingOpensAt", "epochScheduleFor", "tallyGrace", "settleGrace"]));
  });

  it("skips the settle grace without a fee vault", async () => {
    const t = await timingOf(scheduleRpc());
    expect(t.settleGrace).toBeUndefined();
  });
});
