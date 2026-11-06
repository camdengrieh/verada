"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type SwapAsset, type UsdQuote, type VaradaMarketToken } from "@varada/sdk";
import { useDeps } from "@/components/providers";
import { loadPoolMarket, type PoolMarket } from "@/lib/swap/market";
import { useSwapClients } from "./use-swap-clients";
import { useUsdQuotes } from "./use-usd-quotes";

/**
 * USD prices of `assets` from the shared pricing layer (`useUsdQuotes`): stablecoins at $1, the
 * QuoteRegistry route first, the deepest discovered route of v4 pools as the fallback. Public data.
 * Assets without a route are left out.
 */
export function useUsdPrices(assets: readonly SwapAsset[]) {
  const { quotes, loading } = useUsdQuotes(assets.map((a) => a.address));
  const data = useMemo(() => {
    const out = new Map<string, number>();
    for (const a of assets) {
      const q = quotes.get(a.address.toLowerCase());
      if (q?.priceUsd != null) out.set(a.address.toLowerCase(), q.priceUsd);
    }
    return out;
  }, [assets, quotes]);
  return { data: loading && data.size === 0 ? undefined : data, isLoading: loading };
}

/**
 * Price, liquidity, TVL (quote and USD) and 24 h stats of a token's pool. The pool numbers come from
 * the chain; 24 h change and volume from the indexer (`market()`), absent when it is unreachable.
 * `quoteUsdQuote` carries the depth and confidence behind the dollar figures.
 */
export function usePoolMarket(token: VaradaMarketToken | null) {
  const { chain } = useSwapClients();
  const { indexer } = useDeps();
  const { quoteFor } = useUsdQuotes([token?.quote.address]);
  const quoteUsdQuote: UsdQuote | null = token ? (quoteFor(token.quote.address) ?? null) : null;
  const quoteUsd = quoteUsdQuote?.priceUsd ?? null;
  const query = useQuery<PoolMarket>({
    queryKey: ["pool-market", token?.address, token?.quote.address, quoteUsd],
    enabled: Boolean(token),
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: () => loadPoolMarket({ chain, indexer, token: token!, quoteUsd }),
  });
  return { market: query.data ?? null, quoteUsd, quoteUsdQuote, loading: query.isLoading, error: query.error, refresh: query.refetch };
}
