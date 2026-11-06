import type { PeriodProposalState, RoundStatus } from "@varada/sdk";
import type { Address, Hex } from "viem";

/** `ITakeoverGovernor.State`, in enum order. */
export const PROPOSAL_STATES = ["None", "Active", "Closing", "Defeated", "Succeeded", "Executed", "Canceled", "Expired"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** States a proposal never leaves, so the keeper can stop reading it. */
export const TERMINAL_PROPOSAL_STATES: readonly ProposalState[] = ["Defeated", "Executed", "Canceled", "Expired"];

/** `EpochGovernor` state of one `(token, epoch)`. `scheme` is zero until the epoch opens. */
export interface EpochView {
  opened: boolean;
  closed: boolean;
  finalized: boolean;
  voterCount: bigint;
  scheme: Address;
}

/** `IVotingScheme.tallyOf`. */
export interface Tally {
  isFinal: boolean;
  counts: readonly bigint[];
}

/** `TakeoverGovernor` state of one proposal. */
export interface ProposalView {
  token: Address;
  state: ProposalState;
  closed: boolean;
  tallied: boolean;
  scheme: Address;
}

/** Contract reads the keeper bases every decision on. */
export interface ChainReader {
  currentEpoch(): Promise<bigint>;
  /** `EpochGovernor.epochStart`, in seconds. */
  epochStart(epoch: bigint): Promise<bigint>;
  isRegistered(token: Address): Promise<boolean>;
  epoch(token: Address, epoch: bigint): Promise<EpochView>;
  tallyOf(scheme: Address, governor: Address, token: Address, scope: bigint): Promise<Tally>;
  tallyHandles(scheme: Address, governor: Address, token: Address, scope: bigint): Promise<readonly Hex[]>;
  /**
   * Catalogue org ids of an epoch's ballot, in order, from its `BallotPrepared` log. The governor
   * keeps only their commitment, so finalizing an epoch with ballots passes them back as calldata.
   */
  ballotOrgIds(token: Address, epoch: bigint): Promise<Hex[]>;
  proposalCount(): Promise<bigint>;
  proposal(id: bigint): Promise<ProposalView>;
  /**
   * LP fees the token's locked position has earned but nobody has collected yet (both currencies'
   * raw amounts added; a simulated `VaradaLpLocker.collectFees`). Trading fees only reach the
   * FeeVault, and the indexer, when someone collects them. Omitted when the locker is unknown.
   */
  uncollectedFees?(token: Address): Promise<bigint>;
}

/** `RotationGovernor` state of one rotation round (the poll on the cause of rotation `target`). */
export interface RoundView {
  status: RoundStatus;
  /** Stored once the round is prepared (zero before). */
  voteEnd: bigint;
  voters: bigint;
  /** Scheme the round's poll was opened with (zero if never opened). */
  scheme: Address;
}

/** `IOutcomeVotingScheme.outcomeOf`: only the winning option index is ever revealed. */
export interface Outcome {
  isFinal: boolean;
  winner: number;
}

/** `RotationGovernor` state of one period-change proposal (`proposalState`, `getProposal`). */
export interface PeriodProposalView {
  token: Address;
  state: PeriodProposalState;
  /** Scheme the proposal's yes/no poll was opened with. */
  scheme: Address;
  /** Seconds; after it a closed proposal without a final outcome can only expire. */
  executionDeadline: bigint;
}

/** Period-change proposal states a proposal never leaves. */
export const TERMINAL_PERIOD_STATES: readonly PeriodProposalState[] = ["Defeated", "Executed", "Expired", "Canceled"];

/** Contract reads the keeper bases its decisions on for live-mode tokens (`RotationGovernor`). */
export interface RotationReader {
  isRegistered(token: Address): Promise<boolean>;
  currentRotation(token: Address): Promise<bigint>;
  round(token: Address, target: bigint): Promise<RoundView>;
  outcomeOf(scheme: Address, governor: Address, token: Address, scope: bigint): Promise<Outcome>;
  /** `ZamaVotingScheme.outcomeHandle`: the encrypted winner (zero before `requestOutcome`). */
  outcomeHandle(scheme: Address, governor: Address, token: Address, scope: bigint): Promise<Hex>;
  /** Latest block timestamp, in seconds. */
  now(): Promise<bigint>;
  /** `RotationGovernor.proposalCount`: period-change proposals are numbered from 1. */
  proposalCount(): Promise<bigint>;
  periodProposal(id: bigint): Promise<PeriodProposalView>;
}

/** A permissionless transaction the keeper may send. */
export type KeeperAction =
  | { kind: "openEpoch"; token: Address; epoch: bigint }
  | { kind: "closeEpoch"; token: Address; epoch: bigint }
  /** `orgIds`: the ballot's org ids when the epoch has ballots (checked against its commitment), else empty. */
  | { kind: "finalizeEpoch"; token: Address; epoch: bigint; orgIds: Hex[] }
  | { kind: "prepareBallot"; token: Address; epoch: bigint; draws: { orgId: Hex; proof: Hex[] }[] }
  | {
      kind: "prepareCuratedBallot";
      token: Address;
      epoch: bigint;
      curated: { catalogIndex: number; pickOrgId: Hex; pickProof: Hex[]; entryOrgId: Hex; entryProof: Hex[] }[];
      draws: { orgId: Hex; proof: Hex[] }[];
    }
  | { kind: "submitTally"; scheme: Address; governor: Address; token: Address; scope: bigint; cleartexts: Hex; proof: Hex }
  /** `openRound(token)`: the next rotation's round, with no draws. `target` is the one planned for. */
  | { kind: "openRound"; token: Address; target: bigint }
  | { kind: "prepareRound"; token: Address; target: bigint; draws: { orgId: Hex; proof: Hex[] }[] }
  | {
      kind: "prepareCuratedRound";
      token: Address;
      target: bigint;
      curated: { catalogIndex: number; pickOrgId: Hex; pickProof: Hex[]; entryOrgId: Hex; entryProof: Hex[] }[];
      draws: { orgId: Hex; proof: Hex[] }[];
    }
  | { kind: "closeRound"; token: Address; target: bigint }
  | { kind: "finalizeRound"; token: Address; target: bigint }
  /** `IOutcomeVotingScheme.submitOutcome`: the decrypted winner of a poll closed for its outcome. */
  | { kind: "submitOutcome"; scheme: Address; governor: Address; token: Address; scope: bigint; cleartexts: Hex; proof: Hex }
  /** Rotation governor: ends a period-change vote (asks for its outcome, or defeats it below `minVoters`). */
  | { kind: "closePeriodProposal"; id: bigint }
  /** Rotation governor: applies a revealed outcome, or expires a proposal past its execution window. */
  | { kind: "executePeriodProposal"; id: bigint }
  | { kind: "closeProposal"; id: bigint }
  | { kind: "recordTally"; id: bigint }
  | { kind: "execute"; id: bigint }
  /** `FeeVault.settle`: moves a finalized epoch's cause pool to the donation distributor. */
  | { kind: "settle"; token: Address; epoch: bigint }
  /** `DonationDistributor.distribute`: donates a settled epoch to its winning org. */
  | { kind: "distribute"; token: Address; epoch: bigint };

export interface TxResult {
  hash: Hex;
  status: "success" | "reverted";
  gasUsed: bigint;
}

/** Signs and sends keeper transactions from one account, one at a time. */
export interface ChainWriter {
  readonly account: Address;
  /** Gas estimate; throws {@link KeeperRevert} when the call would revert. */
  estimate(action: KeeperAction): Promise<bigint>;
  /** Sends with the given gas limit and waits for the receipt. */
  send(action: KeeperAction, gas: bigint): Promise<TxResult>;
  /**
   * Whether the account has a transaction sent and not yet mined (pending nonce above the latest
   * one). Checked before sending after a send or receipt failure, and once after a start, so a
   * step whose receipt timed out is not sent again while the first is still in the mempool.
   * Omitted: not checked.
   */
  hasPendingTx?(): Promise<boolean>;
}

/** A call that would revert. `errorName` is the decoded custom error (arguments are dropped). */
export class KeeperRevert extends Error {
  constructor(
    readonly errorName: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "KeeperRevert";
  }
}

/** Reads `TokenCreated` logs of the factory, for discovery when the indexer is down. */
export interface FactoryLogReader {
  /** Tokens created in `[fromBlock, latest]` and the last block scanned. */
  tokensCreated(fromBlock: bigint): Promise<{ tokens: Address[]; toBlock: bigint }>;
}

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Strips URLs (RPC endpoints may carry keys) and addresses from an error message, and truncates it. */
export function redact(message: string, max = 300): string {
  return message
    .replace(/https?:\/\/[^\s"'<>]+/g, "<url>")
    .replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, "<address>")
    .slice(0, max);
}
