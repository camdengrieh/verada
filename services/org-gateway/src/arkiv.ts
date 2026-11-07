import type { CatalogOrg } from "@varada/cause-catalog";
import { addr, defineSchema, i32, str, u64 } from "@arkiv-network/sdk/schema";
import { keccak256, stringToBytes, stringToHex, zeroAddress, type Hex } from "viem";
import type { OrgChain } from "@varada/cause-catalog";

/**
 * Arkiv mirror of the org catalogue (Rabdi testnet, chain 7794095). A fallback for the HTTP API;
 * Ethereum mainnet (the resolver's names root) stays the source of truth. Readers must filter on
 * `$creator` = the mirror signer, because anyone can write a `varada.org` entity.
 *
 * Arkiv caps an entity at 32 attributes (31 plus the `arkiv.schema` tag) and has no list type or
 * contains operator, so the 34 category and region slugs cannot each be a bool column. Instead:
 *  - `cat1..cat4` / `reg1..reg4`: an org's first four categories / regions (taxonomy order), indexed,
 *    so `cat1 = "hunger" || cat2 = "hunger" || ...` finds it. In the 2026-11-06 sample 99.8% of orgs
 *    had at most four categories and every org at most four regions;
 *  - `categoryMask` / `regionMask`: the full sets (not indexed: Arkiv has no bitwise operators);
 *  - `payload`: the full org JSON (the same shape as `GET /orgs/:label`).
 * `namesRoot` is the names root of the build in which the entity's content last changed, so a
 * rebuild that leaves an org unchanged does not rewrite it.
 *
 * Addresses: `address` is the Ethereum address (zero when chain 1 is unresolved). `chainFlags`
 * (indexed) has bit 0/1/2 set when Ethereum/Optimism/Base uses an override orgId and bit 4/5/6 when
 * that chain is unresolved; `addressOptimism` / `addressBase` are present only when that chain's
 * address differs from `address` (an override; an unresolved chain has none).
 *
 * Names: `ensName` (`<label>.org.varada.eth`, indexed), `l2Registry` (VaradaOrgNames on Optimism),
 * `tokenId` (`uint256(labelhash)` as 0x hex, the ERC-721 id there) and `nameStatus` (indexed):
 * `unminted`, `minted` (in the op-mint state file) or `claimed` (minted and no longer owned by the
 * custody account).
 */
/**
 * Slim on purpose: every index costs write gas (measured on Rabdi: ~1.14M gas per entity with 20
 * indexed columns and the JSON payload, ~0.5M with 6 and none), and the full record already lives
 * in the catalogue build and the Swarm shards. Indexed: label, orgId, rank, nameStatus, ensName,
 * address and the first category and region; the other slots and masks are stored for readers to
 * filter client-side.
 */
export const OrgEntity = defineSchema("varada.org", {
  namesRoot: str(),
  taxonomyVersion: i32(),
  label: str().indexed(),
  orgId: str().indexed(),
  ein: str(),
  rank: u64().indexed(),
  address: addr().indexed(),
  ensName: str().indexed(),
  l2Registry: addr(),
  tokenId: str(),
  nameStatus: str().indexed(),
  chainFlags: i32(),
  addressOptimism: addr().optional(),
  addressBase: addr().optional(),
  categoryMask: u64(),
  regionMask: i32(),
  cat1: str().indexed(),
  cat2: str(),
  cat3: str(),
  cat4: str(),
  reg1: str().indexed(),
  reg2: str(),
  reg3: str(),
  reg4: str(),
  name: str(),
});

/** Columns of {@link OrgEntity} (+1 for the `arkiv.schema` tag must stay <= 32). */
export const ORG_ENTITY_COLUMNS = 25;

/** VaradaOrgNames (ERC-721 org names) on Optimism. */
export const ORG_L2_REGISTRY: Hex = "0xd032aF2A81936898b8B87b65840A934bA3E1Be40";
export const ORG_NAME_PARENT = "org.varada.eth";

export type NameStatus = "unminted" | "minted" | "claimed";

/** Where each label stands on Optimism (labels; claimed implies minted). */
export interface NameInfo {
  registry: Hex;
  minted: ReadonlySet<string>;
  claimed: ReadonlySet<string>;
}

export const noNames = (registry: Hex = ORG_L2_REGISTRY): NameInfo => ({ registry, minted: new Set(), claimed: new Set() });

export const nameStatusOf = (label: string, n: NameInfo): NameStatus =>
  n.claimed.has(label) ? "claimed" : n.minted.has(label) ? "minted" : "unminted";

/** ERC-721 id of a label on VaradaOrgNames: `uint256(labelhash)`, as lowercase 0x hex. */
export const tokenIdOf = (label: string): Hex => keccak256(stringToBytes(label)).toLowerCase() as Hex;

/** Minted labels whose current owner is neither the custody account nor zero (unknown owners count as not claimed). */
export function claimedLabels(labels: readonly string[], owners: readonly (string | null)[], custody: string): Set<string> {
  const out = new Set<string>();
  labels.forEach((l, i) => {
    const o = owners[i];
    if (o && !/^0x0{40}$/i.test(o) && o.toLowerCase() !== custody.toLowerCase()) out.add(l);
  });
  return out;
}

export const CHAIN_FLAG = {
  overrideEth: 1 << 0,
  overrideOptimism: 1 << 1,
  overrideBase: 1 << 2,
  unresolvedEth: 1 << 4,
  unresolvedOptimism: 1 << 5,
  unresolvedBase: 1 << 6,
} as const;
export const CATEGORY_SLOTS = 4;
export const REGION_SLOTS = 4;
/** Creates or patches per transaction: ~0.74M gas each for the slim entity (measured); 15 stay under the ~16.7M per-transaction gas cap with room for long rows (20 hit it). */
export const DEFAULT_BATCH = 15;

const MAX_STR = 128;

/** Truncates to at most 128 UTF-8 bytes on a code point boundary. */
export function fitStr(s: string): string {
  if (stringToBytes(s).length <= MAX_STR) return s;
  let out = "";
  for (const ch of s) {
    if (stringToBytes(out + ch).length > MAX_STR) break;
    out += ch;
  }
  return out;
}

/** Plain values of one org entity (before Arkiv typing). */
export interface OrgEntityValues {
  taxonomyVersion: number;
  label: string;
  orgId: Hex;
  ein: string;
  rank: number;
  address: Hex;
  ensName: string;
  l2Registry: Hex;
  tokenId: Hex;
  nameStatus: NameStatus;
  chainFlags: number;
  addressOptimism: Hex | null;
  addressBase: Hex | null;
  categoryMask: string;
  regionMask: number;
  cats: string[];
  regs: string[];
  name: string;
}

export function orgEntityValues(o: CatalogOrg, taxonomyVersion: number, names: NameInfo = noNames()): OrgEntityValues {
  if (!o.label || !o.chains || o.chains.length !== 3) throw new Error(`org ${o.orgId} has no label or chains; rebuild the catalogue`);
  const slots = (xs: string[], n: number) => Array.from({ length: n }, (_, i) => xs[i] ?? "");
  const [eth, op, base] = o.chains as [OrgChain, OrgChain, OrgChain];
  let chainFlags = 0;
  [eth, op, base].forEach((c, i) => {
    if (c.source === "override") chainFlags |= 1 << i;
    if (c.source === "unresolved") chainFlags |= 1 << (4 + i);
  });
  const ethAddress = eth.address ?? zeroAddress;
  const differing = (c: OrgChain) => (c.address && c.address.toLowerCase() !== ethAddress.toLowerCase() ? c.address : null);
  return {
    taxonomyVersion,
    label: o.label,
    orgId: o.orgId.toLowerCase() as Hex,
    ein: o.ein ?? "",
    rank: o.rank ?? 0,
    address: ethAddress,
    ensName: `${o.label}.${ORG_NAME_PARENT}`,
    l2Registry: names.registry,
    tokenId: tokenIdOf(o.label),
    nameStatus: nameStatusOf(o.label, names),
    chainFlags,
    addressOptimism: differing(op),
    addressBase: differing(base),
    categoryMask: o.categoryMask,
    regionMask: o.regionMask,
    cats: slots(o.categories, CATEGORY_SLOTS),
    regs: slots(o.regions, REGION_SLOTS),
    name: fitStr(o.name),
  };
}

/** Content hash used to skip unchanged orgs (excludes `namesRoot`). */
export const valuesHash = (v: OrgEntityValues): Hex => keccak256(stringToHex(JSON.stringify(v)));

export function encodeOrgEntity(v: OrgEntityValues, namesRoot: Hex) {
  const [cat1, cat2, cat3, cat4] = v.cats.map(str);
  const [reg1, reg2, reg3, reg4] = v.regs.map(str);
  return {
    namesRoot: str(namesRoot.toLowerCase()),
    taxonomyVersion: i32(v.taxonomyVersion),
    label: str(v.label),
    orgId: str(v.orgId),
    ein: str(v.ein),
    rank: u64(BigInt(v.rank)),
    address: addr(v.address),
    ensName: str(v.ensName),
    l2Registry: addr(v.l2Registry),
    tokenId: str(v.tokenId),
    nameStatus: str(v.nameStatus),
    chainFlags: i32(v.chainFlags),
    ...(v.addressOptimism ? { addressOptimism: addr(v.addressOptimism) } : {}),
    ...(v.addressBase ? { addressBase: addr(v.addressBase) } : {}),
    categoryMask: u64(BigInt(v.categoryMask)),
    regionMask: i32(v.regionMask),
    cat1: cat1!,
    cat2: cat2!,
    cat3: cat3!,
    cat4: cat4!,
    reg1: reg1!,
    reg2: reg2!,
    reg3: reg3!,
    reg4: reg4!,
    name: str(v.name),
  };
}

/** Local record of what the mirror has written (`--state`, resumable). */
export interface MirrorState {
  chainId: number;
  /** Signer address: the `$creator` readers must trust. */
  creator: Hex | null;
  entries: Record<string, { key: Hex; hash: Hex; writtenAt: string }>;
}

export const emptyState = (chainId: number): MirrorState => ({ chainId, creator: null, entries: {} });

export interface MirrorPlan {
  creates: { orgId: Hex; values: OrgEntityValues; hash: Hex }[];
  patches: { orgId: Hex; key: Hex; values: OrgEntityValues; hash: Hex }[];
  /** Orgs in the state that left the catalogue. */
  deletes: { orgId: Hex; key: Hex }[];
  unchanged: number;
}

/**
 * Pure. Orgs not in `state` are created; orgs whose values (including the name fields) changed are
 * patched in place by their stored entity key; orgs that left the catalogue are deleted.
 */
export function planMirror(
  orgs: readonly CatalogOrg[],
  taxonomyVersion: number,
  state: MirrorState,
  names: NameInfo = noNames(),
): MirrorPlan {
  const plan: MirrorPlan = { creates: [], patches: [], deletes: [], unchanged: 0 };
  const seen = new Set<string>();
  for (const o of orgs) {
    if (!o.label || !o.chains) continue;
    const values = orgEntityValues(o, taxonomyVersion, names);
    const hash = valuesHash(values);
    const id = values.orgId;
    seen.add(id);
    const prev = state.entries[id];
    if (!prev) plan.creates.push({ orgId: id, values, hash });
    else if (prev.hash !== hash) plan.patches.push({ orgId: id, key: prev.key, values, hash });
    else plan.unchanged++;
  }
  for (const [orgId, e] of Object.entries(state.entries)) {
    if (!seen.has(orgId)) plan.deletes.push({ orgId: orgId as Hex, key: e.key });
  }
  plan.creates.sort((a, b) => (a.orgId < b.orgId ? -1 : 1));
  return plan;
}

/** Entries last written or extended before `cutoff` (candidates for `extend`). */
export function staleEntries(state: MirrorState, cutoff: Date): { orgId: string; key: Hex }[] {
  return Object.entries(state.entries)
    .filter(([, e]) => new Date(e.writtenAt).getTime() < cutoff.getTime())
    .map(([orgId, e]) => ({ orgId, key: e.key }));
}

export const chunk = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Optional columns a patch must clear because the new values no longer carry them. */
export function unsetColumns(v: OrgEntityValues): ("addressOptimism" | "addressBase")[] {
  const out: ("addressOptimism" | "addressBase")[] = [];
  if (!v.addressOptimism) out.push("addressOptimism");
  if (!v.addressBase) out.push("addressBase");
  return out;
}
