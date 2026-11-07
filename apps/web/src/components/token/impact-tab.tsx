"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { Button } from "@varada/ui/components/ui/button";
import { CauseLeaderboard } from "@varada/ui/components/varada/cause-leaderboard";
import { DonationGoal } from "@varada/ui/components/varada/donation-goal";
import { DonationTimeline } from "@varada/ui/components/varada/donation-timeline";
import { FeeSplitBar } from "@varada/ui/components/varada/fee-split-bar";
import { ImpactBreakdown } from "@varada/ui/components/varada/impact-breakdown";
import { RaisedCounter } from "@varada/ui/components/varada/raised-counter";
import { useCatalogNames } from "@/components/catalog-browser";
import { useCauses } from "@/components/epoch-panel";
import { useDeps } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import type { TokenFeeTotals } from "@/lib/indexer";
import { buildImpact, causeNameOfOrg, liveDonationRows, loadPoolDonations, poolFigures, shortId, usdcToUsd, type DonationRow, type LiveView } from "@/lib/token-data";
import { usdText } from "@/lib/token-view";
import { useDonationUnit } from "@/hooks/use-donation-unit";
import { useNowSec } from "./market-section";

const txUrl = (hash: string) => `https://etherscan.io/tx/${hash}`;

/** Donation payouts of a weekly-pool token (the indexer's donation activity). */
export function usePoolDonations(token: string, enabled: boolean) {
  const deps = useDeps();
  return useQuery({ queryKey: ["token-donations", token.toLowerCase()], queryFn: () => loadPoolDonations(deps.indexer, token, 100), enabled, retry: false, staleTime: 30_000 });
}

export interface ImpactTabProps {
  token: string;
  symbol: string;
  live: LiveView | null;
  feeTotals: TokenFeeTotals | null | undefined;
  /** Current epoch and the previous one, for the "beat last epoch" goal of a weekly-pool token. */
  epoch: bigint | undefined;
  /** The token's donation asset, which every amount here is in. */
  donationAsset?: string;
}

export function ImpactTab({ token, symbol, live, feeTotals, epoch, donationAsset }: ImpactTabProps) {
  const { unit, symbol: assetSymbol } = useDonationUnit(donationAsset);
  const deps = useDeps();
  const donations = usePoolDonations(token, !live);
  const causes = useCauses();

  const rows: DonationRow[] = useMemo(() => (live ? liveDonationRows(live) : (donations.data ?? [])), [live, donations.data]);
  const ids = useMemo(() => [...rows.map((r) => r.causeId), ...(live?.causes.map((c) => c.causeId) ?? [])], [rows, live]);
  const catalog = useCatalogNames(ids);
  const now = useNowSec(60_000);

  // Goals: a live token's next donation (the credited amount waiting on its threshold) or, for a weekly
  // pool, last epoch's pool as the mark to beat.
  const current = useQuery({
    queryKey: ["impact-epochs", token.toLowerCase(), epoch?.toString()],
    queryFn: async () => {
      const [cur, prev] = await Promise.all([deps.indexer.epochDetail(token, epoch!), epoch! > 0n ? deps.indexer.epochDetail(token, epoch! - 1n) : null]);
      return { cur: poolFigures(cur), prev: poolFigures(prev) };
    },
    enabled: !live && epoch !== undefined,
    retry: false,
    staleTime: 30_000,
  });

  const meta = (causeId: string) => ({
    name: causes.data?.get(causeId)?.name ?? catalog.data?.get(causeId)?.name ?? shortId(causeId),
    cause: causeNameOfOrg(catalog.data?.get(causeId)),
  });
  const impact = useMemo(
    () => buildImpact(rows, meta, symbol, txUrl, live ? live.causes.filter((c) => c.credited > 0n).map((c) => ({ causeId: c.causeId, amount: c.credited })) : undefined, unit),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, live, symbol, causes.data, catalog.data, unit],
  );

  if (!live && donations.isLoading) {
    return (
      <div role="status" aria-label="Loading impact" className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-52 rounded-2xl" />
        <Skeleton className="h-52 rounded-2xl" />
      </div>
    );
  }
  if (!live && donations.error && !donations.data) {
    return (
      <div role="alert" className="rounded-2xl border border-line bg-card">
        <EmptyState size="compact" title="Could not load donations" body={errorText(donations.error)} action={<Button variant="outline" size="sm" onClick={() => void donations.refetch()}>Try again</Button>} />
      </div>
    );
  }

  const raised = live ? usdcToUsd(live.totals.credited, unit) : feeTotals ? usdcToUsd(BigInt(feeTotals.causeAmount), unit) : 0;
  const paid = live ? usdcToUsd(live.totals.donated, unit) : usdcToUsd(rows.reduce((s, r) => s + r.amount, 0n), unit);
  const hasMoney = raised > 0 || rows.length > 0;

  if (!hasMoney) {
    return (
      <div className="rounded-2xl border border-line bg-card">
        <EmptyState
          title={`${symbol} has not raised anything yet`}
          body={
            live
              ? "Every swap donates its cause share as it happens. The first trade starts the count, and each donation is listed here with its transaction."
              : `Trading fees are collected in ${assetSymbol} and 90% goes to the cause pool, which holders vote to pay out each epoch. The first trade starts the count.`
          }
        />
        <div className="mx-auto max-w-md px-4 pb-8">
          <FeeSplitBar causeShare={90} />
        </div>
      </div>
    );
  }

  const designated = live?.designatedCause?.toLowerCase();
  const pendingHere = live ? usdcToUsd(live.causes.find((c) => c.causeId.toLowerCase() === designated)?.pending ?? 0n, unit) : 0;
  const goalLive = live && live.threshold && live.threshold > 0n ? { raised: pendingHere, goal: usdcToUsd(live.threshold, unit), label: `Next donation to ${designated ? meta(designated).name : "the designated cause"}` } : null;
  const goalPool =
    !live && current.data?.prev && current.data.prev.total > 0n
      ? { raised: usdcToUsd(current.data.cur?.total ?? 0n, unit), goal: usdcToUsd(current.data.prev.total, unit), label: `Epoch ${epoch?.toString()} pool vs epoch ${(epoch! - 1n).toString()}` }
      : null;
  const goal = goalLive ?? goalPool;

  return (
    <div className="flex flex-col gap-4">
      <div className={goal ? "grid gap-4 lg:grid-cols-2" : undefined}>
        <RaisedCounter
          value={raised}
          label="Raised for causes"
          headingLevel={2}
          tone="sage"
          caption={
            <span>
              {live ? `${usdText(paid)} donated, ${usdText(usdcToUsd(live.totals.pending, unit))} credited and waiting for its donation.` : paid > 0 ? `${rows.length >= 100 ? "At least " : ""}${usdText(paid)} paid out so far to charities, after each week's vote.` : "Collected into the cause pool; paid out after each week's vote."}
            </span>
          }
          latestTo={impact.timeline[0]?.org}
        />
        {goal ? (
          <DonationGoal raised={goal.raised} goal={goal.goal} label={goal.label} headingLevel={2} variant="jar" celebrate={false} />
        ) : null}
      </div>
      {impact.items.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <ImpactBreakdown items={impact.items} title={live ? "Credited by cause" : "Paid by cause"} headingLevel={2} />
          <CauseLeaderboard entries={impact.leaderboard} title="Charities" period={live ? "Credited" : "Paid out"} headingLevel={2} />
        </div>
      ) : null}
      {impact.timeline.length > 0 ? (
        <DonationTimeline donations={impact.timeline} now={now * 1000} headingLevel={2} />
      ) : (
        <div className="rounded-2xl border border-line bg-card">
          <EmptyState size="compact" title="No donation paid yet" body="Payouts are listed here with their transactions once a vote settles or a live donation goes out." />
        </div>
      )}
    </div>
  );
}
