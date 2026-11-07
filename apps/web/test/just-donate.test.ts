import { describe, expect, it } from "vitest";
import type { AgentReport, AgentSummary } from "@/lib/agents";
import {
  chosenCauses,
  donateQueryString,
  heatWord,
  parseDonateQuery,
  placeList,
  rankTrending,
  splitAmount,
  trendingPicks,
} from "@/lib/just-donate";
import { landDots, lonDelta, projectFlat, projectGlobe, regionAt, regionPaths, REGION_CENTRES, MAP_REGIONS } from "@/lib/world-dots";

const VAULT = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

function agent(label: string, category: string, bit: number, over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    categoryBit: bit,
    category,
    name: label,
    label,
    ensName: `${label}.agent.varada.eth`,
    agentId: "1",
    signer: "",
    vault: VAULT(bit + 1),
    active: true,
    description: "",
    walletLinked: false,
    totals: null,
    latest: { epoch: "7", reportRef: "0x", catalogVersion: 1 },
    ...over,
  };
}

function report(a: AgentSummary, regions: Record<string, { weight: number; picks?: { orgId: string; name: string; score: number }[] }>): AgentReport {
  return {
    agent: a,
    epoch: "7",
    reportRef: "0x",
    catalogVersion: 1,
    title: "",
    intro: "",
    generatedAt: "",
    regions: Object.entries(regions).map(([region, r]) => ({
      region,
      regionBit: null,
      bucket: null,
      picksRoot: null,
      verified: true,
      weight: r.weight,
      summary: `${a.label} in ${region}`,
      events: [],
      newsletter: "",
      picks: (r.picks ?? []).map((p, i) => ({ rank: i, catalogIndex: i, reasons: "", sources: [], ...p })),
    })),
  };
}

const hunger = agent("hunger", "hunger", 2);
const water = agent("water", "clean-water", 9, { totals: { donated: "5000000", donations: 1, given: "0", gifts: 0 } });
const homeless = agent("homeless", "homelessness", 1);
const reports = new Map<string, AgentReport | null>([
  ["hunger", report(hunger, { africa: { weight: 8800, picks: [{ orgId: "0xA", name: "Food A", score: 90 }, { orgId: "0xB", name: "Food B", score: 50 }] }, europe: { weight: 1000 } })],
  ["water", report(water, { africa: { weight: 6000, picks: [{ orgId: "0xa", name: "Food A", score: 100 }] }, asia: { weight: 9000, picks: [{ orgId: "0xC", name: "Well C", score: 80 }] } })],
  ["homeless", null],
]);

describe("rankTrending", () => {
  it("ranks causes by their hottest weight in the picked regions", () => {
    const africa = rankTrending([homeless, water, hunger], reports, ["africa"]);
    expect(africa.map((t) => t.slug)).toEqual(["hunger", "clean-water", "homelessness"]);
    expect(africa[0]).toMatchObject({ weight: 8800, hottest: "africa", summary: "hunger in africa", epoch: "7" });
    expect(africa[2]).toMatchObject({ weight: 0, hottest: null });
  });

  it("reads every region when none is picked", () => {
    expect(rankTrending([hunger, water], reports, []).map((t) => [t.slug, t.hottest])).toEqual([
      ["clean-water", "asia"],
      ["hunger", "africa"],
    ]);
  });

  it("breaks ties by what the vault received, and drops agents that cannot take a gift", () => {
    const paused = agent("disaster", "disaster-relief", 0, { active: false });
    const noVault = agent("children", "children-youth", 3, { vault: "" });
    const out = rankTrending([homeless, water, paused, noVault], new Map(), ["oceania"]);
    expect(out.map((t) => t.slug)).toEqual(["clean-water", "homelessness"]);
  });
});

describe("trendingPicks", () => {
  it("keeps each charity once, at its hottest, ordered by weight times score", () => {
    const trends = rankTrending([hunger, water], reports, ["africa"]);
    const picks = trendingPicks(trends, reports, ["africa"]);
    expect(picks.map((p) => [p.name, p.heat, p.agentLabel])).toEqual([
      ["Food A", 7920, "hunger"],
      ["Food B", 4400, "hunger"],
    ]);
    expect(trendingPicks(trends, reports, [], 1).map((p) => p.name)).toEqual(["Food A"]);
  });
});

describe("chosenCauses and splitAmount", () => {
  const trends = rankTrending([hunger, water, homeless], reports, ["africa"]);
  it("defaults to the hottest cause and keeps the visitor's order, capped at three", () => {
    expect(chosenCauses(trends, []).map((t) => t.slug)).toEqual(["hunger"]);
    expect(chosenCauses(trends, ["homelessness", "unknown", "hunger", "homelessness"]).map((t) => t.slug)).toEqual(["homelessness", "hunger"]);
  });
  it("splits exactly, the remainder going to the first causes", () => {
    expect(splitAmount(10_000_001n, 3)).toEqual([3_333_334n, 3_333_334n, 3_333_333n]);
    expect(splitAmount(25_000_000n, 1)).toEqual([25_000_000n]);
    expect(splitAmount(0n, 2)).toEqual([]);
    expect(splitAmount(5n, 0)).toEqual([]);
  });
});

describe("donate query", () => {
  it("round-trips known slugs and a numeric amount", () => {
    const q = parseDonateQuery("?amount=12.5&region=africa,global,mars,asia&cause=hunger,nope,clean-water,education,poverty");
    expect(q).toEqual({ amount: "12.5", regions: ["africa", "asia"], causes: ["hunger", "clean-water", "education"] });
    expect(donateQueryString(q)).toBe("?amount=12.5&region=africa%2Casia&cause=hunger%2Cclean-water%2Ceducation");
    expect(parseDonateQuery("?amount=1e9").amount).toBe("");
    expect(donateQueryString({ amount: "", regions: [], causes: [] })).toBe("");
  });

  it("names places and heat", () => {
    expect(placeList([])).toBe("everywhere");
    expect(placeList(["africa", "asia", "middle-east"])).toBe("Africa, Asia and Middle East");
    expect([9000, 5000, 10, 0].map(heatWord)).toEqual(["Urgent", "Rising", "Steady", "Quiet"]);
  });
});

describe("world dots", () => {
  it("draws each region where it is", () => {
    expect(regionAt(20, 5)).toBe("africa");
    expect(regionAt(-100, 40)).toBe("north-america");
    expect(regionAt(-102, 23)).toBe("latin-america");
    expect(regionAt(-55, -10)).toBe("latin-america");
    expect(regionAt(10, 50)).toBe("europe");
    expect(regionAt(45, 24)).toBe("middle-east");
    expect(regionAt(100, 40)).toBe("asia");
    expect(regionAt(135, -25)).toBe("oceania");
    expect(regionAt(-30, 0)).toBeNull();
    expect(regionAt(-150, 20)).toBeNull();
    for (const r of MAP_REGIONS) expect(regionAt(...REGION_CENTRES[r])).toBe(r);
  });

  it("samples every region and projects the near side only", () => {
    const dots = landDots();
    for (const r of MAP_REGIONS) expect(dots.some((d) => d.region === r)).toBe(true);
    const v = { lon: 20, lat: 0, r: 100, cx: 100, cy: 100 };
    expect(projectGlobe(20, 0, v)).toEqual([100, 100]);
    expect(projectGlobe(-160, 0, v)).toBeNull();
    expect(projectFlat(-180, 84, 720, 284)).toEqual([0, 0]);
    const paths = regionPaths(dots, (lon, lat) => projectGlobe(lon, lat, v));
    expect(paths.africa).toMatch(/^M[\d.]+ [\d.]+h0/);
    expect(paths.oceania).toBe("");
  });

  it("turns the short way round", () => {
    expect(lonDelta(170, -170)).toBe(20);
    expect(lonDelta(-170, 170)).toBe(-20);
    expect(lonDelta(0, 180)).toBe(180);
  });
});
