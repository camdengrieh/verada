"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { CATEGORIES, REGIONS } from "@varada/sdk";
import { FilterSheet, countFilters, type FilterGroup, type FilterValue } from "@varada/ui/components/mobile/filter-sheet";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { HandHeart, Search, SlidersHorizontal, X } from "@varada/ui/components/ui/icons";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Label } from "@varada/ui/components/ui/label";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { HeroCause } from "@varada/ui/components/varada/hero-cause";
import { HeroStats } from "@varada/ui/components/varada/hero-shared";
import { usdFormatOptions } from "@varada/ui/components/varada/impact-shared";
import { CategoryGrid } from "@/components/causes/category-grid";
import { CauseCoins } from "@/components/causes/cause-coins";
import { CausesLeaderboardSection } from "@/components/causes/causes-leaderboard";
import { categoryLabelOf, regionLabelOf } from "@/components/causes/org-card";

import { CauseSearch } from "@/components/cause-search";
import { CatalogResults, FocusPicker, useDebounced } from "@/components/catalog-browser";
import { useRel } from "@/components/nav";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import { agentHref } from "@/components/agent-common";
import { listAgents } from "@/lib/agents";
import {
  agentLabelOfSlug,
  causeNameOfSlug,
  causesQueryString,
  fetchCauseLeaderboard,
  parseCausesQuery,
  usdcToNumber,
  type CausesQueryState,
} from "@/lib/causes-client";

const EMPTY: CausesQueryState = { q: "", categories: [], regions: [] };

function Section({ id, kicker, title, children, aside }: { id: string; kicker: string; title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} id={id} className="@container flex scroll-mt-24 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex flex-col gap-1">
          <span className="kicker">{kicker}</span>
          <h2 id={`${id}-h`} className="m-0 font-display text-2xl font-semibold @lg:text-3xl">
            {title}
          </h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * The Causes page: totals, the 21 categories, who has received the most, the catalogue browser with
 * category and region filters (a filter sheet on phones), and Endaoment search. Filters live in the
 * URL (`?category=&region=&q=`), so a cause page can be linked to.
 */
export function CausesExplorer() {
  const config = useAppConfig();
  const deps = useDeps();
  const rel = useRel();
  const [filters, setFilters] = useState<CausesQueryState>(EMPTY);
  const [qInput, setQInput] = useState("");
  const [ready, setReady] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const searchId = useId();

  // The page is statically exported, so the query string is only known in the browser.
  useEffect(() => {
    const initial = parseCausesQuery(window.location.search);
    setFilters(initial);
    setQInput(initial.q);
    setReady(true);
  }, []);
  const q = useDebounced(qInput.trim());
  useEffect(() => {
    if (ready) setFilters((f) => (f.q === q ? f : { ...f, q }));
  }, [q, ready]);
  useEffect(() => {
    if (!ready) return;
    const next = `${window.location.pathname}${causesQueryString(filters)}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", next);
  }, [filters, ready]);

  const catalog = useQuery({ queryKey: ["catalog-summary"], queryFn: () => deps.indexer.catalog(), retry: false, staleTime: 300_000 });
  const board = useInfiniteQuery({
    queryKey: ["cause-leaderboard"],
    queryFn: ({ pageParam }) => fetchCauseLeaderboard(deps.indexer, { cursor: pageParam, limit: 10 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
    retry: false,
    staleTime: 30_000,
  });
  const stats = useQuery({ queryKey: ["stats"], queryFn: () => deps.indexer.stats(), retry: false, staleTime: 30_000 });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => listAgents(deps.indexer), retry: false, staleTime: 300_000 });

  const firstBoard = board.data?.pages[0];
  const rows = useMemo(() => (board.data?.pages ?? []).flatMap((p) => p?.items ?? []), [board.data]);
  const byCategory = firstBoard?.byCategory;

  const toggleCategory = (slug: string) =>
    setFilters((f) => ({ ...f, categories: f.categories.includes(slug) ? f.categories.filter((s) => s !== slug) : [...f.categories, slug] }));
  const setFocus = useCallback((next: { categories: string[]; regions: string[] }) => setFilters((f) => ({ ...f, ...next })), []);
  const clearAll = () => {
    setFilters(EMPTY);
    setQInput("");
  };

  const sheetGroups: FilterGroup[] = useMemo(
    () => [
      { id: "categories", label: "Cause", type: "multi", options: CATEGORIES.map((c) => ({ value: c.slug, label: c.label, count: catalog.data?.categories.find((x) => x.slug === c.slug)?.orgs })) },
      { id: "regions", label: "Region", type: "multi", options: REGIONS.map((r) => ({ value: r.slug, label: r.label, count: catalog.data?.regions.find((x) => x.slug === r.slug)?.orgs })) },
    ],
    [catalog.data],
  );
  const sheetValue: FilterValue = { categories: filters.categories, regions: filters.regions };
  const nFilters = countFilters(sheetValue);

  const given = firstBoard ? usdcToNumber(firstBoard.totals.donated) : typeof stats.data?.donatedUsdc === "string" && /^\d+$/.test(stats.data.donatedUsdc) ? usdcToNumber(BigInt(stats.data.donatedUsdc)) : undefined;
  const single = filters.categories.length === 1 ? filters.categories[0]! : undefined;
  const singleDef = single ? CATEGORIES.find((c) => c.slug === single) : undefined;
  const agentLabel = single ? agentLabelOfSlug(single) : undefined;
  const agent = agentLabel ? agents.data?.find((a) => a.label === agentLabel) : undefined;
  const agentLink = (label: string) => agentHref(rel(""), label);

  return (
    <div className="flex flex-col gap-10 pb-6">
      {singleDef && single ? (
        <HeroCause
          cause={causeNameOfSlug(single)}
          title={singleDef.label}
          description={`Every charity in the Varada catalogue working on ${singleDef.label.toLowerCase()}. Coins that focus on this cause give to them, and holders choose between them by private vote.`}
          raised={byCategory ? usdcToNumber(byCategory.find((c) => c.slug === single)?.donated ?? 0n) : 0}
          charities={catalog.data?.categories.find((c) => c.slug === single)?.orgs ?? 0}
          curator={
            agent
              ? { ens: agent.ensName || `${agent.label}.agent.${config.ensParentName}`, agentId: agent.agentId, status: agent.active ? "active" : "paused", siteHref: agentLink(agent.label) }
              : undefined
          }
          actions={[
            ...(agentLabel ? [{ label: "Curator agent", href: agentLink(agentLabel), variant: "cause" as const }] : []),
            { label: "Launch a coin", href: `${rel("launch/")}`, variant: "outline" as const },
          ]}
        />
      ) : (
        <header className="@container flex flex-col gap-5 rounded-[32px] border border-line bg-card p-5 @lg:p-8">
          <div className="flex max-w-2xl flex-col gap-3">
            <span className="kicker">Causes</span>
            <h1 className="m-0 font-display text-4xl leading-[1.05] @md:text-5xl">Where the fees go</h1>
            <p className="m-0 text-[17px] leading-relaxed text-ink-soft">
              Every compliant Endaoment organization is in the Varada cause catalogue, grouped by cause and region. Coins choose a focus at launch and their ballots draw from the matching charities.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button asChild variant="cause">
                <a href={rel("donate/")}>
                  <HandHeart aria-hidden="true" />
                  Just donate
                </a>
              </Button>
            </div>
          </div>
          {catalog.isLoading || (board.isLoading && given === undefined) ? (
            <Skeleton className="h-20 rounded-2xl" />
          ) : (
            <HeroStats
              tone="paper"
              stats={[
                ...(given !== undefined ? [{ label: "Given to charities", value: given, format: usdFormatOptions(given, true), live: true }] : []),
                ...(catalog.data ? [{ label: "Charities in the catalogue", value: catalog.data.orgs }] : []),
                ...(firstBoard ? [{ label: "Charities that received gifts", value: firstBoard.totals.causes }] : []),
                { label: "Cause categories", value: CATEGORIES.length },
              ]}
            />
          )}
        </header>
      )}

      <Section id="categories" kicker="By cause" title="Pick a cause">
        <CategoryGrid selected={filters.categories} onToggle={toggleCategory} counts={catalog.data?.categories} totals={byCategory} agentHref={agentLink} />
      </Section>

      {filters.categories.length > 0 && (
        <Section id="coins" kicker="Coins" title={single ? `Coins giving to ${categoryLabelOf(single).toLowerCase()}` : "Coins giving to these causes"}>
          <CauseCoins
            categories={filters.categories}
            regions={filters.regions}
            causeName={single ? categoryLabelOf(single) : filters.categories.map(categoryLabelOf).join(", ")}
            root={rel("")}
          />
        </Section>
      )}

      <Section id="leaderboard" kicker="Giving" title="Who has received the most">
        <CausesLeaderboardSection
          rows={rows}
          loading={board.isLoading}
          error={board.error ? errorText(board.error) : undefined}
          unavailable={board.data !== undefined && firstBoard === null}
          hasMore={Boolean(board.hasNextPage)}
          loadingMore={board.isFetchingNextPage}
          onMore={() => void board.fetchNextPage()}
          onRetry={() => void board.refetch()}
        />
      </Section>

      <Section id="catalogue" kicker="Catalogue" title="Browse the charities">
        <div className="flex flex-col gap-4 md:grid md:grid-cols-[17rem_minmax(0,1fr)] md:items-start md:gap-6">
          <div className="hidden md:sticky md:top-20 md:block md:rounded-[20px] md:border md:border-line md:bg-card md:p-4">
            <FocusPicker categories={filters.categories} regions={filters.regions} onChange={setFocus} />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={searchId}>Name</Label>
              <InputGroup>
                <InputAddon>
                  <Search aria-hidden="true" />
                </InputAddon>
                <Input id={searchId} value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search the catalogue by name" autoComplete="off" />
              </InputGroup>
            </div>
            {(filters.categories.length > 0 || filters.regions.length > 0) && (
              <ul className="m-0 flex list-none flex-wrap items-center gap-2 p-0" aria-label="Active filters">
                {filters.categories.map((s) => (
                  <li key={s}>
                    <FilterChip label={categoryLabelOf(s)} onRemove={() => setFilters((f) => ({ ...f, categories: f.categories.filter((x) => x !== s) }))} />
                  </li>
                ))}
                {filters.regions.map((s) => (
                  <li key={s}>
                    <FilterChip label={regionLabelOf(s)} onRemove={() => setFilters((f) => ({ ...f, regions: f.regions.filter((x) => x !== s) }))} />
                  </li>
                ))}
                <li>
                  <Button variant="ghost" size="sm" onClick={clearAll}>
                    Clear all
                  </Button>
                </li>
              </ul>
            )}
            {ready && <CatalogResults q={filters.q} categories={filters.categories} regions={filters.regions} />}
          </div>
        </div>
        <div className="sticky bottom-[calc(var(--tab-h,0px)+2.25rem)] z-20 flex justify-center md:hidden">
          <Button variant="ink" size="lg" className="shadow-float" onClick={() => setSheetOpen(true)}>
            <SlidersHorizontal aria-hidden="true" />
            Filters{nFilters > 0 ? ` · ${nFilters}` : ""}
          </Button>
        </div>
        <FilterSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          groups={sheetGroups}
          value={sheetValue}
          title="Filter the catalogue"
          description="Pick causes and regions. Nothing changes until you apply."
          onApply={(v) => setFocus({ categories: [...(v.categories ?? [])], regions: [...(v.regions ?? [])] })}
          applyLabel={(d) => {
            const n = countFilters(d);
            return n ? `Apply ${n} filter${n === 1 ? "" : "s"}` : "Show all charities";
          }}
        />
      </Section>

      <Section id="endaoment" kicker="Endaoment" title="Search every registered nonprofit">
        <p className="m-0 max-w-2xl text-[15px] text-ink-soft">
          Looking for an organization that is not in the catalogue? Search Endaoment&apos;s registry by name. An organization&apos;s contract is deployed on its first gift.
        </p>
        <CauseSearch />
      </Section>
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove(): void }) {
  return (
    <Badge tone="cause" shape="pill" className="gap-1 py-1 pl-3 pr-1 text-[13px]">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="relative grid size-6 place-items-center rounded-full outline-none after:absolute after:-inset-2 after:content-[''] hover:bg-sage/15 focus-visible:ring-[3px] focus-visible:ring-ring/35"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </Badge>
  );
}
