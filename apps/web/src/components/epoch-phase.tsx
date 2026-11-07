"use client";

import { Badge } from "@varada/ui/components/ui/badge";
import { Countdown } from "@varada/ui/components/data/countdown";
import { useNowSeconds } from "@/components/governance/hooks";
import { formatTime } from "@/components/use-tx";
import { cycleText, timingPhase, type EpochTiming, type TimingPhase } from "@/lib/epoch-timing";

const PHASES: Record<TimingPhase, { label: string; tone: "neutral" | "cause" | "rwa"; text: string }> = {
  trading: { label: "Trading", tone: "neutral", text: "Ballots are not accepted yet." },
  voting: { label: "Voting", tone: "cause", text: "Ballots are being accepted." },
  ended: { label: "Tally", tone: "rwa", text: "Voting has closed. The votes are counted, then the pool is paid out." },
};

/**
 * Where an epoch is in its cycle: trading (ballots refused until `votingOpensAt`), voting (until the
 * epoch ends) or tally, with a countdown to the next change and the real times. Every figure comes
 * from the governor's schedule, which is owner-set, so the length is shown rather than assumed.
 */
export function EpochPhaseStrip({
  timing,
  epoch,
  onChange,
  className,
}: {
  timing: EpochTiming;
  epoch?: bigint | number | string;
  /** Called when a countdown reaches zero (a phase change): refetch what depends on it. */
  onChange?: () => void;
  className?: string;
}) {
  const now = useNowSeconds(1_000);
  const phase = timingPhase(timing, now);
  const p = PHASES[phase];
  const hasTrading = timing.votingOpensAt > timing.start;
  const text = phase === "voting" && !hasTrading ? "Ballots are accepted for the whole epoch." : p.text;
  const countdownTo = phase === "trading" ? timing.votingOpensAt : timing.end;
  return (
    <div role="group" aria-label={epoch !== undefined ? `Epoch ${epoch} phase` : "Epoch phase"} className={`grid grid-cols-1 gap-2 rounded-2xl bg-paper px-3 py-3 ${className ?? ""}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={p.tone} shape="pill" dot={phase !== "ended"}>
          {p.label}
        </Badge>
        <span className="text-sm text-ink-soft">{text}</span>
      </div>
      {phase !== "ended" && (
        <Countdown
          key={phase}
          to={countdownTo * 1000}
          variant="inline"
          label={phase === "trading" ? "Voting opens in" : "Voting closes in"}
          doneText={phase === "trading" ? "Voting is open" : "Voting is closed"}
          onDone={onChange}
        />
      )}
      <p className="num m-0 text-xs text-ink-muted">
        {hasTrading ? `Trading ${formatTime(timing.start)} to ${formatTime(timing.votingOpensAt)}. ` : ""}Voting {formatTime(timing.votingOpensAt)} to {formatTime(timing.end)}.
      </p>
      <p className="m-0 text-xs text-ink-muted">Epochs last {cycleText(timing)}.</p>
    </div>
  );
}
