"use client";

import { useMemo } from "react";
import { ActivityList } from "@varada/ui/components/data/activity-list";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Badge } from "@varada/ui/components/ui/badge";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { activityRow } from "@/lib/activity-view";
import { tokenPath } from "@/lib/discover";
import { useQuoteAssets } from "@/lib/use-quote-assets";
import { useLiveActivity, useNow, useRel, type LiveActivity } from "./hooks";
import { useActivityContext } from "./live-giving";

const SHOWN = 12;

/**
 * Live trades and gifts as a feed: weekly payouts, live-vault donations (with the cause's name from
 * the catalogue) and swaps, newest first. Pass `token` to scope it to one coin. Rows come from the
 * activity stream (SSE, or polling when that fails or indexer traffic is routed privately).
 */
export function LiveActivityFeed({ token, symbol, live: given, title = "Live activity" }: { token?: string; symbol?: string; live?: LiveActivity; title?: string }) {
  const own = useLiveActivity(40, token);
  const live = given ?? own;
  const rel = useRel();
  const quotes = useQuoteAssets();
  const now = useNow(30_000);
  const base = useActivityContext(live.items, quotes.assets, now ? Math.floor(now.getTime() / 1000) : 0);
  // On a token's own page the symbol is already known; elsewhere it is looked up in bulk.
  const ctx = useMemo(
    () => (token && symbol ? { ...base, symbolOf: (t: string | undefined) => (t?.toLowerCase() === token.toLowerCase() ? symbol : base.symbolOf(t)) } : base),
    [base, token, symbol],
  );
  const rows = useMemo(
    () =>
      live.items
        .flatMap((i) => {
          const row = activityRow(i, ctx);
          return row ? [{ ...row, href: !token && i.token ? rel(tokenPath(i.token)) : undefined }] : [];
        })
        .slice(0, SHOWN),
    [live.items, ctx, token, rel],
  );
  return (
    <section aria-labelledby="live-activity-title" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="live-activity-title" className="m-0 font-display text-2xl font-semibold">
          {title}
        </h2>
        {live.mode ? (
          <Badge tone="cause" dot>
            {live.mode === "sse" ? "Live" : "Updating"}
          </Badge>
        ) : null}
      </div>
      <div className="rounded-[24px] border border-line bg-card p-3 sm:p-4">
        {live.loading ? (
          <Skeleton className="h-48 rounded-2xl" />
        ) : live.error && rows.length === 0 ? (
          <EmptyState size="compact" title="Activity is unavailable" body="The indexer did not answer. New trades and gifts will appear here once it does." />
        ) : (
          <ActivityList
            items={rows}
            label={title}
            density="compact"
            empty={<EmptyState size="compact" title="Nothing yet" body="Trades and donations appear here the moment they settle." />}
          />
        )}
      </div>
    </section>
  );
}
