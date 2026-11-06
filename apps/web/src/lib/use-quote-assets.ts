"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAppConfig, useDeps } from "@/components/providers";
import { useRel } from "@/components/nav";
import { quoteAssetLogo } from "@/lib/asset-packs";
import { quoteAssetsFromRows, type AppQuoteAsset } from "@/lib/quote-assets";

/**
 * The quote registry's allowlist as library quote assets (names, kinds, logos). Market data
 * (prices, depth, routes, Ondo pause state) is layered on by `useQuoteMarkets`.
 */
export function useQuoteAssets(): { assets: AppQuoteAsset[]; isLoading: boolean; error: unknown; refetch(): void } {
  const config = useAppConfig();
  const deps = useDeps();
  const rel = useRel();
  const query = useQuery({ queryKey: ["quote-assets"], queryFn: () => deps.indexer.quoteAssets(), retry: false, staleTime: 300_000 });
  const assets = useMemo(
    () => quoteAssetsFromRows(query.data ?? [], (symbol) => quoteAssetLogo(config, symbol, rel, 64)),
    [query.data, config, rel],
  );
  return { assets, isLoading: query.isLoading, error: query.error, refetch: () => void query.refetch() };
}
