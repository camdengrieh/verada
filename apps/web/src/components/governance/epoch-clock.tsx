"use client";

import { Countdown } from "@varada/ui/components/data/countdown";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { InfoTip } from "@varada/ui/components/ui/info-tip";
import { errorText, formatTime } from "@/components/use-tx";
import type { EpochClock as Clock } from "@/lib/governance";

/**
 * The platform's current epoch and the time left in it (one epoch is one week, Thursday to
 * Thursday, UTC). Voting on every token closes together when it ends.
 */
export function EpochClock({ clock, loading, error, onDone }: { clock: Clock | undefined; loading: boolean; error: unknown; onDone?: () => void }) {
  return (
    <section aria-label="Epoch clock" className="grid gap-3 rounded-[26px] border border-line bg-card p-5">
      <div className="flex items-center gap-1">
        <p className="kicker m-0">{clock ? `Current epoch: ${clock.epoch}` : "Current epoch"}</p>
        <InfoTip entry="epoch" />
      </div>
      {loading && (
        <div role="status" aria-label="Loading the epoch clock" className="grid gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-16 w-72 max-w-full" />
        </div>
      )}
      {Boolean(error) && !clock && (
        <p role="alert" className="m-0 text-sm text-terracotta-strong">
          Could not read the epoch from the chain: {errorText(error)}
        </p>
      )}
      {clock && (
        <>
          <Countdown to={clock.end * 1000} label={`Epoch ${clock.epoch} closes in`} doneText="Voting is closed. Tallies are being counted." onDone={onDone} />
          <p className="num m-0 text-xs text-ink-muted">
            {formatTime(clock.start)} to {formatTime(clock.end)}
          </p>
        </>
      )}
    </section>
  );
}
