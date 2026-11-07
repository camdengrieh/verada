import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toOrgId } from "@varada/endaoment-client";
import { getAddress, isAddressEqual, parseAbi, zeroHash, type Address, type Hex } from "viem";
import type { HarvestedOrg } from "./harvest.js";

/**
 * Per-chain orgIds. Endaoment's OrgFundFactory computes the same CREATE2 address for a given
 * orgId on Ethereum, Optimism and Base, but an org's entity on one chain can have been created
 * under a different orgId (for example NPR on Base under the hyphenated EIN "52-0907625").
 * `verify-addresses` checks every API address against the L1 factory and, where they differ,
 * reads `orgId()` from the deployed entity; `build` turns that cache into one orgId per chain.
 */

/** Endaoment OrgFundFactory (same address and CREATE2 rule on 1, 10 and 8453). */
export const ORG_FUND_FACTORY: Address = "0x10fD9348136dCea154F752fe0B6dB45Fc298A589";
export const CHAINS = [
  { chainId: 1, key: "eth" },
  { chainId: 10, key: "optimism" },
  { chainId: 8453, key: "base" },
] as const;
export type ChainKey = (typeof CHAINS)[number]["key"];

export const factoryAbi = parseAbi(["function computeOrgAddress(bytes32 orgId) view returns (address)"]);
export const orgAbi = parseAbi(["function orgId() view returns (bytes32)"]);

/** Resumable RPC results under `.catalog/addresses/`. */
export const ADDRESS_FILES = { computed: "computed.jsonl", reads: "reads.jsonl" } as const;

export interface AddressCache {
  /** `orgId (lowercase) -> computeOrgAddress(orgId)` on the L1 factory. */
  computed: Map<string, Address>;
  /** `"<chainId>:<address lowercase>" -> orgId()` of that entity, or null when the call failed. */
  reads: Map<string, Hex | null>;
}

export const emptyAddressCache = (): AddressCache => ({ computed: new Map(), reads: new Map() });
const readKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

async function readLines(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line cut short by a crash mid-append; its entries are simply fetched again.
    }
  }
  return out;
}

/** Loads the cache, or null when the directory has never been written. */
export async function readAddressCache(dir: string): Promise<AddressCache | null> {
  const computedLines = await readLines(join(dir, ADDRESS_FILES.computed));
  const readLinesArr = await readLines(join(dir, ADDRESS_FILES.reads));
  if (computedLines.length === 0 && readLinesArr.length === 0) return null;
  const c = emptyAddressCache();
  for (const l of computedLines as { orgId: string; address: string }[]) c.computed.set(l.orgId.toLowerCase(), getAddress(l.address));
  for (const l of readLinesArr as { chainId: number; address: string; orgId: Hex | null }[]) {
    c.reads.set(readKey(l.chainId, l.address), l.orgId ? (l.orgId.toLowerCase() as Hex) : null);
  }
  return c;
}

export type ChainSource = "default" | "override" | "unresolved";

export interface ChainOrgId {
  chainId: number;
  /** Zero hash when unresolved. */
  orgId: Hex;
  /** `computeOrgAddress(orgId)`; null when unresolved or not verified. */
  address: Address | null;
  source: ChainSource;
  /** The API's address for this chain, when it listed one. */
  apiAddress: Address | null;
  /** Advisory (API cache). */
  deployed: boolean | null;
}

export interface ChainResolution {
  /** Whether the default orgId's address was in the cache (false: fell back without checking). */
  verified: boolean;
  chains: Record<ChainKey, ChainOrgId>;
}

/**
 * One orgId per chain (pure; uses only the cache). For chain c with API deployment d:
 *  - no d: the default orgId (`toOrgId(h)`), whose address is deterministic;
 *  - d.address equals computeOrgAddress(default): the default;
 *  - d deployed and its `orgId()` maps back to d.address on the factory: that orgId (override);
 *  - otherwise unresolved (zero orgId).
 * Without the default's computed address in the cache, every chain gets the default, unverified.
 */
export function resolveChainOrgIds(h: HarvestedOrg, cache: AddressCache | null): ChainResolution {
  const def = toOrgId(h).toLowerCase() as Hex;
  const computedDefault = cache?.computed.get(def) ?? null;
  const verified = computedDefault !== null;
  const chains = {} as Record<ChainKey, ChainOrgId>;
  // Harvests from before `deployments` was kept only have the chain 1 address.
  const deployments =
    h.deployments ?? (h.mainnetAddress ? [{ chainId: 1, address: h.mainnetAddress, isDeployed: null as boolean | null }] : []);
  const fallbackAddress = h.mainnetAddress ? getAddress(h.mainnetAddress) : null;
  for (const { chainId, key } of CHAINS) {
    const d = deployments.find((x) => x.chainId === chainId);
    const apiAddress = d ? getAddress(d.address) : null;
    const deployed = d ? d.isDeployed : null;
    const base = { chainId, apiAddress, deployed };
    if (!verified) {
      // Unverified: the default orgId everywhere, and the chain 1 API address (its CREATE2 address).
      chains[key] = { ...base, orgId: def, address: fallbackAddress, source: "default" };
      continue;
    }
    if (!d || isAddressEqual(d.address as Address, computedDefault)) {
      chains[key] = { ...base, orgId: def, address: computedDefault, source: "default" };
      continue;
    }
    const read = d.isDeployed ? cache!.reads.get(readKey(chainId, d.address)) : undefined;
    const readAddress = read ? cache!.computed.get(read) : undefined;
    if (read && readAddress && isAddressEqual(readAddress, d.address as Address)) {
      chains[key] = { ...base, orgId: read, address: readAddress, source: "override" };
    } else {
      chains[key] = { ...base, orgId: zeroHash, address: null, source: "unresolved" };
    }
  }
  return { verified, chains };
}

// ---- RPC ----

export interface ContractCall {
  address: Address;
  abi: typeof factoryAbi | typeof orgAbi;
  functionName: "computeOrgAddress" | "orgId";
  args?: readonly [Hex];
}

/** Executes calls (one Multicall3 batch) and returns each result, or null when that call failed. */
export type BatchReader = (calls: ContractCall[]) => Promise<(unknown | null)[]>;

/** A {@link BatchReader} over a viem client's `multicall` (Multicall3, allowFailure). */
export function multicallReader(client: {
  multicall: (args: { contracts: readonly unknown[]; allowFailure: true; batchSize?: number }) => Promise<{ status: string; result?: unknown }[]>;
}): BatchReader {
  return async (calls) => {
    const res = await client.multicall({ contracts: calls, allowFailure: true, batchSize: 0 });
    return res.map((r) => (r.status === "success" ? (r.result ?? null) : null));
  };
}

export interface VerifyOptions {
  harvested: HarvestedOrg[];
  dir: string;
  readers: { 1: BatchReader; 10: BatchReader; 8453: BatchReader };
  /** Calls per Multicall3 batch. */
  batchSize?: number;
  /** Minimum delay between batches. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Retries per batch (exponential back-off from `retryBaseMs`). */
  retries?: number;
  retryBaseMs?: number;
}

export interface VerifyResult {
  orgs: number;
  computedCalls: number;
  orgIdReads: number;
  rpcMs: number;
}

/**
 * Fills the cache for `harvested`: computes every default orgId on the L1 factory, reads
 * `orgId()` of every deployed entity whose API address differs, and computes those orgIds too.
 * Appends after every batch, so an interrupted run resumes without repeating work.
 */
export async function verifyAddresses(o: VerifyOptions): Promise<VerifyResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? (() => {});
  const size = o.batchSize ?? 500;
  const interval = o.minIntervalMs ?? 250;
  const retries = o.retries ?? 4;
  const retryBase = o.retryBaseMs ?? 2_000;
  await mkdir(o.dir, { recursive: true });
  const cache = (await readAddressCache(o.dir)) ?? emptyAddressCache();
  let rpcMs = 0;
  let first = true;

  const run = async (reader: BatchReader, calls: ContractCall[]) => {
    if (!first) await sleep(interval);
    first = false;
    for (let attempt = 0; ; attempt++) {
      const t = Date.now();
      try {
        const r = await reader(calls);
        rpcMs += Date.now() - t;
        return r;
      } catch (e) {
        rpcMs += Date.now() - t;
        if (attempt >= retries) throw e;
        log(`rpc batch failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); retry ${attempt + 1}/${retries}`);
        await sleep(retryBase * 2 ** attempt);
      }
    }
  };

  const computeMissing = async (orgIds: Iterable<string>, label: string) => {
    const todo = [...new Set([...orgIds].map((x) => x.toLowerCase()))].filter((x) => !cache.computed.has(x)).sort();
    let n = 0;
    for (let i = 0; i < todo.length; i += size) {
      const group = todo.slice(i, i + size) as Hex[];
      const res = await run(
        o.readers[1],
        group.map((id) => ({ address: ORG_FUND_FACTORY, abi: factoryAbi, functionName: "computeOrgAddress", args: [id] as const })),
      );
      const lines: string[] = [];
      group.forEach((id, j) => {
        const a = res[j];
        if (typeof a !== "string") return; // failed call: retried on the next run
        cache.computed.set(id, getAddress(a));
        lines.push(JSON.stringify({ orgId: id, address: getAddress(a) }));
      });
      if (lines.length) await appendFile(join(o.dir, ADDRESS_FILES.computed), lines.join("\n") + "\n");
      n += group.length;
      log(`${label}: ${n}/${todo.length}`);
    }
    return todo.length;
  };

  const defaults: string[] = [];
  for (const h of o.harvested) {
    try {
      defaults.push(toOrgId(h));
    } catch {
      /* no ein or id: build rejects it */
    }
  }
  let computedCalls = await computeMissing(defaults, "computeOrgAddress (default orgIds)");

  // Deployed entities whose API address is not the default's CREATE2 address.
  const toRead = new Map<number, Set<string>>([[1, new Set()], [10, new Set()], [8453, new Set()]]);
  for (const h of o.harvested) {
    let def: string;
    try {
      def = toOrgId(h).toLowerCase();
    } catch {
      continue;
    }
    const computed = cache.computed.get(def);
    if (!computed) continue;
    for (const d of h.deployments ?? []) {
      if (!toRead.has(d.chainId) || !d.isDeployed) continue;
      if (isAddressEqual(d.address as Address, computed)) continue;
      if (!cache.reads.has(readKey(d.chainId, d.address))) toRead.get(d.chainId)!.add(d.address.toLowerCase());
    }
  }
  let orgIdReads = 0;
  for (const [chainId, set] of toRead) {
    const addrs = [...set].sort() as Address[];
    for (let i = 0; i < addrs.length; i += size) {
      const group = addrs.slice(i, i + size);
      const res = await run(o.readers[chainId as 1 | 10 | 8453], group.map((address) => ({ address, abi: orgAbi, functionName: "orgId" })));
      const lines = group.map((address, j) => {
        const v = typeof res[j] === "string" ? ((res[j] as string).toLowerCase() as Hex) : null;
        cache.reads.set(readKey(chainId, address), v);
        return JSON.stringify({ chainId, address, orgId: v });
      });
      await appendFile(join(o.dir, ADDRESS_FILES.reads), lines.join("\n") + "\n");
      orgIdReads += group.length;
      log(`orgId() on chain ${chainId}: ${Math.min(i + size, addrs.length)}/${addrs.length}`);
    }
  }
  const readIds = [...cache.reads.values()].filter((x): x is Hex => x !== null && x !== zeroHash);
  computedCalls += await computeMissing(readIds, "computeOrgAddress (entity orgIds)");
  return { orgs: o.harvested.length, computedCalls, orgIdReads, rpcMs };
}
