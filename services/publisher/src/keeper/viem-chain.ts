import { donationDistributorAbi, epochGovernorAbi, feeVaultAbi, rotationGovernorAbi, takeoverGovernorAbi, varadaFactoryAbi, varadaLpLockerAbi, zamaVotingSchemeAbi } from "@varada/sdk/abis";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import {
  ballotCall,
  ballotCommitment as ballotCommitmentOf,
  createBallotReader,
  createRoundReader,
  PERIOD_PROPOSAL_STATES,
  readEpochWindow,
  ROUND_STATUSES,
  roundCall,
} from "@varada/sdk";
import type { BallotReader, RoundReader } from "./ballot.js";
import {
  KeeperRevert,
  PROPOSAL_STATES,
  type ChainReader,
  type ChainWriter,
  type FactoryLogReader,
  type KeeperAction,
  type RotationReader,
} from "./chain.js";

/** The ballot's org ids could be read from neither the indexer nor the governor's logs. */
export class BallotUnavailable extends Error {
  constructor(detail: string) {
    super(`ballot org ids unavailable: ${detail}`);
    this.name = "BallotUnavailable";
  }
}

export interface ViemChainOptions {
  chainId: number;
  /** Tried in order (viem fallback transport); JSON-RPC batching is on. */
  rpcUrls: string[];
  privateKey: Hex;
  epochGovernor: Address;
  takeoverGovernor: Address;
  /** Live mode's `RotationGovernor`; without it no rotation reader is built and round calls throw. */
  rotationGovernor?: Address;
  /** Factory whose `TokenCreated` logs list tokens (needs a start block, so set apart from `locker`). */
  factory?: Address;
  /** Factory whose `locker()` holds the tokens' LP positions, for {@link ChainReader.uncollectedFees}. */
  lockerFactory?: Address;
  /** Blocks per `eth_getLogs` request (factory scan, ballot log lookup). */
  logChunk?: bigint;
  /** Lowest block the ballot log lookup searches from (the deploy block); 0 when unset. */
  fromBlock?: bigint;
  /**
   * Second source of a ballot's org ids (the indexer's epoch detail), tried before the log scan.
   * Its answer is used only when it matches `ballotCommitment`; null when it has none.
   */
  ballotSource?: (token: Address, epoch: bigint) => Promise<readonly Hex[] | null>;
  receiptTimeoutMs?: number;
  /** `FeeVault` and `DonationDistributor`: targets of the `settle` and `distribute` actions. */
  feeVault?: Address;
  donationDistributor?: Address;
  /** Test seam: replaces the RPC transport built from `rpcUrls`. */
  transport?: Transport;
}

export function chainFor(chainId: number, rpcUrls: string[]): Chain {
  if (chainId === mainnet.id) return mainnet;
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
  });
}

export function transportFor(rpcUrls: string[]): Transport {
  if (rpcUrls.length === 0) throw new Error("no RPC URL");
  const one = (u: string) => http(u, { batch: true, timeout: 30_000, retryCount: 2 });
  return rpcUrls.length === 1 ? one(rpcUrls[0]!) : fallback(rpcUrls.map(one));
}

/** Decoded custom error name of a revert, if any. Arguments are never kept (they may name voters). */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.signature ?? r.reason;
  return undefined;
}

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/** viem-backed {@link ChainReader}, {@link ChainWriter} and factory log reader. */
export function createViemChain(opts: ViemChainOptions): {
  reader: ChainReader;
  writer: ChainWriter;
  ballots: BallotReader;
  /** With `rotationGovernor`: round state and outcome reads, and the round preparer's reads. */
  rotation?: RotationReader;
  rounds?: RoundReader;
  factoryLogs?: FactoryLogReader;
  publicClient: PublicClient;
} {
  const chain = chainFor(opts.chainId, opts.rpcUrls);
  const transport = opts.transport ?? transportFor(opts.rpcUrls);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const account = privateKeyToAccount(opts.privateKey);
  const wallet = createWalletClient({ chain, transport, account });
  const eg = opts.epochGovernor;
  const tg = opts.takeoverGovernor;

  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  const chunk = opts.logChunk ?? 10_000n;
  const ballotPrepared = epochGovernorAbi.find((x) => x.type === "event" && x.name === "BallotPrepared");
  if (!ballotPrepared || ballotPrepared.type !== "event") throw new Error("BallotPrepared missing from the governor ABI");
  /** First block at or after `timestamp` (binary search, cached; `latest + 1` when none is yet). */
  const blockAtCache = new Map<bigint, bigint>();
  const firstBlockAt = async (timestamp: bigint, latest: bigint): Promise<bigint> => {
    const hit = blockAtCache.get(timestamp);
    if (hit !== undefined) return hit;
    let lo = opts.fromBlock ?? 0n;
    let hi = latest + 1n;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if ((await publicClient.getBlock({ blockNumber: mid })).timestamp >= timestamp) hi = mid;
      else lo = mid + 1n;
    }
    if (lo <= latest) blockAtCache.set(timestamp, lo);
    return lo;
  };

  const reader: ChainReader = {
    currentEpoch: () => read<bigint>(eg, epochGovernorAbi, "currentEpoch"),
    async timing() {
      const [block, window, tallyGrace, settleGrace] = await Promise.all([
        publicClient.getBlock({ blockTag: "latest" }),
        readEpochWindow(publicClient, eg),
        read<bigint>(eg, epochGovernorAbi, "tallyGrace"),
        opts.feeVault ? read<bigint>(opts.feeVault, feeVaultAbi, "settleGrace") : Promise.resolve(undefined),
      ]);
      return { now: block.timestamp, window, tallyGrace, settleGrace };
    },
    epochStart: (epoch) => read<bigint>(eg, epochGovernorAbi, "epochStart", [epoch]),
    isRegistered: (token) => read<boolean>(eg, epochGovernorAbi, "isRegistered", [token]),
    async epoch(token, epoch) {
      const [opened, closed, finalized, voterCount, scheme] = await Promise.all([
        read<boolean>(eg, epochGovernorAbi, "isOpened", [token, epoch]),
        read<boolean>(eg, epochGovernorAbi, "isClosed", [token, epoch]),
        read<boolean>(eg, epochGovernorAbi, "isFinalized", [token, epoch]),
        read<bigint>(eg, epochGovernorAbi, "voterCount", [token, epoch]),
        read<Address>(eg, epochGovernorAbi, "epochScheme", [token, epoch]),
      ]);
      return { opened, closed, finalized, voterCount, scheme };
    },
    async tallyOf(scheme, governor, token, scope) {
      const [isFinal, counts] = await read<readonly [boolean, readonly bigint[]]>(scheme, zamaVotingSchemeAbi, "tallyOf", [governor, token, scope]);
      return { isFinal, counts };
    },
    tallyHandles: (scheme, governor, token, scope) => read<readonly Hex[]>(scheme, zamaVotingSchemeAbi, "tallyHandles", [governor, token, scope]),
    async ballotOrgIds(token, epoch) {
      const [commitment, count] = await read<readonly [Hex, number]>(eg, epochGovernorAbi, "ballotCommitment", [token, epoch]);
      const matches = (orgIds: readonly Hex[]) => orgIds.length === Number(count) && ballotCommitmentOf(orgIds) === commitment.toLowerCase();
      let sourceNote = "no indexer";
      if (opts.ballotSource) {
        try {
          const orgIds = await opts.ballotSource(token, epoch);
          if (orgIds && matches(orgIds)) return [...orgIds];
          sourceNote = orgIds ? "indexer org ids do not match the ballot commitment" : "indexer has no org ids";
        } catch (err) {
          sourceNote = `indexer: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      // A ballot is prepared during the epoch it names, so its log lies between the epoch's bounds.
      let found: Hex[] | undefined;
      try {
        const [start, end, latest] = await Promise.all([
          read<bigint>(eg, epochGovernorAbi, "epochStart", [epoch]),
          read<bigint>(eg, epochGovernorAbi, "epochStart", [epoch + 1n]),
          publicClient.getBlockNumber(),
        ]);
        const from = await firstBlockAt(start, latest);
        const to = (await firstBlockAt(end, latest)) - 1n;
        for (let lo = from; lo <= to && !found; lo += chunk) {
          const hi = lo + chunk - 1n < to ? lo + chunk - 1n : to;
          const logs = await publicClient.getLogs({ address: eg, event: ballotPrepared, args: { token, epoch }, fromBlock: lo, toBlock: hi, strict: true });
          if (logs[0]) found = [...(logs[0].args as { orgIds: readonly Hex[] }).orgIds];
        }
      } catch (err) {
        throw new BallotUnavailable(
          `${sourceNote}; BallotPrepared log read failed (the keeper RPC must serve eth_getLogs for the epoch's blocks): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!found) throw new BallotUnavailable(`${sourceNote}; BallotPrepared log not found`);
      if (!matches(found)) throw new BallotUnavailable(`${sourceNote}; BallotPrepared log does not match the ballot commitment`);
      return found;
    },
    proposalCount: () => read<bigint>(tg, takeoverGovernorAbi, "proposalCount"),
    async proposal(id) {
      const [p, state, closed, scheme] = await Promise.all([
        read<{ token: Address; tallied: boolean }>(tg, takeoverGovernorAbi, "getProposal", [id]),
        read<number>(tg, takeoverGovernorAbi, "state", [id]),
        read<boolean>(tg, takeoverGovernorAbi, "isClosed", [id]),
        read<Address>(tg, takeoverGovernorAbi, "proposalScheme", [id]),
      ]);
      const s = PROPOSAL_STATES[state];
      if (!s) throw new Error(`unknown proposal state ${state}`);
      return { token: p.token, tallied: p.tallied, state: s, closed, scheme };
    },
  };
  if (opts.lockerFactory) {
    const lf = opts.lockerFactory;
    let locker: Promise<Address> | undefined;
    reader.uncollectedFees = async (token) => {
      const address = await (locker ??= read<Address>(lf, varadaFactoryAbi, "locker").catch((err: unknown) => {
        locker = undefined;
        throw err;
      }));
      // collectFees is permissionless and returns what it would take: an eth_call costs nothing.
      const { result } = await publicClient.simulateContract({ address, abi: varadaLpLockerAbi, functionName: "collectFees", args: [token] } as never);
      const [a0, a1] = result as readonly [bigint, bigint];
      return a0 + a1;
    };
  }

  const rg = opts.rotationGovernor;
  const needRotation = (): Address => {
    if (!rg) throw new Error("no rotation governor configured");
    return rg;
  };
  let rotation: RotationReader | undefined;
  if (rg) {
    rotation = {
      isRegistered: (token) => read<boolean>(rg, rotationGovernorAbi, "isRegistered", [token]),
      currentRotation: (token) => read<bigint>(rg, rotationGovernorAbi, "currentRotation", [token]),
      async round(token, target) {
        const [[status, , voteEnd, voters], scheme] = await Promise.all([
          read<readonly [number, number, number, number, Hex, bigint, readonly Hex[]]>(rg, rotationGovernorAbi, "roundOf", [token, target]),
          read<Address>(rg, rotationGovernorAbi, "roundScheme", [token, target]),
        ]);
        const s = ROUND_STATUSES[Number(status)];
        if (!s) throw new Error(`unknown round status ${status}`);
        return { status: s, voteEnd: BigInt(voteEnd), voters: BigInt(voters), scheme };
      },
      async outcomeOf(scheme, governor, token, scope) {
        const [isFinal, winner] = await read<readonly [boolean, number]>(scheme, zamaVotingSchemeAbi, "outcomeOf", [governor, token, scope]);
        return { isFinal, winner: Number(winner) };
      },
      outcomeHandle: (scheme, governor, token, scope) => read<Hex>(scheme, zamaVotingSchemeAbi, "outcomeHandle", [governor, token, scope]),
      now: async () => (await publicClient.getBlock({ blockTag: "latest" })).timestamp,
      proposalCount: () => read<bigint>(rg, rotationGovernorAbi, "proposalCount"),
      async periodProposal(id) {
        const [state, p] = await Promise.all([
          read<number>(rg, rotationGovernorAbi, "proposalState", [id]),
          read<{ token: Address; scheme: Address; executionDeadline: number | bigint }>(rg, rotationGovernorAbi, "getProposal", [id]),
        ]);
        const s = PERIOD_PROPOSAL_STATES[Number(state)];
        if (!s) throw new Error(`unknown period proposal state ${state}`);
        return { token: p.token, state: s, scheme: p.scheme, executionDeadline: BigInt(p.executionDeadline) };
      },
    };
  }

  const toCall = (a: KeeperAction): Call => {
    switch (a.kind) {
      case "openRound":
      case "prepareRound":
      case "prepareCuratedRound":
        return roundCall(a, needRotation());
      case "closeRound":
      case "finalizeRound":
        return { address: needRotation(), abi: rotationGovernorAbi, functionName: a.kind, args: [a.token, a.target] };
      case "closePeriodProposal":
      case "executePeriodProposal":
        return { address: needRotation(), abi: rotationGovernorAbi, functionName: a.kind, args: [a.id] };
      case "submitOutcome":
        return { address: a.scheme, abi: zamaVotingSchemeAbi, functionName: "submitOutcome", args: [a.governor, a.token, a.scope, a.cleartexts, a.proof] };
      case "openEpoch":
      case "prepareBallot":
      case "prepareCuratedBallot":
        return ballotCall(a, eg);
      case "closeEpoch":
        return { address: eg, abi: epochGovernorAbi, functionName: a.kind, args: [a.token, a.epoch] };
      case "finalizeEpoch":
        return { address: eg, abi: epochGovernorAbi, functionName: a.kind, args: [a.token, a.epoch, a.orgIds] };
      case "submitTally":
        return { address: a.scheme, abi: zamaVotingSchemeAbi, functionName: "submitTally", args: [a.governor, a.token, a.scope, a.cleartexts, a.proof] };
      case "closeProposal":
      case "recordTally":
      case "execute":
        return { address: tg, abi: takeoverGovernorAbi, functionName: a.kind, args: [a.id] };
      case "settle":
        if (!opts.feeVault) throw new Error("no fee vault configured");
        return { address: opts.feeVault, abi: feeVaultAbi, functionName: a.kind, args: [a.token, a.epoch] };
      case "distribute":
        if (!opts.donationDistributor) throw new Error("no donation distributor configured");
        return { address: opts.donationDistributor, abi: donationDistributorAbi, functionName: a.kind, args: [a.token, a.epoch] };
    }
  };

  const writer: ChainWriter = {
    account: account.address,
    async estimate(action) {
      try {
        return await publicClient.estimateContractGas({ ...toCall(action), account } as never);
      } catch (err) {
        const name = revertName(err);
        if (name !== undefined || (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError))) {
          throw new KeeperRevert(name, `${action.kind} would revert`);
        }
        throw err;
      }
    },
    async send(action, gas) {
      const hash = await wallet.writeContract({ ...toCall(action), gas, chain, account } as never);
      const r = await publicClient.waitForTransactionReceipt({ hash, timeout: opts.receiptTimeoutMs ?? 5 * 60_000 });
      return { hash, status: r.status, gasUsed: r.gasUsed };
    },
    async hasPendingTx() {
      const [pending, latest] = await Promise.all([
        publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
        publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
      ]);
      return pending > latest;
    },
  };

  let factoryLogs: FactoryLogReader | undefined;
  if (opts.factory) {
    const factory = opts.factory;
    const event = varadaFactoryAbi.find((x) => x.type === "event" && x.name === "TokenCreated");
    if (!event || event.type !== "event") throw new Error("TokenCreated missing from the factory ABI");
    factoryLogs = {
      async tokensCreated(fromBlock) {
        const latest = await publicClient.getBlockNumber();
        const tokens: Address[] = [];
        for (let start = fromBlock; start <= latest; start += chunk) {
          const end = start + chunk - 1n < latest ? start + chunk - 1n : latest;
          const logs = await publicClient.getLogs({ address: factory, event, fromBlock: start, toBlock: end, strict: true });
          for (const l of logs) tokens.push((l.args as { token: Address }).token);
        }
        return { tokens, toBlock: latest < fromBlock ? fromBlock - 1n : latest };
      },
    };
  }

  const ballots: BallotReader = createBallotReader(publicClient, eg);
  const rounds: RoundReader | undefined = rg ? createRoundReader(publicClient, rg) : undefined;

  return { reader, writer, ballots, rotation, rounds, factoryLogs, publicClient };
}
