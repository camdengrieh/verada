import { buildReport, pickProof, type BuiltRegion } from "@varada/curator";
import {
  BUCKET_COUNT,
  bucketId,
  categoryMaskOf,
  causeIdOfOrg,
  drawIndex,
  periodPollScope,
  planRotation,
  regionMaskOf,
  rotationPollScope,
} from "@varada/sdk";
import { decodeAbiParameters, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { Backoff } from "../src/keeper/backoff.js";
import { createRoundPreparer, type CatalogEntrySource, type PickSource, type RoundReader } from "../src/keeper/ballot.js";
import type { KeeperAction, PeriodProposalView, RoundView } from "../src/keeper/chain.js";
import { createKeeper } from "../src/keeper/keeper.js";
import { planPeriodProposal, planRound } from "../src/keeper/plan.js";
import { collectLogs, EG, FakeChain, FakeRotation, OTHER_SCHEME, RG, TG, token, ZAMA } from "./keeper-fakes.js";

const T1 = token(1);
/** A weekly token: listed like any other, registered with the epoch governor, never with the rotation one. */
const T2 = token(2);
/** A second live token (same focus as T1). */
const T3 = token(3);
const ROOT = `0x${"ab".repeat(32)}` as Hex;
const HUNGER_AF = bucketId(2, 0);
const HUNGER_AS = bucketId(2, 1);
const sizes = Array.from({ length: BUCKET_COUNT }, () => 0);
sizes[HUNGER_AF] = 40;
sizes[HUNGER_AS] = 10;
const focus = { categoryMask: categoryMaskOf(["hunger"]), regionMask: regionMaskOf(["africa", "asia"]) };
const orgAt = (b: number, i: number) => `0x${b.toString(16).padStart(4, "0")}${i.toString(16).padStart(60, "0")}` as Hex;
/** Weekly epoch whose curations feed the rounds (`curationEpochOf`). */
const CURATION_EPOCH = 2n;

// Curations of epoch 2: Africa 4 picks at 7000, Asia 2 picks at 3000.
const pick = (orgId: Hex, catalogIndex: number) => ({ orgId, catalogIndex, name: "org", score: 50, reasons: "relevant", sources: [] });
const af = [3, 7, 11, 0].map((i) => pick(orgAt(HUNGER_AF, i), i));
const as = [2, 4].map((i) => pick(orgAt(HUNGER_AS, i), i));
const built = buildReport(
  {
    schema: "varada.curation/v1",
    category: "hunger",
    epoch: Number(CURATION_EPOCH),
    catalogVersion: 1,
    generatedAt: "2026-11-09T08:00:00.000Z",
    title: "t",
    intro: "",
    regions: [
      { region: "africa", weight: 7000, summary: "", events: [], picks: af, newsletter: "" },
      { region: "asia", weight: 3000, summary: "", events: [], picks: as, newsletter: "" },
    ],
  },
  null,
);
const [bAf, bAs] = built.regions as [BuiltRegion, BuiltRegion];
const onChain = [
  { bucket: HUNGER_AF, picksRoot: bAf.picksRoot, count: 4, weight: 7000 },
  { bucket: HUNGER_AS, picksRoot: bAs.picksRoot, count: 2, weight: 3000 },
];
const picksFor = (region: BuiltRegion, list: ReturnType<typeof pick>[]) => ({
  picksRoot: region.picksRoot,
  items: list.map((p, rank) => ({ rank, catalogIndex: p.catalogIndex, orgId: p.orgId, proof: pickProof(region, rank, p.catalogIndex, p.orgId) })),
});
function picks(over: Partial<Record<string, ReturnType<typeof picksFor> | null>> = {}): PickSource & { asked: string[] } {
  const all: Record<string, ReturnType<typeof picksFor> | null> = { africa: picksFor(bAf, af), asia: picksFor(bAs, as), ...over };
  const src = {
    asked: [] as string[],
    async picks(label: string, epoch: bigint, region: string) {
      src.asked.push(`${label}/${epoch}/${region}`);
      return all[region] ?? null;
    },
  };
  return src;
}

function entries(): CatalogEntrySource {
  return {
    async entries(at) {
      return { root: ROOT, items: at.map((e) => ({ ...e, orgId: orgAt(e.bucket, e.index), proof: [ROOT] })) };
    },
  };
}

/** The preparer's reads, over the fake governor's rounds, schedule and clock. */
function roundReader(rot: FakeRotation, over: Partial<RoundReader> = {}): RoundReader {
  return {
    roundStatus: async (t, target) => rot.roundOf(t, target).status,
    currentRotation: async () => rot.current(),
    pollWindow: async (_t, target) => rot.window(target),
    curationEpochOf: async () => ({ ok: true, epoch: CURATION_EPOCH }),
    now: async () => rot.now,
    poolOf: async () => ({ version: 1, poolSize: 50n }),
    pinned: async () => [],
    ballotSize: async () => 10,
    focusOf: async () => focus,
    bucketSizes: async () => sizes,
    catalogRoot: async () => ROOT,
    isBlocked: async () => false,
    ...over,
  };
}

function setup(
  opts: {
    over?: Partial<RoundReader>;
    picks?: PickSource;
    preparer?: boolean;
    dryRun?: boolean;
    /** Live tokens besides T1. */
    live?: typeof T1[];
    decryptFail?: () => Error | undefined;
  } = {},
) {
  const chain = new FakeChain();
  chain.register(T2);
  const rot = new FakeRotation().register(T1);
  for (const t of opts.live ?? []) rot.register(t);
  chain.rotation = rot;
  let wall = Number(rot.now) * 1000;
  const advance = (seconds: bigint) => {
    rot.now += seconds;
    wall = Number(rot.now) * 1000;
  };
  const { log, logs } = collectLogs();
  const backoff = new Backoff({ now: () => wall });
  const reader = rot.reader();
  const isRegistered = vi.fn(reader.isRegistered);
  const decryptor = chain.decryptor({ fail: () => opts.decryptFail?.() });
  const chainReader = chain.reader();
  const weeklyIsRegistered = vi.fn(chainReader.isRegistered);
  const keeper = createKeeper({
    reader: { ...chainReader, isRegistered: weeklyIsRegistered },
    writer: chain.writer(),
    decryptor,
    tokens: async () => [T1, T2, ...(opts.live ?? [])],
    epochGovernor: EG,
    takeoverGovernor: TG,
    zamaScheme: ZAMA,
    dryRun: opts.dryRun ?? false,
    maxTxPerRun: 10,
    lookbackEpochs: 0,
    log,
    backoff,
    now: () => wall,
    rotation: {
      governor: RG,
      reader: { ...reader, isRegistered },
      rounds:
        opts.preparer === false
          ? undefined
          : createRoundPreparer({ reader: roundReader(rot, opts.over), entries: entries(), picks: opts.picks ?? picks() }),
      lookbackRounds: 3,
    },
  });
  return { chain, rot, keeper, logs, backoff, advance, isRegistered, weeklyIsRegistered, decryptor };
}

const kinds = (sent: KeeperAction[]) => sent.map((a) => a.kind);
const rotationOnly = (target: bigint) =>
  planRotation(
    { token: T1, epoch: target, version: 1, bucketSizes: sizes, ...focus, pinned: [], ballotSize: 10 },
    { entryAt: async (b, i) => orgAt(b, i), isBlocked: async () => false },
  );

describe("planRound", () => {
  const ctx = { rotationGovernor: RG, zamaScheme: ZAMA };
  const v = (over: Partial<RoundView>): RoundView => ({ status: "Open", voteEnd: 100n, voters: 2n, scheme: ZAMA, ...over });

  it("closes an ended round with ballots, decrypts its winner, then finalizes it", () => {
    expect(planRound(T1, 4n, v({}), undefined, 99n, ctx)).toEqual({ type: "none", reason: "voting", terminal: false });
    expect(planRound(T1, 4n, v({}), undefined, 100n, ctx)).toEqual({ type: "send", action: { kind: "closeRound", token: T1, target: 4n } });
    expect(planRound(T1, 4n, v({ status: "Closed" }), { isFinal: false, winner: 255 }, 100n, ctx)).toEqual({
      type: "decrypt",
      scheme: ZAMA,
      governor: RG,
      token: T1,
      scope: rotationPollScope(4n),
      outcome: true,
    });
    expect(planRound(T1, 4n, v({ status: "Closed" }), { isFinal: true, winner: 1 }, 100n, ctx)).toEqual({
      type: "send",
      action: { kind: "finalizeRound", token: T1, target: 4n },
    });
  });

  it("is done with final rounds, rounds never prepared and ended rounds without ballots", () => {
    for (const status of ["NoChange", "Applied", "Stale", "InactiveWinner", "NoBallot", "None"] as const) {
      expect(planRound(T1, 4n, v({ status }), undefined, 100n, ctx)).toMatchObject({ type: "none", terminal: true });
    }
    expect(planRound(T1, 4n, v({ voters: 0n }), undefined, 100n, ctx)).toMatchObject({ type: "none", terminal: true });
    // Another scheme's poll is never decrypted.
    expect(planRound(T1, 4n, v({ status: "Closed", scheme: OTHER_SCHEME }), { isFinal: false, winner: 255 }, 100n, ctx)).toMatchObject({
      type: "none",
      terminal: false,
    });
  });
});

describe("rotation keeper: preparing rounds", () => {
  it("prepares the next rotation's round once, with the governor's draws seeded by the target", async () => {
    const { chain, keeper, isRegistered } = setup({ over: { curationEpochOf: async () => ({ ok: false, epoch: 0n }) } });
    const s1 = await keeper.run();
    expect(s1).toMatchObject({ liveTokens: 1, failed: 0 });
    expect(kinds(chain.sent)).toEqual(["prepareRound"]);
    const a = chain.sent[0] as Extract<KeeperAction, { kind: "prepareRound" }>;
    expect(a.target).toBe(5n);
    const expected = await rotationOnly(5n);
    expect(a.draws.map((d) => d.orgId)).toEqual(expected.draws.map((d) => d.orgId));
    expect(a.draws[0]!.orgId).toBe(orgAt(HUNGER_AF, drawIndex(T1, 5n, 1, 0, 50)));
    await keeper.run();
    expect(chain.sent).toHaveLength(1);
    // Registration is read once per token: live with the rotation governor, weekly with the
    // epoch governor (the factory registers a token with exactly one, when it creates it).
    for (let i = 0; i < 3; i++) await keeper.run();
    expect(isRegistered.mock.calls.filter(([t]) => t === T1)).toHaveLength(1);
    expect(isRegistered.mock.calls.filter(([t]) => t === T2)).toHaveLength(1);
  });

  it("re-checks a token registered with neither governor, and becomes live once it is", async () => {
    const T4 = token(4);
    const { chain, rot, keeper, isRegistered, weeklyIsRegistered } = setup({ live: [T4] });
    rot.registered.delete(T4.toLowerCase());
    await keeper.run();
    await keeper.run();
    expect(isRegistered.mock.calls.filter(([t]) => t === T4)).toHaveLength(2);
    expect(weeklyIsRegistered.mock.calls.filter(([t]) => t === T4)).toHaveLength(2);
    // An RPC that lagged the indexer catches up: the token is live from the next run.
    rot.register(T4);
    await keeper.run();
    expect(chain.sent.filter((a) => "token" in a && a.token === T4).map((a) => a.kind)).toEqual(["prepareRound"]);
  });

  it("opens a pin-filled round with openRound", async () => {
    const pins = Array.from({ length: 10 }, (_, i) => causeIdOfOrg(orgAt(HUNGER_AF, i)));
    const { chain, rot, keeper } = setup({ over: { pinned: async () => pins } });
    await keeper.run();
    expect(chain.sent).toEqual([{ kind: "openRound", token: T1, target: 5n }]);
    expect(rot.roundOf(T1, 5n).status).toBe("Open");
  });

  it("draws curated slots from the weekly epoch containing the round's vote start", async () => {
    const src = picks();
    const { chain, keeper } = setup({ over: { curationsFor: async () => onChain }, picks: src });
    await keeper.run();
    expect(kinds(chain.sent)).toEqual(["prepareCuratedRound"]);
    expect(src.asked).toEqual([`hunger/${CURATION_EPOCH}/africa`, `hunger/${CURATION_EPOCH}/asia`]);
    const a = chain.sent[0] as Extract<KeeperAction, { kind: "prepareCuratedRound" }>;
    expect(a.curated.map((c) => c.pickOrgId)).toEqual([...af, ...as].map((p) => p.orgId));
    expect(a.curated[0]!.pickProof).toEqual(pickProof(bAf, 0, 3, af[0]!.orgId));
  });

  it("never prepares a rotation-only round while picks are missing, and retries until the owner voids the curation", async () => {
    // The builder requires the curated draws for the whole vote window: a rotation-only
    // prepareRound past the old 15-minute grace would revert IncompleteCuratedBallot.
    let voided = false;
    const { chain, rot, keeper, logs, backoff, advance } = setup({
      over: { curationsFor: async () => (voided ? [] : onChain) },
      picks: picks({ asia: null }),
    });
    rot.curatedRequired = true;
    const s1 = await keeper.run();
    expect(s1.failed).toBe(1);
    expect(chain.sent).toEqual([]);
    const fail1 = logs.find((l) => l.msg === "keeper step failed")!;
    expect(fail1.data).toMatchObject({ token: T1, round: 5n, op: "read", retryInSeconds: 300, awaitingCuratedPicks: true });
    // The first report of these missing picks alarms; retries of the same wait do not.
    expect(fail1.level).toBe("error");
    expect(String(fail1.data!.error)).toMatch(/CuratedPicksUnavailable.*voidCurations/);
    expect(backoff.blocked(`round:${T1.toLowerCase()}:5`)).toBe(true);

    // Past the old 15-minute grace (retries at 6, 16 and 31 minutes in): still nothing sent.
    for (let i = 0; i < 4; i++) {
      advance(300n);
      await keeper.run();
    }
    expect(chain.sent).toEqual([]);
    const failed = logs.filter((l) => l.msg === "keeper step failed");
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(failed.slice(1).every((l) => l.level === "warn" && Number(l.data!.retryInSeconds) <= 900)).toBe(true);

    // The registry owner voids the curation: the next attempt prepares with rotation only.
    voided = true;
    rot.curatedRequired = false;
    advance(600n);
    await keeper.run();
    expect(kinds(chain.sent)).toEqual(["prepareRound"]);
    const a = chain.sent[0] as Extract<KeeperAction, { kind: "prepareRound" }>;
    expect(a.draws.map((d) => d.orgId)).toEqual((await rotationOnly(5n)).draws.map((d) => d.orgId));
    expect(rot.roundOf(T1, 5n).status).toBe("Open");
  });

  it("logs missing picks at error once, not for every round of every live token", async () => {
    const { chain, rot, keeper, logs, advance } = setup({ live: [T3], over: { curationsFor: async () => onChain }, picks: picks({ asia: null }) });
    rot.curatedRequired = true;
    // Three hours of 5-minute runs: every round of both tokens waits for the picks.
    for (let i = 0; i < 36; i++) {
      await keeper.run();
      advance(300n);
    }
    const failed = logs.filter((l) => l.msg === "keeper step failed");
    expect(failed.length).toBeGreaterThanOrEqual(6);
    expect(failed.filter((l) => l.level === "error")).toHaveLength(1);
    expect(failed.every((l) => l.data?.awaitingCuratedPicks === true)).toBe(true);
    expect(chain.sent.filter((a) => "target" in a)).toEqual([]);
    // Any other failure of a round still logs at error.
    expect(logs.filter((l) => l.level === "error" && l.msg !== "keeper step failed")).toEqual([]);
  });

  it("uses the picks when they turn up", async () => {
    let published = false;
    const src: PickSource = { picks: async (label, epoch, region) => (published ? picks().picks(label, epoch, region) : null) };
    const { chain, rot, keeper, advance } = setup({ over: { curationsFor: async () => onChain }, picks: src });
    rot.curatedRequired = true;
    await keeper.run();
    expect(chain.sent).toEqual([]);
    published = true;
    advance(300n);
    await keeper.run();
    expect(kinds(chain.sent)).toEqual(["prepareCuratedRound"]);
  });

  it("leaves a round whose vote window ended, and never prepares a past round", async () => {
    const { chain, rot, keeper, advance } = setup();
    advance(rot.window(5n).voteEnd - rot.now);
    const s = await keeper.run();
    expect(s.failed).toBe(0);
    expect(chain.sent).toEqual([]);
    // Next rotation: round 6 is the one to prepare; round 5 is out of reach for good.
    advance(FakeRotation.BUFFER);
    await keeper.run();
    expect(chain.sent).toMatchObject([{ kind: "prepareRound", target: 6n }]);
  });

  it("without a round preparer, prepares nothing but still closes and finalizes", async () => {
    const { chain, rot, keeper } = setup({ preparer: false });
    rot.openRound(T1, 4n, 2n, 1n);
    await keeper.run();
    expect(kinds(chain.sent)).toEqual(["closeRound", "submitOutcome", "finalizeRound"]);
  });
});

describe("rotation keeper: closing rounds", () => {
  it("closes an ended round with ballots, relays its decrypted winner and finalizes it, once", async () => {
    const { chain, rot, keeper, decryptor } = setup();
    // Round 4 was voted during rotation 3; its vote window ended 15 minutes before rotation 4.
    rot.openRound(T1, 4n, 3n, 1n);
    const s1 = await keeper.run();
    expect(kinds(chain.sent)).toEqual(["closeRound", "submitOutcome", "finalizeRound", "prepareRound"]);
    expect(s1).toMatchObject({ decrypted: 1, failed: 0, liveTokens: 1 });
    const submit = chain.sent[1] as Extract<KeeperAction, { kind: "submitOutcome" }>;
    expect(submit).toMatchObject({ scheme: ZAMA, governor: RG, token: T1, scope: rotationPollScope(4n) });
    expect(decodeAbiParameters([{ type: "uint256" }], submit.cleartexts)).toEqual([1n]);
    // Only the winner's handle is ever decrypted.
    expect(decryptor.calls).toEqual([[rot.outcomeOfRound(T1, 4n)!.handle]]);
    expect(rot.roundOf(T1, 4n).status).toBe("Applied");

    const reads = rot.reads;
    await keeper.run();
    expect(chain.sent).toHaveLength(4);
    // Finished rounds are not read again: only the chain time, the token's rotation, the open
    // round 5 and the proposal count are.
    expect(rot.reads - reads).toBeLessThanOrEqual(4);
  });

  it("keeps following a closed round past the lookback until it is finalized", async () => {
    let outage = true;
    const { chain, rot, keeper, logs, advance } = setup({ preparer: false, decryptFail: () => (outage ? new Error("relayer down") : undefined) });
    // Round 3 got ballots; its winner cannot be decrypted for hours. Later rounds get no ballots.
    rot.openRound(T1, 3n, 2n, 1n);
    for (let i = 0; i < 36; i++) {
      await keeper.run();
      advance(300n);
    }
    // Rotation 7 now: the lookback (3 rounds) is [5, 8], round 3 is below it.
    expect(rot.current()).toBe(7n);
    expect(rot.roundOf(T1, 3n).status).toBe("Closed");
    expect(logs.filter((l) => l.msg === "keeper is following an unfinished round past its lookback")).toHaveLength(1);
    // A late finalize still applies the winner (no later round was applied), so it is driven.
    outage = false;
    for (let i = 0; i < 72 && rot.roundOf(T1, 3n).status !== "Applied"; i++) {
      await keeper.run();
      advance(300n);
    }
    expect(rot.roundOf(T1, 3n).status).toBe("Applied");
    expect(chain.sent.filter((a) => a.kind === "finalizeRound")).toEqual([{ kind: "finalizeRound", token: T1, target: 3n }]);
    const reads = rot.reads;
    await keeper.run();
    // No longer followed: chain time, rotation, rounds 5..8 and the proposal count.
    expect(rot.reads - reads).toBeLessThanOrEqual(7);
  });

  it("waits for voting to end before closing the current round", async () => {
    const { chain, rot, keeper, advance } = setup({ preparer: false });
    rot.openRound(T1, 5n, 2n, 0n);
    await keeper.run();
    expect(chain.sent).toEqual([]);
    advance(rot.window(5n).voteEnd - rot.now);
    await keeper.run();
    expect(kinds(chain.sent)).toEqual(["closeRound", "submitOutcome", "finalizeRound"]);
  });

  it("never closes an ended round without ballots, and below minVoters closes it without decrypting", async () => {
    const { chain, rot, keeper, decryptor } = setup({ preparer: false });
    rot.openRound(T1, 3n, 0n);
    rot.openRound(T1, 4n, 1n);
    rot.minVoters = 2n;
    await keeper.run();
    expect(chain.sent).toEqual([{ kind: "closeRound", token: T1, target: 4n }]);
    expect(rot.roundOf(T1, 3n).status).toBe("Open");
    expect(rot.roundOf(T1, 4n).status).toBe("NoChange");
    expect(decryptor.calls).toEqual([]);
  });

  it("does not decrypt a round opened on another scheme", async () => {
    const { chain, rot, keeper, decryptor } = setup({ preparer: false });
    rot.openRound(T1, 4n, 2n, 0n, OTHER_SCHEME);
    await keeper.run();
    expect(kinds(chain.sent)).toEqual(["closeRound"]);
    expect(decryptor.calls).toEqual([]);
  });

  it("plans the outcome submission without decrypting in a dry run", async () => {
    const { chain, rot, keeper, logs, decryptor } = setup({ preparer: false, dryRun: true });
    rot.openRound(T1, 4n, 2n, 0n);
    rot.apply({ kind: "closeRound", token: T1, target: 4n }, false);
    await keeper.run();
    expect(chain.sent).toEqual([]);
    expect(decryptor.calls).toEqual([]);
    expect(logs.some((l) => l.msg === "keeper dry run" && l.data?.tx === "submitOutcome")).toBe(true);
  });

  it("leaves weekly tokens alone and keeps the weekly keeper running", async () => {
    const { chain } = setup({ preparer: false });
    chain.register(T2);
    chain.openEpoch(T2, 9n, 0n);
    const k = createKeeper({
      reader: chain.reader(),
      writer: chain.writer(),
      decryptor: chain.decryptor(),
      tokens: async () => [T2],
      epochGovernor: EG,
      takeoverGovernor: TG,
      zamaScheme: ZAMA,
      dryRun: false,
      maxTxPerRun: 10,
      lookbackEpochs: 1,
      log: collectLogs().log,
      rotation: { governor: RG, reader: chain.rotation!.reader() },
    });
    const s = await k.run();
    expect(s.liveTokens).toBe(0);
    expect(kinds(chain.sent)).toEqual(["finalizeEpoch"]);
  });
});

describe("rotation keeper: limits", () => {
  it("counts round transactions against the per-run cap", async () => {
    const { chain, rot } = setup();
    rot.openRound(T1, 4n, 2n, 1n);
    const k = createKeeper({
      reader: chain.reader(),
      writer: chain.writer(),
      decryptor: chain.decryptor(),
      tokens: async () => [T1],
      epochGovernor: EG,
      takeoverGovernor: TG,
      zamaScheme: ZAMA,
      dryRun: false,
      maxTxPerRun: 2,
      lookbackEpochs: 0,
      log: collectLogs().log,
      rotation: { governor: RG, reader: rot.reader() },
    });
    const s = await k.run();
    expect(s.capped).toBe(true);
    expect(kinds(chain.sent)).toEqual(["closeRound", "submitOutcome"]);
  });
});

describe("planPeriodProposal", () => {
  const ctx = { rotationGovernor: RG, zamaScheme: ZAMA };
  const p = (over: Partial<PeriodProposalView>): PeriodProposalView => ({ token: T1, state: "Closed", scheme: ZAMA, executionDeadline: 1_000n, ...over });

  it("closes an ended proposal, decrypts its outcome, then executes it", () => {
    expect(planPeriodProposal(2n, p({ state: "Active" }), undefined, 10n, ctx)).toEqual({ type: "none", reason: "voting", terminal: false });
    expect(planPeriodProposal(2n, p({ state: "Ended" }), undefined, 10n, ctx)).toEqual({ type: "send", action: { kind: "closePeriodProposal", id: 2n } });
    expect(planPeriodProposal(2n, p({}), { isFinal: false, winner: 255 }, 10n, ctx)).toEqual({
      type: "decrypt",
      scheme: ZAMA,
      governor: RG,
      token: T1,
      scope: periodPollScope(2n),
      outcome: true,
    });
    expect(planPeriodProposal(2n, p({}), { isFinal: true, winner: 1 }, 10n, ctx)).toEqual({ type: "send", action: { kind: "executePeriodProposal", id: 2n } });
  });

  it("expires a closed proposal past its execution window, and is done with terminal ones", () => {
    expect(planPeriodProposal(2n, p({ scheme: OTHER_SCHEME }), { isFinal: false, winner: 255 }, 1_000n, ctx)).toMatchObject({ type: "none", terminal: false });
    expect(planPeriodProposal(2n, p({ scheme: OTHER_SCHEME }), { isFinal: false, winner: 255 }, 1_001n, ctx)).toEqual({
      type: "send",
      action: { kind: "executePeriodProposal", id: 2n },
    });
    for (const state of ["Defeated", "Executed", "Expired", "Canceled", "None"] as const) {
      expect(planPeriodProposal(2n, p({ state }), undefined, 10n, ctx)).toMatchObject({ type: "none", terminal: true });
    }
  });
});

describe("rotation keeper: period-change proposals", () => {
  it("closes a passed proposal, relays its decrypted outcome and executes it, once", async () => {
    const { chain, rot, keeper, decryptor, advance } = setup({ preparer: false });
    const id = rot.proposePeriod(T1, rot.now + 100n, 3n, 1n);
    let s = await keeper.run();
    expect(s.periodProposalsChecked).toBe(1);
    expect(chain.sent).toEqual([]);
    advance(100n);
    await keeper.run();
    expect(kinds(chain.sent)).toEqual(["closePeriodProposal", "submitOutcome", "executePeriodProposal"]);
    const submit = chain.sent[1] as Extract<KeeperAction, { kind: "submitOutcome" }>;
    expect(submit).toMatchObject({ governor: RG, token: T1, scope: periodPollScope(id) });
    expect(decryptor.calls).toEqual([[rot.outcomeOfPeriod(id)!.handle]]);
    expect(rot.periodState(id)).toBe("Executed");
    s = await keeper.run();
    expect(s.periodProposalsChecked).toBe(0);
    expect(chain.sent).toHaveLength(3);
  });

  it("closes a proposal below minVoters without decrypting", async () => {
    const { chain, rot, keeper, decryptor, advance } = setup({ preparer: false });
    rot.minVoters = 2n;
    const id = rot.proposePeriod(T1, rot.now + 100n, 1n);
    advance(100n);
    await keeper.run();
    expect(chain.sent).toEqual([{ kind: "closePeriodProposal", id }]);
    expect(rot.periodState(id)).toBe("Defeated");
    expect(decryptor.calls).toEqual([]);
  });

  it("expires a proposal on another scheme once its execution window ends", async () => {
    const { chain, rot, keeper, decryptor, advance } = setup({ preparer: false });
    const id = rot.proposePeriod(T1, rot.now + 100n, 2n, 1n, { executionWindow: 600n, scheme: OTHER_SCHEME });
    advance(100n);
    await keeper.run();
    expect(kinds(chain.sent)).toEqual(["closePeriodProposal"]);
    advance(600n);
    await keeper.run();
    expect(kinds(chain.sent)).toEqual(["closePeriodProposal"]);
    advance(1n);
    await keeper.run();
    expect(kinds(chain.sent)).toEqual(["closePeriodProposal", "executePeriodProposal"]);
    expect(rot.periodState(id)).toBe("Expired");
    expect(decryptor.calls).toEqual([]);
  });
});
