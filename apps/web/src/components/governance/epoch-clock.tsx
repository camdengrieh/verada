"use client";

import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { InfoTip } from "@varada/ui/components/ui/info-tip";
import { EpochPhaseStrip } from "@/components/epoch-phase";
import { errorText } from "@/components/use-tx";
import { timingOf } from "@/lib/epoch-timing";
import type { EpochClock as Clock } from "@/lib/governance";

/**
 * The platform's current epoch: its phase (trading, then voting, then tally), the time to the next
 * change and the real times, all from the governor's owner-set schedule. Every token's voting opens
 * and closes together.
 */
export function EpochClock({ clock, loading, error, onDone }: { clock: Clock | undefined; loading: boolean; error: unknown; onDone?: () => void }) {
  return (
    <section aria-label="Epoch clock" className="grid grid-cols-1 gap-3 rounded-[26px] border border-line bg-card p-5">
      <div className="flex items-center gap-1">
        <p className="kicker m-0">{clock ? `Current epoch: ${clock.epoch}` : "Current epoch"}</p>
        <InfoTip entry="epoch" />
      </div>
      {loading && (
        <div role="status" aria-label="Loading the epoch clock" className="grid grid-cols-1 gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-16 w-72 max-w-full" />
        </div>
      )}
      {Boolean(error) && !clock && (
        <p role="alert" className="m-0 text-sm text-terracotta-strong">
          Could not read the epoch from the chain: {errorText(error)}
        </p>
      )}
      {clock && <EpochPhaseStrip timing={timingOf(clock)!} epoch={clock.epoch} onChange={onDone} />}
    </section>
  );
}
