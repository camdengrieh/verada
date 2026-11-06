/**
 * Route finding. A Varada token trades against its quote asset only, so a user paying in another
 * asset needs a path of existing Uniswap v4 pools: user asset -> (hub pools) -> quote asset -> token.
 *
 * What is searched: v4 pools only, without hooks, in the configured fee tiers, among the nodes
 * {user asset, destination, hubs, extra hubs}; ETH (native, address zero) and WETH are separate
 * nodes joined by a free wrap / unwrap edge. Uniswap v3 and v2 liquidity is NOT searched.
 */
import { getAddress, type Address } from "viem";
import { DEFAULT_ENVIRONMENT, DEFAULT_FEE_TIERS, DEFAULT_HUBS, MAX_ROUTE_POOL_HOPS } from "./constants.js";
import { buildPoolKey, poolIdOf, readPoolStates, type ReadClient } from "./pool.js";
import { NATIVE_CURRENCY, type PoolKey, type PoolState, type Route, type RouteStep, type SwapAsset, type SwapEnvironment } from "./types.js";

export interface RoutingConfig {
  env?: SwapEnvironment;
  /** Assets routes may pass through (and users may pay with). Default {@link DEFAULT_HUBS}. */
  hubs?: readonly SwapAsset[];
  /** More nodes to search through, e.g. allowlisted Ondo quote assets. */
  extraHubs?: readonly SwapAsset[];
  feeTiers?: readonly { fee: number; tickSpacing: number }[];
  /** Most pool hops (the wrap / unwrap edge is free). Default 3. */
  maxHops?: number;
  /** Pools kept per asset pair, deepest first. Default 2. */
  poolsPerPair?: number;
  /** Most candidate routes handed on to the quoter. Default 16. */
  maxCandidates?: number;
}

type ResolvedRouting = Required<Omit<RoutingConfig, "extraHubs">> & { extraHubs: readonly SwapAsset[] };

export function resolveRoutingConfig(cfg: RoutingConfig = {}): ResolvedRouting {
  return {
    env: cfg.env ?? DEFAULT_ENVIRONMENT,
    hubs: cfg.hubs ?? DEFAULT_HUBS,
    extraHubs: cfg.extraHubs ?? [],
    feeTiers: cfg.feeTiers ?? DEFAULT_FEE_TIERS,
    maxHops: Math.min(cfg.maxHops ?? MAX_ROUTE_POOL_HOPS, MAX_ROUTE_POOL_HOPS),
    poolsPerPair: cfg.poolsPerPair ?? 2,
    maxCandidates: cfg.maxCandidates ?? 16,
  };
}

const key = (a: Address) => a.toLowerCase();

/** Unique node addresses of a search: the endpoints (minus the Varada token) plus the hubs. */
export function routingNodes(cfg: RoutingConfig, endpoints: readonly Address[]): Address[] {
  const c = resolveRoutingConfig(cfg);
  const seen = new Map<string, Address>();
  for (const a of [...endpoints, ...c.hubs.map((h) => h.address), ...c.extraHubs.map((h) => h.address)]) seen.set(key(a), getAddress(a));
  return [...seen.values()];
}

/** Every hook-less pool key among `nodes` in the configured fee tiers. */
export function candidatePoolKeys(nodes: readonly Address[], feeTiers: readonly { fee: number; tickSpacing: number }[] = DEFAULT_FEE_TIERS): PoolKey[] {
  const keys: PoolKey[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      for (const t of feeTiers) keys.push(buildPoolKey({ currencyA: a, currencyB: b, fee: t.fee, tickSpacing: t.tickSpacing }));
    }
  }
  return keys;
}

interface CacheEntry {
  at: number;
  states: PoolState[];
}

/** Short-lived memo of pool discovery: which pools exist hardly changes within a minute. */
const discoveryCache = new Map<string, CacheEntry>();
export const DISCOVERY_TTL_MS = 30_000;
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Finds which candidate pools exist (initialized, with liquidity) via `StateView`, in one batched
 * read. Also reads the `extra` pool keys (the Varada token's own pool). Cached for 30 s per node set.
 */
export async function discoverPools(
  client: ReadClient,
  nodes: readonly Address[],
  cfg: RoutingConfig = {},
  extra: readonly PoolKey[] = [],
  opts: { now?: number; bypassCache?: boolean } = {},
): Promise<PoolState[]> {
  const c = resolveRoutingConfig(cfg);
  const keys = [...candidatePoolKeys(nodes, c.feeTiers), ...extra];
  const cacheKey = keys.map((k) => poolIdOf(k)).join(",") + c.env.stateView;
  const now = opts.now ?? Date.now();
  const hit = discoveryCache.get(cacheKey);
  if (hit && !opts.bypassCache && now - hit.at < DISCOVERY_TTL_MS) return hit.states;
  const states = (await readPoolStates(client, keys, c.env)).filter((s) => s.initialized && s.liquidity > 0n);
  discoveryCache.set(cacheKey, { at: now, states });
  return states;
}

function stepFor(state: PoolState, currencyIn: Address): RouteStep {
  const zeroForOne = key(state.key.currency0) === key(currencyIn);
  return {
    kind: "pool",
    key: state.key,
    poolId: state.poolId,
    zeroForOne,
    currencyIn: getAddress(currencyIn),
    currencyOut: zeroForOne ? state.key.currency1 : state.key.currency0,
  };
}

/** Number of pool steps in a route. */
export const poolHops = (r: Route): number => r.steps.filter((s) => s.kind === "pool").length;

/**
 * All simple paths from `from` to `to` over the given pools, at most `maxHops` pool hops, with the
 * free ETH <-> WETH edge. Parallel pools of one pair are limited to the `poolsPerPair` deepest
 * (a pool whose hooks are non-zero is always kept: it is a Varada pool). Shortest first.
 */
export function enumerateRoutes(
  pools: readonly PoolState[],
  from: Address,
  to: Address,
  opts: { weth: Address; maxHops?: number; poolsPerPair?: number; maxCandidates?: number },
): Route[] {
  const maxHops = Math.min(opts.maxHops ?? MAX_ROUTE_POOL_HOPS, MAX_ROUTE_POOL_HOPS);
  const perPair = opts.poolsPerPair ?? 2;
  const maxCandidates = opts.maxCandidates ?? 16;
  const src = key(from);
  const dst = key(to);
  if (src === dst) return [];

  // group live pools per unordered pair, deepest first
  const byPair = new Map<string, PoolState[]>();
  for (const p of pools) {
    if (!p.initialized || p.liquidity === 0n) continue;
    const k = [key(p.key.currency0), key(p.key.currency1)].sort().join("/");
    const list = byPair.get(k) ?? [];
    list.push(p);
    byPair.set(k, list);
  }
  const adjacency = new Map<string, PoolState[]>();
  const add = (node: string, p: PoolState) => adjacency.set(node, [...(adjacency.get(node) ?? []), p]);
  for (const list of byPair.values()) {
    const hooked = list.filter((p) => key(p.key.hooks) !== key(NATIVE_CURRENCY));
    const plain = list.filter((p) => key(p.key.hooks) === key(NATIVE_CURRENCY)).sort((a, b) => (a.liquidity < b.liquidity ? 1 : a.liquidity > b.liquidity ? -1 : 0));
    for (const p of [...hooked, ...plain.slice(0, perPair)]) {
      add(key(p.key.currency0), p);
      add(key(p.key.currency1), p);
    }
  }

  const weth = key(opts.weth);
  const eth = key(NATIVE_CURRENCY);
  const out: Route[] = [];

  const dfs = (node: Address, steps: RouteStep[], visited: Set<string>, hops: number) => {
    if (key(node) === dst) {
      out.push({ steps: [...steps], currencyIn: getAddress(from), currencyOut: getAddress(to) });
      return;
    }
    for (const p of adjacency.get(key(node)) ?? []) {
      if (hops >= maxHops) break;
      const step = stepFor(p, node);
      if (step.kind !== "pool" || visited.has(key(step.currencyOut))) continue;
      visited.add(key(step.currencyOut));
      steps.push(step);
      dfs(step.currencyOut, steps, visited, hops + 1);
      steps.pop();
      visited.delete(key(step.currencyOut));
    }
    // free wrap / unwrap edge
    const other = key(node) === eth ? weth : key(node) === weth ? eth : null;
    if (other && !visited.has(other)) {
      const target = getAddress(other);
      const step: RouteStep = key(node) === eth ? { kind: "wrap", currencyIn: getAddress(node), currencyOut: target } : { kind: "unwrap", currencyIn: getAddress(node), currencyOut: target };
      visited.add(other);
      steps.push(step);
      dfs(target, steps, visited, hops);
      steps.pop();
      visited.delete(other);
    }
  };
  dfs(from, [], new Set([src]), 0);

  const feeOf = (r: Route) => r.steps.reduce((acc, s) => acc + (s.kind === "pool" ? (s.key.fee & 0x7fffff) : 0), 0);
  out.sort((a, b) => poolHops(a) - poolHops(b) || a.steps.length - b.steps.length || feeOf(a) - feeOf(b));
  return out.slice(0, maxCandidates);
}

/** Splits a route at wrap / unwrap steps into v4 segments (run as one `V4_SWAP` each) and conversions. */
export type RouteSegment =
  | { kind: "v4"; steps: Extract<RouteStep, { kind: "pool" }>[]; currencyIn: Address; currencyOut: Address }
  | { kind: "wrap"; currencyIn: Address; currencyOut: Address }
  | { kind: "unwrap"; currencyIn: Address; currencyOut: Address };

export function segmentRoute(route: Route): RouteSegment[] {
  const segments: RouteSegment[] = [];
  let cur: Extract<RouteStep, { kind: "pool" }>[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    segments.push({ kind: "v4", steps: cur, currencyIn: cur[0]!.currencyIn, currencyOut: cur[cur.length - 1]!.currencyOut });
    cur = [];
  };
  for (const s of route.steps) {
    if (s.kind === "pool") {
      cur.push(s);
    } else {
      flush();
      segments.push(s.kind === "wrap" ? { kind: "wrap", currencyIn: s.currencyIn, currencyOut: s.currencyOut } : { kind: "unwrap", currencyIn: s.currencyIn, currencyOut: s.currencyOut });
    }
  }
  flush();
  return segments;
}

/** "ETH > USDC > NVDAon > $HARAMBE" style label for a route, using `symbolOf` for each address. */
export function describeRoute(route: Route, symbolOf: (a: Address) => string): string {
  const parts = [symbolOf(route.currencyIn)];
  for (const s of route.steps) parts.push(symbolOf(s.currencyOut));
  return parts.join(" > ");
}
