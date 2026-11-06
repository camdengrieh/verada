// TypeScript mirror of contracts/src/libraries/RotationScheduleLib.sol, shared by the rotation
// handlers and the live-token API. Times are unix seconds, indices rotation numbers.

/** `RotationPeriod` enum order. */
export const ROTATION_PERIODS = ["OneHour", "TwelveHours", "OneDay", "ThreeDays", "OneWeek"] as const;
export type RotationPeriodName = (typeof ROTATION_PERIODS)[number];

const LENGTHS = [3_600n, 43_200n, 86_400n, 259_200n, 604_800n] as const;

export type Schedule = {
  anchorTime: bigint;
  anchorIndex: bigint;
  period: number;
  hasPending: boolean;
  pendingPeriod: number;
  pendingFrom: bigint;
};

/** Length of a rotation of period `p` in seconds (anything past the enum is a week, as on-chain). */
export function periodLength(p: number): bigint {
  return LENGTHS[p] ?? LENGTHS[4];
}

export function periodName(p: number): RotationPeriodName | null {
  return ROTATION_PERIODS[p] ?? null;
}

/** Start time of rotation `pendingFrom` (meaningful when `hasPending`). */
export function switchAt(s: Schedule): bigint {
  return s.anchorTime + (s.pendingFrom - s.anchorIndex) * periodLength(s.period);
}

/** Rotation index at time `t`; `t` before the anchor counts as the anchor rotation. */
export function indexAt(s: Schedule, t: bigint): bigint {
  if (t < s.anchorTime) return s.anchorIndex;
  if (s.hasPending) {
    const sw = switchAt(s);
    if (t >= sw) return s.pendingFrom + (t - sw) / periodLength(s.pendingPeriod);
  }
  return s.anchorIndex + (t - s.anchorTime) / periodLength(s.period);
}

/** Start time of rotation `n` (`n >= anchorIndex`). */
export function startOf(s: Schedule, n: bigint): bigint {
  if (s.hasPending && n >= s.pendingFrom) return switchAt(s) + (n - s.pendingFrom) * periodLength(s.pendingPeriod);
  return s.anchorTime + (n - s.anchorIndex) * periodLength(s.period);
}

/** Period of rotation `n`. */
export function periodOf(s: Schedule, n: bigint): number {
  return s.hasPending && n >= s.pendingFrom ? s.pendingPeriod : s.period;
}

/** Folds a pending change that has taken effect by `t` into the anchor. */
export function sync(s: Schedule, t: bigint): Schedule {
  if (!s.hasPending) return s;
  const sw = switchAt(s);
  if (t < sw) return s;
  return { anchorTime: sw, anchorIndex: s.pendingFrom, period: s.pendingPeriod, hasPending: false, pendingPeriod: 0, pendingFrom: 0n };
}
