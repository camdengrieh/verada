import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { concat, encodeAbiParameters, keccak256, zeroHash, type Hex } from "viem";
import { buildCatalog } from "../src/build.js";
import { decodeCcipRequest, decodeCcipResponse, encodeCcipRequest, encodeCcipResponse } from "../src/ccip.js";
import { exportCcip } from "../src/export.js";
import { buildNameShards, entriesHash, labelhash, NamesIndex, shardOf, type NameEntry } from "../src/names.js";
import { org } from "./fixtures.js";

const ids = (n: number) => {
  const h = `0x${n.toString(16).padStart(64, "0")}` as Hex;
  return { eth: h, optimism: h, base: n % 2 ? zeroHash : h };
};

/** VaradaOrgResolver's check, re-implemented with viem only (no OZ library). */
function resolveLikeSolidity(root: Hex, hash: Hex, response: Hex, bits = 12): { eth: Hex; optimism: Hex; base: Hex } | null {
  const { root: r, shard, entries, proof } = decodeCcipResponse(response);
  if (r.toLowerCase() !== root.toLowerCase()) throw new Error("wrong root");
  if (Number(BigInt(hash) >> BigInt(256 - bits)) !== shard) throw new Error("wrong shard");
  const b32 = { type: "bytes32" } as const;
  const eh = keccak256(encodeAbiParameters([{ type: "tuple[]", components: [b32, b32, b32, b32] }], [entries as unknown as [Hex, Hex, Hex, Hex][]]));
  // leaf = keccak256(bytes.concat(keccak256(abi.encode(shard, entriesHash))))
  let node = keccak256(keccak256(encodeAbiParameters([{ type: "uint256" }, b32], [BigInt(shard), eh])));
  for (const p of proof) node = BigInt(node) < BigInt(p) ? keccak256(concat([node, p])) : keccak256(concat([p, node]));
  if (node.toLowerCase() !== root.toLowerCase()) throw new Error("invalid proof");
  // entries are sorted, so a binary search works; a linear scan is the same answer.
  const e = entries.find((x) => x[0].toLowerCase() === hash.toLowerCase());
  return e ? { eth: e[1], optimism: e[2], base: e[3] } : null;
}

describe("sharded names", () => {
  const names = Array.from({ length: 300 }, (_, i) => ({ label: `org-${i}`, orgIds: ids(i + 1) }));
  const s = buildNameShards(names);
  const idx = new NamesIndex(s);

  it("has a leaf for every one of the 4096 shards, sorted entries, and the top 12 bits as shard", () => {
    expect(s.shards).toHaveLength(4096);
    expect([...s.tree.entries()]).toHaveLength(4096);
    for (const sh of s.shards) for (let i = 1; i < sh.length; i++) expect(BigInt(sh[i - 1]![0]) < BigInt(sh[i]![0])).toBe(true);
    const h = labelhash("org-7");
    expect(shardOf(h)).toBe(parseInt(h.slice(2, 5), 16));
    expect(entriesHash([])).toBe(keccak256(encodeAbiParameters([{ type: "tuple[]", components: [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }] }], [[]])));
  });

  it("resolves a present label through the CCIP response the way the resolver does", () => {
    const p = idx.nameProof("org-41");
    const res = encodeCcipResponse(idx.root, p);
    expect(resolveLikeSolidity(idx.root, labelhash("org-41"), res)).toEqual(ids(42));
  });

  it("proves absence of an unknown label from its (possibly empty) shard", () => {
    for (const label of ["not-a-charity", "x", "org-300"]) {
      const p = idx.nameProof(label);
      expect(p.orgIds).toBeNull();
      expect(resolveLikeSolidity(idx.root, labelhash(label), encodeCcipResponse(idx.root, p))).toBeNull();
    }
    const empty = s.shards.findIndex((x) => x.length === 0);
    expect(empty).toBeGreaterThanOrEqual(0);
    const p = idx.shardProof(empty)!;
    expect(p.entries).toEqual([]);
  });

  it("rejects a tampered entry or a proof for the wrong shard", () => {
    const p = idx.nameProof("org-41");
    const tampered = p.entries.map((e) => (e[0] === p.labelhash ? ([e[0], e[1], e[2], `0x${"ff".repeat(32)}`] as NameEntry) : e));
    expect(() => resolveLikeSolidity(idx.root, p.labelhash, encodeCcipResponse(idx.root, { ...p, entries: tampered }))).toThrow("invalid proof");
    const other = idx.shardProof((p.shard + 1) % 4096)!;
    expect(() => resolveLikeSolidity(idx.root, p.labelhash, encodeCcipResponse(idx.root, other))).toThrow("wrong shard");
  });

  it("encodes the request as abi.encode(uint256 shard) and range-checks it", () => {
    expect(encodeCcipRequest(4095)).toBe(`0x${"0".repeat(61)}fff`);
    expect(decodeCcipRequest(encodeCcipRequest(4095))).toBe(4095);
    expect(() => decodeCcipRequest(encodeCcipRequest(4096))).toThrow("out of range");
    expect(() => decodeCcipRequest("0x12")).toThrow();
  });
});

describe("export-ccip", () => {
  it("writes one file per shard plus l2-fallback.json, each answering like the gateway", async () => {
    const { catalog } = buildCatalog([org(1, { name: "Hope Fund" }), org(2, { name: "River Food Bank" })]);
    const out = await mkdtemp(join(tmpdir(), "ccip-export-"));
    const st = await exportCcip(catalog, out);
    expect(st.files).toBe(4097);
    expect(st.emptyShards).toBe(4094);
    expect((await readdir(join(out, "ccip"))).length).toBe(4096);
    expect(JSON.parse(await readFile(join(out, "l2-fallback.json"), "utf8"))).toEqual({ data: "0x" });
    const o = catalog.orgs[0]!;
    const hash = labelhash(o.label!);
    const file = join(out, "ccip", `${encodeCcipRequest(shardOf(hash))}.json`);
    const { data } = JSON.parse(await readFile(file, "utf8")) as { data: Hex };
    expect(resolveLikeSolidity(catalog.meta.namesRoot!, hash, data)).toEqual({ eth: o.orgId, optimism: o.orgId, base: o.orgId });
    expect(st.swarmChunks.total).toBe(st.swarmChunks.data + 2 * 4097);
  });
});
