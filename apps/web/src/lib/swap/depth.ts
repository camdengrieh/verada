import type { PublicClient } from "viem";
import { USDC, discoverPools, enumerateRoutes, pickBestQuote, routingNodes, WETH, type RoutingConfig, type SwapAsset } from "@varada/sdk";

export interface QuoteDepth {
  /** Trade size in USD that was quoted. */
  sizeUsd: number;
  /** Price impact in percent of selling that much of the quote asset for USDC, excluding fees. */
  impactPct: number;
}

/**
 * How deep the way from the quote asset to USDC is (the way a token's fees are converted before they
 * are donated): the price impact of selling `sizeUsd` of the quote asset for USDC along the best
 * route of existing v4 pools. Null when there is no route or no price.
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
    return { sizeUsd, impactPct: best.priceImpactPct };
  } catch {
    return null;
  }
}
