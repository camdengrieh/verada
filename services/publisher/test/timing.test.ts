import { describe, expect, it } from "vitest";
import { Backoff } from "../src/keeper/backoff.js";
import { createKeeper } from "../src/keeper/keeper.js";
import { checkTiming } from "../src/keeper/timing.js";
import { collectLogs, EG, EPOCH_ZERO, FakeChain, TG, token, ZAMA } from "./keeper-fakes.js";
import type { KeeperTiming } from "../src/keeper/chain.js";

const T1 = token(1);
const MIN = 60n;
const window = (length: bigint, votingWindow: bigint, epoch = 10n) => {
  const start = EPOCH_ZERO + epoch * length;
  return { epoch, start, end: start + length, votingOpensAt: start + length - votingWindow, length, votingWindow, holdWindow: length };
};
const timing = (length: bigint, votingWindow: bigint, o: Partial<KeeperTiming> = {}): KeeperTiming => {
  const w = window(length, votingWindow);
  return { now: w.start + 600n, window: w, tallyGrace: 14n * 86_400n, settleGrace: 7n * 86_400n, ...o };
};

describe("checkTiming", () => {
  it("is quiet for the weekly default", () => {
    const r = checkTiming(timing(604_800n, 604_800n), { intervalSeconds: 300, lookbackEpochs: 4 });
    expect(r.warnings).toEqual([]);
    expect(r.summary).toMatchObject({ phase: "voting", epochLengthSeconds: 604_800, tradingSeconds: 0, votingWindowSeconds: 604_800, secondsToNextPhase: 604_200 });
  });

  it("reads a 45 minute cycle: 30 minutes of trading, then 15 of voting", () => {
    const t = timing(45n * MIN, 15n * MIN);
    const r = checkTiming(t, { intervalSeconds: 300, lookbackEpochs: 4 });
    expect(r.summary).toMatchObject({ phase: "trading", epochLengthSeconds: 2700, votingWindowSeconds: 900, tradingSeconds: 1800, secondsToNextPhase: 1200 });
    const voting = checkTiming({ ...t, now: t.window.votingOpensAt + 1n }, { intervalSeconds: 300, lookbackEpochs: 4 });
    expect(voting.summary).toMatchObject({ phase: "voting", secondsToNextPhase: 899 });
    // A 5 minute interval is fine against 30 minutes of trading: only the lookback is short.
    expect(r.warnings.map((w) => w.msg)).toEqual([expect.stringContaining("KEEPER_LOOKBACK_EPOCHS")]);
    expect(r.warnings[0]!.data).toMatchObject({ lookbackSeconds: 10_800, graceStillOpen: ["tallyGrace", "settleGrace"] });
  });

  it("is quiet when the lookback spans the graces", () => {
    const t = timing(45n * MIN, 15n * MIN, { tallyGrace: 30n * MIN, settleGrace: 20n * MIN });
    // 8 epochs = 6 hours.
    expect(checkTiming(t, { intervalSeconds: 120, lookbackEpochs: 8 }).warnings).toEqual([]);
    expect(checkTiming(t, { intervalSeconds: 120, lookbackEpochs: 7 }).warnings).toHaveLength(1);
  });

  it("warns when the interval is more than half the time before voting opens", () => {
    const r = checkTiming(timing(45n * MIN, 15n * MIN, { tallyGrace: 600n, settleGrace: 600n }), { intervalSeconds: 1200, lookbackEpochs: 16 });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.data).toMatchObject({ intervalSeconds: 1200, secondsBeforeVotingOpens: 1800, recommendedIntervalSeconds: 450 });
    // Voting open all epoch: the lead time is the epoch.
    const whole = checkTiming(timing(45n * MIN, 45n * MIN, { tallyGrace: 600n, settleGrace: 600n }), { intervalSeconds: 1800, lookbackEpochs: 16 });
    expect(whole.warnings[0]!.data).toMatchObject({ secondsBeforeVotingOpens: 2700 });
  });

  it("keys warnings by the settings they depend on", () => {
    const a = checkTiming(timing(2700n, 900n), { intervalSeconds: 300, lookbackEpochs: 4 });
    const b = checkTiming(timing(2700n, 900n), { intervalSeconds: 300, lookbackEpochs: 4 });
    const c = checkTiming(timing(2700n, 900n), { intervalSeconds: 60, lookbackEpochs: 4 });
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });
});

describe("keeper on a 45 minute epoch with a 5 minute interval", () => {
  function setup(chain: FakeChain, over: { intervalSeconds?: number; lookbackEpochs?: number } = {}) {
    const { logs, log } = collectLogs();
    const keeper = createKeeper({
      reader: chain.reader(),
      writer: chain.writer(),
      decryptor: chain.decryptor(),
      tokens: async () => [T1],
      epochGovernor: EG,
      takeoverGovernor: TG,
      zamaScheme: ZAMA,
      dryRun: false,
      maxTxPerRun: 10,
      lookbackEpochs: over.lookbackEpochs ?? 4,
      intervalSeconds: over.intervalSeconds ?? 300,
      log,
      backoff: new Backoff({ baseMs: 300_000, maxMs: 600_000 }),
    });
    return { keeper, logs };
  }

  it("takes the schedule from the chain, reports it and warns once per schedule", async () => {
    const chain = new FakeChain().register(T1).shortCycle(30n * MIN, 15n * MIN);
    chain.timingEnabled = true;
    const { keeper, logs } = setup(chain);
    const s1 = await keeper.run();
    expect(s1.timing).toMatchObject({ epochLengthSeconds: 2700, votingWindowSeconds: 900, tradingSeconds: 1800, phase: "trading" });
    await keeper.run();
    expect(logs.filter((l) => l.msg === "keeper epoch schedule")).toHaveLength(1);
    expect(logs.filter((l) => l.level === "warn" && String(l.msg).includes("KEEPER_LOOKBACK_EPOCHS"))).toHaveLength(1);
    // The schedule changes (the owner lengthened the epoch): reported again.
    chain.shortCycle(60n * MIN, 30n * MIN);
    await keeper.run();
    expect(logs.filter((l) => l.msg === "keeper epoch schedule")).toHaveLength(2);
  });

  it("finishes an ended 45 minute epoch (close, decrypt, submit, finalize) in the first run after it ends", async () => {
    const chain = new FakeChain().register(T1).shortCycle(30n * MIN, 15n * MIN);
    chain.timingEnabled = true;
    chain.current = 120n;
    chain.openEpoch(T1, 119n, 2n, [3n, 7n]);
    for (const e of [116n, 117n, 118n]) chain.epochOf(T1, e).finalized = true;
    const { keeper } = setup(chain);
    const s = await keeper.run();
    expect(chain.sent.map((a) => a.kind)).toEqual(["closeEpoch", "submitTally", "finalizeEpoch"]);
    expect(s).toMatchObject({ txs: 3, decrypted: 1, failed: 0 });
    expect(chain.epochOf(T1, 119n).finalized).toBe(true);
  });

  it("keeps working when the schedule cannot be read, and says so once", async () => {
    const chain = new FakeChain().register(T1);
    chain.timingEnabled = true;
    chain.timingError = new Error("rpc down");
    chain.openEpoch(T1, 9n, 1n, [1n, 0n]);
    for (const e of [6n, 7n, 8n]) chain.epochOf(T1, e).finalized = true;
    const { keeper, logs } = setup(chain);
    const s = await keeper.run();
    expect(s.timing).toBeUndefined();
    expect(chain.epochOf(T1, 9n).finalized).toBe(true);
    await keeper.run();
    expect(logs.filter((l) => l.msg.includes("could not read the epoch schedule"))).toHaveLength(1);
  });
});
