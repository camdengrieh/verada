import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { toCauseId, toOrgId } from "@varada/endaoment-client";
import {
  BUCKET_COUNT,
  CATALOG_LEAF_TYPES,
  CATEGORIES,
  REGIONS,
  TAXONOMY_VERSION,
  bucketId,
  categorySlugs,
  regionSlugs,
  type CatalogEntry,
} from "@varada/sdk";
import type { Hex } from "viem";
import { classify, type Overrides, type TagSource } from "./classify.js";
import type { HarvestedOrg } from "./harvest.js";
import { assignLabels, type LabelAssignment, type LabelLedger } from "./labels.js";
import { buildNameShards, SHARD_BITS, type NameShards } from "./names.js";
import { CHAINS, resolveChainOrgIds, type AddressCache, type ChainOrgId } from "./addresses.js";
import { rankOrg, type RankSignals } from "./rank.js";

/** Chains Endaoment deploys orgs on. */
export const ORG_CHAIN_IDS = [1, 10, 8453] as const;

/** One chain of an org: its orgId there and the factory's CREATE2 address for it. */
export type OrgChain = ChainOrgId;

/** Lists in `stats.addresses` are capped at this many items (the counts are exact). */
export const ADDRESS_LIST_CAP = 500;

export interface ChainStats {
  default: number;
  override: number;
  unresolved: number;
  overrides: { endaomentId: string; name: string; orgId: Hex; chainOrgId: Hex; address: Hex | null }[];
  unresolvedOrgs: { endaomentId: string; name: string; orgId: Hex; apiAddress: Hex | null; deployed: boolean | null }[];
}

export type Leaf = [number, number, Hex];

/** One org in the catalogue, as published in `orgs.jsonl` and loaded by the indexer. */
export interface CatalogOrg {
  orgId: Hex;
  causeId: Hex;
  id: string;
  ein: string | null;
  name: string;
  nteeCode: string | null;
  country: string | null;
  state: string | null;
  claimed: boolean;
  /** Decimal string (JSON has no bigint). */
  categoryMask: string;
  regionMask: number;
  categories: string[];
  regions: string[];
  sources: { categories: TagSource[]; regions: TagSource[] };
  /** Every `(bucket, index)` the org occupies. */
  entries: { bucket: number; index: number }[];
  /** ENS label: `<label>.org.varada.eth` (set by every build since names were added). */
  label?: string;
  /** Ethereum address (`chains[0].address`); null when chain 1 is unresolved. */
  address?: Hex | null;
  chains?: OrgChain[];
  website?: string | null;
  /** 0-1000, see `rank.ts`. */
  rank?: number;
  rankSignals?: RankSignals;
}

export interface Rejection {
  id: string;
  reason: "non-compliant" | "no-org-id" | "no-mainnet-address" | "duplicate-org-id";
}

export interface CatalogStats {
  orgs: number;
  entries: number;
  rejected: Record<Rejection["reason"], number>;
  byCategory: Record<string, number>;
  byRegion: Record<string, number>;
  categorySource: Record<TagSource, number>;
  regionSource: Record<TagSource, number>;
  names?: LabelAssignment["stats"];
  addresses?: {
    /** False when `build` ran without the `verify-addresses` cache (every chain: default orgId). */
    verified: boolean;
    /** Orgs whose default orgId was not in the cache (treated as default on every chain). */
    unverifiedOrgs: number;
    perChain: Record<string, ChainStats>;
  };
}

export interface CatalogMeta {
  taxonomyVersion: number;
  builtAt: string;
  sourceAsOf: string | null;
  root: Hex;
  /** Root of the sharded names tree (`VaradaOrgResolver.root()`). */
  namesRoot?: Hex;
  /** Names shard bits: shard = top `namesShardBits` bits of the labelhash. */
  namesShardBits?: number;
  bucketSizes: number[];
  stats: CatalogStats;
}

export interface CatalogNames {
  /** Every label ever assigned (`label -> orgId`), including orgs no longer in the catalogue. */
  ledger: LabelLedger;
  /** The orgs of this catalogue, sharded by labelhash, and the tree over all shards. */
  shards: NameShards;
}

/** Shards the labelled orgs of a catalogue (deterministic from `orgs`). */
export function namesFromOrgs(orgs: readonly CatalogOrg[], bits: number = SHARD_BITS): NameShards {
  return buildNameShards(
    orgs
      .filter((o) => o.label && o.chains?.length === 3)
      .map((o) => ({ label: o.label!, orgIds: { eth: o.chains![0]!.orgId, optimism: o.chains![1]!.orgId, base: o.chains![2]!.orgId } })),
    bits,
  );
}

export interface BuiltCatalog {
  meta: CatalogMeta;
  orgs: CatalogOrg[];
  tree: StandardMerkleTree<Leaf>;
  /** Absent when reading a catalogue built before names were added. */
  names?: CatalogNames;
}

const zeroSources = (): Record<TagSource, number> => ({ ntee: 0, keyword: 0, country: 0, text: 0, override: 0, fallback: 0 });

/**
 * Filters, classifies and buckets harvested orgs, and builds the Merkle tree whose root goes to
 * `CauseCatalog`. Each bucket is sorted by orgId, so a rebuild from the same input gives the
 * same root.
 */
export function buildCatalog(
  harvested: HarvestedOrg[],
  opts: {
    overrides?: Overrides;
    sourceAsOf?: string | null;
    now?: Date;
    previousLabels?: LabelLedger;
    /** `verify-addresses` output; without it every chain uses the default orgId (unverified). */
    addresses?: AddressCache | null;
    /** Names shard bits (default {@link SHARD_BITS}). */
    namesShardBits?: number;
  } = {},
): { catalog: BuiltCatalog; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  const byOrgId = new Map<Hex, { h: HarvestedOrg; orgId: Hex }>();
  for (const h of [...harvested].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!h.isCompliant) {
      rejected.push({ id: h.id, reason: "non-compliant" });
      continue;
    }
    if (!h.mainnetAddress) {
      rejected.push({ id: h.id, reason: "no-mainnet-address" });
      continue;
    }
    let orgId: Hex;
    try {
      orgId = toOrgId(h);
    } catch {
      rejected.push({ id: h.id, reason: "no-org-id" });
      continue;
    }
    if (byOrgId.has(orgId)) {
      rejected.push({ id: h.id, reason: "duplicate-org-id" });
      continue;
    }
    byOrgId.set(orgId, { h, orgId });
  }

  const stats: CatalogStats = {
    orgs: 0,
    entries: 0,
    rejected: { "non-compliant": 0, "no-org-id": 0, "no-mainnet-address": 0, "duplicate-org-id": 0 },
    byCategory: Object.fromEntries(CATEGORIES.map((c) => [c.slug, 0])),
    byRegion: Object.fromEntries(REGIONS.map((r) => [r.slug, 0])),
    categorySource: zeroSources(),
    regionSource: zeroSources(),
    addresses: {
      verified: Boolean(opts.addresses),
      unverifiedOrgs: 0,
      perChain: Object.fromEntries(
        CHAINS.map((c) => [String(c.chainId), { default: 0, override: 0, unresolved: 0, overrides: [], unresolvedOrgs: [] } as ChainStats]),
      ),
    },
  };
  for (const r of rejected) stats.rejected[r.reason]++;

  const buckets: Hex[][] = Array.from({ length: BUCKET_COUNT }, () => []);
  const orgs: CatalogOrg[] = [];
  for (const { h, orgId } of byOrgId.values()) {
    const c = classify(h, opts.overrides);
    const categories = categorySlugs(c.categoryMask);
    const regions = regionSlugs(c.regionMask);
    for (const cat of CATEGORIES) {
      if (((c.categoryMask >> BigInt(cat.bit)) & 1n) === 0n) continue;
      for (const reg of REGIONS) {
        if (((c.regionMask >> reg.bit) & 1) === 0) continue;
        buckets[bucketId(cat.bit, reg.bit)]!.push(orgId);
      }
    }
    for (const s of categories) stats.byCategory[s]!++;
    for (const s of regions) stats.byRegion[s]!++;
    for (const s of c.sources.categories) stats.categorySource[s]++;
    for (const s of c.sources.regions) stats.regionSource[s]++;
    const resolution = resolveChainOrgIds(h, opts.addresses ?? null);
    const chains = CHAINS.map((c) => resolution.chains[c.key]);
    if (!resolution.verified) stats.addresses!.unverifiedOrgs++;
    for (const ch of chains) {
      const cs = stats.addresses!.perChain[String(ch.chainId)]!;
      cs[ch.source]++;
      if (ch.source === "override" && cs.overrides.length < ADDRESS_LIST_CAP) {
        cs.overrides.push({ endaomentId: h.id, name: h.name, orgId, chainOrgId: ch.orgId, address: ch.address });
      }
      if (ch.source === "unresolved" && cs.unresolvedOrgs.length < ADDRESS_LIST_CAP) {
        cs.unresolvedOrgs.push({ endaomentId: h.id, name: h.name, orgId, apiAddress: ch.apiAddress, deployed: ch.deployed });
      }
    }
    const address = resolution.chains.eth.address;
    orgs.push({
      orgId,
      causeId: toCauseId(h),
      id: h.id,
      ein: h.ein,
      name: h.name,
      nteeCode: h.nteeCode,
      country: h.country,
      state: h.state,
      claimed: h.claimed,
      categoryMask: c.categoryMask.toString(),
      regionMask: c.regionMask,
      categories,
      regions,
      sources: c.sources,
      entries: [],
      address,
      chains,
      website: h.website ?? null,
      ...rankOrg(h),
    });
  }

  const labels = assignLabels(
    orgs.map((o) => ({ id: o.id, ein: o.ein, name: o.name, orgId: o.orgId })),
    opts.previousLabels,
  );
  for (const o of orgs) o.label = labels.labelOf.get(o.orgId)!;
  stats.names = labels.stats;

  const orgIndex = new Map(orgs.map((o, i) => [o.orgId, i]));
  const leaves: Leaf[] = [];
  buckets.forEach((ids, bucket) => {
    ids.sort();
    ids.forEach((orgId, index) => {
      leaves.push([bucket, index, orgId]);
      orgs[orgIndex.get(orgId)!]!.entries.push({ bucket, index });
    });
  });
  stats.orgs = orgs.length;
  stats.entries = leaves.length;

  if (leaves.length === 0) throw new Error("catalogue is empty");
  const tree = StandardMerkleTree.of(leaves, [...CATALOG_LEAF_TYPES]);
  const shards = namesFromOrgs(orgs, opts.namesShardBits ?? SHARD_BITS);
  return {
    catalog: {
      meta: {
        taxonomyVersion: TAXONOMY_VERSION,
        builtAt: (opts.now ?? new Date()).toISOString(),
        sourceAsOf: opts.sourceAsOf ?? null,
        root: tree.root as Hex,
        namesRoot: shards.tree.root as Hex,
        namesShardBits: shards.bits,
        bucketSizes: buckets.map((b) => b.length),
        stats,
      },
      orgs,
      tree,
      names: { ledger: labels.ledger, shards },
    },
    rejected,
  };
}

/** Proof of one catalogue entry. */
export function entryProof(tree: StandardMerkleTree<Leaf>, entry: CatalogEntry): Hex[] {
  return tree.getProof([entry.bucket, entry.index, entry.orgId]) as Hex[];
}

/** Leaf hash of an entry (OpenZeppelin standard tree: double keccak of the ABI encoding). */
export function leafHash(tree: StandardMerkleTree<Leaf>, entry: CatalogEntry): Hex {
  return tree.leafHash([entry.bucket, entry.index, entry.orgId]) as Hex;
}

/** Whether `proof` shows `entry` is in the catalogue with `root` (what `CauseCatalog.verify` checks). */
export function verifyEntryProof(root: Hex, entry: CatalogEntry, proof: readonly Hex[]): boolean {
  return StandardMerkleTree.verify(root, [...CATALOG_LEAF_TYPES], [entry.bucket, entry.index, entry.orgId], [...proof]);
}
