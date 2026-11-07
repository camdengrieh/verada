/**
 * Epoch timing for display. The epoch length, voting window and hold window are owner-set on the
 * governor, so nothing here assumes a week: every figure comes from the governor (or the indexer's
 * copy of its schedule). An epoch is TRADING until `votingOpensAt` (ballots revert `VotingNotOpen`),
 * VOTING until `end`, then in its tally phase (counted, finalized, paid out).
 */
import { epochPhase, type EpochPhase } from "@varada/sdk";

export type { EpochPhase as TimingPhase };

/** One epoch's schedule in unix seconds; `end` is exclusive. */
export interface EpochTiming {
  start: number;
  end: number;
  /** First second ballots are accepted. Equals `start` when voting is open the whole epoch. */
  votingOpensAt: number;
}

/**
 * The timing of an epoch from an indexer or chain detail (or the platform clock), or null when its
 * boundaries are unknown. A source without `votingOpensAt` (an indexer that predates the schedule
 * fields) accepts ballots from the start.
 */
export function timingOf(src: { start?: number; end?: number; votingOpensAt?: number } | null | undefined): EpochTiming | null {
  if (!src || src.start === undefined || src.end === undefined) return null;
  return { start: src.start, end: src.end, votingOpensAt: src.votingOpensAt ?? src.start };
}

/** Phase of an epoch at `nowSeconds`. */
export function timingPhase(t: Pick<EpochTiming, "votingOpensAt" | "end">, nowSeconds: number): EpochPhase {
  return epochPhase({ votingOpensAt: BigInt(t.votingOpensAt), end: BigInt(t.end) }, BigInt(Math.floor(nowSeconds)));
}

/** "45 minutes", "1 hour 30 minutes", "7 days": the two largest non-zero units, singular or plural. */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return "0 seconds";
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  const parts: string[] = [];
  let rest = s;
  for (const [size, word] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 && parts.length < 2) parts.push(`${n} ${word}${n === 1 ? "" : "s"}`);
  }
  return parts.join(" ");
}

/** The cycle in a sentence: "45 minutes: 30 minutes of trading, then 15 minutes of voting", or the length alone when voting is open throughout. */
export function cycleText(t: EpochTiming): string {
  const length = t.end - t.start;
  const trading = t.votingOpensAt - t.start;
  if (trading <= 0) return `${durationText(length)}, with ballots accepted throughout`;
  return `${durationText(length)}: ${durationText(trading)} of trading, then ${durationText(t.end - t.votingOpensAt)} of voting`;
}
