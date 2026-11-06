/**
 * The trading engine: one call from "what does this trade cost" to a ready Universal Router
 * transaction. Pure orchestration of the other modules over a read client.
 */
import type { Address } from "viem";
import { ondoTokensIn, checkOndoTradable, type ComplianceOptions, type ComplianceReport } from "./compliance.js";
import { SwapError, mapSwapError, type SwapReason } from "./errors.js";
import { readVaradaFee } from "./fee.js";
import { poolIdOf, varadaPoolKey, type ReadClient } from "./pool.js";
import { applySlippage, pickBestQuote, type BestQuote, type QuoteContext } from "./quote.js";
import { describeRoute, discoverPools, enumerateRoutes, movingCurrencies, rankRoutes, resolveRoutingConfig, routingNodes, type RoutingConfig } from "./routing.js";
import { routeVenues } from "./venues.js";
import { VARADA_TOKEN_DECIMALS } from "./constants.js";
import type { PoolState, QuoteMode, RouteQuote, SwapAsset, SwapVenue, TradeSide, VaradaFeeInfo, VaradaMarketToken } from "./types.js";

export interface TradeRequest {
  token: VaradaMarketToken;
  side: TradeSide;
  /** The asset paid with (buy) or received (sell). */
  asset: SwapAsset;
  /** Exact-in: the amount paid (buy: asset, sell: token). Exact-out: the amount received. Raw units. */
  amount: bigint;
  mode?: QuoteMode;
  /** Slippage tolerance in basis points (50 = 0.5%). */
  slippageBps: number;
}

/** Trades that would move the price by this much or more are blocked (`price-impact`), in percent. */
export const DEFAULT_MAX_PRICE_IMPACT_PCT = 30;

export interface TradeContext {
  routing?: RoutingConfig;
  /** Block trades whose price impact (net of fees) reaches this percent. Default {@link DEFAULT_MAX_PRICE_IMPACT_PCT}. */
  maxImpactPct?: number;
  /** Extra Ondo / compliance inputs; see {@link ComplianceOptions}. */
  compliance?: ComplianceOptions;
}

export interface TradeQuote {
  request: TradeRequest;
  mode: QuoteMode;
  best: RouteQuote;
  /** Other routes that quoted, best first (includes `best`). */
  alternatives: RouteQuote[];
  routeLabel: string;
  /** Venues the best route trades on ("v4", "v3", "v2"), in order of use. */
  venues: SwapVenue[];
  /** The asset the user pays / receives and the token, in trade order. */
  payAsset: SwapAsset;
  receiveAsset: SwapAsset;
  /** Raw amounts of the trade: pay and receive. */
  amountIn: bigint;
  amountOut: bigint;
  /** Slippage-adjusted limits: the least received and the most paid. */
  amountOutMin: bigint;
  amountInMax: bigint;
  fee: VaradaFeeInfo;
  /** Varada fee as a fraction (0.025 = 2.5%). */
  feeFraction: number;
  compliance: ComplianceReport;
  /** Typed reasons that stop the trade. Empty when it can go ahead. */
  blockers: SwapReason[];
  /** Pool of the token, for the liquidity display. */
  tokenPool: PoolState | null;
  /** Wall-clock time of the quote (ms). */
  quotedAt: number;
  /** What the quote was made with; lets callers quote more sizes on the same route (`quoteRoute`). */
  context: QuoteContext;
}

/**
 * Ondo checks for the tokens of a route. A paused token blocks the trade when it is the one the user pays or
 * receives or the token's quote asset (the pool prices against it, and the live hook converts fees in it). An Ondo
 * token that is only an intermediate hop inside a v4 segment never moves as an ERC-20 (the pool manager nets its flow
 * to zero inside the swap, checked on a fork), so a pause there is reported as a warning. A token between two segments
 * or a hop of a v3 / v2 pool is really transferred: `binding` includes those (`movingCurrencies`), so a pause blocks.
 */
async function checkRouteOndo(client: ReadClient, routeCurrencies: readonly Address[], binding: readonly Address[], opts?: ComplianceOptions): Promise<ComplianceReport> {
  const bindingSet = new Set(binding.map((a) => a.toLowerCase()));
  const all = ondoTokensIn(routeCurrencies);
  const direct = all.filter((a) => bindingSet.has(a.toLowerCase()));
  const intermediate = all.filter((a) => !bindingSet.has(a.toLowerCase()));
  const report = await checkOndoTradable(client, direct, opts);
  if (intermediate.length > 0) {
    const passing = await checkOndoTradable(client, intermediate);
    for (const b of passing.blockers) {
      report.warnings.push({ ...b, message: `${b.symbol ?? "A token"} on the route is paused by Ondo; the trade passes through it without moving it` });
    }
    report.checked.push(...passing.checked);
  }
  return report;
}

/**
 * Quotes a buy or sell of a Varada token in any hub asset: reads the token's fee from its hook,
 * discovers which Uniswap v4, v3 and v2 pools exist among the hubs, enumerates 1-3 hop routes (mixing venues), quotes
 * each through the V4Quoter / v3 QuoterV2 / v2 Router02 and keeps the best (highest output / lowest input). Also runs the Ondo
 * pause / compliance checks for the Ondo tokens on the route.
 *
 * Throws {@link SwapError} (`no-route`, `insufficient-liquidity`, `pool-not-initialized`, ...) when
 * the trade cannot be quoted at all; trade-level blockers that do not prevent a quote (paused Ondo
 * asset, blocked address) come back in `blockers`.
 */
export async function quoteTrade(client: ReadClient, req: TradeRequest, ctx: TradeContext = {}): Promise<TradeQuote> {
  const cfg = resolveRoutingConfig(ctx.routing);
  const mode: QuoteMode = req.mode ?? "exactIn";
  if (req.amount <= 0n) throw new SwapError("zero-amount");
  const token = req.token;
  const tokenAsset: SwapAsset = { address: token.address, symbol: token.symbol, decimals: token.decimals ?? VARADA_TOKEN_DECIMALS };
  const payAsset = req.side === "buy" ? req.asset : tokenAsset;
  const receiveAsset = req.side === "buy" ? tokenAsset : req.asset;
  if (req.asset.address.toLowerCase() === token.address.toLowerCase()) throw new SwapError("unsupported-asset");

  const tokenKey = varadaPoolKey(token.address, token.quote.address, token.hook);
  const nodes = routingNodes(ctx.routing ?? {}, [req.asset.address, token.quote.address]);
  const [pools, fee] = await Promise.all([
    discoverPools(client, nodes, ctx.routing, [tokenKey]),
    readVaradaFee(client, token.address, token.hook, { mode: token.mode }),
  ]);
  const tokenPoolId = poolIdOf(tokenKey);
  const tokenPool = pools.find((p) => p.poolId === tokenPoolId) ?? null;
  if (!tokenPool) throw new SwapError("pool-not-initialized", "This token's pool has no liquidity");

  const [from, to] = req.side === "buy" ? [req.asset.address, token.address] : [token.address, req.asset.address];
  const candidates = enumerateRoutes(pools, from, to, { weth: cfg.env.weth, maxHops: cfg.maxHops, poolsPerPair: cfg.poolsPerPair, maxCandidates: cfg.maxCandidates });
  if (candidates.length === 0) throw new SwapError("no-route");

  const states = new Map(pools.map((p) => [p.poolId, p] as const));
  const context: QuoteContext = {
    env: cfg.env,
    tokenIn: payAsset,
    tokenOut: receiveAsset,
    states,
    feeBps: new Map([[tokenPoolId, fee.feeBps]]),
  };
  // Each quoter call simulates the whole route, which is costly over a slow RPC: estimate every candidate
  // from the pools' liquidity and price first and quote the most promising few. If none of them can fill
  // the size (a thin pool runs out of liquidity), the next few are tried.
  const ranked = rankRoutes(candidates, states, req.amount, mode, candidates.length, context.feeBps);
  let picked: BestQuote | null = null;
  let firstError: unknown;
  for (let i = 0; i < ranked.length && !picked; i += cfg.quoteTop) {
    try {
      picked = await pickBestQuote(client, ranked.slice(i, i + cfg.quoteTop), mode, req.amount, context);
    } catch (e) {
      const err = e instanceof SwapError ? e : mapSwapError(e);
      if (err.reason === "rpc-unavailable") throw err;
      if (firstError === undefined || (firstError instanceof SwapError && firstError.reason === "insufficient-liquidity" && err.reason !== "insufficient-liquidity")) firstError = err;
    }
  }
  if (!picked) throw firstError;
  const { best, all } = picked;

  const limits = applySlippage(best, req.slippageBps);
  const currencies = best.route.steps.flatMap((s) => [s.currencyIn, s.currencyOut]);
  const compliance = await checkRouteOndo(client, currencies, [payAsset.address, receiveAsset.address, token.quote.address, ...movingCurrencies(best.route)], ctx.compliance);
  const blockers: SwapReason[] = compliance.blockers.map((b) => b.reason);
  if (best.priceImpactPct >= (ctx.maxImpactPct ?? DEFAULT_MAX_PRICE_IMPACT_PCT)) blockers.push("price-impact");

  const symbols = new Map<string, string>([tokenAsset, token.quote, req.asset, ...cfg.hubs, ...cfg.extraHubs].map((x) => [x.address.toLowerCase(), x.symbol] as [string, string]));
  const routeLabel = describeRoute(best.route, (a) => symbols.get(a.toLowerCase()) ?? `${a.slice(0, 6)}…${a.slice(-4)}`);
  return {
    request: req,
    mode,
    best,
    alternatives: all,
    routeLabel,
    venues: routeVenues(best.route),
    payAsset,
    receiveAsset,
    amountIn: best.amountIn,
    amountOut: best.amountOut,
    amountOutMin: limits.amountOutMin,
    amountInMax: limits.amountInMax,
    fee,
    feeFraction: fee.feeBps / 10_000,
    compliance,
    blockers,
    tokenPool,
    quotedAt: Date.now(),
    context,
  };
}

/** Whether the router needs the user's address for this quote's pay asset (ERC-20 input). */
export function paysNative(q: Pick<TradeQuote, "payAsset">): boolean {
  return q.payAsset.address.toLowerCase() === "0x0000000000000000000000000000000000000000";
}

