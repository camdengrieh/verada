// Written for Varada: this epoch's weekly cause pool as a round bowl filling with pigment (InkFill,
// adapted from 21st.dev @good-listener/liquid-button id 23994), a ring for how much of the 7-day
// epoch has passed, and the data/countdown timer.
"use client";

import { useEffect, useId, useState, type ComponentProps } from "react";
import { Countdown } from "@varada/ui/components/data/countdown";
import { buttonVariants } from "@varada/ui/components/ui/button";
import { NumberTicker } from "@varada/ui/components/motion/number-ticker";
import { cn } from "@varada/ui/lib/utils";
import { InkFill, clamp01, formatUsd, usdFormatOptions } from "./impact-shared";
import { DefaultLink, type LinkComponent } from "./shared";

const toMs = (t: number | Date) => (typeof t === "number" ? t : t.getTime());

/** Fraction of an epoch that has passed, 0–1. */
export function epochElapsed(startsAt: number | Date, endsAt: number | Date, now: number): number {
  const s = toMs(startsAt);
  const e = toMs(endsAt);
  return e > s ? clamp01((now - s) / (e - s)) : 1;
}

export interface PoolMeterProps extends Omit<ComponentProps<"section">, "children"> {
  epoch: number;
  /** USD in the pool so far. */
  amount: number;
  /** Fill toward this (e.g. last epoch's pool). Without it the bowl fills with time instead. */
  target?: number;
  startsAt: number | Date;
  endsAt: number | Date;
  /** Reference time for the elapsed ring; the meter keeps its own clock when left out. */
  now?: number;
  /** Formatted extras. */
  attributed?: string;
  carriedForward?: string;
  /** Curator agent for this epoch's ballot. */
  curator?: string;
  voteHref?: string;
  onVote?: () => void;
  voteLabel?: string;
  LinkComponent?: LinkComponent;
  headingLevel?: 2 | 3 | 4;
}

const R = 46;
const CIRC = 2 * Math.PI * R;

/** An epoch's pool filling up, the time gone in the epoch, and the countdown to the vote closing. */
export function PoolMeter({
  epoch,
  amount,
  target,
  startsAt,
  endsAt,
  now: nowProp,
  attributed,
  carriedForward,
  curator,
  voteHref,
  onVote,
  voteLabel = "Vote privately",
  LinkComponent = DefaultLink,
  headingLevel = 3,
  className,
  ...props
}: PoolMeterProps) {
  const titleId = `pool-meter-${useId().replace(/:/g, "")}`;
  const [clock, setClock] = useState<number | null>(null);
  useEffect(() => {
    if (nowProp !== undefined) return;
    setClock(Date.now());
    const id = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [nowProp]);
  const now = nowProp ?? clock;
  const elapsed = now === null ? 0 : epochElapsed(startsAt, endsAt, now);
  const fill = target ? clamp01(amount / target) : elapsed;
  const Heading = `h${headingLevel}` as const;
  const cta = cn(buttonVariants({ variant: "cause" }), "w-full @md:w-auto");

  return (
    <section
      data-slot="pool-meter"
      aria-labelledby={titleId}
      className={cn("@container rounded-[26px] border border-line bg-card p-5", className)}
      {...props}
    >
      <div className="flex flex-col items-center gap-5 @md:flex-row @md:items-center">
        <div className="relative size-44 shrink-0">
          {/* Elapsed ring: how far through the 7 days we are. */}
          <svg viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
            <circle cx="50" cy="50" r={R} fill="none" stroke="var(--sand)" strokeWidth="4" />
            <circle
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke="var(--ochre)"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={CIRC * (1 - elapsed)}
              className="transition-[stroke-dashoffset] duration-700 motion-reduce:transition-none"
            />
          </svg>
          <div className="absolute inset-[10%] overflow-hidden rounded-full border border-line bg-paper">
            <InkFill level={fill} wave={5} />
            <div className="relative flex size-full flex-col items-center justify-center text-center">
              <span className="text-xs font-semibold text-ink-soft">in the pool</span>
              <NumberTicker value={amount} format={usdFormatOptions(amount, true)} className="text-2xl font-semibold text-ink" />
              {target ? <span className="num text-xs text-ink-soft">{Math.round(fill * 100)}% of {formatUsd(target, { compact: true })}</span> : null}
            </div>
          </div>
        </div>

        <div className="flex w-full min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <Heading id={titleId} className="m-0 font-display text-xl font-semibold">
              Epoch {epoch} cause pool
            </Heading>
            <span className="text-sm text-ink-soft">
              <span className="num">{Math.round(elapsed * 100)}%</span> of the week gone · holders vote privately on where it goes
            </span>
          </div>
          <Countdown to={endsAt} variant="inline" label="Vote closes in" doneText="Voting closed" />
          {attributed || carriedForward ? (
            <dl className="m-0 grid grid-cols-2 gap-2 text-sm">
              {attributed ? (
                <div className="flex flex-col">
                  <dt className="text-ink-muted">Attributed</dt>
                  <dd className="num m-0 font-semibold text-ink">{attributed}</dd>
                </div>
              ) : null}
              {carriedForward ? (
                <div className="flex flex-col">
                  <dt className="text-ink-muted">Carried forward</dt>
                  <dd className="num m-0 font-semibold text-ink">{carriedForward}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {curator ? (
            <span className="text-[13px] text-ink-soft">
              Ballot curated by <span className="font-semibold text-sage-ink">{curator}</span>
            </span>
          ) : null}
          {voteHref ? (
            <LinkComponent href={voteHref} className={cta}>
              {voteLabel}
            </LinkComponent>
          ) : onVote ? (
            <button type="button" onClick={onVote} className={cta}>
              {voteLabel}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
