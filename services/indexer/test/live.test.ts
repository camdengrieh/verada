import { describe, expect, it } from "vitest";
import {
  claimsConversion,
  liveCauseSchedule,
  liveCauseTotal,
  liveDonation,
  liveFee,
  liveHeldRetry,
  liveMode,
  liveRound,
  liveSchedule,
  liveToken,
  liveVaultTotal,
} from "ponder:schema";
import { ActivityBus } from "../src/api/bus";
import { readApiConfig } from "../src/api/config";
import type { LiveRepo } from "../src/api/live";
import { toLiveView } from "../src/api/live";
import { createApi } from "../src/api/routes";
import {
  onClaimsConverted,
  onCredited,
  onDonationDeferred,
  onFeeTaken,
  onHeldRetried,
  onLiveDonated,
  onLiveModeConfigured,
  onLivePoolRegistered,
  onLiveTokenConfigured,
  onLiveTokenRegistered,
  onPlatformWithdrawn,
} from "../src/handlers/live";
import {
  onCauseScheduled,
  onPeriodChangeScheduled,
  onRotationTokenRegistered,
  onRoundFinalized,
} from "../src/handlers/rotation";
import { indexAt, type Schedule, startOf, sync } from "../src/rotation-schedule";
import { fixtureRepo } from "./api.fixtures";
import { createFakeContext } from "./fakeDb";

const T = "0x00000000000000000000000000000000000000a1" as const;
const HOOK = "0x00000000000000000000000000000000000000f1" as const;
const VAULT = "0x00000000000000000000000000000000000000f2" as const;
const GOV = "0x00000000000000000000000000000000000000f3" as const;
const ORG = "0x00000000000000000000000000000000000000f4" as const;
const WETH = "0x00000000000000000000000000000000000000b1" as const;
const C1 = `0x${"11".repeat(32)}` as const;
const C2 = `0x${"22".repeat(32)}` as const;
const POOL = `0x${"99".repeat(32)}` as const;
const tx = { hash: `0x${"ab".repeat(32)}` as const };
const HOUR = 3_600n;
const DAY = 86_400n;

const pks = () =>
  new Map<object, string[]>([
    [liveMode, ["id"]],
    [liveToken, ["token"]],
    [liveCauseTotal, ["token", "causeId"]],
    [liveFee, ["id"]],
    [liveHeldRetry, ["id"]],
    [liveDonation, ["id"]],
    [liveVaultTotal, ["id"]],
    [claimsConversion, ["id"]],
    [liveSchedule, ["token"]],
    [liveCauseSchedule, ["token", "fromRotation"]],
    [liveRound, ["token", "target"]],
  ]);

let h = createFakeContext(pks());
const block = (n: number, ts: bigint) => ({ number: BigInt(n), timestamp: ts });
// biome-ignore lint/suspicious/noExplicitAny: test shim for event payloads
const run = (fn: any, args: object, id: string, ts: bigint, address: string) =>
  fn({ event: { args, block: block(1, ts), transaction: tx, id, log: { address } }, context: h.context });

/** A launch at t = 1000 with C1 and one-hour rotations, in on-chain event order. */
async function launch() {
  h = createFakeContext(pks());
  await run(onLiveModeConfigured, { liveHook: HOOK, liveVault: VAULT }, "m", 900n, "0x01");
  await run(onLiveTokenConfigured, { token: T, baseFeeBps: 100, launchSurchargeBps: 5000, surchargeDecaySeconds: 600, launchTimestamp: 1000 }, "l1", 1000n, HOOK);
  await run(onLiveTokenRegistered, { token: T, threshold: 50_000_000n, initialCause: C1, period: 0 }, "l2", 1000n, VAULT);
  await run(onRotationTokenRegistered, { token: T, initialCause: C1, period: 0, anchorTime: 1000n }, "l3", 1000n, GOV);
  await run(onLivePoolRegistered, { token: T, quote: WETH, poolId: POOL }, "l4", 1000n, HOOK);
}

describe("rotation schedule", () => {
  const s: Schedule = { anchorTime: 1000n, anchorIndex: 0n, period: 0, hasPending: false, pendingPeriod: 0, pendingFrom: 0n };
  it("counts rotations from the anchor", () => {
    expect(indexAt(s, 1000n)).toBe(0n);
    expect(indexAt(s, 1000n + HOUR - 1n)).toBe(0n);
    expect(indexAt(s, 1000n + HOUR)).toBe(1n);
    expect(startOf(s, 3n)).toBe(1000n + 3n * HOUR);
  });
  it("switches period at the pending boundary without skipping an index", () => {
    const p = { ...s, hasPending: true, pendingPeriod: 2, pendingFrom: 2n };
    expect(indexAt(p, 1000n + 2n * HOUR)).toBe(2n);
    expect(indexAt(p, 1000n + 2n * HOUR + DAY - 1n)).toBe(2n);
    expect(indexAt(p, 1000n + 2n * HOUR + DAY)).toBe(3n);
    expect(startOf(p, 4n)).toBe(1000n + 2n * HOUR + 2n * DAY);
    expect(sync(p, 1000n + HOUR)).toBe(p);
    expect(sync(p, 1000n + 2n * HOUR)).toMatchObject({ anchorTime: 1000n + 2n * HOUR, anchorIndex: 2n, period: 2, hasPending: false });
  });
});

describe("live handlers", () => {
  it("assembles the live token from its launch events", async () => {
    await launch();
    expect(h.rows(liveMode)[0]).toMatchObject({ liveHook: HOOK, liveVault: VAULT });
    expect(h.rows(liveToken)).toHaveLength(1);
    expect(h.rows(liveToken)[0]).toMatchObject({
      baseFeeBps: 100,
      launchTimestamp: 1000n,
      threshold: 50_000_000n,
      initialCause: C1,
      initialPeriod: 0,
      quote: WETH,
      poolId: POOL,
      createdAt: 1000n,
    });
    expect(h.rows(liveSchedule)[0]).toMatchObject({ anchorTime: 1000n, period: 0, hasPending: false });
    expect(h.rows(liveCauseSchedule)[0]).toMatchObject({ fromRotation: 0n, causeId: C1, startsAt: 1000n });
  });

  it("keeps per-cause credit, donations, deferrals and held quote", async () => {
    await launch();
    await run(onFeeTaken, { token: T, causeId: C1, rotation: 0n, quote: WETH, quoteAmount: 10n, usdcOut: 100n, converted: true, failure: "0x00000000" }, "f1", 1100n, HOOK);
    await run(onCredited, { token: T, causeId: C1, rotation: 0n, gross: 100n, platform: 10n, causeShare: 90n }, "c1", 1100n, VAULT);
    await run(onFeeTaken, { token: T, causeId: C1, rotation: 0n, quote: WETH, quoteAmount: 7n, usdcOut: 0n, converted: false, failure: "0xdeadbeef" }, "f2", 1200n, HOOK);
    await run(onDonationDeferred, { token: T, causeId: C1, pending: 90n, reason: "0x12345678" }, "d0", 1200n, VAULT);
    await run(onHeldRetried, { token: T, causeId: C1, caller: ORG, quoteIn: 5n, usdcOut: 50n }, "r1", 1300n, HOOK);
    await run(onCredited, { token: T, causeId: C1, rotation: 2n ** 64n - 1n, gross: 50n, platform: 5n, causeShare: 45n }, "c2", 1300n, VAULT);
    await run(onLiveDonated, { token: T, causeId: C1, org: ORG, amount: 135n, orgDeployed: true, inSwap: false }, "d1", 1400n, VAULT);
    await run(onPlatformWithdrawn, { treasury: ORG, amount: 15n }, "w1", 1500n, VAULT);
    await run(onClaimsConverted, { source: HOOK, currency: WETH, to: VAULT, amountIn: 5n, settlementOut: 50n }, "cc", 1300n, "0x02");

    expect(h.rows(liveFee).map((f) => f.converted)).toEqual([true, false]);
    expect(h.rows(liveCauseTotal)[0]).toMatchObject({
      gross: 150n,
      platform: 15n,
      causeShare: 135n,
      credits: 2,
      donated: 135n,
      donations: 1,
      heldQuote: 2n,
      deferrals: 1,
      lastDeferReason: "0x12345678",
      lastDonatedAt: 1400n,
    });
    expect(h.rows(liveDonation)[0]).toMatchObject({ amount: 135n, orgDeployed: true, inSwap: false });
    expect(h.rows(liveVaultTotal)[0]).toMatchObject({ platformAccrued: 15n, platformWithdrawn: 15n, withdrawals: 1 });
    expect(h.rows(claimsConversion)[0]).toMatchObject({ source: HOOK, settlementOut: 50n });
  });

  it("records scheduled causes, round outcomes and period changes", async () => {
    await launch();
    await run(onRoundFinalized, { token: T, target: 1n, status: 3, winner: `0x${"00".repeat(32)}`, effectiveFrom: 0n }, "rf0", 1000n + HOUR - 10n, GOV);
    await run(onCauseScheduled, { token: T, causeId: C2, fromRotation: 2n, startsAt: 1000n + 2n * HOUR }, "cs", 1000n + HOUR + 10n, GOV);
    await run(onRoundFinalized, { token: T, target: 2n, status: 4, winner: C2, effectiveFrom: 2n }, "rf", 1000n + HOUR + 10n, GOV);
    expect(h.rows(liveRound).map((r) => r.status)).toEqual(["NoChange", "Applied"]);
    expect(h.rows(liveCauseSchedule).map((r) => r.causeId)).toEqual([C1, C2]);
    // Re-scheduling the same boundary replaces it.
    await run(onCauseScheduled, { token: T, causeId: C1, fromRotation: 2n, startsAt: 1000n + 2n * HOUR }, "cs2", 1000n + HOUR + 20n, GOV);
    expect(h.rows(liveCauseSchedule)).toHaveLength(2);
    expect(h.rows(liveCauseSchedule)[1]?.causeId).toBe(C1);

    await run(onPeriodChangeScheduled, { token: T, id: 1n, newPeriod: 2, fromRotation: 3n, switchAt: 1000n + 3n * HOUR }, "pc", 1000n + 2n * HOUR + 5n, GOV);
    expect(h.rows(liveSchedule)[0]).toMatchObject({ anchorTime: 1000n, anchorIndex: 0n, period: 0, hasPending: true, pendingPeriod: 2, pendingFrom: 3n, switchAt: 1000n + 3n * HOUR, periodChanges: 1 });
    // A second change after the first took effect folds the first into the anchor.
    const t2 = 1000n + 3n * HOUR + DAY + 5n;
    await run(onPeriodChangeScheduled, { token: T, id: 2n, newPeriod: 4, fromRotation: 5n, switchAt: 1000n + 3n * HOUR + 2n * DAY }, "pc2", t2, GOV);
    expect(h.rows(liveSchedule)[0]).toMatchObject({ anchorTime: 1000n + 3n * HOUR, anchorIndex: 3n, period: 2, pendingPeriod: 4, pendingFrom: 5n, periodChanges: 2 });
  });

  it("ignores a period change for an unregistered token", async () => {
    h = createFakeContext(pks());
    await run(onPeriodChangeScheduled, { token: T, id: 1n, newPeriod: 2, fromRotation: 3n, switchAt: 5n }, "pc", 10n, GOV);
    expect(h.rows(liveSchedule)).toHaveLength(0);
  });
});

const liveRepoFrom = (): LiveRepo => ({
  async getLiveToken(t) {
    const tok = h.rows(liveToken).find((r) => r.token === t);
    if (!tok) return null;
    return {
      token: tok as never,
      schedule: (h.rows(liveSchedule)[0] ?? null) as never,
      causeSchedule: h.rows(liveCauseSchedule) as never,
      causeTotals: h.rows(liveCauseTotal) as never,
    };
  },
  async donations() {
    return h.rows(liveDonation) as never;
  },
});

describe("live API", () => {
  const mk = (live: LiveRepo | undefined, nowMs: number) => {
    const r = fixtureRepo();
    return createApi({
      repo: r,
      search: { search: async () => [] },
      config: readApiConfig({}),
      bus: new ActivityBus(() => r.listActivity({ limit: 100 }), 10_000),
      live,
      now: () => nowMs,
    });
  };

  it("serves the designated cause, rotation clock and totals per cause", async () => {
    await launch();
    await run(onCredited, { token: T, causeId: C1, rotation: 0n, gross: 100n, platform: 10n, causeShare: 90n }, "c1", 1100n, VAULT);
    await run(onLiveDonated, { token: T, causeId: C1, org: ORG, amount: 60n, orgDeployed: false, inSwap: true }, "d1", 1100n, VAULT);
    await run(onCauseScheduled, { token: T, causeId: C2, fromRotation: 2n, startsAt: 1000n + 2n * HOUR }, "cs", 1000n + HOUR + 10n, GOV);
    await run(onCredited, { token: T, causeId: C2, rotation: 2n, gross: 1000n, platform: 100n, causeShare: 900n }, "c2", 1000n + 2n * HOUR + 1n, VAULT);
    await run(onLiveDonated, { token: T, causeId: C2, org: ORG, amount: 900n, orgDeployed: false, inSwap: true }, "d2", 1000n + 2n * HOUR + 1n, VAULT);

    // Rotation 1: C1 still designated, C2 scheduled next.
    let res = await mk(liveRepoFrom(), Number(1000n + HOUR + 30n) * 1000).request(`/api/live/${T}`);
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.rotation).toMatchObject({ current: "1", period: "OneHour", periodSeconds: "3600", startedAt: String(1000n + HOUR), nextRotationAt: String(1000n + 2n * HOUR), pendingPeriodChange: null });
    expect(body.designatedCause).toMatchObject({ causeId: C1, fromRotation: "0" });
    expect(body.nextCause).toMatchObject({ causeId: C2, fromRotation: "2", startsAt: String(1000n + 2n * HOUR) });

    // A pending period change shows up and moves later boundaries only.
    await run(onPeriodChangeScheduled, { token: T, id: 1n, newPeriod: 2, fromRotation: 3n, switchAt: 1000n + 3n * HOUR }, "pc", 1000n + 2n * HOUR + 5n, GOV);
    res = await mk(liveRepoFrom(), Number(1000n + 2n * HOUR + 30n) * 1000).request(`/api/live/${T.toUpperCase().replace("0X", "0x")}`);
    body = await res.json();
    expect(body.rotation).toMatchObject({ current: "2", nextRotationAt: String(1000n + 3n * HOUR), nextPeriod: "OneDay" });
    expect(body.rotation.pendingPeriodChange).toEqual({ period: "OneDay", fromRotation: "3", switchAt: String(1000n + 3n * HOUR) });
    expect(body.designatedCause.causeId).toBe(C2);
    expect(body.nextCause).toBeNull();
    expect(body.causes.map((c: { causeId: string }) => c.causeId)).toEqual([C2, C1]);
    expect(body.causes[1]).toMatchObject({ credited: "90", donated: "60", pending: "30" });
    expect(body.totals).toEqual({ gross: "1100", platform: "110", credited: "990", donated: "960", pending: "30" });
    expect(body.recentDonations).toHaveLength(2);
    expect(body).toMatchObject({ threshold: "50000000", initialPeriod: "OneHour", quote: WETH, decimals: 6 });
  });

  it("falls back to the initial cause before the governor is indexed", () => {
    const view = toLiveView(
      {
        token: { token: T, baseFeeBps: null, launchSurchargeBps: null, surchargeDecaySeconds: null, launchTimestamp: null, threshold: 0n, initialCause: C1, initialPeriod: 4, registeredAt: 1n, quote: null, poolId: null, createdAt: 1n, txHash: tx.hash },
        schedule: null,
        causeSchedule: [],
        causeTotals: [],
      },
      10n,
    );
    expect(view.rotation).toBeNull();
    expect(view.designatedCause).toEqual({ causeId: C1, fromRotation: null, startsAt: null });
    expect(view.initialPeriod).toBe("OneWeek");
  });

  it("answers 404 for an unknown token, 400 for a bad address and 503 without the tables", async () => {
    await launch();
    expect((await mk(liveRepoFrom(), 2_000_000).request(`/api/live/0x${"00".repeat(19)}a2`)).status).toBe(404);
    expect((await mk(liveRepoFrom(), 2_000_000).request("/api/live/0x12")).status).toBe(400);
    expect((await mk(undefined, 2_000_000).request(`/api/live/${T}`)).status).toBe(503);
  });
});
