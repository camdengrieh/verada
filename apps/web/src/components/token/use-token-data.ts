"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDeps, usePrivacyPrefs } from "@/components/providers";
import { subscribeActivity } from "@/lib/activity-stream";
import type { MarketTrade } from "@/lib/indexer";
import { mergeTrades, tokenIsCurrency0, tradeFromActivity } from "@/lib/token-market";

/** Hourly rows for the longest chart range; every shorter range is cut from the same response. */
export const MARKET_HOURS = 168;

/** The pool's market snapshot (price, hourly volume and ticks), refreshed every 30 seconds. */
export function useMarket(address: string) {
  const deps = useDeps();
  return useQuery({
    queryKey: ["token-market", address.toLowerCase()],
    queryFn: () => deps.indexer.market(address, MARKET_HOURS),
    retry: false,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useHolderSummary(address: string) {
  const deps = useDeps();
  return useQuery({ queryKey: ["token-holder-summary", address.toLowerCase()], queryFn: () => deps.indexer.holderSummary(address), retry: false, staleTime: 30_000 });
}

export function useHolders(address: string) {
  const deps = useDeps();
  return useQuery({ queryKey: ["token-holders", address.toLowerCase()], queryFn: () => deps.indexer.holders(address, { limit: 50 }), retry: false, staleTime: 30_000 });
}

const PAGE = 50;

/**
 * Trades newest first: the first page, older pages on request, and new swaps pushed over the
 * activity stream (polling when the indexer is routed through the anon network, which EventSource
 * cannot use). Nothing here sends the viewer's address anywhere: "my trades" is filtered by the caller.
 */
export function useTradeTape(address: string, quote: { quote: string | null; decimals: number | null }) {
  const deps = useDeps();
  const qc = useQueryClient();
  const [prefs] = usePrivacyPrefs();
  const first = useQuery({
    queryKey: ["token-trades", address.toLowerCase()],
    queryFn: () => deps.indexer.trades(address, { limit: PAGE }),
    retry: false,
    staleTime: 15_000,
  });
  const [older, setOlder] = useState<MarketTrade[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string>();
  const [live, setLive] = useState<MarketTrade[]>([]);
  const [mode, setMode] = useState<"sse" | "polling" | null>(null);

  useEffect(() => {
    setOlder([]);
    setLive([]);
    setCursor(undefined);
  }, [address]);

  const nextCursor = cursor === undefined ? (first.data?.nextCursor ?? null) : cursor;

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await deps.indexer.trades(address, { limit: PAGE, cursor: nextCursor });
      setOlder((prev) => mergeTrades(prev, page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      setMoreError(e instanceof Error ? e.message : "Could not load older trades");
    } finally {
      setLoadingMore(false);
    }
  }, [deps.indexer, address, nextCursor]);

  // The latest quote facts live in a ref so the subscription is not rebuilt when the market loads.
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = subscribeActivity(deps.indexer, {
      token: address,
      kind: "trade",
      sse: !prefs.routeIndexer,
      onMode: setMode,
      onItems: (items) => {
        const { quote: q, decimals } = quoteRef.current;
        const c0 = q ? tokenIsCurrency0(address, q) : false;
        const mapped = items.flatMap((i) => tradeFromActivity(i, address, c0, decimals) ?? []);
        if (mapped.length === 0) return;
        setLive((prev) => mergeTrades(prev, mapped));
        // A swap moves the price, volume and holders: refresh them once the burst settles.
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          void qc.invalidateQueries({ queryKey: ["token-market", address.toLowerCase()] });
          void qc.invalidateQueries({ queryKey: ["token-holder-summary", address.toLowerCase()] });
        }, 2_000);
      },
    });
    return () => {
      unsubscribe();
      clearTimeout(timer.current);
    };
  }, [deps.indexer, address, prefs.routeIndexer, qc]);

  const trades = useMemo(() => mergeTrades(older, first.data?.items ?? [], live), [older, first.data, live]);
  return {
    trades,
    loading: first.isLoading,
    error: first.error,
    refetch: () => void first.refetch(),
    hasMore: Boolean(nextCursor),
    loadMore,
    loadingMore,
    moreError,
    mode,
  };
}
