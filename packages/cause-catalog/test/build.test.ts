import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { describe, expect, it } from "vitest";
import { getAddress, zeroHash, type Hex } from "viem";
import { toOrgId } from "@varada/endaoment-client";
import { emptyAddressCache } from "../src/addresses.js";
import { BUCKET_COUNT, bucketId, categoryBySlug, regionBySlug } from "@varada/sdk";
import { buildCatalog, entryProof } from "../src/build.js";
import { readCatalog, writeCatalog } from "../src/io.js";
import { NamesIndex, labelhash, verifyNameProof } from "../src/names.js";
import { org } from "./fixtures.js";

const HUNGER_NA = bucketId(categoryBySlug("hunger").bit, regionBySlug("north-america").bit);

describe("buildCatalog", () => {
  it("filters ineligible orgs and records why", () => {
    const { catalog, rejected } = buildCatalog([
      org(1),
      org(2, { isCompliant: false }),
      org(3, { mainnetAddress: null }),
      org(4, { ein: null, id: "not-a-uuid" }),
      org(5, { id: "00000000-0000-0000-0000-999999999999", ein: String(100000001) }),
    ]);
    expect(catalog.orgs.map((o) => o.ein)).toEqual(["100000001"]);
    expect(rejected.map((r) => r.reason).sort()).toEqual(["duplicate-org-id", "no-mainnet-address", "no-org-id", "non-compliant"]);
  });

  it("is deterministic regardless of input order and buckets sort by orgId", () => {
    const input = [org(3), org(1), org(2)];
    const a = buildCatalog(input).catalog;
    const b = buildCatalog([...input].reverse()).catalog;
    expect(a.meta.root).toBe(b.meta.root);
    expect(a.meta.bucketSizes).toHaveLength(BUCKET_COUNT);
    expect(a.meta.bucketSizes[HUNGER_NA]).toBe(3);
    const ids = [...a.tree.entries()].filter(([, l]) => l[0] === HUNGER_NA).map(([, l]) => l[2]);
    expect(ids).toEqual([...ids].sort());
  });

  it("puts an org in every category x region bucket it matches, with verifiable proofs", () => {
    const { catalog } = buildCatalog([org(1, { nteeCode: "Q33", description: "famine relief in Kenya" })]);
    const o = catalog.orgs[0]!;
    expect(o.categories).toEqual(["disaster-relief", "hunger"]);
    expect(o.regions).toEqual(["africa", "north-america", "global"]);
    expect(o.entries).toHaveLength(6);
    for (const e of o.entries) {
      const proof = entryProof(catalog.tree, { ...e, orgId: o.orgId });
      expect(StandardMerkleTree.verify(catalog.meta.root, ["uint16", "uint32", "bytes32"], [e.bucket, e.index, o.orgId], proof)).toBe(true);
    }
  });

  it("round-trips through the published files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-"));
    const { catalog } = buildCatalog([org(1), org(2, { country: "KEN", nteeCode: "Z00", description: "orphanage" })]);
    await writeCatalog(dir, catalog);
    const back = await readCatalog(dir);
    expect(back.meta.root).toBe(catalog.meta.root);
    expect(back.orgs).toEqual(catalog.orgs);
  });

  it("labels every org, builds a verifiable names tree and keeps labels across rebuilds", async () => {
    const first = buildCatalog([org(1, { name: "Hope Fund" }), org(2, { name: "Hope Fund" })]).catalog;
    expect(first.orgs.map((o) => o.label).sort()).toEqual(["hope-fund", "hope-fund-2"]);
    expect(first.meta.namesRoot).toBe(first.names!.shards.tree.root);
    expect(first.meta.namesShardBits).toBe(12);
    const idx = new NamesIndex(first.names!.shards);
    const p = idx.nameProof("hope-fund-2");
    const o2 = first.orgs.find((o) => o.label === "hope-fund-2")!;
    expect(p.labelhash).toBe(labelhash("hope-fund-2"));
    expect(p.orgIds).toEqual({ eth: o2.orgId, optimism: o2.orgId, base: o2.orgId });
    expect(verifyNameProof(first.meta.namesRoot!, p.labelhash, p.shard, p.entries, p.proof)).toEqual(p.orgIds);
    expect(idx.nameProof("nope").orgIds).toBeNull();
    expect(first.meta.stats.addresses!.verified).toBe(false);

    const dir = await mkdtemp(join(tmpdir(), "catalog-names-"));
    await writeCatalog(dir, first);
    const back = await readCatalog(dir);
    expect(back.names!.shards.tree.root).toBe(first.meta.namesRoot);

    // org 1 drops out and org 0 (earlier id) arrives: org 2 keeps hope-fund-2, org 0 gets -3.
    const second = buildCatalog([org(0, { name: "Hope Fund" }), org(2, { name: "Hope Fund" })], {
      previousLabels: back.names!.ledger,
    }).catalog;
    const byEin = Object.fromEntries(second.orgs.map((o) => [o.ein, o.label]));
    expect(byEin[String(100000002)]).toBe("hope-fund-2");
    expect(byEin[String(100000000)]).toBe("hope-fund-3");
    expect(second.names!.ledger["hope-fund"]).toBe(first.orgs.find((o) => o.label === "hope-fund")!.orgId);
  });

  it("puts each chain's verified orgId in the names leaf and counts overrides and unresolved chains", () => {
    const a = "0x00000000000000000000000000000000000000aa";
    const other = "0x00000000000000000000000000000000000000bb";
    const ghost = "0x00000000000000000000000000000000000000cc";
    const h1 = org(1, {
      mainnetAddress: a,
      deployments: [
        { chainId: 1, address: a, isDeployed: true, usdcBalance: "0" },
        { chainId: 8453, address: other, isDeployed: true, usdcBalance: "0" },
      ],
    });
    const h2 = org(2, { deployments: [{ chainId: 10, address: ghost, isDeployed: false, usdcBalance: null }] });
    const altId = `0x${"35".repeat(32)}` as Hex;
    const cache = emptyAddressCache();
    cache.computed.set(toOrgId(h1).toLowerCase(), getAddress(a));
    cache.computed.set(toOrgId(h2).toLowerCase(), getAddress("0x000000000000000000000000000000000000beef"));
    cache.computed.set(altId, getAddress(other));
    cache.reads.set(`8453:${other}`, altId);
    const { catalog } = buildCatalog([h1, h2], { addresses: cache });
    const o1 = catalog.orgs.find((o) => o.ein === "100000001")!;
    expect(o1.chains!.map((c) => [c.chainId, c.source, c.orgId])).toEqual([
      [1, "default", o1.orgId],
      [10, "default", o1.orgId],
      [8453, "override", altId],
    ]);
    expect(o1.chains![2]!.address).toBe(getAddress(other));
    const o2 = catalog.orgs.find((o) => o.ein === "100000002")!;
    expect(o2.chains![1]).toMatchObject({ source: "unresolved", orgId: zeroHash, address: null, apiAddress: getAddress(ghost) });
    const leaf2 = new NamesIndex(catalog.names!.shards).nameProof(o2.label!);
    expect(leaf2.orgIds).toEqual({ eth: o2.orgId, optimism: zeroHash, base: o2.orgId });
    const st = catalog.meta.stats.addresses!;
    expect(st.verified).toBe(true);
    expect(st.perChain["8453"]).toMatchObject({ default: 1, override: 1, unresolved: 0 });
    expect(st.perChain["8453"]!.overrides[0]).toMatchObject({ chainOrgId: altId });
    expect(st.perChain["10"]).toMatchObject({ default: 1, override: 0, unresolved: 1 });
  });
});
