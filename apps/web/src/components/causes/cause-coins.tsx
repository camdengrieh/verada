"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Button } from "@varada/ui/components/ui/button";
import { Coins } from "@varada/ui/components/ui/icons";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { useTokenLogo } from "@/components/discover/hooks";
import { ResultsError, TokenResults } from "@/components/discover/token-results";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import { loadDiscover, type DiscoverToken } from "@/lib/discover-client";
import { useQuoteAssets } from "@/lib/use-quote-assets";

const LIMIT = 12;

/**
 * Coins that chose this cause as their focus. `/api/discover` matches a focus that overlaps the
 * categories and also returns coins with no focus yet, so only coins whose own focus names one of
 * these causes are kept; when the indexer can only serve the plain list (no focus data), nothing
 * is claimed and the section says so.
 */
export function coinsForCauses(tokens: readonly DiscoverToken[], categories: readonly string[]): DiscoverToken[] {
  return tokens.filter((t) => t.focus !== null && t.focus.categories.some((c) => categories.includes(c)));
}

/** `root`: the relative path to the site root from the page (links stay relative under any gateway). */
export function CauseCoins({ categories, regions = [], causeName, root }: { categories: readonly string[]; regions?: readonly string[]; causeName: string; root: string }) {
  const config = useAppConfig();
  const deps = useDeps();
  const rel = useCallback((path: string) => `${root}${path.replace(/^\//, "")}`, [root]);
  const quotes = useQuoteAssets();
  const logo = useTokenLogo();
  const page = useQuery({
    queryKey: ["cause-coins", categories.join(","), regions.join(",")],
    queryFn: () => loadDiscover(config, deps, { categories, regions, sort: "raised", limit: LIMIT }),
    enabled: categories.length > 0,
    retry: false,
    staleTime: 60_000,
  });
  const coins = useMemo(() => (page.data?.source === "market" ? coinsForCauses(page.data.items, categories) : []), [page.data, categories]);
  const href = rel;
  const ctx = useMemo(() => ({ parent: config.ensParentName, assets: quotes.assets, logo }), [config.ensParentName, quotes.assets, logo]);
  const allHref = `${rel("")}?tab=cause${categories.length === 1 ? `&category=${categories[0]}` : ""}`;

  if (page.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-56 rounded-[24px]" />
        ))}
      </div>
    );
  }
  if (page.error) return <ResultsError message={errorText(page.error) || "The indexer did not answer."} onRetry={() => void page.refetch()} />;
  if (page.data && page.data.source !== "market") {
    return <p className="m-0 rounded-2xl border border-line bg-card px-4 py-3 text-sm text-ink-soft">Coin focus is not available from the indexer right now, so coins cannot be listed by cause.</p>;
  }
  if (coins.length === 0) {
    return (
      <EmptyState
        icon={<Coins aria-hidden="true" />}
        title={`No coin gives to ${causeName.toLowerCase()} yet`}
        body="Launch one and choose this cause as its focus: its trading fees fund these charities every week."
        action={
          <Button asChild variant="cause">
            <a href={rel("launch/")}>Launch a coin</a>
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <TokenResults tokens={coins} ctx={ctx} view="cards" href={href} nowSeconds={Math.floor(Date.now() / 1000)} hasMore={false} loadingMore={false} onLoadMore={() => {}} scrollRoot={null} />
      <a href={allHref} className="self-start text-sm font-semibold text-ink underline-offset-4 hover:underline">
        Every coin for {causeName.toLowerCase()} on Discover
      </a>
    </div>
  );
}
