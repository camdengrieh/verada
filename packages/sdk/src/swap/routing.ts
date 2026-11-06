/**
 * Route finding. A Varada token trades against its quote asset only, so a user paying in another
 * asset needs a path of existing Uniswap v4 pools: user asset -> (hub pools) -> quote asset -> token.
 *
 * What is searched, among the nodes {user asset, destination, hubs, extra hubs}: Uniswap v4 pools without
 * hooks in the configured fee tiers, Uniswap v3 pools in the four standard fee tiers and Uniswap v2 pairs
 * (each venue can be switched off with `venues`). ETH (native, address zero) and WETH are separate
 * nodes joined by a free wrap / unwrap edge; v3 and v2 trade WETH. A route may mix venues.
 */
import { getAddress, type Address } from "viem";
import { DEFAULT_ENVIRONMENT, DEFAULT_FEE_TIERS, DEFAULT_HUBS, DEFAULT_VENUES, MAX_ROUTE_POOL_HOPS, ONDO_FEE_TIERS } from "./constants.js";
import { isOndoToken } from "../ondo.js";
import { buildPoolKey, poolIdOf, readPoolStates, type ReadClient } from "./pool.js";
import { NATIVE_CURRENCY, type PoolKey, type PoolState, type Route, type RouteStep, type SwapAsset, type SwapEnvironment } from "./types.js";
import { candidatePairs, discoverV2Pairs, discoverV3Pools, stepVenue, type VenueConfig } from "./venues.js";

export interface RoutingConfig {
  env?: SwapEnvironment;
  /** Assets routes may pass through (and users may pay with). Default {@link DEFAULT_HUBS}. */
  hubs?: readonly SwapAsset[];
  /** More nodes to search through, e.g. allowlisted Ondo quote assets. */
  extraHubs?: readonly SwapAsset[];
  feeTiers?: readonly { fee: number; tickSpacing: number }[];
  /** Added for pairs with an Ondo token. Default {@link ONDO_FEE_TIERS}; [] searches `feeTiers` only. */
  ondoFeeTiers?: readonly { fee: number; tickSpacing: number }[];
  /** Most pool hops (the wrap / unwrap edge is free). Default 3. */
  maxHops?: number;
  /** Pools kept per asset pair, deepest first. Default 2. */
  poolsPerPair?: number;
  /** Most candidate routes enumerated. Default 10. */
  maxCandidates?: number;
  /** Candidates (best estimate first) that are sent to the quoter. Default 4. */
  quoteTop?: number;
  /** Venues to search. Default: v4, v3 and v2. */
  venues?: VenueConfig;
}

type ResolvedRouting = Required<Omit<RoutingConfig, "extraHubs" | "venues">> & { extraHubs: readonly SwapAsset[]; venues: Required<VenueConfig> };

export function resolveRoutingConfig(cfg: RoutingConfig = {}): ResolvedRouting {
  return {
    env: cfg.env ?? DEFAULT_ENVIRONMENT,
    hubs: cfg.hubs ?? DEFAULT_HUBS,
    extraHubs: cfg.extraHubs ?? [],
    feeTiers: cfg.feeTiers ?? DEFAULT_FEE_TIERS,
    ondoFeeTiers: cfg.ondoFeeTiers ?? ONDO_FEE_TIERS,
    maxHops: Math.min(cfg.maxHops ?? MAX_ROUTE_POOL_HOPS, MAX_ROUTE_POOL_HOPS),
    poolsPerPair: cfg.poolsPerPair ?? 2,
    maxCandidates: cfg.maxCandidates ?? 16,
    quoteTop: cfg.quoteTop ?? 4,
    venues: { ...DEFAULT_VENUES, ...cfg.venues },
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

/**
 * Every hook-less pool key among `nodes` in the configured fee tiers. With `core`, only pairs that
 * include a core node are generated: the satellites (a user's Ondo token, the quote asset, registry
 * assets) connect to the hubs, not to each other, which keeps the number of reads linear in them.
 */
export function candidatePoolKeys(
  nodes: readonly Address[],
  feeTiers: readonly { fee: number; tickSpacing: number }[] = DEFAULT_FEE_TIERS,
  core?: readonly Address[],
  /** Added (deduplicated) for pairs that include an Ondo token; pass [] to turn off. */
  ondoFeeTiers: readonly { fee: number; tickSpacing: number }[] = ONDO_FEE_TIERS,
): PoolKey[] {
  const ondoTiers = ondoFeeTiers.filter((o) => !feeTiers.some((t) => t.fee === o.fee && t.tickSpacing === o.tickSpacing));
  const coreSet = core ? new Set(core.map(key)) : null;
  const keys: PoolKey[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (coreSet && !coreSet.has(key(a)) && !coreSet.has(key(b))) continue;
      const tiers = ondoTiers.length > 0 && (isOndoToken(a) || isOndoToken(b)) ? [...feeTiers, ...ondoTiers] : feeTiers;
      for (const t of tiers) keys.push(buildPoolKey({ currencyA: a, currencyB: b, fee: t.fee, tickSpacing: t.tickSpacing }));
    }
  }
  return keys;
}

interface CacheEntry {
  at: number;
  states: PoolState[];
}

/** Short-lived memo of pool discovery: it only spares the repeated reads of one typing session; prices are re-read after 10 s. */
const discoveryCache = new Map<string, CacheEntry>();
export const DISCOVERY_TTL_MS = 10_000;
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Finds which candidate pools exist (initialized, with liquidity), in batched reads: v4 pools through
 * `StateView`, v3 pools through the factory then `slot0` / `liquidity`, v2 pairs through the factory then
 * `getReserves`; pools between hubs, and between each other node and the hubs. Also reads the `extra` pool keys (the
 * Varada token's own pool). Cached for 10 s per node set. A failed v3 / v2 read means "no such pool"; a failed
 * v4 read throws (`rpc-unavailable`).
 */
export async function discoverPools(
  client: ReadClient,
  nodes: readonly Address[],
  cfg: RoutingConfig = {},
  extra: readonly PoolKey[] = [],
  opts: { now?: number; bypassCache?: boolean } = {},
): Promise<PoolState[]> {
  const c = resolveRoutingConfig(cfg);
  const core = c.hubs.map((h) => h.address);
  const keys = [...(c.venues.v4 ? candidatePoolKeys(nodes, c.feeTiers, core, c.ondoFeeTiers) : []), ...extra];
  const v = c.venues;
  const cacheKey = keys.map((k) => poolIdOf(k)).join(",") + c.env.stateView + (v.v3 ? "+v3" : "") + (v.v2 ? "+v2" : "") + nodes.map((n) => n.toLowerCase()).join(",");
  const now = opts.now ?? Date.now();
  const hit = discoveryCache.get(cacheKey);
  if (hit && !opts.bypassCache && now - hit.at < DISCOVERY_TTL_MS) return hit.states;
  const pairs = v.v3 || v.v2 ? candidatePairs(nodes, c.env.weth, core) : [];
  const [v4, v3, v2] = await Promise.all([
    readPoolStates(client, keys, c.env),
    v.v3 ? discoverV3Pools(client, pairs, c.env) : [],
    v.v2 ? discoverV2Pairs(client, pairs, c.env) : [],
  ]);
  const states = [...v4, ...v3, ...v2].filter((s) => s.initialized && s.liquidity > 0n);
  discoveryCache.set(cacheKey, { at: now, states });
  return states;
}

function stepFor(state: PoolState, currencyIn: Address): RouteStep {
  const zeroForOne = key(state.key.currency0) === key(currencyIn);
  return {
    kind: "pool",
    key: state.key,
    poolId: state.poolId,
    ...(state.venue && state.venue !== "v4" ? { venue: state.venue, address: state.address } : {}),
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
  const maxCandidates = opts.maxCandidates ?? 10;
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

/**
 * Splits a route at wrap / unwrap steps and at venue changes into segments: consecutive pool steps of one venue
 * run as one `V4_SWAP` / `V3_SWAP_EXACT_*` / `V2_SWAP_EXACT_*` command; conversions are their own segments.
 */
type PoolStepOf = Extract<RouteStep, { kind: "pool" }>;
export type RouteSegment =
  | { kind: "v4"; steps: PoolStepOf[]; currencyIn: Address; currencyOut: Address }
  | { kind: "v3"; steps: PoolStepOf[]; currencyIn: Address; currencyOut: Address }
  | { kind: "v2"; steps: PoolStepOf[]; currencyIn: Address; currencyOut: Address }
  | { kind: "wrap"; currencyIn: Address; currencyOut: Address }
  | { kind: "unwrap"; currencyIn: Address; currencyOut: Address };

export function segmentRoute(route: Route): RouteSegment[] {
  const segments: RouteSegment[] = [];
  let cur: PoolStepOf[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    segments.push({ kind: stepVenue(cur[0]!), steps: cur, currencyIn: cur[0]!.currencyIn, currencyOut: cur[cur.length - 1]!.currencyOut });
    cur = [];
  };
  for (const s of route.steps) {
    if (s.kind === "pool") {
      if (cur.length > 0 && stepVenue(cur[0]!) !== stepVenue(s)) flush();
      cur.push(s);
    } else {
      flush();
      segments.push(s.kind === "wrap" ? { kind: "wrap", currencyIn: s.currencyIn, currencyOut: s.currencyOut } : { kind: "unwrap", currencyIn: s.currencyIn, currencyOut: s.currencyOut });
    }
  }
  flush();
  return segments;
}

/**
 * Currencies of a route that really move as ERC-20 transfers (so an Ondo pause or blocklist applies): the two
 * ends, every currency at a segment boundary (the router holds it between commands) and every currency of a
 * v3 / v2 pool (those pools transfer each hop). A currency strictly inside a v4 segment is netted to zero by the
 * pool manager and never moves.
 */
export function movingCurrencies(route: Route): Address[] {
  const out = new Map<string, Address>();
  const add = (a: Address) => out.set(key(a), a);
  add(route.currencyIn);
  add(route.currencyOut);
  for (const seg of segmentRoute(route)) {
    add(seg.currencyIn);
    add(seg.currencyOut);
    if (seg.kind === "v3" || seg.kind === "v2") for (const s of seg.steps) add(s.currencyOut);
  }
  return [...out.values()];
}

/** "ETH > USDC > NVDAon > $HARAMBE" style label for a route, using `symbolOf` for each address. */
export function describeRoute(route: Route, symbolOf: (a: Address) => string): string {
  const parts = [symbolOf(route.currencyIn)];
  for (const s of route.steps) parts.push(symbolOf(s.currencyOut));
  return parts.join(" > ");
}

/**
 * A cheap estimate of what `amount` gets along `route`, without any RPC: each pool step is treated as a
 * constant-product pool with the virtual reserves of its current liquidity and price (the liquidity of the
 * active tick range, so crossing ticks is ignored) after its fee. Exact-in returns the output, exact-out the
 * input. Only used to choose which candidates are worth a quoter call; the quoter gives the real number.
 * Raw units, floating point; null when a pool of the route is unknown.
 */
export function estimateRoute(
  route: Route,
  states: ReadonlyMap<string, PoolState>,
  amount: bigint,
  mode: "exactIn" | "exactOut",
  feeBps?: ReadonlyMap<string, number>,
): number | null {
  const steps = route.steps.filter((s): s is Extract<RouteStep, { kind: "pool" }> => s.kind === "pool");
  const hop = (s: Extract<RouteStep, { kind: "pool" }>, value: number, forward: boolean): number | null => {
    const st = states.get(s.poolId);
    if (!st || !st.initialized || st.liquidity === 0n) return null;
    const sqrtP = Number(st.sqrtPriceX96) / 2 ** 96;
    const L = Number(st.liquidity);
    const reserveIn = s.zeroForOne ? L / sqrtP : L * sqrtP;
    const reserveOut = s.zeroForOne ? L * sqrtP : L / sqrtP;
    const fee = (feeBps?.get(s.poolId) !== undefined ? (feeBps.get(s.poolId) as number) / 10_000 : st.lpFee / 1_000_000);
    if (forward) {
      const inAfterFee = value * (1 - fee);
      return (reserveOut * inAfterFee) / (reserveIn + inAfterFee);
    }
    if (value >= reserveOut) return Number.POSITIVE_INFINITY;
    return ((reserveIn * value) / (reserveOut - value)) / (1 - fee);
  };
  let v = Number(amount);
  if (mode === "exactIn") {
    for (const s of steps) {
      const r = hop(s, v, true);
      if (r === null) return null;
      v = r;
    }
  } else {
    for (const s of [...steps].reverse()) {
      const r = hop(s, v, false);
      if (r === null) return null;
      v = r;
    }
  }
  return v;
}

/**
 * Orders `routes` by their {@link estimateRoute} (best first) and keeps the `keep` best: highest estimated
 * output for exact-in, lowest estimated input for exact-out. Routes that cannot be estimated sort last.
 */
export function rankRoutes(
  routes: readonly Route[],
  states: ReadonlyMap<string, PoolState>,
  amount: bigint,
  mode: "exactIn" | "exactOut",
  keep: number,
  feeBps?: ReadonlyMap<string, number>,
): Route[] {
  const scored = routes.map((r, i) => ({ r, i, est: estimateRoute(r, states, amount, mode, feeBps) }));
  scored.sort((a, b) => {
    if (a.est === null || b.est === null) return a.est === b.est ? a.i - b.i : a.est === null ? 1 : -1;
    const d = mode === "exactIn" ? b.est - a.est : a.est - b.est;
    return d !== 0 ? d : a.i - b.i;
  });
  return scored.slice(0, keep).map((x) => x.r);
}
