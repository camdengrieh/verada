"use client";

import { useMemo } from "react";
import { ActivityFeed } from "@varada/ui/components/varada/activity-feed";
import { ActivityTicker } from "@varada/ui/components/varada/activity-ticker";
import { RaisedCounter } from "@varada/ui/components/varada/raised-counter";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { toFeedItem, toTickerItem, type ActivityContext } from "@/lib/activity";
import type { ActivityItem, Stats } from "@/lib/indexer";
import { platformTotals } from "@/lib/platform-stats";
import { findQuote, type AppQuoteAsset } from "@/lib/quote-assets";
import { useUsdQuotes } from "@/hooks/use-usd-quotes";
import { useCauseLookup, useNow, useRel, useTokenSymbols, type LiveActivity } from "./hooks";

/** Lookups the ticker and feed need, built from the activity itself. */
export function useActivityContext(items: readonly ActivityItem[], assets: readonly AppQuoteAsset[], nowSeconds: number): ActivityContext {
  const { quoteFor } = useUsdQuotes();
  const symbols = useTokenSymbols(useMemo(() => items.map((i) => i.token), [items]));
  const causeOf = useCauseLookup(useMemo(() => items.filter((i) => i.kind === "donation" || i.kind === "live_donation").map((i) => (typeof i.data.causeId === "string" ? i.data.causeId : undefined)), [items]));
  return useMemo(
    () => ({
      symbolOf: (t) => (t ? symbols.get(t.toLowerCase()) || undefined : undefined),
      quoteOf: (a) => {
        const q = a ? findQuote(assets, a) : undefined;
        return q ? { symbol: q.symbol, decimals: q.decimals } : undefined;
      },
      usdOf: (a) => (a ? quoteFor(a) : undefined),
      causeOf,
      nowSeconds,
    }),
    [symbols, assets, causeOf, nowSeconds, quoteFor],
  );
}

/** The live strip under the header: new trades, gifts, launches and ballots as they arrive. */
export function LiveTicker({ live, assets }: { live: LiveActivity; assets: readonly AppQuoteAsset[] }) {
  const { items } = live;
  const now = useNow(60_000);
  const ctx = useActivityContext(items, assets, now ? Math.floor(now.getTime() / 1000) : 0);
  const rows = useMemo(() => items.map((i) => toTickerItem(i, ctx)).filter((r): r is NonNullable<typeof r> => r !== null).slice(0, 30), [items, ctx]);
  const { market, giving } = useMemo(() => splitTicker(rows), [rows]);
  if (rows.length === 0) return null;
  // Two strips running opposite ways: the market on top, giving and votes underneath.
  if (market.length === 0 || giving.length === 0) return <ActivityTicker items={rows} className="rounded-2xl border" label="Live activity on Varada" />;
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-line">
      <ActivityTicker items={market} tag="Market" label="Live trades and launches" className="border-b" />
      <ActivityTicker items={giving} tag="Giving" direction="right" duration={46} label="Live gifts and votes" className="border-b-0" />
    </div>
  );
}

/** Trades and launches in one strip, gifts and votes in the other. */
export function splitTicker<T extends { kind: string }>(rows: readonly T[]): { market: T[]; giving: T[] } {
  const giving = rows.filter((r) => r.kind === "GIVE" || r.kind === "VOTE");
  return { market: rows.filter((r) => !giving.includes(r)), giving };
}

/** Total raised next to the latest donations. */
export function LiveGiving({ live, stats, statsLoading, assets }: { live: LiveActivity; stats: Stats | undefined; statsLoading: boolean; assets: readonly AppQuoteAsset[] }) {
  const rel = useRel();
  const { items, fresh, loading } = live;
  const now = useNow(30_000);
  const ctx = useActivityContext(items, assets, now ? Math.floor(now.getTime() / 1000) : 0);
  const totals = platformTotals(stats);
  const feed = useMemo(() => items.map((i) => toFeedItem(i, ctx, fresh.has(i.id))).filter((r): r is NonNullable<typeof r> => r !== null).slice(0, 8), [items, ctx, fresh]);
  const latest = feed[0];
  return (
    <section aria-labelledby="live-giving" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <h2 id="live-giving" className="sr-only">
        Giving so far
      </h2>
      {totals ? (
        <RaisedCounter
          value={totals.raisedUsd}
          label="Raised for causes"
          headingLevel={3}
          latestTo={typeof latest?.text === "string" ? latest.text.replace(/^gave to /, "") : undefined}
          caption={`${totals.donations.toLocaleString("en-US")} donation${totals.donations === 1 ? "" : "s"} to ${totals.causes.toLocaleString("en-US")} cause${totals.causes === 1 ? "" : "s"}`}
        />
      ) : (
        <div className="rounded-[24px] border border-line bg-card p-6" aria-busy={statsLoading}>
          <p className="m-0 text-sm text-ink-muted">{statsLoading ? "Loading the total raised" : "The total raised is unavailable while the indexer is unreachable."}</p>
          {statsLoading ? <Skeleton className="mt-3 h-10 w-40" /> : null}
        </div>
      )}
      {loading ? (
        <Skeleton className="h-64 rounded-[24px]" />
      ) : (
        <ActivityFeed
          items={feed}
          announce
          emptyText="No donations yet. The first one lands here the moment it settles."
          footer={
            <a href={rel("governance/")} className="inline-flex min-h-11 items-center text-sm font-semibold text-sage-ink underline-offset-4 hover:underline">
              See how causes are chosen
            </a>
          }
        />
      )}
    </section>
  );
}
