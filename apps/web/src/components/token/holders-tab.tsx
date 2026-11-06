"use client";

import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { Button } from "@varada/ui/components/ui/button";
import { HolderInsights } from "@varada/ui/components/varada/holder-insights";
import { HoldersTable, type HolderItem, type HolderLabel as UiHolderLabel } from "@varada/ui/components/varada/holders-table";
import { errorText } from "@/components/use-tx";
import type { HolderSummary, TokenHolder } from "@/lib/indexer";
import { toUnits, TOKEN_DECIMALS } from "@/lib/token-market";
import type { useHolders, useHolderSummary } from "./use-token-data";

const LABELS: Record<NonNullable<TokenHolder["label"]>, UiHolderLabel> = { pool: "pool", creator: "creator", burn: "burn", vault: "vault" };

/** Indexer holder rows as the library's table items. */
export function holderItems(rows: readonly TokenHolder[]): HolderItem[] {
  return rows.map((h) => ({
    address: h.account as `0x${string}`,
    label: h.label ? LABELS[h.label] : undefined,
    balance: toUnits(h.balance, TOKEN_DECIMALS),
    share: h.share,
  }));
}

export function HoldersTab({ symbol, holders, summary }: { symbol: string; holders: ReturnType<typeof useHolders>; summary: ReturnType<typeof useHolderSummary> }) {
  if (holders.isLoading || summary.isLoading) {
    return (
      <div role="status" aria-label="Loading holders" className="flex flex-col gap-4">
        <Skeleton className="h-56 w-full rounded-2xl" />
        <Skeleton className="h-72 w-full rounded-2xl" />
      </div>
    );
  }
  if (holders.error && !holders.data) {
    return (
      <div role="alert" className="rounded-2xl border border-line bg-card">
        <EmptyState size="compact" title="Could not load holders" body={errorText(holders.error)} action={<Button variant="outline" size="sm" onClick={() => void holders.refetch()}>Try again</Button>} />
      </div>
    );
  }
  const items = holderItems(holders.data?.items ?? []);
  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-card">
        <EmptyState title="No holders yet" body={`The first transfer of ${symbol} lists its holders here, with who holds the supply and how concentrated it is.`} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {summary.data ? <InsightsFor summary={summary.data} /> : null}
      <HoldersTable holders={items} symbol={`$${symbol}`} totalHolders={holders.data?.holders} headingLevel={2} defaultHideContracts={false} />
    </div>
  );
}

function InsightsFor({ summary }: { summary: HolderSummary }) {
  return (
    <HolderInsights
      holders={summary.holders}
      newHolders24h={summary.newHolders24h}
      top10Share={summary.top10Share}
      creatorShare={summary.creatorShare}
      poolShare={summary.poolShare}
      buckets={summary.buckets}
      history={summary.history.length > 1 ? summary.history.map((d) => d.holders) : undefined}
      headingLevel={2}
    />
  );
}
