import type { Hex } from "viem";
import { indexAt, periodLength, periodName, periodOf, type Schedule, startOf } from "../rotation-schedule";

/** Read access to the live-donation tables (implemented over Ponder's db and by test fixtures). */
export interface LiveTokenRow {
  token: Hex;
  baseFeeBps: number | null;
  launchSurchargeBps: number | null;
  surchargeDecaySeconds: number | null;
  launchTimestamp: bigint | null;
  threshold: bigint | null;
  initialCause: Hex | null;
  initialPeriod: number | null;
  registeredAt: bigint | null;
  quote: Hex | null;
  poolId: Hex | null;
  createdAt: bigint;
  txHash: Hex;
}

export interface LiveScheduleRow extends Schedule {
  token: Hex;
  switchAt: bigint | null;
  periodChanges: number;
}

export interface LiveCauseScheduleRow {
  token: Hex;
  fromRotation: bigint;
  causeId: Hex;
  startsAt: bigint;
  scheduledAt: bigint;
  txHash: Hex;
}

export interface LiveCauseTotalRow {
  token: Hex;
  causeId: Hex;
  gross: bigint;
  platform: bigint;
  causeShare: bigint;
  credits: number;
  donated: bigint;
  donations: number;
  heldQuote: bigint;
  deferrals: number;
  lastDeferReason: Hex | null;
  lastCreditedAt: bigint | null;
  lastDonatedAt: bigint | null;
}

export interface LiveDonationRow {
  id: string;
  token: Hex;
  causeId: Hex;
  org: Hex;
  amount: bigint;
  orgDeployed: boolean;
  inSwap: boolean;
  timestamp: bigint;
  txHash: Hex;
}

export interface LiveRepo {
  getLiveToken(token: Hex): Promise<{
    token: LiveTokenRow;
    schedule: LiveScheduleRow | null;
    /** Ascending by `fromRotation`. */
    causeSchedule: LiveCauseScheduleRow[];
    causeTotals: LiveCauseTotalRow[];
  } | null>;
  /** Newest first. */
  donations(token: Hex, limit: number): Promise<LiveDonationRow[]>;
}

/** The scheduled cause in effect at rotation `n`: the last schedule row starting at or before it. */
function causeAt(rows: LiveCauseScheduleRow[], n: bigint): LiveCauseScheduleRow | null {
  let found: LiveCauseScheduleRow | null = null;
  for (const r of rows) if (r.fromRotation <= n && (!found || r.fromRotation >= found.fromRotation)) found = r;
  return found;
}

const period = (p: number) => ({ period: periodName(p), periodSeconds: periodLength(p) });

/**
 * Live token view at unix time `now`: the rotation clock (current rotation, its start, the next
 * rotation time, any pending period change), the designated cause now and the one scheduled next,
 * and per-cause totals. `rotation` is null until the rotation governor's registration is indexed;
 * the designated cause then falls back to the launch's initial cause.
 */
export function toLiveView(found: NonNullable<Awaited<ReturnType<LiveRepo["getLiveToken"]>>>, now: bigint) {
  const { token: t, schedule: s, causeSchedule } = found;
  let rotation = null;
  let designated: { causeId: Hex; fromRotation: bigint | null; startsAt: bigint | null } | null = t.initialCause
    ? { causeId: t.initialCause, fromRotation: null, startsAt: null }
    : null;
  let next: { causeId: Hex; fromRotation: bigint; startsAt: bigint } | null = null;

  if (s) {
    const n = indexAt(s, now);
    const nextAt = startOf(s, n + 1n);
    rotation = {
      current: n,
      ...period(periodOf(s, n)),
      startedAt: startOf(s, n),
      nextRotationAt: nextAt,
      nextPeriod: periodName(periodOf(s, n + 1n)),
      anchorTime: s.anchorTime,
      pendingPeriodChange:
        s.hasPending && s.pendingFrom > n
          ? { period: periodName(s.pendingPeriod), fromRotation: s.pendingFrom, switchAt: startOf(s, s.pendingFrom) }
          : null,
      periodChanges: s.periodChanges,
    };
    const cur = causeAt(causeSchedule, n);
    if (cur) designated = { causeId: cur.causeId, fromRotation: cur.fromRotation, startsAt: cur.startsAt };
    const upcoming = causeSchedule.filter((r) => r.fromRotation > n).sort((a, b) => (a.fromRotation < b.fromRotation ? -1 : 1))[0];
    if (upcoming) next = { causeId: upcoming.causeId, fromRotation: upcoming.fromRotation, startsAt: upcoming.startsAt };
  }

  const causes = found.causeTotals
    .map((c) => ({
      causeId: c.causeId,
      gross: c.gross,
      platform: c.platform,
      credited: c.causeShare,
      donated: c.donated,
      pending: c.causeShare > c.donated ? c.causeShare - c.donated : 0n,
      heldQuote: c.heldQuote,
      credits: c.credits,
      donations: c.donations,
      deferrals: c.deferrals,
      lastDeferReason: c.lastDeferReason,
      lastCreditedAt: c.lastCreditedAt,
      lastDonatedAt: c.lastDonatedAt,
    }))
    .sort((a, b) => (a.donated === b.donated ? (a.causeId < b.causeId ? -1 : 1) : a.donated > b.donated ? -1 : 1));
  const sum = (k: "gross" | "platform" | "credited" | "donated" | "pending") => causes.reduce((acc, c) => acc + c[k], 0n);

  return {
    token: t.token,
    decimals: 6,
    currency: "USDC",
    threshold: t.threshold,
    initialCause: t.initialCause,
    initialPeriod: t.initialPeriod === null ? null : periodName(t.initialPeriod),
    quote: t.quote,
    poolId: t.poolId,
    fee: { baseFeeBps: t.baseFeeBps, launchSurchargeBps: t.launchSurchargeBps, surchargeDecaySeconds: t.surchargeDecaySeconds, launchTimestamp: t.launchTimestamp },
    registeredAt: t.registeredAt,
    now,
    rotation,
    designatedCause: designated,
    nextCause: next,
    totals: { gross: sum("gross"), platform: sum("platform"), credited: sum("credited"), donated: sum("donated"), pending: sum("pending") },
    causes,
  };
}
