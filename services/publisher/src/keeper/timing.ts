import { epochPhase, hasTradingPhase, type EpochPhase } from "@varada/sdk";
import type { KeeperTiming } from "./chain.js";

/** The schedule as logged with each run (seconds and counts as numbers, so it serializes). */
export interface TimingSummary {
  epoch: number;
  phase: EpochPhase;
  epochLengthSeconds: number;
  votingWindowSeconds: number;
  /** Seconds before voting opens; 0 when voting is open the whole epoch. */
  tradingSeconds: number;
  votingOpensAt: number;
  epochEnd: number;
  secondsToNextPhase: number;
  tallyGraceSeconds?: number;
  settleGraceSeconds?: number;
}

export interface TimingReport {
  summary: TimingSummary;
  /** Identifies the settings the warnings depend on, so each distinct set is warned about once. */
  key: string;
  warnings: { msg: string; data: Record<string, unknown> }[];
}

const MIN_COVERAGE_SECONDS = 6n * 3_600n;

/**
 * Reads the keeper's own settings against the chain's schedule. A schedule is owner-set and can be
 * as short as 5 minutes per phase, so a keeper tuned for weekly epochs may be too slow for it:
 *
 *  - `intervalSeconds`: ballots of an epoch must be prepared before voting opens (the trading
 *    phase, or the whole epoch when voting is open all of it), so a run interval longer than half of
 *    it risks voters waiting for an opening;
 *  - `lookbackEpochs`: an epoch is only followed while it is among the last `lookbackEpochs`, so the
 *    lookback must span the tally and settle graces (after which the fallbacks and late fees apply)
 *    plus an outage margin, in time and not in epochs.
 */
export function checkTiming(t: KeeperTiming, cfg: { intervalSeconds: number; lookbackEpochs: number }): TimingReport {
  const w = t.window;
  const trading = hasTradingPhase(w) ? w.votingOpensAt - w.start : 0n;
  const phase = epochPhase(w, t.now);
  const nextAt = phase === "trading" ? w.votingOpensAt : w.end;
  const summary: TimingSummary = {
    epoch: Number(w.epoch),
    phase,
    epochLengthSeconds: Number(w.length),
    votingWindowSeconds: Number(w.votingWindow),
    tradingSeconds: Number(trading),
    votingOpensAt: Number(w.votingOpensAt),
    epochEnd: Number(w.end),
    secondsToNextPhase: nextAt > t.now ? Number(nextAt - t.now) : 0,
    tallyGraceSeconds: t.tallyGrace === undefined ? undefined : Number(t.tallyGrace),
    settleGraceSeconds: t.settleGrace === undefined ? undefined : Number(t.settleGrace),
  };
  const warnings: TimingReport["warnings"] = [];

  const lead = trading > 0n ? trading : w.length;
  const interval = BigInt(cfg.intervalSeconds);
  if (interval * 2n > lead) {
    warnings.push({
      msg: "keeper interval is more than half of the time before voting opens; ballots may be prepared late",
      data: {
        intervalSeconds: cfg.intervalSeconds,
        secondsBeforeVotingOpens: Number(lead),
        recommendedIntervalSeconds: Math.max(30, Number(lead / 4n)),
      },
    });
  }

  const coverage = BigInt(cfg.lookbackEpochs) * w.length;
  const needs: Record<string, bigint> = {};
  if (t.tallyGrace !== undefined) needs.tallyGrace = t.tallyGrace + w.length;
  if (t.settleGrace !== undefined) needs.settleGrace = t.settleGrace + w.length;
  const short = Object.entries(needs).filter(([, need]) => coverage < need);
  if (coverage < MIN_COVERAGE_SECONDS || short.length > 0) {
    warnings.push({
      msg: "KEEPER_LOOKBACK_EPOCHS spans less time than a keeper outage or the grace periods: an epoch can leave the lookback before it is finished",
      data: {
        lookbackEpochs: cfg.lookbackEpochs,
        lookbackSeconds: Number(coverage),
        epochLengthSeconds: summary.epochLengthSeconds,
        graceStillOpen: short.map(([k]) => k),
        minimumSeconds: Number(MIN_COVERAGE_SECONDS),
      },
    });
  }
  const key = [w.length, w.votingWindow, w.votingOpensAt - w.start, t.tallyGrace ?? "-", t.settleGrace ?? "-", cfg.intervalSeconds, cfg.lookbackEpochs].join(":");
  return { summary, key, warnings };
}
