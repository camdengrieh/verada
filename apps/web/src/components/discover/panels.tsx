"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { CATEGORIES } from "@varada/sdk";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@varada/ui/components/ui/toggle-group";
import { Coins } from "@varada/ui/components/ui/icons";
import { CauseIcon } from "@varada/ui/components/varada/cause-icon";
import { QuoteAssetList } from "@varada/ui/components/varada/quote-asset-list";
import type { VaradaLinkProps } from "@varada/ui/components/varada/shared";
import { cn } from "@varada/ui/lib/utils";
import { useDeps } from "@/components/providers";
import { CADENCES, causeNameOf, isCryptoKind, type DiscoverState } from "@/lib/discover";
import { US_MARKET_EARLY_CLOSES, US_MARKET_HOLIDAYS } from "@/lib/market-calendar";
import type { AppQuoteAsset } from "@/lib/quote-assets";
import { useNow } from "./hooks";

/** "By cause": the 21 categories with their catalogue size; a pick filters the list. */
export function CauseChooser({ selected, onSelect }: { selected: string | null; onSelect(slug: string | null): void }) {
  const deps = useDeps();
  const catalog = useQuery({ queryKey: ["catalog-summary"], queryFn: () => deps.indexer.catalog(), retry: false, staleTime: 600_000 });
  const counts = new Map(catalog.data?.categories.map((c) => [c.slug, c.orgs]));
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-2 text-sm font-semibold text-ink">Choose a cause</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {CATEGORIES.map((c) => {
          const on = selected === c.slug;
          const orgs = counts.get(c.slug);
          return (
            <button
              key={c.slug}
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(on ? null : c.slug)}
              className={cn(
                "flex min-h-14 items-center gap-2.5 rounded-2xl border p-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                on ? "border-sage bg-sage-tint text-sage-ink" : "border-line bg-card hover:bg-paper-card",
              )}
            >
              <CauseIcon cause={causeNameOf(c.slug)} size={36} decorative />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-semibold">{c.label}</span>
                {orgs !== undefined ? <span className="num text-xs text-ink-muted">{orgs.toLocaleString("en-US")} charities</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** "Live donation": only coins that donate every swap, optionally one rotation cadence. */
export function CadenceFilter({ value, onChange }: { value: DiscoverState["cadence"]; onChange(c: DiscoverState["cadence"]): void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm font-semibold text-ink" id="cadence-label">
        Charity rotates every
      </span>
      <ToggleGroup aria-labelledby="cadence-label" value={value ?? "any"} onValueChange={(v) => onChange(!v || v === "any" ? null : (v as DiscoverState["cadence"]))} size="sm">
        <ToggleGroupItem value="any">Any</ToggleGroupItem>
        {CADENCES.map((c) => (
          <ToggleGroupItem key={c} value={c}>
            {c === "week" ? "Week" : c}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function PairLink({ href, children, onPick, ...props }: VaradaLinkProps & { onPick(symbol: string): void }) {
  return (
    <a
      href={href}
      {...props}
      onClick={(e) => {
        // The row opens the coins paired with it, in place: no navigation, the URL carries the choice.
        const symbol = new URLSearchParams(href.slice(href.indexOf("?"))).get("pair");
        if (symbol) {
          e.preventDefault();
          onPick(symbol);
        }
        props.onClick?.(e);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Stocks &amp; RWA: the allowlisted tokenized assets with price, depth, fee route and market status (the
 * US session, or Ondo's pause), each row opening the coins paired with it.
 */
export function PairsPanel({ assets, selected, onPick, loading, marketsLoading }: { assets: readonly AppQuoteAsset[]; selected: string | null; onPick(symbol: string | null): void; loading: boolean; marketsLoading: boolean }) {
  const now = useNow(30_000);
  const Link = useMemo(() => {
    const L = (p: VaradaLinkProps) => <PairLink {...p} onPick={onPick} />;
    return L;
  }, [onPick]);
  const stocks = assets.filter((a) => !isCryptoKind(a.kind));
  if (loading) return <Skeleton className="h-48 rounded-[24px]" />;
  if (stocks.length === 0) {
    return <EmptyState size="compact" icon={<Coins />} title="No tokenized stocks yet" body="Ondo stocks and ETFs appear here once the quote registry allowlists them as pairs." />;
  }
  if (!now) return <Skeleton className="h-48 rounded-[24px]" />;
  const marketsUnavailable = !marketsLoading && stocks.every((a) => a.route === undefined && a.price === undefined);
  return (
    <div className="flex flex-col gap-2">
      {marketsUnavailable ? (
        <p role="note" className="m-0 rounded-2xl border border-line bg-paper-card px-4 py-3 text-sm text-ink-soft">
          Prices, liquidity and fee routes are read from the chain, which did not answer. Until it does, those columns show as empty, not as missing.
        </p>
      ) : null}
      {selected ? (
        <p className="m-0 text-sm text-ink-soft">
          Showing coins paired with <strong className="num">{selected}</strong>.{" "}
          <button type="button" className="font-semibold text-sage-ink underline underline-offset-4" onClick={() => onPick(null)}>
            Show every stock pair
          </button>
        </p>
      ) : null}
      <QuoteAssetList
        title="Pairs"
        headingLevel={3}
        assets={stocks}
        now={now}
        holidays={US_MARKET_HOLIDAYS}
        earlyCloses={US_MARKET_EARLY_CLOSES}
        recommendedSymbol={null}
        defaultSort="liquidity"
        searchPlaceholder="Search NVDAon, Tesla, SPY…"
        getHref={(a) => `?tab=stocks&pair=${encodeURIComponent(a.symbol)}`}
        LinkComponent={Link}
      />
    </div>
  );
}
