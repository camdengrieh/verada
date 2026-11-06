"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAppConfig, useDeps } from "@/components/providers";
import { siteBase } from "@/lib/base";
import { quoteAssetLogo } from "@/lib/asset-packs";
import { quoteAssetsFromRows, type AppQuoteAsset } from "@/lib/quote-assets";

/** Site-relative asset paths against the site root (useRel() is wrong inside pages: it sees no layout segments there). */
const resolveAsset = (path: string) => `${siteBase()}${path.replace(/^\//, "")}`;

/**
 * The quote registry's allowlist as library quote assets (names, kinds, logos). Market data
 * (prices, depth, routes, Ondo pause state) is layered on by `useQuoteMarkets`.
 */
export function useQuoteAssets(): { assets: AppQuoteAsset[]; isLoading: boolean; error: unknown; refetch(): void } {
  const config = useAppConfig();
  const deps = useDeps();
  const query = useQuery({ queryKey: ["quote-assets"], queryFn: () => deps.indexer.quoteAssets(), retry: false, staleTime: 300_000 });
  const assets = useMemo(
    () => quoteAssetsFromRows(query.data ?? [], (symbol) => quoteAssetLogo(config, symbol, resolveAsset, 64)),
    [query.data, config],
  );
  return { assets, isLoading: query.isLoading, error: query.error, refetch: () => void query.refetch() };
}
