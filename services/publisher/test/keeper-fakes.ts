import { periodPollScope, rotationPollScope, type PeriodProposalState, type RoundStatus } from "@varada/sdk";
import { getAddress, keccak256, toHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import {
  KeeperRevert,
  sameAddress,
  type ChainReader,
  type ChainWriter,
  type EpochView,
  type KeeperAction,
  type ProposalState,
  type ProposalView,
  type RotationReader,
  type RoundView,
} from "../src/keeper/chain.js";
import { createFakeDecryptor, decodeCleartexts } from "../src/keeper/decrypt.js";

export const EG = "0x00000000000000000000000000000000000000e1" as Address;
export const TG = "0x00000000000000000000000000000000000000e2" as Address;
export const ZAMA = "0x00000000000000000000000000000000000000a1" as Address;
export const OTHER_SCHEME = "0x00000000000000000000000000000000000000b2" as Address;
export const KEEPER = "0x000000000000000000000000000000000000c0de" as Address;
export const PROOF = "0x5eed" as Hex;
export const WEEK = 604_800n;
/** `epochStart(0)` of the fake governor. */
export const EPOCH_ZERO = 2_900n * WEEK;
export const token = (i: number) => getAddress(`0x${(0xaa00 + i).toString(16).padStart(40, "0")}`);

interface Poll {
  /** Tally word handles; empty until the poll's first ballot (lazy tallies). */
  handles: Hex[];
  values: bigint[];
  closed: boolean;
  isFinal: boolean;
  counts: bigint[];
}
interface EpochState {
  opened: boolean;
  closed: boolean;
  finalized: boolean;
  voters: bigint;
  scheme: Address;
}
interface Proposal {
  token: Address;
  ended: boolean;
  expired: boolean;
  closed: boolean;
  tallied: boolean;
  executed: boolean;
  canceled: boolean;
  quorum: bigint;
  forWeight: bigint;
  againstWeight: bigint;
  scheme: Address;
}

const pollKey = (governor: Address, t: Address, scope: bigint) => `${governor}:${t}:${scope}`.toLowerCase();
const revert = (name: string) => new KeeperRevert(name, `would revert ${name}`);

/** In-memory EpochGovernor + TakeoverGovernor + ZamaVotingScheme with the contracts' guards. */
export class FakeChain {
  current = 10n;
  registered = new Set<string>();
  defaultCause = true;
  epochs = new Map<string, EpochState>();
  polls = new Map<string, Poll>();
  proposals: Proposal[] = [];
  sent: KeeperAction[] = [];
  /** `token:epoch` of prepared ballots. */
  prepared = new Set<string>();
  estimates: KeeperAction[] = [];
  reads = 0;
  sendError?: Error;
  /** Org ids of each opened epoch's ballot (`token:epoch`), as its `BallotPrepared` log carries them. */
  ballots = new Map<string, Hex[]>();
  /** `token:epoch` keys whose ballot log lookup fails. */
  missingBallotLogs = new Set<string>();
  /** Uncollected LP fees by lowercase token (`VaradaLpLocker.collectFees` simulated). */
  lpFees = new Map<string, bigint>();
  lpFeesError?: Error;
  /** Live mode: round actions are applied to it, and the decryptor knows its outcome handles. */
  rotation?: FakeRotation;
  private handleSeq = 0;

  register(t: Address) {
    this.registered.add(t.toLowerCase());
    return this;
  }

  private epochState(t: Address, e: bigint): EpochState {
    const k = `${t}:${e}`.toLowerCase();
    let s = this.epochs.get(k);
    if (!s) {
      s = { opened: false, closed: false, finalized: false, voters: 0n, scheme: "0x0000000000000000000000000000000000000000" };
      this.epochs.set(k, s);
    }
    return s;
  }

  /** Closes a poll like `ZamaVotingScheme.requestTally`: without ballots it is final at once. */
  private closePoll(governor: Address, t: Address, scope: bigint) {
    const p = this.polls.get(pollKey(governor, t, scope))!;
    p.closed = true;
    if (p.handles.length === 0) {
      p.isFinal = true;
      p.counts = [0n, 0n];
    }
  }

  private openPoll(governor: Address, t: Address, scope: bigint, values: bigint[]) {
    const handles = values.map(() => keccak256(toHex(`handle-${++this.handleSeq}`)));
    this.polls.set(pollKey(governor, t, scope), { handles, values, closed: false, isFinal: false, counts: [] });
  }

  /** Opens an epoch with ballots whose (hidden) per-option totals are `values`. */
  openEpoch(t: Address, e: bigint, voters: bigint, values: bigint[] = [0n, 0n], scheme: Address = ZAMA) {
    Object.assign(this.epochState(t, e), { opened: true, voters, scheme });
    this.openPoll(EG, t, e, values);
    this.ballots.set(`${t}:${e}`.toLowerCase(), [0, 1].map((i) => keccak256(toHex(`org-${t}-${e}-${i}`))));
  }

  epochOf(t: Address, e: bigint) {
    return this.epochState(t, e);
  }

  pollOf(governor: Address, t: Address, scope: bigint) {
    return this.polls.get(pollKey(governor, t, scope));
  }

  /** `values` are the hidden tally words; `[]` is a proposal nobody voted on. */
  addProposal(p: Partial<Proposal> & { token: Address }, values: bigint[] = [0n, 0n]): bigint {
    this.proposals.push({
      ended: true, expired: false, closed: false, tallied: false, executed: false, canceled: false,
      quorum: 10n, forWeight: 0n, againstWeight: 0n, scheme: ZAMA, ...p,
    });
    const id = BigInt(this.proposals.length);
    this.openPoll(TG, p.token, id, values);
    return id;
  }

  stateOf(id: bigint): ProposalState {
    const p = this.proposals[Number(id) - 1];
    if (!p) return "None";
    if (p.canceled) return "Canceled";
    if (p.executed) return "Executed";
    if (p.tallied) {
      if (!(p.forWeight >= p.quorum && p.forWeight > p.againstWeight)) return "Defeated";
      return p.expired ? "Expired" : "Succeeded";
    }
    if (!p.ended && !p.closed) return "Active";
    if (p.expired) return "Expired";
    return "Closing";
  }

  reader(): ChainReader {
    const r = <T>(v: T) => {
      this.reads++;
      return Promise.resolve(v);
    };
    return {
      currentEpoch: () => r(this.current),
      epochStart: (e) => r(EPOCH_ZERO + e * WEEK),
      isRegistered: (t) => r(this.registered.has(t.toLowerCase())),
      epoch: (t, e) => {
        const s = this.epochState(t, e);
        const v: EpochView = { opened: s.opened, closed: s.closed, finalized: s.finalized, voterCount: s.voters, scheme: s.scheme };
        return r(v);
      },
      tallyOf: (scheme, governor, t, scope) => {
        const p = this.polls.get(pollKey(governor, t, scope));
        return r({ isFinal: p?.isFinal ?? false, counts: p?.counts ?? [] });
      },
      tallyHandles: (scheme, governor, t, scope) => r(this.polls.get(pollKey(governor, t, scope))?.handles ?? []),
      ballotOrgIds: (t, e) => {
        const k = `${t}:${e}`.toLowerCase();
        const orgs = this.ballots.get(k);
        if (!orgs || this.missingBallotLogs.has(k)) return Promise.reject(new Error("BallotPrepared log not found"));
        return r([...orgs]);
      },
      proposalCount: () => r(BigInt(this.proposals.length)),
      proposal: (id) => {
        const p = this.proposals[Number(id) - 1]!;
        const v: ProposalView = { token: p.token, state: this.stateOf(id), closed: p.closed, tallied: p.tallied, scheme: p.scheme };
        return r(v);
      },
      uncollectedFees: (t) => (this.lpFeesError ? Promise.reject(this.lpFeesError) : r(this.lpFees.get(t.toLowerCase()) ?? 0n)),
    };
  }

  /** Validates `a` like the contracts would and applies it unless `dry`. */
  private apply(a: KeeperAction, dry: boolean) {
    if (FakeRotation.handles(a)) {
      if (!this.rotation) throw new Error(`no rotation governor for ${a.kind}`);
      return this.rotation.apply(a, dry);
    }
    switch (a.kind) {
      case "closeEpoch": {
        if (a.epoch >= this.current) throw revert("EpochNotEnded");
        const s = this.epochState(a.token, a.epoch);
        if (!s.opened) throw revert("EpochNotOpened");
        if (s.closed) throw revert("EpochAlreadyClosed");
        if (!dry) {
          s.closed = true;
          this.closePoll(EG, a.token, a.epoch);
        }
        return;
      }
      case "finalizeEpoch": {
        if (a.epoch >= this.current) throw revert("EpochNotEnded");
        const s = this.epochState(a.token, a.epoch);
        if (s.finalized) throw revert("EpochAlreadyFinalized");
        let best = 0n;
        if (s.opened && s.voters > 0n) {
          const p = this.polls.get(pollKey(EG, a.token, a.epoch))!;
          if (!p.isFinal) throw revert("TallyNotFinal");
          // The governor checks the calldata options against the ballot commitment.
          const orgs = this.ballots.get(`${a.token}:${a.epoch}`.toLowerCase()) ?? [];
          if (a.orgIds.length !== orgs.length || a.orgIds.some((o, i) => o !== orgs[i])) throw revert("OptionsMismatch");
          for (const c of p.counts) if (c > best) best = c;
        }
        if (best === 0n && !this.defaultCause) throw revert("NoVotes");
        if (!dry) s.finalized = true;
        return;
      }
      case "submitTally": {
        const p = this.polls.get(pollKey(a.governor, a.token, a.scope));
        if (!p?.closed) throw revert("PollNotClosed");
        if (p.isFinal) throw revert("TallyAlreadyFinal");
        if ((a.cleartexts.length - 2) / 2 !== 32 * p.handles.length) throw revert("InvalidTallyProof");
        const words = decodeCleartexts(a.cleartexts);
        // Stands in for FHE.checkSignatures: the proof must match and the words must be the true totals in handle order.
        if (a.proof !== PROOF || words.some((w, i) => w !== p.values[i])) throw revert("InvalidKMSSignatures");
        if (!dry) {
          p.isFinal = true;
          p.counts = words;
        }
        return;
      }
      case "closeProposal": {
        const s = this.stateOf(a.id);
        const p = this.proposals[Number(a.id) - 1]!;
        if (s === "Active") throw revert("VotingNotEnded");
        if (p.closed) throw revert("AlreadyClosed");
        if (s !== "Closing") throw revert("NotClosable");
        if (!dry) {
          p.closed = true;
          this.closePoll(TG, p.token, a.id);
        }
        return;
      }
      case "recordTally": {
        const p = this.proposals[Number(a.id) - 1]!;
        if (!p.closed) throw revert("NotClosed");
        if (p.tallied) throw revert("AlreadyTallied");
        const poll = this.polls.get(pollKey(TG, p.token, a.id))!;
        if (!poll.isFinal) throw revert("TallyNotFinal");
        if (!dry) {
          p.againstWeight = poll.counts[0]!;
          p.forWeight = poll.counts[1]!;
          p.tallied = true;
        }
        return;
      }
      case "openEpoch":
      case "prepareBallot":
      case "prepareCuratedBallot": {
        // Both prepare the ballot and open the epoch; the contract rejects ballots before that.
        if (a.epoch !== this.current) throw revert("EpochNotCurrent");
        const k = `${a.token}:${a.epoch}`.toLowerCase();
        if (this.prepared.has(k)) throw revert("BallotAlreadyPrepared");
        if (!dry) {
          this.prepared.add(k);
          Object.assign(this.epochState(a.token, a.epoch), { opened: true, scheme: ZAMA });
        }
        return;
      }
      case "execute": {
        if (this.stateOf(a.id) !== "Succeeded") throw revert("NotExecutable");
        if (!dry) this.proposals[Number(a.id) - 1]!.executed = true;
        return;
      }
    }
  }

  writer(): ChainWriter {
    return {
      account: KEEPER,
      estimate: async (a) => {
        this.estimates.push(a);
        this.apply(a, true);
        return 100_000n;
      },
      send: async (a, gas) => {
        if (gas < 100_000n) throw new Error("gas limit below estimate");
        if (this.sendError) throw this.sendError;
        this.apply(a, false);
        this.sent.push(a);
        return { hash: keccak256(toHex(`tx-${this.sent.length}`)), status: "success" as const, gasUsed: 90_000n };
      },
    };
  }

  /** Decryptor that knows the true totals behind every handle. */
  decryptor(opts: Parameters<typeof createFakeDecryptor>[1] = {}) {
    return createFakeDecryptor(
      (h) => {
        for (const p of this.polls.values()) {
          const i = p.handles.findIndex((x) => x.toLowerCase() === h.toLowerCase());
          if (i >= 0) return p.values[i]!;
        }
        const winner = this.rotation?.winnerOf(h);
        if (winner !== undefined) return winner;
        throw new Error("unknown handle");
      },
      { proof: PROOF, ...opts },
    );
  }
}

export const RG = "0x00000000000000000000000000000000000000e3" as Address;

interface FakeRound {
  status: RoundStatus;
  voteEnd: bigint;
  voters: bigint;
  scheme: Address;
}
interface OutcomePoll {
  handle: Hex;
  /** The (hidden) winning option index. */
  winner: bigint;
  isFinal: boolean;
}
interface FakePeriodProposal {
  token: Address;
  /** Stored state; `Active` reads as `Ended` from `end`. */
  state: PeriodProposalState;
  end: bigint;
  executionDeadline: bigint;
  voters: bigint;
  scheme: Address;
}
type RoundKind =
  | "openRound"
  | "prepareRound"
  | "prepareCuratedRound"
  | "closeRound"
  | "finalizeRound"
  | "submitOutcome"
  | "closePeriodProposal"
  | "executePeriodProposal";
const ROUND_KINDS: readonly string[] = [
  "openRound",
  "prepareRound",
  "prepareCuratedRound",
  "closeRound",
  "finalizeRound",
  "submitOutcome",
  "closePeriodProposal",
  "executePeriodProposal",
];

/**
 * In-memory `RotationGovernor` with an hourly schedule from `anchor` (vote window
 * `[start(target - 1), start(target) - 15 min)`, curation grace 15 minutes), plus the outcome side
 * of `ZamaVotingScheme`, with the contracts' guards.
 */
export class FakeRotation {
  static readonly PERIOD = 3_600n;
  static readonly BUFFER = 900n;
  anchor = 1_000_000n;
  /** Chain time: rotation 4, one minute in. */
  now = this.anchor + 4n * FakeRotation.PERIOD + 60n;
  registered = new Set<string>();
  rounds = new Map<string, FakeRound>();
  /** Outcome polls by `token:scope`, rotation rounds and period proposals alike. */
  outcomes = new Map<string, OutcomePoll>();
  periodProposals = new Map<bigint, FakePeriodProposal>();
  minVoters = 1n;
  /** Models usable curations: for its whole vote window a round needs `prepareCuratedRound`. */
  curatedRequired = false;
  reads = 0;
  private seq = 0;

  static handles(a: KeeperAction): a is Extract<KeeperAction, { kind: RoundKind }> {
    return ROUND_KINDS.includes(a.kind);
  }

  register(t: Address) {
    this.registered.add(t.toLowerCase());
    return this;
  }

  current(): bigint {
    return (this.now - this.anchor) / FakeRotation.PERIOD;
  }

  window(target: bigint) {
    const voteStart = this.anchor + (target - 1n) * FakeRotation.PERIOD;
    const voteEnd = this.anchor + target * FakeRotation.PERIOD - FakeRotation.BUFFER;
    return { snapshot: voteStart - 1n, voteStart, voteEnd };
  }

  roundOf(t: Address, target: bigint): FakeRound {
    const k = `${t}:${target}`.toLowerCase();
    let r = this.rounds.get(k);
    if (!r) {
      r = { status: "None", voteEnd: 0n, voters: 0n, scheme: zeroAddress };
      this.rounds.set(k, r);
    }
    return r;
  }

  /** A round opened earlier with `voters` ballots whose hidden winner is option `winner`. */
  openRound(t: Address, target: bigint, voters: bigint, winner = 0n, scheme: Address = ZAMA) {
    Object.assign(this.roundOf(t, target), { status: "Open", voteEnd: this.window(target).voteEnd, voters, scheme });
    this.outcomes.set(this.okey(t, rotationPollScope(target)), { handle: zeroHash, winner, isFinal: false });
  }

  /** A period-change proposal voting until `end` (seconds) with `voters` ballots; `winner` 1 is FOR. */
  proposePeriod(t: Address, end: bigint, voters: bigint, winner = 1n, opts: { executionWindow?: bigint; scheme?: Address } = {}) {
    const id = BigInt(this.periodProposals.size + 1);
    this.periodProposals.set(id, {
      token: t,
      state: "Active",
      end,
      executionDeadline: end + (opts.executionWindow ?? 3n * 86_400n),
      voters,
      scheme: opts.scheme ?? ZAMA,
    });
    this.outcomes.set(this.okey(t, periodPollScope(id)), { handle: zeroHash, winner, isFinal: false });
    return id;
  }

  periodState(id: bigint): PeriodProposalState {
    const p = this.periodProposals.get(id);
    if (!p) return "None";
    return p.state === "Active" && this.now >= p.end ? "Ended" : p.state;
  }

  private okey(t: Address, scope: bigint) {
    return `${t}:${scope}`.toLowerCase();
  }

  outcomeOfRound(t: Address, target: bigint) {
    return this.outcomes.get(this.okey(t, rotationPollScope(target)));
  }

  outcomeOfPeriod(id: bigint) {
    const p = this.periodProposals.get(id);
    return p && this.outcomes.get(this.okey(p.token, periodPollScope(id)));
  }

  winnerOf(h: Hex): bigint | undefined {
    for (const o of this.outcomes.values()) if (o.handle !== zeroHash && o.handle.toLowerCase() === h.toLowerCase()) return o.winner;
    return undefined;
  }


  reader(): RotationReader {
    const r = <T>(v: T) => {
      this.reads++;
      return Promise.resolve(v);
    };
    return {
      isRegistered: (t) => r(this.registered.has(t.toLowerCase())),
      currentRotation: (t) => r(this.registered.has(t.toLowerCase()) ? this.current() : 0n),
      round: (t, target) => {
        const v = this.roundOf(t, target);
        const view: RoundView = { status: v.status, voteEnd: v.voteEnd, voters: v.voters, scheme: v.scheme };
        return r(view);
      },
      outcomeOf: (scheme, governor, t, scope) => {
        const o = this.outcomes.get(this.okey(t, scope));
        return r({ isFinal: o?.isFinal ?? false, winner: o?.isFinal ? Number(o.winner) : 255 });
      },
      outcomeHandle: (scheme, governor, t, scope) => r(this.outcomes.get(this.okey(t, scope))?.handle ?? zeroHash),
      now: () => r(this.now),
      proposalCount: () => r(BigInt(this.periodProposals.size)),
      periodProposal: (id) => {
        const p = this.periodProposals.get(id);
        return r({ token: p?.token ?? zeroAddress, state: this.periodState(id), scheme: p?.scheme ?? zeroAddress, executionDeadline: p?.executionDeadline ?? 0n });
      },
    };
  }

  apply(a: Extract<KeeperAction, { kind: RoundKind }>, dry: boolean) {
    switch (a.kind) {
      case "openRound":
      case "prepareRound":
      case "prepareCuratedRound": {
        if (!this.registered.has(a.token.toLowerCase())) throw revert("TokenNotRegistered");
        const target = a.kind === "openRound" ? this.current() + 1n : a.target;
        if (target !== this.current() + 1n) throw revert("RoundNotCurrent");
        const r = this.roundOf(a.token, target);
        if (r.status !== "None") throw revert("RoundAlreadyOpened");
        const w = this.window(target);
        if (this.now >= w.voteEnd) throw revert("VotingClosed");
        if (this.curatedRequired && a.kind !== "prepareCuratedRound") throw revert("IncompleteCuratedBallot");
        if (!dry) Object.assign(r, { status: "Open", voteEnd: w.voteEnd, scheme: ZAMA });
        return;
      }
      case "closeRound": {
        const r = this.roundOf(a.token, a.target);
        if (r.status === "None") throw revert("RoundNotOpened");
        if (r.status !== "Open") throw revert("RoundAlreadyClosed");
        if (this.now < r.voteEnd) throw revert("VotingNotEnded");
        if (dry) return;
        if (r.voters < this.minVoters) {
          r.status = "NoChange";
          return;
        }
        r.status = "Closed";
        const o = this.outcomeOfRound(a.token, a.target)!;
        o.handle = keccak256(toHex(`outcome-${++this.seq}`));
        return;
      }
      case "submitOutcome": {
        if (!sameAddress(a.governor, RG)) throw revert("PollNotClosed");
        const o = this.outcomes.get(this.okey(a.token, a.scope));
        if (!o || o.handle === zeroHash) throw revert("PollNotClosed");
        if (o.isFinal) throw revert("TallyAlreadyFinal");
        if ((a.cleartexts.length - 2) / 2 !== 32) throw revert("InvalidTallyProof");
        const [word] = decodeCleartexts(a.cleartexts);
        if (a.proof !== PROOF || word !== o.winner) throw revert("InvalidKMSSignatures");
        if (!dry) o.isFinal = true;
        return;
      }
      case "finalizeRound": {
        const r = this.roundOf(a.token, a.target);
        if (r.status !== "Closed") throw revert("RoundNotClosed");
        if (!this.outcomeOfRound(a.token, a.target)?.isFinal) throw revert("TallyNotFinal");
        if (!dry) r.status = "Applied";
        return;
      }
      case "closePeriodProposal": {
        const p = this.periodProposals.get(a.id);
        if (!p) throw revert("UnknownProposal");
        if (this.periodState(a.id) !== "Ended") throw revert("NotClosable");
        if (dry) return;
        if (p.voters === 0n || p.voters < this.minVoters) {
          p.state = "Defeated";
          return;
        }
        p.state = "Closed";
        this.outcomeOfPeriod(a.id)!.handle = keccak256(toHex(`period-outcome-${++this.seq}`));
        return;
      }
      case "executePeriodProposal": {
        const p = this.periodProposals.get(a.id);
        if (!p) throw revert("UnknownProposal");
        if (this.periodState(a.id) !== "Closed") throw revert("NotExecutable");
        const o = this.outcomeOfPeriod(a.id)!;
        const late = this.now > p.executionDeadline;
        if (!o.isFinal && !late) throw revert("TallyNotFinal");
        if (dry) return;
        p.state = !o.isFinal || late ? "Expired" : o.winner === 1n ? "Executed" : "Defeated";
        return;
      }
    }
  }
}

export const collectLogs = () => {
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const log = (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => {
    logs.push({ level, msg, data });
  };
  return { logs, log };
};
