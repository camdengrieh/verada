"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImageSource } from "@varada/ui/components/varada/shared";
import { swarmGatewayUrl } from "@varada/sdk";
import { causeNameOf } from "@/lib/discover";
import { siteBase } from "@/lib/base";
import { useSiteRoot } from "@/lib/site-root";
import { usePrivacyPrefs, useAppConfig, useDeps } from "@/components/providers";
import { mergeActivity } from "@/lib/activity";
import { subscribeActivity } from "@/lib/activity-stream";
import { buildQuery, DEFAULT_STATE, parseState, stateToSearch, type DiscoverState } from "@/lib/discover";
import { fetchDiscover, loadDiscover } from "@/lib/discover-client";
import type { ActivityItem, CatalogOrg } from "@/lib/indexer";
import type { AppQuoteAsset } from "@/lib/quote-assets";
import type { CauseName } from "@varada/ui/components/varada/cause-icon";

/** Event that tells every discover view the URL changed (history.pushState does not fire one). */
export const URL_EVENT = "varada:url";

/** Re-renders every `ms` with the current time. Starts at null so server and client markup agree. */
export function useNow(ms = 30_000): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The discover state, kept in the query string (`?tab=stocks&pair=NVDAon`) without navigating. */
export function useDiscoverState(): [DiscoverState, (patch: Partial<DiscoverState>, opts?: { replace?: boolean }) => void, boolean] {
  const [state, setState] = useState<DiscoverState>(DEFAULT_STATE);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const read = () => setState(parseState(window.location.search));
    read();
    setReady(true);
    window.addEventListener("popstate", read);
    window.addEventListener(URL_EVENT, read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener(URL_EVENT, read);
    };
  }, []);
  const update = useCallback((patch: Partial<DiscoverState>, opts: { replace?: boolean } = {}) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      const search = stateToSearch(next);
      try {
        const url = `${window.location.pathname}${search}${window.location.hash}`;
        if (opts.replace) window.history.replaceState(null, "", url);
        else window.history.pushState(null, "", url);
      } catch {
        // history can be unavailable in sandboxed frames; the state still applies
      }
      return next;
    });
  }, []);
  return [state, update, ready];
}

/** Platform totals from `/api/stats`, polled gently. */
export function usePlatformStats() {
  const deps = useDeps();
  return useQuery({ queryKey: ["stats"], queryFn: () => deps.indexer.stats(), retry: false, staleTime: 15_000, refetchInterval: 45_000 });
}

/** The discover list, one cursor page at a time. `enabled` waits for the pairs a tab depends on. */
export function useDiscoverList(state: DiscoverState, assets: readonly AppQuoteAsset[], enabled: boolean) {
  const config = useAppConfig();
  const deps = useDeps();
  const base = useMemo(() => buildQuery(state, assets), [state, assets]);
  const key = JSON.stringify(base);
  return useInfiniteQuery({
    queryKey: ["discover", key],
    queryFn: ({ pageParam }) => loadDiscover(config, deps, { ...base, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    retry: false,
    staleTime: 15_000,
  });
}

/** URL of a token logo on the Swarm gateway, as a library image. */
export function useTokenLogo(): (ref: string | null) => ImageSource | undefined {
  const config = useAppConfig();
  const gateway = config.swarmGatewayUrl;
  return useCallback(
    (ref: string | null) => {
      if (!gateway || !ref) return undefined;
      try {
        return { src: swarmGatewayUrl(gateway, ref) };
      } catch {
        return undefined;
      }
    },
    [gateway],
  );
}

/** Calls `onVisible` when the sentinel scrolls into view (infinite pagination); `root` is the scroller when it is not the page. */
export function useSentinel(onVisible: () => void, enabled: boolean, root?: Element | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { root: root ?? null, rootMargin: "320px" });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, root]);
  return ref;
}

/**
 * Live activity: the latest page, then new items from the SSE stream (polling when SSE fails, or
 * when indexer traffic is routed privately, since EventSource cannot use the anon network's fetch).
 */
export interface LiveActivity {
  items: ActivityItem[];
  fresh: ReadonlySet<string>;
  mode: "sse" | "polling" | null;
  loading: boolean;
  error: boolean;
}

export function useLiveActivity(max = 40): LiveActivity {
  const deps = useDeps();
  const [prefs] = usePrivacyPrefs();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<"sse" | "polling" | null>(null);
  const first = useQuery({ queryKey: ["activity", "latest"], queryFn: () => deps.indexer.activity({ limit: 30 }), retry: false, staleTime: 15_000 });
  useEffect(() => {
    if (first.data) setItems((prev) => mergeActivity(prev, first.data.items, max));
  }, [first.data, max]);
  useEffect(() => {
    const stop = subscribeActivity(deps.indexer, {
      sse: !prefs.routeIndexer,
      onMode: setMode,
      onItems: (incoming) => {
        setItems((prev) => mergeActivity(prev, incoming, max));
        setFresh((prev) => new Set([...prev, ...incoming.map((i) => i.id)]));
      },
    });
    return stop;
  }, [deps.indexer, prefs.routeIndexer, max]);
  return { items, fresh, mode, loading: first.isLoading, error: Boolean(first.error) };
}

/** Symbols of tokens by address, fetched in one bulk call for whatever the caller has not seen yet. */
export function useTokenSymbols(addresses: readonly (string | undefined)[]): ReadonlyMap<string, string> {
  const deps = useDeps();
  const [known, setKnown] = useState<ReadonlyMap<string, string>>(new Map());
  const missing = useMemo(
    () => [...new Set(addresses.filter((a): a is string => !!a).map((a) => a.toLowerCase()))].filter((a) => !known.has(a)).sort().slice(0, 50),
    [addresses, known],
  );
  const key = missing.join(",");
  useEffect(() => {
    if (!key) return;
    let live = true;
    fetchDiscover(deps.indexer, { tokens: key.split(","), limit: 50 })
      .then((page) => {
        if (!live) return;
        setKnown((prev) => {
          const next = new Map(prev);
          for (const a of key.split(",")) if (!next.has(a)) next.set(a, "");
          for (const t of page.items) if (t.symbol) next.set(t.address.toLowerCase(), t.symbol);
          return next;
        });
      })
      .catch(() => {
        if (live) setKnown((prev) => new Map([...prev, ...key.split(",").map((a) => [a, ""] as const)]));
      });
    return () => {
      live = false;
    };
  }, [key, deps.indexer]);
  return known;
}

/** Name and category of causes by id, from the catalogue (one bulk call per new set). */
export function useCauseLookup(causeIds: readonly (string | undefined)[]): (id: string | undefined) => { name: string; cause: CauseName } | undefined {
  const deps = useDeps();
  const ids = useMemo(() => [...new Set(causeIds.filter((c): c is string => !!c).map((c) => c.toLowerCase()))].sort().slice(0, 50), [causeIds]);
  const q = useQuery({ queryKey: ["catalog-names", ids.join(",")], queryFn: () => deps.indexer.catalogCauses(ids), enabled: ids.length > 0, retry: false, staleTime: 600_000 });
  return useCallback(
    (id) => {
      const org: CatalogOrg | undefined = id ? q.data?.get(id.toLowerCase()) : undefined;
      return org ? { name: org.name, cause: causeNameOf(org.categories[0] ?? "other") } : undefined;
    },
    [q.data],
  );
}

/**
 * Site-relative href builder. `useRel()` from nav is only right in the root layout (a page sees no
 * layout segments), so page components resolve against the site root from the URL instead.
 */
export function useRel(): (path: string) => string {
  const root = useSiteRoot();
  return useCallback((path) => `${root ?? siteBase()}${path.replace(/^\//, "")}`, [root]);
}
