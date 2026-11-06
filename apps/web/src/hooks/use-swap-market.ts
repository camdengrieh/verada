"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { WETH, type SwapAsset, type VaradaMarketToken } from "@varada/sdk";
import { useDeps } from "@/components/providers";
import { loadPoolMarket, type PoolMarket } from "@/lib/swap/market";
import { loadUsdPrices } from "@/lib/swap/usd";
import { useSwapClients } from "./use-swap-clients";

/** USD prices of `assets` from the existing v4 pools (stablecoins at $1). Public data. */
export function useUsdPrices(assets: readonly SwapAsset[]) {
  const { chain } = useSwapClients();
  const key = assets.map((a) => a.address.toLowerCase()).sort().join(",");
  return useQuery({
    queryKey: ["swap-usd", key],
    enabled: assets.length > 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: () => loadUsdPrices(chain, assets),
  });
}

/**
 * Price, liquidity, TVL (quote and USD) and 24 h stats of a token's pool. The pool numbers come from
 * the chain; 24 h change and volume from the indexer (`market()`), absent when it is unreachable.
 */
export function usePoolMarket(token: VaradaMarketToken | null) {
  const { chain } = useSwapClients();
  const { indexer } = useDeps();
  const quoteAssets = useMemo(() => (token ? [token.quote, WETH] : []), [token]);
  const usd = useUsdPrices(quoteAssets);
  const quoteUsd = token ? (usd.data?.get(token.quote.address.toLowerCase()) ?? null) : null;
  const query = useQuery<PoolMarket>({
    queryKey: ["pool-market", token?.address, token?.quote.address, quoteUsd],
    enabled: Boolean(token),
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: () => loadPoolMarket({ chain, indexer, token: token!, quoteUsd }),
  });
  return { market: query.data ?? null, quoteUsd, loading: query.isLoading, error: query.error, refresh: query.refetch };
}
