import { describe, expect, it } from "vitest";
import { MAX_ATTRIBUTES } from "@arkiv-network/sdk";
import { buildCatalog, type HarvestedOrg } from "@varada/cause-catalog";
import { CHAIN_FLAG, claimedLabels, encodeOrgEntity, fitStr, noNames, ORG_ENTITY_COLUMNS, ORG_L2_REGISTRY, orgEntityValues, planMirror, emptyState, staleEntries, tokenIdOf, unsetColumns } from "../src/arkiv.js";
import { keccak256, stringToBytes } from "viem";

const org = (n: number, over: Partial<HarvestedOrg> = {}): HarvestedOrg => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
  ein: String(100000000 + n),
  name: `Org ${n}`,
  description: null,
  nteeCode: "Q33",
  country: "KEN",
  state: null,
  isCompliant: true,
  claimed: false,
  donationsReceived: 0,
  mainnetAddress: "0x000000000000000000000000000000000000beef",
  ...over,
});

describe("arkiv org entity", () => {
  const { catalog } = buildCatalog([org(1, { description: "famine relief" }), org(2)]);
  const root = catalog.meta.namesRoot!;

  it("fits Arkiv's attribute cap and encodes every column", () => {
    const enc = encodeOrgEntity(orgEntityValues(catalog.orgs[0]!, catalog.meta.taxonomyVersion), root);
    // Optional per-chain addresses are absent when every chain shares the Ethereum address.
    expect(Object.keys(enc)).toHaveLength(ORG_ENTITY_COLUMNS - 2);
    expect(ORG_ENTITY_COLUMNS + 1).toBeLessThanOrEqual(MAX_ATTRIBUTES);
  });

  it("slots categories and regions, indexes only the slim set, and carries no payload", () => {
    const o = catalog.orgs.find((x) => x.ein === "100000001")!;
    const v = orgEntityValues(o, 2);
    expect(v.cats.slice(0, o.categories.length)).toEqual(o.categories);
    expect(v.cats).toHaveLength(4);
    expect("payload" in v).toBe(false);
    const enc = encodeOrgEntity(v, root) as Record<string, unknown>;
    expect("payload" in enc).toBe(false);
  });

  it("truncates names to 128 UTF-8 bytes on a code point boundary", () => {
    const s = fitStr("é".repeat(100));
    expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(128);
    expect(s).toBe("é".repeat(64));
  });

  it("plans creates, then skips unchanged, patches changed and deletes removed orgs", () => {
    const p1 = planMirror(catalog.orgs, 2, emptyState(7794095));
    expect(p1.creates).toHaveLength(2);
    const state = emptyState(7794095);
    for (const c of p1.creates) state.entries[c.orgId] = { key: `0x${"aa".repeat(32)}`, hash: c.hash, writtenAt: "2026-01-01T00:00:00.000Z" };
    expect(planMirror(catalog.orgs, 2, state)).toMatchObject({ creates: [], patches: [], deletes: [], unchanged: 2 });
    const changed = buildCatalog([org(1, { description: "famine relief", claimed: true })]).catalog;
    const p2 = planMirror(changed.orgs, 2, state);
    expect(p2.patches).toHaveLength(1);
    expect(p2.deletes).toHaveLength(1);
    expect(staleEntries(state, new Date("2026-06-01T00:00:00.000Z"))).toHaveLength(2);
  });

  it("flags overrides and unresolved chains and stores only differing addresses", () => {
    const o = structuredClone(catalog.orgs[0]!);
    const alt = "0x69D68d5118Fc6FAC79d5D1c9c1EF5515dd4aa1d2" as const;
    o.chains![2] = { ...o.chains![2]!, source: "override", orgId: `0x${"35".repeat(32)}`, address: alt };
    o.chains![1] = { ...o.chains![1]!, source: "unresolved", orgId: `0x${"00".repeat(32)}`, address: null };
    const v = orgEntityValues(o, 2);
    expect(v.chainFlags).toBe(CHAIN_FLAG.overrideBase | CHAIN_FLAG.unresolvedOptimism);
    expect([v.addressOptimism, v.addressBase]).toEqual([null, alt]);
    const enc = encodeOrgEntity(v, root);
    expect("addressBase" in enc && !("addressOptimism" in enc)).toBe(true);
    expect(unsetColumns(v)).toEqual(["addressOptimism"]);
  });

  it("records the ENS name, the Optimism token id and the name status", () => {
    const o = catalog.orgs[0]!;
    const v = orgEntityValues(o, 2);
    expect(v.ensName).toBe(`${o.label}.org.varada.eth`);
    expect(v.l2Registry).toBe(ORG_L2_REGISTRY);
    expect(v.tokenId).toBe(keccak256(stringToBytes(o.label!)));
    expect(BigInt(v.tokenId).toString(16)).toBe(tokenIdOf(o.label!).slice(2).replace(/^0+/, ""));
    expect(v.nameStatus).toBe("unminted");
    const enc = encodeOrgEntity(v, root);
    expect(enc).toHaveProperty("ensName");
    expect(enc).toHaveProperty("nameStatus");
  });

  it("patches (never re-creates) an entity when its name goes unminted -> minted -> claimed", () => {
    const state = emptyState(7794095);
    const p0 = planMirror(catalog.orgs, 2, state);
    p0.creates.forEach((c, i) => (state.entries[c.orgId] = { key: `0x${String(i + 1).padStart(64, "0")}`, hash: c.hash, writtenAt: "2026-11-07T00:00:00.000Z" }));
    const label = catalog.orgs[0]!.label!;
    const minted = { ...noNames(), minted: new Set([label]) };
    const p1 = planMirror(catalog.orgs, 2, state, minted);
    expect(p1.creates).toEqual([]);
    expect(p1.patches).toHaveLength(1);
    expect(p1.patches[0]!.values.nameStatus).toBe("minted");
    expect(p1.patches[0]!.key).toBe(state.entries[p1.patches[0]!.orgId]!.key);
    expect(p1.unchanged).toBe(catalog.orgs.length - 1);
    state.entries[p1.patches[0]!.orgId]!.hash = p1.patches[0]!.hash;
    const p2 = planMirror(catalog.orgs, 2, state, { ...minted, claimed: new Set([label]) });
    expect(p2.creates).toEqual([]);
    expect(p2.patches.map((p) => p.values.nameStatus)).toEqual(["claimed"]);
    expect(planMirror(catalog.orgs, 2, state, minted)).toMatchObject({ creates: [], patches: [], deletes: [] });
  });

  it("counts a name claimed only when its owner is someone other than custody", () => {
    const custody = "0x00000000000000000000000000000000000000c0";
    const got = claimedLabels(["a", "b", "c", "d"], [custody.toUpperCase().replace("0X", "0x"), "0x00000000000000000000000000000000000000c1", null, "0x0000000000000000000000000000000000000000"], custody);
    expect([...got]).toEqual(["b"]);
  });
});
