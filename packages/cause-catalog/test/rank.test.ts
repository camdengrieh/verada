import { describe, expect, it } from "vitest";
import { MAX_RANK, rankOrg } from "../src/rank.js";

const base = { claimed: false, donationsReceived: 0, description: null };

describe("rankOrg", () => {
  it("scores an empty listing 0 and treats missing fields as 0", () => {
    expect(rankOrg(base).rank).toBe(0);
    expect(rankOrg({ ...base, lifetimeContributionsUsdc: "not-a-number" }).rank).toBe(0);
  });

  it("caps at MAX_RANK (1000) when every signal saturates", () => {
    expect(MAX_RANK).toBe(1000);
    const r = rankOrg({
      claimed: true,
      donationsReceived: 1e6,
      description: "x",
      lifetimeContributionsUsdc: String(1e9 * 1e6),
      grantsReceived: 1e6,
      featuredIndex: 3,
      website: "https://x.org",
    });
    expect(r.rank).toBe(1000);
  });

  it("reads lifetimeContributionsUsdc as 6-decimal USDC and log-scales it", () => {
    const r = rankOrg({ ...base, lifetimeContributionsUsdc: "5700115908905" });
    expect(r.rankSignals.contributionsUsd).toBeCloseTo(5_700_115.9, 0);
    expect(r.rank).toBe(Math.round((450 * Math.log10(1 + 5_700_115.908905)) / 7));
  });

  it("weights a claimed profile above modest contributions", () => {
    const claimed = rankOrg({ ...base, claimed: true }).rank;
    const funded = rankOrg({ ...base, lifetimeContributionsUsdc: String(1000 * 1e6) }).rank;
    expect(claimed).toBe(200);
    expect(claimed).toBeGreaterThan(funded);
  });
});
