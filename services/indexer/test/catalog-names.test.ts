import { buildCatalog, type HarvestedOrg } from "@varada/cause-catalog";
import { describe, expect, it } from "vitest";
import { ActivityBus } from "../src/api/bus";
import { catalogStoreOf, namesSummary } from "../src/api/catalog";
import { readApiConfig } from "../src/api/config";
import { createApi } from "../src/api/routes";
import { fixtureRepo } from "./api.fixtures";

const org = (i: number, over: Partial<HarvestedOrg> = {}): HarvestedOrg => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  ein: String(410000000 + i),
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

// Labels and rank come from the build: claimed orgs rank higher.
const { catalog } = buildCatalog([
  org(1, { name: "Red Cross Chapter of Smalltown" }),
  org(2, { name: "American Red Cross", claimed: true, donationsReceived: 5000 }),
  org(3, { name: "Red Cross" }),
  org(4, { name: "Food Bank" }),
]);

const mkApp = (c = catalog) => {
  const config = readApiConfig({});
  const repo = fixtureRepo();
  const bus = new ActivityBus(() => repo.listActivity({ limit: 100 }), 10_000);
  return createApi({ repo, search: { search: async () => [] }, config, bus, catalog: catalogStoreOf(c) });
};
const get = async (app: ReturnType<typeof createApi>, path: string) => (await app.request(path)).json();

describe("catalogue names", () => {
  it("counts the names a build registers in /api/catalog", async () => {
    const body = await get(mkApp(), "/api/catalog");
    expect(body.names).toEqual({ count: 4, root: catalog.meta.namesRoot, shardBits: catalog.meta.namesShardBits });
    expect(namesSummary(catalog)).toBe(namesSummary(catalog)); // cached per build
  });

  it("counts from orgs.jsonl when the names tree is not loaded, and is null on builds without names", () => {
    const { names: _names, ...noTree } = catalog;
    expect(namesSummary({ ...noTree })?.count).toBe(4);
    const unnamed = { ...noTree, meta: { ...catalog.meta, namesRoot: undefined, namesShardBits: undefined } };
    expect(namesSummary(unnamed)).toBeNull();
  });

  it("puts exact matches first, then the rest by rank", async () => {
    const app = mkApp();
    const red = await get(app, "/api/catalog/search?q=red%20cross");
    expect(red.total).toBe(3);
    // "Red Cross" matches the whole query; American Red Cross outranks the Smalltown chapter.
    expect(red.items.map((o: { name: string }) => o.name)).toEqual(["Red Cross", "American Red Cross", "Red Cross Chapter of Smalltown"]);
    const label = catalog.orgs.find((o) => o.name === "Red Cross Chapter of Smalltown")!.label!;
    const byLabel = await get(app, `/api/catalog/search?q=${label}.org.varada.eth`);
    expect(byLabel.items[0].label).toBe(label);
    // Paging walks the same order.
    const second = await get(app, "/api/catalog/search?q=red%20cross&offset=1&limit=1");
    expect(second.items.map((o: { name: string }) => o.name)).toEqual(["American Red Cross"]);
    expect(second.total).toBe(3);
    // No query: everything, highest rank first.
    expect((await get(app, "/api/catalog/search")).items[0].name).toBe("American Red Cross");
  });
});
