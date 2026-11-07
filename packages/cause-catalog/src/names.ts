import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeAbiParameters, keccak256, stringToBytes, type Hex } from "viem";

/**
 * The names behind `<label>.org.varada.eth`, sharded so the CCIP-Read fallback can be static
 * files. Every labelled org is an entry `(labelhash, orgIdEth, orgIdOptimism, orgIdBase)`; entries
 * go to shard `uint256(labelhash) >> (256 - bits)` (the top `bits` bits), sorted by labelhash.
 *
 * The names tree is an OpenZeppelin StandardMerkleTree of `[uint256 shard, bytes32 entriesHash]`
 * over all `2**bits` shards, empty ones included, so a label's absence is provable. Its root is
 * `root()` on `VaradaOrgResolver`, which checks the shard proof, finds the labelhash in the
 * entries and computes each chain's address with Endaoment's L1 OrgFundFactory. A zero orgId
 * means no record on that chain.
 */
export const SHARD_BITS = 12;
export const NAMES_LEAF_TYPES = ["uint256", "bytes32"] as const;
export type NameLeaf = [number, Hex];
/** `(labelhash, orgIdEth, orgIdOptimism, orgIdBase)`. */
export type NameEntry = readonly [Hex, Hex, Hex, Hex];

/** Per-chain orgIds of one name (zero hash when the chain has no record). */
export interface NameOrgIds {
  eth: Hex;
  optimism: Hex;
  base: Hex;
}

/** ENS labelhash: `keccak256(utf8(label))`. */
export const labelhash = (label: string): Hex => keccak256(stringToBytes(label));

/** Top `bits` bits of the labelhash. */
export const shardOf = (hash: Hex, bits: number = SHARD_BITS): number => Number(BigInt(hash) >> BigInt(256 - bits));

export const ENTRIES_ABI = [
  { type: "tuple[]", components: [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }] },
] as const;

const hashEntries = (entries: readonly NameEntry[]): Hex =>
  keccak256(encodeAbiParameters(ENTRIES_ABI, [entries as unknown as readonly [Hex, Hex, Hex, Hex][]]));
/** Hash of an empty shard (`abi.encode` of an empty array). */
export const EMPTY_ENTRIES_HASH: Hex = hashEntries([]);

/** `keccak256(abi.encode(Entry[] entries))`. */
export const entriesHash = (entries: readonly NameEntry[]): Hex => (entries.length === 0 ? EMPTY_ENTRIES_HASH : hashEntries(entries));

export interface NameShards {
  bits: number;
  /** `shards[i]`: entries of shard i, ascending by labelhash. */
  shards: NameEntry[][];
  tree: StandardMerkleTree<NameLeaf>;
}

const lower = (h: Hex) => h.toLowerCase() as Hex;

export function buildNameShards(
  names: Iterable<{ label: string; orgIds: NameOrgIds }>,
  bits: number = SHARD_BITS,
): NameShards {
  if (!Number.isInteger(bits) || bits < 1 || bits > 24) throw new Error(`invalid shard bits ${bits}`);
  const shards: NameEntry[][] = Array.from({ length: 2 ** bits }, () => []);
  const seen = new Set<string>();
  for (const n of names) {
    const h = lower(labelhash(n.label));
    if (seen.has(h)) throw new Error(`duplicate label ${n.label}`);
    seen.add(h);
    shards[shardOf(h, bits)]!.push([h, lower(n.orgIds.eth), lower(n.orgIds.optimism), lower(n.orgIds.base)]);
  }
  for (const s of shards) s.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
  const leaves: NameLeaf[] = shards.map((s, i) => [i, entriesHash(s)]);
  return { bits, shards, tree: StandardMerkleTree.of(leaves, [...NAMES_LEAF_TYPES]) };
}

export interface ShardProof {
  shard: number;
  entries: NameEntry[];
  entriesHash: Hex;
  proof: Hex[];
}

export interface NameProof extends ShardProof {
  labelhash: Hex;
  /** Null when the label is not in its shard (the shard proof then proves absence). */
  orgIds: NameOrgIds | null;
}

const orgIdsOf = (e: NameEntry): NameOrgIds => ({ eth: e[1], optimism: e[2], base: e[3] });

/** Shard and name proofs over one names tree (indexes the tree once). */
export class NamesIndex {
  readonly root: Hex;
  readonly bits: number;
  private readonly treeIndex: number[];

  constructor(private readonly names: NameShards) {
    this.root = names.tree.root as Hex;
    this.bits = names.bits;
    this.treeIndex = new Array<number>(names.shards.length);
    for (const [i, [shard]] of names.tree.entries()) this.treeIndex[Number(shard)] = i;
  }

  get size(): number {
    return this.names.shards.reduce((n, s) => n + s.length, 0);
  }

  get shardCount(): number {
    return this.names.shards.length;
  }

  shardProof(shard: number): ShardProof | null {
    if (!Number.isInteger(shard) || shard < 0 || shard >= this.names.shards.length) return null;
    const entries = this.names.shards[shard]!;
    return { shard, entries, entriesHash: entriesHash(entries), proof: this.names.tree.getProof(this.treeIndex[shard]!) as Hex[] };
  }

  proofByHash(hash: Hex): NameProof {
    const h = lower(hash);
    const sp = this.shardProof(shardOf(h, this.bits))!;
    const e = sp.entries.find((x) => x[0] === h);
    return { ...sp, labelhash: h, orgIds: e ? orgIdsOf(e) : null };
  }

  nameProof(label: string): NameProof {
    return this.proofByHash(labelhash(label));
  }
}

/** Proof (or proof of absence) of `label` in `names`. */
export const nameProof = (names: NameShards, label: string): NameProof => new NamesIndex(names).nameProof(label);

/**
 * What the resolver's callback checks: the shard leaf is in the tree under `root`, and the result
 * is the entry for `hash` (null when absent). Throws when the proof is invalid or the shard is wrong.
 */
export function verifyNameProof(
  root: Hex,
  hash: Hex,
  shard: number,
  entries: readonly NameEntry[],
  proof: readonly Hex[],
  bits: number = SHARD_BITS,
): NameOrgIds | null {
  if (shardOf(hash, bits) !== shard) throw new Error("labelhash is not in this shard");
  if (!StandardMerkleTree.verify(root, [...NAMES_LEAF_TYPES], [shard, entriesHash(entries)], [...proof])) {
    throw new Error("invalid shard proof");
  }
  const e = entries.find((x) => x[0].toLowerCase() === hash.toLowerCase());
  return e ? orgIdsOf(e) : null;
}
