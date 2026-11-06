import { buildCatalog, type HarvestedOrg } from "@varada/cause-catalog";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { catalogStoreOf } from "../src/api/catalog";
import { type CauseTotalRow, mergeCauseTotals, rankCauseTotals, totalsByCategory } from "../src/api/cause-totals";
import { readApiConfig } from "../src/api/config";
import { createApi } from "../src/api/routes";
import type { Repo } from "../src/api/types";

declare global {
  interface Response {
    // biome-ignore lint/suspicious/noExplicitAny: test convenience for JSON bodies
    json(): Promise<any>;
  }
}

const org = (i: number, over: Partial<HarvestedOrg> = {}): HarvestedOrg => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  ein: String(400000000 + i),
  name: `Org ${i}`,
  description: null,
  nteeCode: "K31",
  country: "USA",
  state: "NY",
  isCompliant: true,
  claimed: false,
  donationsReceived: 0,
  mainnetAddress: "0x000000000000000000000000000000000000beef",
  ...over,
});
const { catalog } = buildCatalog([org(1, { name: "City Food Bank" }), org(2, { name: "Rhino Rescue", nteeCode: "D31", country: "ZAF" }), org(3, { name: "Shelter House", nteeCode: "L41" })]);
const [food, rhino, shelter] = catalog.orgs.map((o) => o.causeId as Hex);
const unknown = `0x${"ab".repeat(32)}` as Hex;

const weekly: CauseTotalRow[] = [
  { causeId: food!, donated: 5_000_000n, donations: 1, tokens: 1 },
  { causeId: rhino!, donated: 2_000_000n, donations: 2, tokens: 1 },
];
const live: CauseTotalRow[] = [
  { causeId: food!.toUpperCase().replace("0X", "0x") as Hex, donated: 1_000_000n, donations: 4, tokens: 2 },
  { causeId: shelter!, donated: 9_000_000n, donations: 3, tokens: 1 },
  { causeId: unknown, donated: 1n, donations: 1, tokens: 1 },
];

describe("cause totals", () => {
  it("merges weekly and live gifts per cause, case-insensitively", () => {
    const m = mergeCauseTotals(weekly, live);
    expect(m).toHaveLength(4);
    expect(m.find((r) => r.causeId === food)).toMatchObject({ donated: 6_000_000n, donations: 5, tokens: 3 });
  });

  it("ranks by donated with a stable tie-break", () => {
    const ranked = rankCauseTotals([
      { causeId: "0x02" as Hex, donated: 5n, donations: 1, tokens: 1 },
      { causeId: "0x01" as Hex, donated: 5n, donations: 1, tokens: 1 },
      { causeId: "0x03" as Hex, donated: 9n, donations: 1, tokens: 1 },
    ]);
    expect(ranked.map((r) => r.causeId)).toEqual(["0x03", "0x01", "0x02"]);
  });

  it("sums per category through the catalogue and skips unknown causes", () => {
    const store = catalogStoreOf(catalog);
    const by = totalsByCategory(rankCauseTotals(mergeCauseTotals(weekly, live)), (id) => store.causes([id])?.[0]);
    expect(by.find((c) => c.slug === "hunger")).toMatchObject({ donated: 6_000_000n, causes: 1 });
    expect(by.find((c) => c.slug === "homelessness")).toMatchObject({ donated: 9_000_000n });
    expect(by.reduce((n, c) => n + c.causes, 0)).toBeGreaterThanOrEqual(3);
  });
});

describe("GET /api/causes/leaderboard", () => {
  const mk = (withTotals = true, withCatalog = true) =>
    createApi({
      repo: {} as Repo,
      search: { search: async () => [] },
      config: readApiConfig({}),
      causeTotals: withTotals ? { totals: async () => mergeCauseTotals(weekly, live) } : undefined,
      catalog: withCatalog ? catalogStoreOf(catalog) : undefined,
    });

  it("pages causes largest first with names, totals and categories", async () => {
    const app = mk();
    const r1 = await (await app.request("/api/causes/leaderboard?limit=2")).json();
    expect(r1).toMatchObject({ decimals: 6, currency: "USDC", totals: { causes: 4, donations: 11, donated: "17000001" } });
    expect(r1.items.map((i: { rank: number; donated: string }) => [i.rank, i.donated])).toEqual([[1, "9000000"], [2, "6000000"]]);
    expect(r1.items[0].org).toMatchObject({ name: "Shelter House", categories: ["homelessness"] });
    expect(r1.byCategory.map((c: { slug: string }) => c.slug)).toContain("hunger");
    const r2 = await (await app.request(`/api/causes/leaderboard?limit=2&cursor=${r1.nextCursor}`)).json();
    expect(r2.items.map((i: { rank: number }) => i.rank)).toEqual([3, 4]);
    expect(r2.items[1].org).toBeNull();
    expect(r2.nextCursor).toBeNull();
  });

  it("works without the catalogue (no names, no categories)", async () => {
    const r = await (await mk(true, false).request("/api/causes/leaderboard")).json();
    expect(r.items[0].org).toBeNull();
    expect(r.byCategory).toEqual([]);
  });

  it("validates the cursor and answers 503 without the repo", async () => {
    expect((await mk().request("/api/causes/leaderboard?cursor=zz")).status).toBe(400);
    expect((await mk(false).request("/api/causes/leaderboard")).status).toBe(503);
  });
});
