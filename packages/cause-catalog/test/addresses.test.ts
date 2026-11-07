import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { toOrgId } from "@varada/endaoment-client";
import { getAddress, keccak256, zeroHash, type Address, type Hex } from "viem";
import { readAddressCache, resolveChainOrgIds, verifyAddresses, type BatchReader, type ContractCall } from "../src/addresses.js";
import type { HarvestedOrg } from "../src/harvest.js";
import { org } from "./fixtures.js";

/** Fake CREATE2: address = last 20 bytes of keccak(orgId). */
const create2 = (orgId: Hex): Address => getAddress(`0x${keccak256(orgId).slice(-40)}`);
const HYPHEN_ID = `0x${Buffer.from("52-0907625").toString("hex").padEnd(64, "0")}` as Hex;

function fakeL1(fail = 0): BatchReader & { calls: number } {
  let failures = fail;
  const r = (async (calls: ContractCall[]) => {
    r.calls++;
    if (failures-- > 0) throw new Error("429");
    return calls.map((c) => create2(c.args![0]));
  }) as BatchReader & { calls: number };
  r.calls = 0;
  return r;
}

function fakeChain(orgIds: Record<string, Hex>): BatchReader {
  return async (calls) => calls.map((c) => orgIds[c.address.toLowerCase()] ?? null);
}

function withChains(n: number, chains: Partial<Record<1 | 10 | 8453, { address: string; isDeployed: boolean }>>): HarvestedOrg {
  const h = org(n);
  const def = create2(toOrgId(h));
  return {
    ...h,
    mainnetAddress: chains[1]?.address ?? def,
    deployments: ([1, 10, 8453] as const)
      .filter((c) => chains[c] !== undefined || c === 1)
      .map((c) => ({ chainId: c, address: (chains[c]?.address ?? def).toLowerCase(), isDeployed: chains[c]?.isDeployed ?? false, usdcBalance: "0" })),
  };
}

describe("verifyAddresses + resolveChainOrgIds", () => {
  it("resolves defaults, overrides via orgId(), and unresolved chains; resumes without repeating work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "addresses-"));
    const npr = withChains(1, { 8453: { address: create2(HYPHEN_ID), isDeployed: true } });
    const liar = withChains(2, { 10: { address: "0x00000000000000000000000000000000000000aa", isDeployed: true } });
    const ghost = withChains(3, { 10: { address: "0x00000000000000000000000000000000000000bb", isDeployed: false } });
    const plain = withChains(4, { 10: {} as never });
    plain.deployments = plain.deployments!.slice(0, 1); // API lists chain 1 only
    const l1 = fakeL1(1);
    const readers = {
      1: l1,
      10: fakeChain({ "0x00000000000000000000000000000000000000aa": `0x${"77".repeat(32)}` }), // orgId() does not map back
      8453: fakeChain({ [create2(HYPHEN_ID).toLowerCase()]: HYPHEN_ID }),
    };
    const sleep = vi.fn(async () => {});
    const res = await verifyAddresses({ harvested: [npr, liar, ghost, plain], dir, readers, batchSize: 2, sleep, retryBaseMs: 1 });
    expect(res.orgIdReads).toBe(2); // NPR on Base, liar on Optimism (ghost is not deployed)
    expect(sleep).toHaveBeenCalled();

    const cache = (await readAddressCache(dir))!;
    const r1 = resolveChainOrgIds(npr, cache);
    expect(r1.chains.base).toMatchObject({ source: "override", orgId: HYPHEN_ID, address: create2(HYPHEN_ID) });
    expect(r1.chains.eth).toMatchObject({ source: "default", orgId: toOrgId(npr).toLowerCase() });
    expect(resolveChainOrgIds(liar, cache).chains.optimism).toMatchObject({ source: "unresolved", orgId: zeroHash, address: null });
    expect(resolveChainOrgIds(ghost, cache).chains.optimism.source).toBe("unresolved");
    const rp = resolveChainOrgIds(plain, cache);
    expect([rp.chains.optimism.source, rp.chains.base.source]).toEqual(["default", "default"]);
    expect(rp.chains.base.address).toBe(create2(toOrgId(plain)));

    const again = fakeL1();
    const res2 = await verifyAddresses({ harvested: [npr, liar, ghost, plain], dir, readers: { ...readers, 1: again }, sleep });
    expect(res2).toMatchObject({ computedCalls: 0, orgIdReads: 0 });
    expect(again.calls).toBe(0);
  });

  it("falls back to the default orgId on every chain without a cache", () => {
    const h = withChains(5, { 8453: { address: "0x00000000000000000000000000000000000000cc", isDeployed: true } });
    const r = resolveChainOrgIds(h, null);
    expect(r.verified).toBe(false);
    expect(Object.values(r.chains).map((c) => c.source)).toEqual(["default", "default", "default"]);
  });
});
