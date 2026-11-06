// Written for Varada (takeover poll card from the A-Vote board)
import { useId, type ComponentProps, type ReactNode } from "react";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Divider } from "@varada/ui/components/ui/divider";
import { cn } from "@varada/ui/lib/utils";

export type TakeoverStatus = "active" | "passed" | "failed" | "executed";
export type TakeoverVote = "for" | "against";

export interface TakeoverCardProps extends Omit<ComponentProps<"section">, "children"> {
  status: TakeoverStatus;
  /** The proposal in a sentence; the proposed controller address is usually inside it. */
  proposal: ReactNode;
  /** Turnout so far and the quorum, as percent of supply. */
  turnout: number;
  quorum: number;
  /** Share of votes cast, when known (the tally may stay encrypted until the end). */
  forPct?: number;
  againstPct?: number;
  /** "Ends in 1d 6h" */
  endsIn?: string;
  /** The viewer's vote, if cast. */
  myVote?: TakeoverVote;
  onVote?: (vote: TakeoverVote) => void;
  /** Why the viewer can't vote ("Hold $HARAMBE at the snapshot to vote"). */
  disabledReason?: string;
}

const STATUS: Record<TakeoverStatus, { label: string; tone: "rwa" | "cause" | "neutral" | "ink" }> = {
  active: { label: "Active", tone: "rwa" },
  passed: { label: "Passed", tone: "cause" },
  failed: { label: "Failed", tone: "neutral" },
  executed: { label: "Executed", tone: "ink" },
};

/**
 * Holders' poll to replace a coin's controller: quorum progress and For / Against. A size container:
 * while voting is open and the card is 576px or wider, the vote buttons move into a column on the
 * right.
 */
export function TakeoverCard({
  status,
  proposal,
  turnout,
  quorum,
  forPct,
  againstPct,
  endsIn,
  myVote,
  onVote,
  disabledReason,
  className,
  ...props
}: TakeoverCardProps) {
  const titleId = `takeover-${useId().replace(/:/g, "")}`;
  const reasonId = `${titleId}-reason`;
  const progress = quorum > 0 ? Math.min(100, (turnout / quorum) * 100) : 0;
  const s = STATUS[status];
  const canVote = status === "active" && !!onVote && !disabledReason && !myVote;
  return (
    <section aria-labelledby={titleId} data-slot="takeover-card" className={cn("@container rounded-[26px] border border-line bg-card p-5", className)} {...props}>
      <div className={cn("grid grid-cols-1 gap-2.5", status === "active" && "@xl:grid-cols-[minmax(0,1fr)_minmax(12rem,15rem)] @xl:gap-x-6")}>
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id={titleId} className="m-0 font-display text-xl font-semibold">
              Takeover poll
            </h3>
            <Badge tone={s.tone} shape="pill">
              {s.label}
            </Badge>
          </div>
          <div className="m-0 text-sm break-words text-ink-soft">{proposal}</div>
          <div className="flex flex-wrap justify-between gap-x-3 text-[13px]">
            <span>Quorum{endsIn ? <span className="text-ink-muted"> · {endsIn}</span> : null}</span>
            <span className="num">
              {turnout}% of {quorum}%
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Turnout towards quorum"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
            aria-valuetext={`${turnout}% of supply voted, quorum is ${quorum}%`}
            className="h-2 overflow-hidden rounded-full bg-sand"
          >
            <div className={cn("h-full rounded-full", progress >= 100 ? "bg-sage" : "bg-ochre")} style={{ width: `${progress}%` }} />
          </div>
          {forPct !== undefined && againstPct !== undefined ? (
            <div className="flex justify-between text-[13px] text-ink-soft">
              <span>
                For <strong className="num text-ink">{forPct}%</strong>
              </span>
              <span>
                Against <strong className="num text-ink">{againstPct}%</strong>
              </span>
            </div>
          ) : null}
        </div>
        {status === "active" ? (
          <div className="flex flex-col gap-2.5 @xl:justify-center @xl:border-l @xl:border-line @xl:pl-6">
            <Divider variant="dashed" className="@xl:hidden" />
            <div className="flex gap-2 @xl:flex-col" role="group" aria-label="Your vote">
              {(["for", "against"] as const).map((v) => (
                <Button
                  key={v}
                  variant={myVote === v ? "ink" : "outline"}
                  className="flex-1"
                  aria-pressed={myVote === v}
                  aria-describedby={disabledReason ? reasonId : undefined}
                  disabled={!canVote && myVote !== v}
                  onClick={() => onVote?.(v)}
                >
                  {v === "for" ? "For" : "Against"}
                  {myVote === v ? <span className="sr-only"> (your vote)</span> : null}
                </Button>
              ))}
            </div>
            {disabledReason ? (
              <p id={reasonId} className="m-0 text-[13px] text-ink-muted">
                {disabledReason}
              </p>
            ) : myVote ? (
              <p className="m-0 text-[13px] text-ink-muted">You voted {myVote === "for" ? "for" : "against"} this takeover.</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
