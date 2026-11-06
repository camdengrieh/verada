import { describe, expect, it } from "vitest";
import {
  agentLabelOfSlug,
  causeNameOfSlug,
  causesQueryString,
  fetchCauseLeaderboard,
  parseCausesQuery,
  toLeaderboardPage,
  usdcToNumber,
} from "@/lib/causes-client";
import { IndexerError } from "@/lib/indexer";

describe("category slugs", () => {
  it("maps SDK slugs to UI cause names through the agent label", () => {
    expect(causeNameOfSlug("homelessness")).toBe("homeless");
    expect(causeNameOfSlug("hunger")).toBe("hunger");
    expect(causeNameOfSlug("something-new")).toBe("other");
    expect(agentLabelOfSlug("homelessness")).toBe("homeless");
    expect(agentLabelOfSlug("other")).toBeUndefined();
  });
});

describe("causes query string", () => {
  it("round-trips filters and drops unknown slugs", () => {
    const s = parseCausesQuery("?category=hunger,nope,hunger&region=africa&q=water");
    expect(s).toEqual({ q: "water", categories: ["hunger"], regions: ["africa"] });
    expect(causesQueryString(s)).toBe("?q=water&category=hunger&region=africa");
    expect(causesQueryString({ q: " ", categories: [], regions: [] })).toBe("");
  });
});

describe("leaderboard mapper", () => {
  const body = {
    totals: { causes: 2, donations: 5, donated: "7000000" },
    items: [
      { rank: 1, causeId: "0xaa", donated: "5000000", donations: 3, tokens: 2, org: { orgId: "0x1", name: "Food Bank", ein: "12-3456789", country: "USA", categories: ["hunger"], regions: ["global"] } },
      { rank: 2, causeId: "0xbb", donated: "2000000", donations: 2, tokens: 1, org: null },
      { nope: true },
    ],
    byCategory: [{ slug: "hunger", donated: "5000000", donations: 3, causes: 1 }],
    nextCursor: "c2",
  };
  it("keeps bigint amounts and tolerates unknown orgs", () => {
    const p = toLeaderboardPage(body)!;
    expect(p.totals.donated).toBe(7_000_000n);
    expect(p.items).toHaveLength(2);
    expect(p.items[1]!.org).toBeNull();
    expect(p.byCategory[0]).toMatchObject({ slug: "hunger", donated: 5_000_000n });
    expect(p.nextCursor).toBe("c2");
    expect(usdcToNumber(p.items[0]!.donated)).toBe(5);
    expect(toLeaderboardPage("nope")).toBeNull();
  });
  it("returns null when the indexer has no totals route", async () => {
    const client = { get: async () => { throw new IndexerError("x", 503); } };
    expect(await fetchCauseLeaderboard(client)).toBeNull();
    const boom = { get: async () => { throw new IndexerError("x", 400); } };
    await expect(fetchCauseLeaderboard(boom)).rejects.toThrow();
  });
});
