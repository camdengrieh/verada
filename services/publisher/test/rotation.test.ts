import { buildReport, pickProof, type BuiltRegion } from "@verada/curator";
import { BUCKET_COUNT, bucketId, categoryMaskOf, causeIdOfOrg, drawIndex, planRotation, regionMaskOf, rotationPollScope } from "@verada/sdk";
import { decodeAbiParameters, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { Backoff } from "../src/keeper/backoff.js";
import { createRoundPreparer, type CatalogEntrySource, type PickSource, type RoundReader } from "../src/keeper/ballot.js";
import type { KeeperAction, RoundView } from "../src/keeper/chain.js";
import { createKeeper } from "../src/keeper/keeper.js";
import { planRound } from "../src/keeper/plan.js";
import { collectLogs, EG, FakeChain, FakeRotation, OTHER_SCHEME, RG, TG, token, ZAMA } from "./keeper-fakes.js";

const T1 = token(1);
/** A weekly token: listed like any other, never registered with the rotation governor. */
const T2 = token(2);
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
    schema: "verada.curation/v1",
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

function setup(opts: { over?: Partial<RoundReader>; picks?: PickSource; preparer?: boolean; dryRun?: boolean } = {}) {
  const chain = new FakeChain();
  const rot = new FakeRotation().register(T1);
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
  const decryptor = chain.decryptor();
  const keeper = createKeeper({
    reader: chain.reader(),
    writer: chain.writer(),
    decryptor,
    tokens: async () => [T1, T2],
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
  return { chain, rot, keeper, logs, backoff, advance, isRegistered, decryptor };
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
    // Live registration is read once; a weekly token is re-checked each run.
    expect(isRegistered.mock.calls.filter(([t]) => t === T1)).toHaveLength(1);
    expect(isRegistered.mock.calls.filter(([t]) => t === T2)).toHaveLength(2);
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

  it("backs off until the curation grace ends when picks are missing, then prepares with rotation only", async () => {
    const { chain, rot, keeper, logs, backoff, advance } = setup({ over: { curationsFor: async () => onChain }, picks: picks({ asia: null }) });
    rot.curatedUntilGrace = true;
    const w = rot.window(5n);
    const retryAt = Number(w.graceEnd) * 1000 + 30_000;
    expect(w.graceEnd - w.voteStart).toBe(900n); // hourly: a 15-minute grace

    // One minute into the vote window: the base backoff (5 minutes) is shorter than the grace.
    const s1 = await keeper.run();
    expect(s1.failed).toBe(1);
    expect(chain.sent).toEqual([]);
    const fail1 = logs.find((l) => l.msg === "keeper step failed")!;
    expect(fail1.data).toMatchObject({ token: T1, round: 5n, op: "read", retryInSeconds: 300 });
    expect(String(fail1.data!.error)).toMatch(/CuratedPicksUnavailable/);
    expect(backoff.blocked(`round:${T1.toLowerCase()}:5`)).toBe(true);

    // Still blocked a second before the backoff ends.
    advance(299n);
    expect((await keeper.run()).backedOff).toBe(1);

    // The doubled backoff (10 minutes) is capped at the grace end plus 30 seconds.
    advance(1n);
    await keeper.run();
    const fail2 = logs.filter((l) => l.msg === "keeper step failed")[1]!;
    const nowMs = Number(rot.now) * 1000;
    expect(fail2.data).toMatchObject({ failures: 2, retryInSeconds: Math.round((retryAt - nowMs) / 1000) });
    expect(fail2.data!.retryInSeconds).toBe(570);
    advance(569n);
    expect((await keeper.run()).backedOff).toBe(1);
    expect(chain.sent).toEqual([]);

    // Grace over: prepared with rotation draws only, which the builder accepts from then.
    advance(1n);
    expect(rot.now * 1000n).toBe(BigInt(retryAt));
    await keeper.run();
    expect(kinds(chain.sent)).toEqual(["prepareRound"]);
    const a = chain.sent[0] as Extract<KeeperAction, { kind: "prepareRound" }>;
    expect(a.draws.map((d) => d.orgId)).toEqual((await rotationOnly(5n)).draws.map((d) => d.orgId));
    expect(rot.roundOf(T1, 5n).status).toBe("Open");
  });

  it("uses the picks when they turn up during the grace", async () => {
    let published = false;
    const src: PickSource = { picks: async (label, epoch, region) => (published ? picks().picks(label, epoch, region) : null) };
    const { chain, rot, keeper, advance } = setup({ over: { curationsFor: async () => onChain }, picks: src });
    rot.curatedUntilGrace = true;
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
    // Finished rounds are not read again; only the open round 5 and the token's rotation are.
    expect(rot.reads - reads).toBeLessThanOrEqual(4);
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
