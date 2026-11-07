"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useAppConfig, useDeps } from "@/components/providers";
import { siteBase } from "@/lib/base";
import { fetchNamesCount, MIN_QUERY, NAME_PAGE, normalizeNameQuery, toNameHits } from "@/lib/org-names";
import { useSiteRoot } from "@/lib/site-root";

/** `value`, updated `ms` after it stops changing. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

/**
 * Site-relative href builder. `root` (a relative path to the site root such as "./" or "../")
 * wins; otherwise the app shell's site root, otherwise the root derived from the URL.
 */
export function useNameRel(root?: string): (path: string) => string {
  const ctx = useSiteRoot();
  return useCallback((path: string) => `${root ?? ctx ?? siteBase()}${path.replace(/^\//, "")}`, [root, ctx]);
}

/** Registered names (charity names from the indexer's catalogue, plus the agent names). */
export function useNamesCount() {
  const deps = useDeps();
  return useQuery({
    queryKey: ["org-names-count"],
    queryFn: () => fetchNamesCount(deps.indexer),
    retry: false,
    staleTime: 600_000,
  });
}

/**
 * Charity names matching `query` (name, label or full name, EIN), paged by {@link NAME_PAGE}. Off
 * below {@link MIN_QUERY} characters. A page is null when the indexer has no catalogue loaded.
 */
export function useOrgNameSearch(query: string) {
  const deps = useDeps();
  const { ensParentName } = useAppConfig();
  const q = normalizeNameQuery(query);
  const results = useInfiniteQuery({
    queryKey: ["org-name-search", q],
    queryFn: async ({ pageParam }) => {
      const page = await deps.indexer.catalogSearch({ q, offset: pageParam, limit: NAME_PAGE });
      return page && { total: page.total, count: page.items.length, hits: toNameHits(page.items, ensParentName) };
    },
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      if (!last) return undefined;
      const loaded = all.reduce((n, p) => n + (p?.count ?? 0), 0);
      return loaded < last.total && last.count > 0 ? loaded : undefined;
    },
    enabled: q.length >= MIN_QUERY,
    retry: false,
    staleTime: 60_000,
  });
  const pages = results.data?.pages ?? [];
  return {
    q,
    results,
    /** Null while nothing has loaded; also null when the catalogue is unavailable (see `unavailable`). */
    total: pages[0]?.total ?? null,
    hits: pages.flatMap((p) => p?.hits ?? []),
    unavailable: pages.length > 0 && pages[0] === null,
  };
}
