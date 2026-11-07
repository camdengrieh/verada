import { epochAt, epochWindowOf, type EpochSegment, type EpochWindow } from "@varada/sdk";

/** What the governor and the vault hold before an owner setter is ever called. */
export const DEFAULT_GRACES = {
  /** `EpochGovernor.tallyGrace` default: 14 days. */
  tallyGrace: 14n * 86_400n,
  /** `EpochGovernor.launchSnapshotDelay` default: 1 day. */
  launchSnapshotDelay: 86_400n,
  /** `EpochGovernor.curationGrace` default: 6 hours. */
  curationGrace: 6n * 3_600n,
  /** `FeeVault.settleGrace` default: 7 days. */
  settleGrace: 7n * 86_400n,
} as const;

export type GraceName = keyof typeof DEFAULT_GRACES;

/** One stored `timing_setting` row. */
export interface TimingSettingRow {
  id: string;
  value: bigint;
  setAt: bigint;
}

/** The four owner-set grace periods: the last event's value, else the contract default. */
export function gracesOf(rows: readonly TimingSettingRow[]) {
  const out = {} as Record<GraceName, { value: bigint; setAt: bigint | null }>;
  for (const name of Object.keys(DEFAULT_GRACES) as GraceName[]) {
    const row = rows.find((r) => r.id === name);
    out[name] = row ? { value: row.value, setAt: row.setAt } : { value: DEFAULT_GRACES[name], setAt: null };
  }
  return out;
}

/**
 * Window of epoch `n` from the stored segments, or null without a schedule (the governor has not
 * been seen live yet). Epoch boundaries are never `zero + n * length`: a schedule change moves them.
 */
export function scheduleWindow(schedule: readonly EpochSegment[], n: bigint): EpochWindow | null {
  if (schedule.length === 0 || n < 0n) return null;
  try {
    return epochWindowOf(schedule, n);
  } catch {
    return null;
  }
}

/** Current epoch index at unix time `now`, or null without a schedule (or before epoch 0). */
export function currentEpochOf(schedule: readonly EpochSegment[], now: bigint): bigint | null {
  if (schedule.length === 0) return null;
  try {
    return epochAt(now, schedule);
  } catch {
    return null;
  }
}

/** The timing fields of an epoch window as served (`end` exclusive), all null without one. */
export function timingFields(w: EpochWindow | null) {
  return {
    start: w?.start ?? null,
    end: w?.end ?? null,
    votingOpensAt: w?.votingOpensAt ?? null,
    length: w?.length ?? null,
    votingWindow: w?.votingWindow ?? null,
    holdWindow: w?.holdWindow ?? null,
  };
}
