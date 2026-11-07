import type { CatalogOrg } from "@varada/cause-catalog";
import { keccak256, stringToBytes, zeroHash, type Hex } from "viem";

/** `VaradaOrgNames.NONE`: the name has no record on that chain. */
export const NONE: Hex = `0x${"f".repeat(64)}`;
/** Chains whose org ids `VaradaOrgResolver` reads from the registry. */
export const RECORD_CHAINS = [1, 10, 8453] as const;
/** ~51k gas per name (measured, `test_gas_registerBatchOf200`): 200 names ≈ 10.2M gas. */
export const DEFAULT_MINT_BATCH = 200;
export const GAS_PER_NAME = 51_000n;

export interface Registration {
  label: string;
  labelhash: Hex;
  orgId: Hex;
  rank: number;
}

export interface ChainOverride {
  labelhash: Hex;
  chainId: number;
  orgId: Hex;
}

export interface MintPlan {
  registrations: Registration[];
  overrides: ChainOverride[];
  skipped: { label: string | undefined; reason: string }[];
}

export const orgNamesAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "regs",
        type: "tuple[]",
        components: [
          { name: "label", type: "string" },
          { name: "orgId", type: "bytes32" },
        ],
      },
      { name: "to", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setChainOrgIds",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "overrides",
        type: "tuple[]",
        components: [
          { name: "labelhash", type: "bytes32" },
          { name: "chainId", type: "uint256" },
          { name: "orgId", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "defaultOrgIdOf",
    stateMutability: "view",
    inputs: [{ name: "labelhash", type: "bytes32" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "chainOverrideOf",
    stateMutability: "view",
    inputs: [
      { name: "labelhash", type: "bytes32" },
      { name: "chainId", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const isZero = (h: Hex | null | undefined) => !h || /^0x0*$/.test(h);

/**
 * What to write to `VaradaOrgNames` for a build: one registration per labelled org, highest rank
 * first (so a partial run, such as a demo of the top N, covers the most relevant orgs), plus a
 * chain override wherever a chain's org id differs from the default or the chain is unresolved.
 * The default org id is the org's catalogue id (`toOrgId`), the same one the Merkle leaf uses
 * for the chains without an override.
 */
export function planMint(orgs: CatalogOrg[]): MintPlan {
  const registrations: Registration[] = [];
  const overrides: ChainOverride[] = [];
  const skipped: MintPlan["skipped"] = [];
  const seen = new Set<string>();
  for (const o of orgs) {
    if (!o.label) {
      skipped.push({ label: undefined, reason: `no label (${o.id})` });
      continue;
    }
    if (seen.has(o.label)) {
      skipped.push({ label: o.label, reason: "duplicate label" });
      continue;
    }
    seen.add(o.label);
    const labelhash = keccak256(stringToBytes(o.label));
    registrations.push({ label: o.label, labelhash, orgId: o.orgId, rank: o.rank ?? 0 });
    for (const chainId of RECORD_CHAINS) {
      const c = o.chains?.find((x) => x.chainId === chainId);
      if (!c) continue; // no API deployment: deterministic default
      if (isZero(c.orgId)) overrides.push({ labelhash, chainId, orgId: NONE });
      else if (c.orgId.toLowerCase() !== o.orgId.toLowerCase()) overrides.push({ labelhash, chainId, orgId: c.orgId });
    }
  }
  registrations.sort((a, b) => b.rank - a.rank || (a.label < b.label ? -1 : 1));
  return { registrations, overrides, skipped };
}

/** Org ids per chain as the resolver will read them back, for checking a plan against chain state. */
export function resolvedIds(defaultId: Hex, override: Hex): Hex {
  if (isZero(defaultId)) return zeroHash;
  if (override.toLowerCase() === NONE) return zeroHash;
  return isZero(override) ? defaultId : override;
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
