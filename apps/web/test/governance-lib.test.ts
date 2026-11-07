import { describe, expect, it } from "vitest";
import {
  ballotMakeup,
  causeLeaderboard,
  causeNameForSlug,
  donationTimeline,
  epochStatus,
  formatWeight,
  loadEpochClock,
  loadHistory,
  loadTokenEpochs,
  optionSources,
  orgCause,
  orgRegionLabel,
  pickIndex,
  tallyResults,
  toBallotOptions,
  toFinalizedEpoch,
  toPoolDonation,
  tokenLogoUrl,
  usdcToUsd,
} from "@/lib/governance";
import { causeIdOfOrg } from "@varada/sdk";
import type { ActivityItem, CatalogOrg } from "@/lib/indexer";

const id = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
const org = (over: Partial<CatalogOrg> = {}): CatalogOrg => ({ orgId: id(9), causeId: id(1), ein: null, name: "Alpha", country: null, state: null, nteeCode: null, categories: ["homelessness"], regions: ["africa"], label: null, ethOrgId: null, ...over });

describe("cause and region labels", () => {
  it("maps catalogue slugs to the library's cause names", () => {
    expect(causeNameForSlug("disaster-relief")).toBe("disaster");
    expect(causeNameForSlug("homelessness")).toBe("homeless");
    expect(causeNameForSlug("cancer-research")).toBe("cancer");
    expect(causeNameForSlug("nope")).toBe("other");
    expect(causeNameForSlug(undefined)).toBe("other");
  });

  it("prefers a category inside the token's focus", () => {
    const o = org({ categories: ["hunger", "homelessness"] });
    expect(orgCause(o)).toBe("hunger");
    expect(orgCause(o, { categories: ["homelessness"] })).toBe("homeless");
    expect(orgCause(undefined)).toBe("other");
  });

  it("names an org's region", () => {
    expect(orgRegionLabel(org())).toBe("Africa");
    expect(orgRegionLabel(org({ regions: ["asia", "europe", "oceania"] }))).toBe("Asia + 2 more");
    expect(orgRegionLabel(org({ regions: [] }))).toBe("Global");
  });
});

describe("ballot options", () => {
  it("builds library options with names, categories, sources and curator scores", () => {
    const orgs = new Map([[id(1), org()], [id(2), org({ causeId: id(2), name: "Beta", categories: ["hunger"], regions: ["asia"] })]]);
    const opts = toBallotOptions({
      options: [id(1), id(2), id(3)],
      sources: ["pinned", "curated", null],
      orgs,
      causes: new Map([[id(3), { name: "Registry Name" }]]),
      scores: new Map([[id(2), 88], [id(1), 70]]),
    });
    expect(opts).toEqual([
      { id: "0", org: "Alpha", category: "homeless", region: "Africa", source: "pinned" },
      { id: "1", org: "Beta", category: "hunger", region: "Asia", source: "curated", score: "88/100" },
      // Unknown source is listed under Rotation; names fall back to the registry.
      { id: "2", org: "Registry Name", category: "other", region: "Global", source: "rotation" },
    ]);
  });

  it("shortens an id while its name is unknown", () => {
    const [o] = toBallotOptions({ options: [id(7)], sources: ["rotation"] });
    expect(o!.org).toMatch(/^0x070707…0707$/);
  });

  it("derives sources: pins before the ballot is prepared, indexer sources after", () => {
    expect(optionSources(false, ["a", "b"], null)).toEqual(["pinned", "pinned"]);
    expect(optionSources(true, ["a", "b"], { optionSources: ["pinned", "rotation"] })).toEqual(["pinned", "rotation"]);
    expect(optionSources(true, ["a", "b"], { optionSources: ["pinned"] })).toEqual([null, null]);
    expect(optionSources(true, ["a"], null)).toEqual([null]);
  });

  it("states the makeup only when every source is known", () => {
    expect(ballotMakeup(["pinned", "curated", "rotation", "rotation"])).toBe("1 pinned, 1 curated, 2 rotation");
    expect(ballotMakeup(["pinned", null])).toBeNull();
    expect(ballotMakeup([])).toBeNull();
  });
});

describe("epoch status", () => {
  const now = 1_000_000;
  const poll = (over = {}) => ({ opened: true, closed: false, isFinal: false, optionCount: 2, counts: null, ballotCount: 0, ...over });
  it("walks from unopened to finalized", () => {
    expect(epochStatus(null, now).phase).toBe("unopened");
    expect(epochStatus({ prepared: false, poll: null }, now).phase).toBe("unopened");
    expect(epochStatus({ prepared: true, poll: poll(), end: now + 10 }, now).phase).toBe("open");
    expect(epochStatus({ prepared: true, poll: poll(), end: now - 1 }, now).phase).toBe("counting");
    expect(epochStatus({ prepared: true, poll: poll({ closed: true }), end: now + 10 }, now).phase).toBe("counting");
    expect(epochStatus({ prepared: true, poll: poll({ closed: true, isFinal: true }) }, now).phase).toBe("tallied");
    expect(epochStatus({ prepared: true, poll: poll(), finalized: true }, now).phase).toBe("finalized");
  });
});

describe("tally results", () => {
  it("shares and the leader, in ballot order", () => {
    const rows = tallyResults(["a", "b", "c"], ["25", "70", "5"])!;
    expect(rows.map((r) => r.share)).toEqual([25, 70, 5]);
    expect(rows.map((r) => r.leader)).toEqual([false, true, false]);
  });
  it("has no leader when nobody voted, and no rows without counts", () => {
    expect(tallyResults(["a", "b"], ["0", "0"])!.every((r) => !r.leader && r.share === 0)).toBe(true);
    expect(tallyResults(["a"], null)).toBeNull();
    expect(tallyResults(["a"], [])).toBeNull();
  });
});

describe("formatting", () => {
  it("compacts big weights and converts USDC", () => {
    expect(formatWeight(125n)).toBe("125");
    expect(formatWeight(38_900_000n)).toBe("38.9M");
    expect(usdcToUsd("2500000000")).toBe(2500);
    expect(usdcToUsd("1500000")).toBe(1.5);
    expect(usdcToUsd("junk")).toBe(0);
  });
  it("builds a logo URL only for a real reference", () => {
    expect(tokenLogoUrl(undefined, `0x${"ab".repeat(32)}`)).toBeNull();
    expect(tokenLogoUrl("https://gw.example", `0x${"0".repeat(64)}`)).toBeNull();
    expect(tokenLogoUrl("https://gw.example", `0x${"ab".repeat(32)}`)).toContain("https://gw.example/bzz/");
  });
});

describe("clock and loaders", () => {
  it("reads the current epoch and its week", async () => {
    const readContract = async ({ functionName }: { functionName: string }) => (functionName === "currentEpoch" ? 5n : 1_000_000n);
    const clock = await loadEpochClock({ governorAddress: "0x00000000000000000000000000000000000000d1" }, { chain: () => ({ readContract }) as never });
    expect(clock).toEqual({ epoch: 5n, start: 1_000_000, end: 1_604_800 });
    await expect(loadEpochClock({}, { chain: () => ({}) as never })).rejects.toThrow(/Governor address/);
  });

  it("loads every token's epoch with a concurrency cap and marks failures", async () => {
    let active = 0;
    let peak = 0;
    const tokens = Array.from({ length: 10 }, (_, i) => ({ address: `0x${i}` }));
    const indexer = {
      epochDetail: async (t: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
        if (t === "0x3") throw new Error("down");
        return t === "0x4" ? null : ({ epoch: "5" } as never);
      },
    };
    const rows = await loadTokenEpochs({ indexer: indexer as never }, tokens, 5n, 3);
    expect(peak).toBeLessThanOrEqual(3);
    expect(rows[3]).toMatchObject({ failed: true, detail: null });
    expect(rows[4]).toMatchObject({ failed: false, detail: null });
    expect(rows[0]!.detail).toEqual({ epoch: "5" });
  });
});

describe("history", () => {
  const T = "0x00000000000000000000000000000000000000a1";
  const epochItem: ActivityItem = { id: "epoch:1", kind: "epoch", token: T, timestamp: 100, data: { epoch: "4", winningCauseId: id(1), voteCount: 7, donatedAmount: "2500000000", donatedAt: "120" } };
  const donationItem: ActivityItem = { id: "donation:1", kind: "donation", token: T, timestamp: 120, txHash: `0x${"cd".repeat(32)}`, data: { epoch: "4", causeId: id(1), payout: "0xe1", amount: "2500000000" } };

  it("maps feed items and ignores other kinds", () => {
    expect(toFinalizedEpoch(epochItem)).toMatchObject({ epoch: "4", winningCauseId: id(1), voteCount: 7, donatedAmount: "2500000000", donatedAt: 120 });
    expect(toFinalizedEpoch({ ...epochItem, data: { ...epochItem.data, winningCauseId: `0x${"0".repeat(64)}` } })!.winningCauseId).toBeNull();
    expect(toFinalizedEpoch(donationItem)).toBeNull();
    expect(toPoolDonation(donationItem)).toMatchObject({ causeId: id(1), amount: "2500000000" });
    expect(toPoolDonation(epochItem)).toBeNull();
  });

  it("loads both feeds", async () => {
    const calls: unknown[] = [];
    const indexer = { activity: async (q: { kind: string }) => (calls.push(q), { items: q.kind === "epoch" ? [epochItem] : [donationItem], nextCursor: null }) };
    const h = await loadHistory({ indexer: indexer as never });
    expect(h.epochs).toHaveLength(1);
    expect(h.donations).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("builds the timeline and leaderboard from payouts", () => {
    const labels = { cause: () => ({ name: "Alpha", category: "homeless" as const }), token: () => "$HAR" };
    const d = [toPoolDonation(donationItem)!, { ...toPoolDonation(donationItem)!, id: "d2", amount: "500000000", timestamp: 90 }, { ...toPoolDonation(donationItem)!, id: "d3", amount: "0" }];
    const tl = donationTimeline(d, labels, 1);
    expect(tl.map((x) => x.id)).toEqual(["donation:1", "d2"]);
    expect(tl[0]).toMatchObject({ org: "Alpha", amount: 2500, coin: "$HAR", via: "pool", at: 120_000 });
    expect(tl[0]!.txHref).toContain("etherscan.io/tx/");
    expect(causeLeaderboard(d, labels)).toEqual([{ id: id(1), name: "Alpha", cause: "homeless", raised: 3000 }]);
  });
});

describe("curator pick index", () => {
  it("keys picks by cause id and keeps the best score across agents", () => {
    const orgId = id(9);
    const pick = (score: number) => ({ rank: 0, orgId, catalogIndex: 0, name: "x", score, reasons: "", sources: [] });
    const region = (score: number) => ({ regions: [{ region: "africa", picks: [pick(score)] }] }) as never;
    const idx = pickIndex([{ agent: "hunger", report: region(70) }, { agent: "water", report: region(90) }, { agent: "x", report: null }]);
    expect(idx.get(causeIdOfOrg(orgId as `0x${string}`).toLowerCase())).toEqual({ score: 90, agent: "water" });
  });
});
