"use client";

import { CircleAlert, HandHeart } from "@varada/ui/components/ui/icons";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Button } from "@varada/ui/components/ui/button";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { CauseLeaderboard, type LeaderboardEntry } from "@varada/ui/components/varada/cause-leaderboard";
import { shortAddress } from "@/components/use-tx";
import { causeNameOfSlug, usdcToNumber, type LeaderboardRow } from "@/lib/causes-client";

/** Library leaderboard rows from the indexer's per-cause totals. Names come from the catalogue when it is loaded. */
export function leaderboardEntries(rows: readonly LeaderboardRow[]): LeaderboardEntry[] {
  return rows.map((r) => ({
    id: r.causeId,
    name: r.org?.name ?? `Cause ${shortAddress(r.causeId)}`,
    sub: `${r.donations} gift${r.donations === 1 ? "" : "s"} from ${r.tokens} coin${r.tokens === 1 ? "" : "s"}`,
    cause: causeNameOfSlug(r.org?.categories[0] ?? "other"),
    raised: usdcToNumber(r.donated),
  }));
}

/** Who has received the most, with loading, empty, error and paging states. */
export function CausesLeaderboardSection({
  rows,
  loading,
  error,
  unavailable,
  hasMore,
  loadingMore,
  onMore,
  onRetry,
}: {
  rows: readonly LeaderboardRow[];
  loading: boolean;
  error?: string;
  /** The indexer has no per-cause totals (older build). */
  unavailable?: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore(): void;
  onRetry(): void;
}) {
  if (loading) {
    return (
      <div role="status" aria-label="Loading the leaderboard" className="flex flex-col gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-14 rounded-xl" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <EmptyState
        size="compact"
        icon={<CircleAlert />}
        role="alert"
        title="Could not load the leaderboard"
        body={error}
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }
  if (unavailable) {
    return <EmptyState size="compact" icon={<CircleAlert />} title="Totals are not available" body="This indexer does not report money given per cause yet." />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        size="compact"
        icon={<HandHeart />}
        title="No gifts yet"
        body="The first donation to a charity, from a weekly pool or a live-donation coin, puts it on the board."
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <CauseLeaderboard entries={leaderboardEntries(rows)} title="Most given to" period="All time" headingLevel={3} />
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={onMore} disabled={loadingMore}>
            {loadingMore ? "Loading" : "Show more"}
          </Button>
        </div>
      )}
    </div>
  );
}
