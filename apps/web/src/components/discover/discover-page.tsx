"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PullToRefresh } from "@varada/ui/components/mobile/pull-to-refresh";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@varada/ui/components/ui/tabs";
import { useAppConfig } from "@/components/providers";
import { stocksTabEmpty, TABS, TAB_LABELS, type DiscoverState, type DiscoverTab } from "@/lib/discover";
import { errorText } from "@/components/use-tx";
import { useQuoteAssets } from "@/lib/use-quote-assets";
import { Filters } from "./filters";
import { HomeHero } from "./hero";
import { useDiscoverList, useDiscoverState, useLiveActivity, useNow, usePlatformStats, useRel, useTokenLogo } from "./hooks";
import { LiveGiving, LiveTicker } from "./live-giving";
import { CadenceFilter, CauseChooser, PairsPanel } from "./panels";
import { ResultsEmpty, ResultsError, ResultsSkeleton, TokenResults, useResultsView, ViewToggle } from "./token-results";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Coins } from "@varada/ui/components/ui/icons";

/** True below 768px, after mount. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

const TAB_HINT: Record<DiscoverTab, string> = {
  trending: "Most trades in the last 24 hours.",
  new: "Newest launches first.",
  stocks: "Coins paired with tokenized stocks, ETFs and other Ondo assets.",
  cause: "Pick a cause to see the coins that fund it.",
  live: "Every swap donates straight away; the charity rotates on a schedule.",
};

/** Home: hero with live totals, discovery tabs and filters, the coin list, and live giving. */
export function DiscoverPage() {
  const config = useAppConfig();
  const rel = useRel();
  const [state, update] = useDiscoverState();
  const quotes = useQuoteAssets();
  const stats = usePlatformStats();
  const live = useLiveActivity();
  const logo = useTokenLogo();
  const now = useNow(60_000);
  const mobile = useIsMobile();
  const [view, setView] = useResultsView();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  // Tabs and pair filters depend on which pairs the registry allowlists; wait for that list first.
  const needsPairs = state.tab === "stocks" || Boolean(state.pair);
  const stocksMissing = stocksTabEmpty(state, quotes.assets);
  const list = useDiscoverList(state, quotes.assets, !quotes.isLoading || !needsPairs ? !stocksMissing : false);

  const pages = list.data?.pages ?? [];
  const tokens = useMemo(() => pages.flatMap((p) => p.items), [pages]);
  const source = pages[0]?.source;
  const total = pages[0]?.total ?? null;
  const filtered = Boolean(state.q || state.pair || state.category || state.region || state.mode || state.cadence || state.tab === "stocks" || state.tab === "live" || state.tab === "cause");
  const nowSeconds = now ? Math.floor(now.getTime() / 1000) : 0;
  const href = useCallback((path: string) => rel(path), [rel]);
  const ctx = useMemo(() => ({ parent: config.ensParentName, assets: quotes.assets, logo }), [config.ensParentName, quotes.assets, logo]);

  const refresh = useCallback(async () => {
    await Promise.all([list.refetch(), stats.refetch()]);
    quotes.refetch();
  }, [list, stats, quotes]);

  const clear = () => update({ pair: null, category: null, region: null, mode: null, cadence: null, q: "", tab: state.tab === "stocks" || state.tab === "live" ? state.tab : "trending" });
  // A pair belongs to the tab it was picked on (a crypto pair makes no sense under Stocks), so a tab change drops it.
  const onTab = (tab: string) => update({ tab: tab as DiscoverTab, pair: null, cadence: null });

  const body = (() => {
    if (stocksMissing) return null;
    if (list.isLoading || (needsPairs && quotes.isLoading)) return <ResultsSkeleton view={view} />;
    if (list.error) return <ResultsError message={errorText(list.error) || "The indexer did not answer."} onRetry={() => void list.refetch()} />;
    if (tokens.length === 0) return <ResultsEmpty filtered={filtered} onClear={clear} launchHref={rel("launch/")} />;
    return (
      <TokenResults
        tokens={tokens}
        ctx={ctx}
        view={view}
        href={href}
        nowSeconds={nowSeconds}
        hasMore={Boolean(list.hasNextPage)}
        loadingMore={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
        scrollRoot={mobile ? scroller : null}
      />
    );
  })();

  return (
    <div className="flex flex-col gap-8">
      <h1 className="sr-only">Varada: memecoins that give back</h1>
      <LiveTicker live={live} assets={quotes.assets} />
      <HomeHero stats={stats.data} />

      <section id="coins" aria-labelledby="coins-title" className="flex scroll-mt-24 flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="coins-title" className="m-0 font-display text-3xl font-semibold">
              Discover coins
            </h2>
            <p className="m-0 mt-1 text-sm text-ink-soft" aria-live="polite">
              {TAB_HINT[state.tab]}
              {total !== null && source === "market" ? ` ${total.toLocaleString("en-US")} ${total === 1 ? "coin" : "coins"}.` : ""}
            </p>
          </div>
          <ViewToggle value={view} onChange={setView} />
        </div>

        <Tabs value={state.tab} onValueChange={onTab}>
          <TabsList aria-label="Coin lists" scrollable>
            {TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
                {TAB_LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={state.tab} className="mt-4 flex flex-col gap-4">
            {state.tab === "cause" ? <CauseChooser selected={state.category} onSelect={(category) => update({ category })} /> : null}
            {state.tab === "stocks" ? <PairsPanel assets={quotes.assets} selected={state.pair} onPick={(pair) => update({ pair })} loading={quotes.isLoading} marketsLoading={quotes.marketsLoading} /> : null}
            {state.tab === "live" ? <CadenceFilter value={state.cadence} onChange={(cadence) => update({ cadence })} /> : null}
            <Filters state={state} assets={quotes.assets} onChange={update} />
            {source && source !== "market" ? (
              <p role="note" className="m-0 rounded-2xl border border-line bg-paper-card px-4 py-3 text-sm text-ink-soft">
                {source === "chain"
                  ? "The indexer is unreachable, so these coins were read straight from the chain: no prices, and only the search applies."
                  : "Market data is unavailable right now: prices, pair, cause and mode filters are not applied."}
              </p>
            ) : null}
            {stocksMissing ? <EmptyState size="compact" icon={<Coins />} title="No stock pairs to list" body="No Ondo stock or ETF is allowlisted as a pair yet, so there are no coins to show here." /> : null}
            {mobile ? (
              <PullToRefresh onRefresh={refresh} scrollRef={setScroller} scrollClassName="max-h-[78dvh] pb-4" labels={{ button: "Refresh coins" }}>
                {body}
              </PullToRefresh>
            ) : (
              body
            )}
          </TabsContent>
        </Tabs>
      </section>

      <LiveGiving live={live} stats={stats.data} statsLoading={stats.isLoading} assets={quotes.assets} />
    </div>
  );
}
