import { describe, expect, it } from "vitest";
import type { CatalogOrg } from "@varada/cause-catalog";
import { keccak256, stringToBytes, zeroHash, type Hex } from "viem";
import { NONE, chunk, planMint, resolvedIds } from "../src/opmint.js";

const id = (s: string) => (`0x${Buffer.from(s).toString("hex").padEnd(64, "0")}` as Hex);

function org(label: string | undefined, orgId: Hex, rank: number, chains?: [number, Hex | null][]): CatalogOrg {
  return {
    id: label ?? "x",
    orgId,
    label,
    rank,
    chains: chains?.map(([chainId, o]) => ({ chainId, orgId: o })),
  } as unknown as CatalogOrg;
}

describe("planMint", () => {
  it("orders by rank, records overrides and NONE, skips unlabelled and duplicate labels", () => {
    const npr = id("520907625");
    const plan = planMint([
      org("small-org", id("1"), 10),
      org("national-public-radio", npr, 700, [
        [1, npr],
        [10, npr],
        [8453, id("52-0907625")],
      ]),
      org("eth-only", id("2"), 50, [
        [1, id("2")],
        [10, null],
        [8453, zeroHash],
      ]),
      org(undefined, id("3"), 999),
      org("small-org", id("4"), 5),
    ]);
    expect(plan.registrations.map((r) => r.label)).toEqual(["national-public-radio", "eth-only", "small-org"]);
    expect(plan.registrations[0]!.labelhash).toBe(keccak256(stringToBytes("national-public-radio")));
    expect(plan.overrides).toEqual([
      { labelhash: keccak256(stringToBytes("national-public-radio")), chainId: 8453, orgId: id("52-0907625") },
      { labelhash: keccak256(stringToBytes("eth-only")), chainId: 10, orgId: NONE },
      { labelhash: keccak256(stringToBytes("eth-only")), chainId: 8453, orgId: NONE },
    ]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["no label (x)", "duplicate label"]);
  });

  it("reads records back the way the resolver does", () => {
    expect(resolvedIds(id("a"), zeroHash)).toBe(id("a"));
    expect(resolvedIds(id("a"), id("b"))).toBe(id("b"));
    expect(resolvedIds(id("a"), NONE)).toBe(zeroHash);
    expect(resolvedIds(zeroHash, id("b"))).toBe(zeroHash);
  });

  it("chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
