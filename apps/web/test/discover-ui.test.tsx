import { describe, expect, it, vi } from "vitest";
import { platformTotals } from "@/lib/platform-stats";
import { activeFilterCount, fromFilterValue, toFilterValue } from "@/components/discover/filters";
import { DEFAULT_STATE } from "@/lib/discover";

// hero.tsx imports the providers and the asset manifest; only the pure stat mapping is under test.
vi.mock("@/components/providers", () => ({ useAppConfig: () => ({ ensParentName: "varada.eth" }), useDeps: () => ({}), usePrivacyPrefs: () => [{}, () => undefined] }));

describe("platformTotals", () => {
  it("adds the weekly pools and the live cause share, in dollars", () => {
    expect(platformTotals({ tokens: 24, causeFees: "48210000000", liveCauseShare: "6400000000", donations: 63, liveDonations: 12, causes: 20 })).toEqual({
      raisedUsd: 54_610,
      tokens: 24,
      donations: 75,
      causes: 20,
    });
  });
  it("works against an older indexer without live fields", () => {
    expect(platformTotals({ tokens: 3, causeFees: "90000000", donations: 1, causes: 1 })).toMatchObject({ raisedUsd: 90, donations: 1 });
  });
  it("is null when there is no stats object", () => {
    expect(platformTotals(undefined)).toBeNull();
    expect(platformTotals({})).toBeNull();
  });
});

describe("hero stats", () => {
  it("counts up when the indexer answered and shows dashes when it did not", async () => {
    const { heroStats } = await import("@/components/discover/hero");
    const ok = heroStats({ raisedUsd: 10, tokens: 2, donations: 3, causes: 1 });
    expect(ok.map((s) => s.value)).toEqual([10, 2, 3]);
    expect(ok[0]?.live).toBe(true);
    const down = heroStats(null);
    expect(down.map((s) => s.value)).toEqual(["–", "–", "–"]);
    expect(down[0]?.live).toBe(false);
  });
});

describe("filter sheet mapping", () => {
  it("round-trips the state and counts what is set on top of the tab", () => {
    const state = { ...DEFAULT_STATE, pair: "NVDAon", category: "hunger", region: null, mode: "weekly" as const };
    expect(toFilterValue(state)).toEqual({ pair: ["NVDAon"], cause: ["hunger"], region: ["all"], mode: ["weekly"] });
    expect(fromFilterValue(toFilterValue(state))).toEqual({ pair: "NVDAon", category: "hunger", region: null, mode: "weekly" });
    expect(activeFilterCount(state)).toBe(3);
    expect(activeFilterCount(DEFAULT_STATE)).toBe(0);
  });
  it("treats All as no filter and ignores unknown modes", () => {
    expect(fromFilterValue({ pair: ["all"], cause: ["all"], region: ["asia"], mode: ["bogus"] })).toEqual({ pair: null, category: null, region: "asia", mode: null });
  });
});
