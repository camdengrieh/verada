import type { PublicClient } from "viem";
import { DEFAULT_MAX_PRICE_IMPACT_PCT, SwapError, USDC, discoverPools, enumerateRoutes, pickBestQuote, routingNodes, WETH, type RoutingConfig, type SwapAsset } from "@varada/sdk";

export interface QuoteDepth {
  /** Trade size in USD that was quoted. */
  sizeUsd: number;
  /** Price impact in percent of selling that much of the quote asset for USDC, excluding fees. Null: no route of existing pools can fill that size (a thin pool). */
  impactPct: number | null;
}

/**
 * How deep the way from the quote asset to USDC is (the way a token's fees are converted before they
 * are donated): the price impact of selling `sizeUsd` of the quote asset for USDC along the best
 * route of existing v4 pools. `impactPct` is null when the routes are too thin to fill the size or the impact reaches the engine's block threshold; the whole
 * result is null when there is no route, no price or the read failed.
 */
export async function loadQuoteRouteDepth(chain: PublicClient, quote: SwapAsset, quoteUsd: number | null, sizeUsd = 10_000, routing: RoutingConfig = {}): Promise<QuoteDepth | null> {
  if (!quoteUsd || quoteUsd <= 0) return null;
  const pools = await discoverPools(chain, routingNodes(routing, [quote.address, USDC.address]), routing);
  const routes = enumerateRoutes(pools, quote.address, USDC.address, { weth: WETH.address });
  if (routes.length === 0) return null;
  const amount = BigInt(Math.floor((sizeUsd / quoteUsd) * 10 ** Math.min(quote.decimals, 12))) * 10n ** BigInt(Math.max(0, quote.decimals - 12));
  if (amount <= 0n) return null;
  try {
    const { best } = await pickBestQuote(chain, routes, "exactIn", amount, {
      tokenIn: quote,
      tokenOut: USDC,
      states: new Map(pools.map((p) => [p.poolId, p])),
    });
    // pickBestQuote never throws for impact: the trade engine blocks a quote at this threshold (`price-impact`),
    // so a size at or past it is one the route cannot fill in the same sense.
    return { sizeUsd, impactPct: best.priceImpactPct >= DEFAULT_MAX_PRICE_IMPACT_PCT ? null : best.priceImpactPct };
  } catch (e) {
    return e instanceof SwapError && e.reason === "insufficient-liquidity" ? { sizeUsd, impactPct: null } : null;
  }
}
