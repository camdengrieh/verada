import { periodPollScope, rotationPollScope } from "@varada/sdk";
import type { Address } from "viem";
import type { Log } from "../jobs/types.js";
import { Backoff } from "./backoff.js";
import { KeeperRevert, redact, type ChainReader, type ChainWriter, type KeeperAction, type RotationReader } from "./chain.js";
import { CuratedPicksUnavailable, type BallotPreparer, type RoundPreparer } from "./ballot.js";
import { checkDecryption, type PublicDecryptor } from "./decrypt.js";
import type { DonationPlanner } from "./donate.js";
import {
  epochNeedsTally,
  finalizeNeedsOptions,
  periodProposalNeedsOutcome,
  planEpoch,
  planPeriodProposal,
  planProposal,
  planRound,
  proposalNeedsTally,
  roundNeedsOutcome,
  type Step,
} from "./plan.js";

/**
 * Longest wait between attempts at a ballot or round blocked by missing curator picks: they can be
 * served, or the curation voided, at any time, and an hourly round votes for 45 minutes.
 */
export const PICKS_RETRY_MAX_MS = 15 * 60_000;
/** Missing curator picks that persist this long are logged at error again (re-paged). */
export const PICKS_REPAGE_MS = 2 * 3_600_000;

/** Live-mode rotation rounds (`RotationGovernor`). */
export interface RotationDeps {
  governor: Address;
  reader: RotationReader;
  /** Prepares the next rotation's round; omitted when no catalogue source (indexer). */
  rounds?: RoundPreparer;
  /**
   * Rounds before the next rotation's that are re-read each run for close, outcome and finalize.
   * Default 24. A round seen open or closed is also followed past the lookback until it is final
   * (while the process runs; a restart only finds the rounds inside the lookback).
   */
  lookbackRounds?: number;
}

export interface KeeperDeps {
  reader: ChainReader;
  writer: ChainWriter;
  decryptor: PublicDecryptor;
  /** Prepares current-epoch ballots that need rotation draws; omitted when no catalogue source. */
  ballots?: BallotPreparer;
  /** Tokens to keep (indexer listing with a factory-log fallback). */
  tokens: () => Promise<Address[]>;
  epochGovernor: Address;
  takeoverGovernor: Address;
  /**
   * Live tokens' rotation rounds: prepares each token's next round, closes ended ones, relays the
   * public decryption of their winner and finalizes them; and the governor's period-change
   * proposals (close, decrypt the outcome, execute). Omitted when no rotation governor is
   * configured.
   */
  rotation?: RotationDeps;
  /** The Zama voting scheme; polls on any other scheme are never decrypted. */
  zamaScheme: Address;
  dryRun: boolean;
  maxTxPerRun: number;
  lookbackEpochs: number;
  log: Log;
  backoff?: Backoff;
  /** Steps taken for one epoch or proposal per run (close, decrypt+submit, finalize). */
  maxStepsPerItem?: number;
  /** Gas limit = estimate * gasBufferPct / 100. */
  gasBufferPct?: bigint;
  /**
   * Indexer facts on which tokens are active. With it, the keeper opens the current epoch only for
   * active tokens (see {@link idleEpochs}); without it, when it fails or lags the chain, or when
   * the reader cannot see uncollected LP fees, every epoch is opened.
   */
  activity?: ActivitySource;
  /**
   * A token is idle, and its current epoch is left closed for anyone to open on demand, when the
   * indexer shows no fees credited to its pools, no ballots and no curation-skip request in the
   * last `idleEpochs` epochs (and the current one), no pin change and no launch since the start
   * of epoch `current - idleEpochs`, and its LP position holds no uncollected fees. 0 opens every
   * epoch. Default 2.
   */
  idleEpochs?: number;
  /** The indexer counts as down when its last indexed block is older than this. Default 600. */
  maxIndexerLagSeconds?: number;
  /** Wall clock in ms (tests). */
  now?: () => number;
  /**
   * Settles and distributes finalized epochs (`FeeVault.settle`, `DonationDistributor.distribute`),
   * which are then followed until donated or empty. Omitted: a finalized epoch is done.
   */
  donation?: DonationPlanner;
}

/** Tokens with recent activity (indexer `/api/active-tokens`). */
export interface ActivitySource {
  activeTokens(sinceEpoch: bigint, sinceTime: bigint): Promise<{ token: string }[]>;
  /**
   * Timestamp (seconds) of the last block the indexer has indexed, or null when it reports none
   * (Ponder `/status`). Omitted: freshness is not checked.
   */
  indexedAt?(): Promise<bigint | null>;
}

export interface KeeperRunSummary {
  tokens: number;
  epochsChecked: number;
  ballotsChecked: number;
  /** Current-epoch openings skipped because the token is idle. */
  idleSkipped: number;
  proposalsChecked: number;
  /** Rotation governor period-change proposals read this run. */
  periodProposalsChecked: number;
  /** Live tokens registered with the rotation governor. */
  liveTokens: number;
  roundsChecked: number;
  /** Transactions mined (or, in dry run, planned). */
  txs: number;
  decrypted: number;
  failed: number;
  backedOff: number;
  capped: boolean;
  halted: boolean;
  dryRun: boolean;
}

type ItemRef =
  | { token: Address; epoch: bigint }
  | { token: Address; round: bigint }
  | { proposal: bigint; token?: Address }
  | { periodProposal: bigint; token?: Address };

const describe = (a: KeeperAction): Record<string, unknown> => {
  switch (a.kind) {
    case "openEpoch":
    case "closeEpoch":
    case "settle":
    case "distribute":
      return { tx: a.kind, token: a.token, epoch: a.epoch };
    case "finalizeEpoch":
      return { tx: a.kind, token: a.token, epoch: a.epoch, options: a.orgIds.length };
    case "submitTally":
    case "submitOutcome":
      return { tx: a.kind, token: a.token, scope: a.scope, governor: a.governor };
    case "prepareBallot":
      return { tx: a.kind, token: a.token, epoch: a.epoch, draws: a.draws.length };
    case "prepareCuratedBallot":
      return { tx: a.kind, token: a.token, epoch: a.epoch, curated: a.curated.length, draws: a.draws.length };
    case "openRound":
    case "closeRound":
    case "finalizeRound":
      return { tx: a.kind, token: a.token, round: a.target };
    case "prepareRound":
      return { tx: a.kind, token: a.token, round: a.target, draws: a.draws.length };
    case "prepareCuratedRound":
      return { tx: a.kind, token: a.token, round: a.target, curated: a.curated.length, draws: a.draws.length };
    case "closePeriodProposal":
    case "executePeriodProposal":
      return { tx: a.kind, periodProposal: a.id };
    default:
      return { tx: a.kind, proposal: a.id };
  }
};

/**
 * The tally keeper. Every decision is read from chain state at run time, so runs are idempotent and
 * a restart loses nothing but backoff timers. Transactions go out one at a time from one account,
 * each after a gas estimate and followed by its receipt, so the nonce sequence never forks.
 */
export function createKeeper(deps: KeeperDeps) {
  const backoff = deps.backoff ?? new Backoff();
  const maxSteps = deps.maxStepsPerItem ?? 4;
  const buffer = deps.gasBufferPct ?? 120n;
  /** Epochs already finalized and proposals in a terminal state: never read again. */
  const doneEpochs = new Map<string, bigint>();
  const doneProposals = new Set<bigint>();
  /** Current-epoch ballots that are prepared or need no keeper help. */
  const doneBallots = new Set<string>();
  /** Current-epoch ballots already logged as skipped (one line per token and epoch, not per run). */
  const idleLogged = new Set<string>();
  const idleEpochs = deps.idleEpochs ?? 2;
  const maxLag = BigInt(deps.maxIndexerLagSeconds ?? 600);
  const now = deps.now ?? Date.now;
  let noFeeReaderLogged = false;
  /** Lowercase live tokens (registration is permanent). */
  const liveTokens = new Set<string>();
  /**
   * Lowercase weekly tokens: registered with the epoch governor, so never live (the factory
   * registers a token with exactly one governor, in its creation transaction). Not read again.
   * A token registered with neither (e.g. an RPC behind the indexer) is re-checked each run.
   */
  const weeklyTokens = new Set<string>();
  /** Per lowercase live token: rounds in a final state, never read again (pruned past the lookback). */
  const doneRounds = new Map<string, Set<bigint>>();
  /**
   * Per lowercase live token: rounds below the lookback that were open or closed when last read.
   * They are followed until final: a late `finalizeRound` still applies the winner unless a later
   * round was applied first. Bounded per token; the oldest is dropped, with an error.
   */
  const carriedRounds = new Map<string, Map<bigint, { warned: boolean }>>();
  const MAX_CARRIED = 64;
  /** Period-change proposals in a terminal state: never read again. */
  const donePeriods = new Set<bigint>();
  /**
   * `CuratedPicksUnavailable` messages logged at error: when last paged and how many failures
   * since. Repeats log at warn until `PICKS_REPAGE_MS` has passed, then at error again.
   */
  const picksReported = new Map<string, { pagedAt: number; failures: number }>();
  const lookbackRounds = BigInt(deps.rotation?.lookbackRounds ?? 24);
  /**
   * A transaction of ours may still be in the mempool: set at start (a restart may follow a send
   * whose receipt never came) and after a send or receipt failure, cleared once
   * `writer.hasPendingTx` says the nonce is clear. Reads always see `latest`, so a step still in
   * flight would otherwise plan, estimate and go out again at the next nonce, then revert.
   */
  let mayHavePendingTx = true;

  /** Lowercase addresses of active tokens, or null when every epoch should be opened. */
  async function activeSet(current: bigint): Promise<Set<string> | null> {
    if (!deps.activity || idleEpochs <= 0) return null;
    if (!deps.reader.uncollectedFees) {
      // LP trading fees reach the indexer only once collected: without the on-chain check a
      // trading token would look idle.
      if (!noFeeReaderLogged) deps.log("warn", "keeper cannot read uncollected LP fees (no FACTORY_ADDRESS); opening every current epoch");
      noFeeReaderLogged = true;
      return null;
    }
    const since = current > BigInt(idleEpochs) ? current - BigInt(idleEpochs) : 0n;
    try {
      const sinceTime = await deps.reader.epochStart(since);
      const [items, indexedAt] = await Promise.all([deps.activity.activeTokens(since, sinceTime), deps.activity.indexedAt?.()]);
      if (indexedAt !== undefined) {
        // A lagging or re-syncing indexer answers 200 with a partial set: treat it as missing.
        const lag = BigInt(Math.floor(now() / 1000)) - (indexedAt ?? 0n);
        if (indexedAt === null || lag > maxLag) {
          deps.log("warn", "keeper found the indexer behind the chain; opening every current epoch", {
            indexedAt: indexedAt ?? null,
            lagSeconds: indexedAt === null ? null : lag,
            maxLagSeconds: maxLag,
          });
          return null;
        }
      }
      return new Set(items.map((i) => i.token.toLowerCase()));
    } catch (err) {
      deps.log("warn", "keeper could not read token activity; opening every current epoch", {
        error: redact(err instanceof Error ? err.message : String(err)),
      });
      return null;
    }
  }

  /** Whether the token's LP position has earned fees nobody collected; true when unknown. */
  async function hasLpFees(token: Address): Promise<boolean> {
    try {
      return (await deps.reader.uncollectedFees!(token)) > 0n;
    } catch (err) {
      deps.log("warn", "keeper could not read uncollected LP fees; opening the epoch", {
        token,
        error: redact(err instanceof Error ? err.message : String(err)),
      });
      return true;
    }
  }

  async function run(): Promise<KeeperRunSummary> {
    const s: KeeperRunSummary = {
      tokens: 0,
      epochsChecked: 0,
      ballotsChecked: 0,
      idleSkipped: 0,
      proposalsChecked: 0,
      periodProposalsChecked: 0,
      liveTokens: 0,
      roundsChecked: 0,
      txs: 0,
      decrypted: 0,
      failed: 0,
      backedOff: 0,
      capped: false,
      halted: false,
      dryRun: deps.dryRun,
    };
    const stop = () => s.halted || s.capped;

    /**
     * Records a failed step and backs the item off. Logged at `error` (alarmed on by infra), except
     * `NoVotes`: an empty epoch with no default cause is an expected, owner-fixable state, so it stays
     * at `warn` and just waits out its backoff. A ballot or round waiting for missing curator picks
     * (`CuratedPicksUnavailable`) is retried at least every `PICKS_RETRY_MAX_MS`, since the picks
     * may be served (or the curation voided by the registry owner) at any time; there is no
     * rotation-only fallback. It logs at `error` the first time each message is seen (it names the
     * agent, region and epoch), then at `warn`, since every ballot and round of every token in that
     * focus hits the same missing picks; while they stay missing it logs at `error` again every
     * `PICKS_REPAGE_MS`, so a dismissed first page is not the last.
     */
    const fail = (key: string, ref: ItemRef, op: string, err: unknown) => {
      s.failed++;
      const hint = (err as { retryAt?: unknown } | null)?.retryAt;
      const retryAt = typeof hint === "number" ? hint : undefined;
      const missingPicks = err instanceof CuratedPicksUnavailable;
      const delay = backoff.fail(key, retryAt, missingPicks ? PICKS_RETRY_MAX_MS : undefined);
      const data: Record<string, unknown> = { ...ref, op, retryInSeconds: Math.round(delay / 1000), failures: backoff.failures(key) };
      if (err instanceof KeeperRevert) data.revert = err.errorName ?? "unknown";
      else data.error = redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      let expected = err instanceof KeeperRevert && err.errorName === "NoVotes";
      if (missingPicks) {
        const seen = picksReported.get(err.message);
        const at = now();
        if (seen && at - seen.pagedAt < PICKS_REPAGE_MS) {
          seen.failures++;
          expected = true;
        } else {
          if (!seen && picksReported.size >= 1_000) picksReported.clear();
          if (seen) data.failuresSincePage = seen.failures + 1;
          picksReported.set(err.message, { pagedAt: at, failures: 0 });
        }
        data.awaitingCuratedPicks = true;
      }
      deps.log(expected ? "warn" : "error", "keeper step failed", data);
    };

    /**
     * Builds `submitTally` from the scheme's tally handles and a public decryption, or for an
     * outcome poll `submitOutcome` from its single winner handle (no count is ever decrypted).
     */
    const decryptAction = async (step: Extract<Step, { type: "decrypt" }>, ref: ItemRef): Promise<KeeperAction> => {
      const { scheme, governor, token, scope } = step;
      if (step.outcome) {
        if (!deps.rotation) throw new Error("outcome poll without a rotation reader");
        const handle = await deps.rotation.reader.outcomeHandle(scheme, governor, token, scope);
        if (/^0x0*$/.test(handle)) throw new Error("poll has no outcome handle");
        const r = await deps.decryptor.publicDecrypt([handle]);
        const { cleartexts } = checkDecryption([handle], r);
        s.decrypted++;
        deps.log("info", "outcome decrypted", { ...ref });
        return { kind: "submitOutcome", scheme, governor, token, scope, cleartexts, proof: r.decryptionProof };
      }
      const handles = await deps.reader.tallyHandles(scheme, governor, token, scope);
      if (handles.length === 0) throw new Error("poll has no tally handles");
      const r = await deps.decryptor.publicDecrypt(handles);
      const { cleartexts } = checkDecryption(handles, r);
      s.decrypted++;
      deps.log("info", "tally decrypted", { ...ref, options: handles.length });
      return { kind: "submitTally", scheme, governor, token, scope, cleartexts, proof: r.decryptionProof };
    };

    /** Drives one item through up to `maxSteps` steps, re-reading chain state before each. */
    const drive = async (key: string, ref: ItemRef, next: () => Promise<Step>): Promise<"done" | "open"> => {
      if (backoff.blocked(key)) {
        s.backedOff++;
        return "open";
      }
      for (let i = 0; i < maxSteps && !stop(); i++) {
        let step: Step;
        try {
          step = await next();
        } catch (err) {
          fail(key, ref, "read", err);
          return "open";
        }
        if (step.type === "none") return step.terminal ? "done" : "open";
        if (s.txs >= deps.maxTxPerRun) {
          s.capped = true;
          return "open";
        }

        if (step.type === "decrypt" && deps.dryRun) {
          s.txs++;
          deps.log("info", "keeper dry run", { ...ref, tx: step.outcome ? "submitOutcome" : "submitTally", note: "decryption skipped in dry run" });
          return "open";
        }
        let action: KeeperAction;
        try {
          action = step.type === "decrypt" ? await decryptAction(step, ref) : step.action;
        } catch (err) {
          fail(key, ref, "decrypt", err);
          return "open";
        }

        let gas: bigint;
        try {
          gas = await deps.writer.estimate(action);
        } catch (err) {
          fail(key, ref, action.kind, err);
          return "open";
        }
        if (deps.dryRun) {
          s.txs++;
          deps.log("info", "keeper dry run", { ...describe(action), gasEstimate: gas });
          return "open";
        }

        if (mayHavePendingTx && deps.writer.hasPendingTx) {
          let pending: boolean;
          try {
            pending = await deps.writer.hasPendingTx();
          } catch (err) {
            fail(key, ref, "pendingTx", err);
            s.halted = true;
            return "open";
          }
          if (pending) {
            deps.log("warn", "keeper has a transaction pending; not sending until it is mined or dropped", { ...describe(action), account: deps.writer.account });
            s.halted = true;
            return "open";
          }
          mayHavePendingTx = false;
        }

        const limit = (gas * buffer) / 100n;
        try {
          s.txs++;
          const r = await deps.writer.send(action, limit);
          if (r.status !== "success") {
            fail(key, ref, action.kind, new Error(`transaction ${r.hash} reverted`));
            return "open";
          }
          deps.log("info", "keeper tx mined", { ...describe(action), hash: r.hash, gasUsed: r.gasUsed });
          backoff.clear(key);
        } catch (err) {
          // A send or receipt failure may leave a pending nonce: stop the run rather than stack more,
          // and check the nonce before the next send.
          fail(key, ref, action.kind, err);
          mayHavePendingTx = true;
          s.halted = true;
          return "open";
        }
      }
      return "open";
    };

    /**
     * Live tokens: per token, the rounds from `next - lookbackRounds` to the next rotation's round
     * (`next = currentRotation + 1`), oldest first, after any older round still unfinished when it
     * left that range. The next round is prepared once nobody has; every ended round with ballots
     * is closed, its winner decrypted and submitted, and finalized. Then the governor's
     * period-change proposals: closed, their outcome decrypted and submitted, and executed.
     */
    const runRotation = async (rot: RotationDeps, tokens: Address[]) => {
      let chainNow: bigint;
      try {
        chainNow = await rot.reader.now();
      } catch (err) {
        deps.log("error", "keeper could not read the chain time; rotation rounds skipped", {
          error: redact(err instanceof Error ? err.message : String(err)),
        });
        return;
      }
      const ctx = { rotationGovernor: rot.governor, zamaScheme: deps.zamaScheme };
      const errText = (err: unknown) => redact(err instanceof Error ? err.message : String(err));

      // Which tokens are live: read once per token (concurrently, so JSON-RPC batching applies).
      const unknown = tokens.filter((t) => !liveTokens.has(t.toLowerCase()) && !weeklyTokens.has(t.toLowerCase()));
      for (let i = 0; i < unknown.length && !stop(); i += 50) {
        await Promise.all(
          unknown.slice(i, i + 50).map(async (token) => {
            const t = token.toLowerCase();
            try {
              if (await rot.reader.isRegistered(token)) liveTokens.add(t);
              else if (await deps.reader.isRegistered(token)) weeklyTokens.add(t);
            } catch (err) {
              deps.log("warn", "keeper could not read the token's registration", { token, error: errText(err) });
            }
          }),
        );
      }

      for (const token of tokens) {
        if (stop()) break;
        const t = token.toLowerCase();
        if (!liveTokens.has(t)) continue;
        let current: bigint;
        try {
          current = await rot.reader.currentRotation(token);
        } catch (err) {
          deps.log("warn", "keeper could not read the token's rotation", { token, error: errText(err) });
          continue;
        }
        s.liveTokens++;
        const next = current + 1n;
        const from = next > lookbackRounds ? next - lookbackRounds : 1n;
        let done = doneRounds.get(t);
        if (!done) doneRounds.set(t, (done = new Set()));
        for (const target of done) if (target < from) done.delete(target);
        let carried = carriedRounds.get(t);
        if (!carried) carriedRounds.set(t, (carried = new Map()));
        const targets = [...carried.keys()].filter((x) => x < from).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        for (let target = from; target <= next; target++) targets.push(target);

        for (const target of targets) {
          if (stop()) break;
          if (done.has(target)) continue;
          s.roundsChecked++;
          const r = await drive(`round:${t}:${target}`, { token, round: target }, async () => {
            const v = await rot.reader.round(token, target);
            if (v.status === "None" && target === next) {
              // Nobody can vote until the round is prepared.
              if (!rot.rounds) return { type: "none", reason: "no round preparer", terminal: false };
              return rot.rounds.plan(token, target);
            }
            const outcome = roundNeedsOutcome(v) ? await rot.reader.outcomeOf(v.scheme, rot.governor, token, rotationPollScope(target)) : undefined;
            return planRound(token, target, v, outcome, chainNow, ctx);
          });
          if (r === "done") {
            done.add(target);
            carried.delete(target);
            continue;
          }
          if (target === next) continue;
          // Unfinished: keep following it once it leaves the lookback.
          const c = carried.get(target) ?? { warned: false };
          carried.set(target, c);
          if (target < from && !c.warned) {
            c.warned = true;
            deps.log("warn", "keeper is following an unfinished round past its lookback", { token, round: target, lookbackRounds });
          }
        }
        while (carried.size > MAX_CARRIED) {
          const oldest = [...carried.keys()].reduce((a, b) => (a < b ? a : b));
          carried.delete(oldest);
          deps.log("error", "keeper stopped following an unfinished round", { token, round: oldest, maxCarried: MAX_CARRIED });
        }
      }

      // Period-change proposals: close, decrypt the yes/no outcome, execute (or expire).
      let count = 0n;
      try {
        count = await rot.reader.proposalCount();
      } catch (err) {
        deps.log("error", "keeper could not read the rotation governor's proposal count", { error: errText(err) });
      }
      for (let id = 1n; id <= count && !stop(); id++) {
        if (donePeriods.has(id)) continue;
        s.periodProposalsChecked++;
        const r = await drive(`period:${id}`, { periodProposal: id }, async () => {
          const p = await rot.reader.periodProposal(id);
          const outcome = periodProposalNeedsOutcome(p) ? await rot.reader.outcomeOf(p.scheme, rot.governor, p.token, periodPollScope(id)) : undefined;
          return planPeriodProposal(id, p, outcome, chainNow, ctx);
        });
        if (r === "done") donePeriods.add(id);
      }
    };

    // Takeovers first: their execution window is the tighter deadline.
    let count = 0n;
    try {
      count = await deps.reader.proposalCount();
    } catch (err) {
      deps.log("error", "keeper could not read proposal count", { error: redact(err instanceof Error ? err.message : String(err)) });
    }
    for (let id = 1n; id <= count && !stop(); id++) {
      if (doneProposals.has(id)) continue;
      s.proposalsChecked++;
      const ref: ItemRef = { proposal: id };
      const r = await drive(`proposal:${id}`, ref, async () => {
        const p = await deps.reader.proposal(id);
        const tally = proposalNeedsTally(p) ? await deps.reader.tallyOf(p.scheme, deps.takeoverGovernor, p.token, id) : undefined;
        return planProposal(id, p, tally, deps);
      });
      if (r === "done") doneProposals.add(id);
    }

    let tokenList: Address[] | undefined;
    const listTokens = async () => {
      tokenList ??= await deps.tokens();
      s.tokens = tokenList.length;
      return tokenList;
    };

    // Rotation rounds next: their windows are minutes to hours, an epoch's are days.
    if (deps.rotation && !stop()) await runRotation(deps.rotation, await listTokens());

    if (!stop()) {
      const current = await deps.reader.currentEpoch();
      const from = current > BigInt(deps.lookbackEpochs) ? current - BigInt(deps.lookbackEpochs) : 0n;
      for (const [k, e] of doneEpochs) if (e < from) doneEpochs.delete(k);
      const tokens = await listTokens();

      for (const k of doneBallots) if (!k.endsWith(`:${current}`)) doneBallots.delete(k);
      for (const k of idleLogged) if (!k.endsWith(`:${current}`)) idleLogged.delete(k);
      const active = deps.ballots ? await activeSet(current) : null;

      for (const token of tokens) {
        if (stop()) break;
        // The current epoch's ballot first: nobody can vote until the epoch is opened.
        const ballotKey = `ballot:${token.toLowerCase()}:${current}`;
        if (deps.ballots && !doneBallots.has(ballotKey) && active && !active.has(token.toLowerCase()) && !(await hasLpFees(token))) {
          // Idle: re-checked every run, so the epoch opens once fees (collected or not), ballots
          // or pins show up.
          s.idleSkipped++;
          if (!idleLogged.has(ballotKey)) {
            idleLogged.add(ballotKey);
            deps.log("info", "keeper skipped idle epoch", { token, epoch: current, idleEpochs });
          }
        } else if (deps.ballots && !doneBallots.has(ballotKey)) {
          s.ballotsChecked++;
          const ballots = deps.ballots;
          const r = await drive(ballotKey, { token, epoch: current }, async () => {
            if (!(await deps.reader.isRegistered(token))) return { type: "none", reason: "not registered", terminal: true };
            return ballots.plan(token, current);
          });
          if (r === "done") doneBallots.add(ballotKey);
        }
        const pending: bigint[] = [];
        for (let e = from; e < current; e++) if (!doneEpochs.has(`epoch:${token.toLowerCase()}:${e}`)) pending.push(e);
        if (pending.length === 0) continue;
        let registered: boolean;
        try {
          registered = await deps.reader.isRegistered(token);
        } catch (err) {
          deps.log("warn", "keeper could not read token registration", { token, error: redact(err instanceof Error ? err.message : String(err)) });
          continue;
        }
        if (!registered) continue;

        for (const epoch of pending) {
          if (stop()) break;
          s.epochsChecked++;
          const key = `epoch:${token.toLowerCase()}:${epoch}`;
          const r = await drive(key, { token, epoch }, async () => {
            const v = await deps.reader.epoch(token, epoch);
            if (v.finalized && deps.donation) return deps.donation.plan(token, epoch);
            const tally = epochNeedsTally(v) ? await deps.reader.tallyOf(v.scheme, deps.epochGovernor, token, epoch) : undefined;
            const step = planEpoch(token, epoch, v, tally, { epochGovernor: deps.epochGovernor, zamaScheme: deps.zamaScheme });
            if (step.type === "send" && step.action.kind === "finalizeEpoch" && finalizeNeedsOptions(v)) {
              return { type: "send", action: { ...step.action, orgIds: await deps.reader.ballotOrgIds(token, epoch) } };
            }
            return step;
          });
          if (r === "done") doneEpochs.set(key, epoch);
        }
      }
    }
    if (s.capped) deps.log("warn", "keeper reached its per-run transaction cap", { maxTxPerRun: deps.maxTxPerRun });
    return s;
  }

  return { run, backoff };
}
