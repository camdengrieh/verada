"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAppConfig, useDeps } from "@/components/providers";
import { siteBase } from "@/lib/base";
import { quoteAssetLogo } from "@/lib/asset-packs";
import { quoteAssetsFromRows, type AppQuoteAsset } from "@/lib/quote-assets";
import { readQuoteMarkets, withQuoteMarkets } from "@/lib/quote-markets";

/** Site-relative asset paths against the site root (useRel() is wrong inside pages: it sees no layout segments there). */
const resolveAsset = (path: string) => `${siteBase()}${path.replace(/^\//, "")}`;

/**
 * The quote registry's allowlist as library quote assets: names, kinds and logos from the indexer's
 * `/quote-assets`, then (when the chain answers) each asset's fee route, USD price, depth and Ondo
 * pause state from the registry, the v4 StateView and Ondo's pause manager. `marketsLoading` is true
 * while those reads are in flight; the list is usable without them.
 */
export function useQuoteAssets(): {
  assets: AppQuoteAsset[];
  isLoading: boolean;
  marketsLoading: boolean;
  marketsError: unknown;
  error: unknown;
  refetch(): void;
} {
  const config = useAppConfig();
  const deps = useDeps();
  const query = useQuery({ queryKey: ["quote-assets"], queryFn: () => deps.indexer.quoteAssets(), retry: false, staleTime: 300_000 });
  const base = useMemo(() => quoteAssetsFromRows(query.data ?? [], (symbol) => quoteAssetLogo(config, symbol, resolveAsset, 64)), [query.data, config]);
  const key = base.map((a) => a.address).join(",");
  const markets = useQuery({
    queryKey: ["quote-markets", config.factoryAddress, key],
    queryFn: () => readQuoteMarkets(deps.chain(), config, base),
    enabled: base.length > 0,
    retry: false,
    staleTime: 60_000,
  });
  const assets = useMemo(() => withQuoteMarkets(base, markets.data), [base, markets.data]);
  return {
    assets,
    isLoading: query.isLoading,
    marketsLoading: markets.isLoading,
    marketsError: markets.error,
    error: query.error,
    refetch: () => {
      void query.refetch();
      void markets.refetch();
    },
  };
}
