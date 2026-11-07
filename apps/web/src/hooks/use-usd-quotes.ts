"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { isAddress } from "viem";
import type { UsdQuote } from "@varada/sdk";
import { useDeps } from "@/components/providers";
import { BASE_PRICED, isStableAddress, loadDiscoveredUsdQuotes, mergeUsdQuotes, registryUsdQuotes } from "@/lib/usd-pricing";
import { useQuoteAssets } from "@/lib/use-quote-assets";

export interface UsdQuotes {
  /** Quotes by lowercase address. */
  quotes: ReadonlyMap<string, UsdQuote>;
  /** The quote for an address; undefined while nothing is known (loading or not requested). */
  quoteFor(address: string | null | undefined): UsdQuote | undefined;
  loading: boolean;
}

/** A Date that moves once a minute, so the Ondo market-closed flag follows the session. */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * The one USD price source of the app: USD per quote asset from the QuoteRegistry route (read in
 * `useQuoteAssets`), with the deepest route of pools the swap engine finds as the fallback, plus
 * depth and a confidence flag. `extra` adds addresses beyond the registry's allowlist and the base
 * set (USDC, WETH). Public data: nothing here carries a wallet address.
 */
export function useUsdQuotes(extra: readonly (string | null | undefined)[] = []): UsdQuotes {
  const deps = useDeps();
  const registry = useQuoteAssets();
  const now = useMinute();
  const regQuotes = useMemo(() => registryUsdQuotes(registry.assets), [registry.assets]);
  const decimals = useMemo(() => new Map(registry.assets.map((a) => [a.address.toLowerCase(), a.decimals] as const)), [registry.assets]);

  const extraKey = extra.filter((a): a is string => Boolean(a) && isAddress(a as string, { strict: false })).map((a) => a.toLowerCase()).sort().join(",");
  const wanted = useMemo(() => {
    const set = new Set<string>([...BASE_PRICED, ...registry.assets.map((a) => a.address), ...(extraKey ? extraKey.split(",") : [])].map((a) => a.toLowerCase()));
    return [...set].sort();
  }, [registry.assets, extraKey]);
  // Only what the registry could not price needs the discovery read.
  const missing = useMemo(() => wanted.filter((a) => !isStableAddress(a) && !regQuotes.has(a)), [wanted, regQuotes]);
  // Wait for the registry's own reads: its prices are preferred and discovery would otherwise run for every asset.
  const registryReady = !registry.isLoading && !registry.marketsLoading;
  const discovered = useQuery({
    queryKey: ["usd-discovered", missing.join(",")],
    enabled: registryReady && missing.length > 0,
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: () => loadDiscoveredUsdQuotes(deps.chain(), missing.map((a) => ({ address: a as Address, decimals: decimals.get(a) ?? 18 }))),
  });

  const quotes = useMemo(() => mergeUsdQuotes(wanted, regQuotes, discovered.data ?? new Map(), now), [wanted, regQuotes, discovered.data, now]);
  const loading = !registryReady || (missing.length > 0 && discovered.isLoading);
  return useMemo(() => ({ quotes, loading, quoteFor: (a) => (a ? quotes.get(a.toLowerCase()) : undefined) }), [quotes, loading]);
}

/** The quote for one asset (plus the base set). */
export function useQuoteUsd(address: string | null | undefined): { quote: UsdQuote | undefined; loading: boolean } {
  const { quoteFor, loading } = useUsdQuotes([address]);
  return { quote: quoteFor(address), loading };
}
