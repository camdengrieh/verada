// Written for Varada: a painted jar (or bar) filling toward a donation goal, with milestones. The
// rising surface reuses the two-layer wave from 21st.dev @good-listener/liquid-button (id 23994);
// crossing the goal fires the donation confetti preset.
"use client";

import { Check } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from "react";
import { useConfetti } from "@varada/ui/components/motion/confetti";
import { cn } from "@varada/ui/lib/utils";
import { clamp01, formatUsd } from "./impact-shared";
import { INK_TONES, type InkTone } from "./raised-counter";

export interface GoalMilestone {
  /** USD amount where the milestone sits. */
  at: number;
  label: string;
}

export interface GoalProgress {
  /** 0–1, clamped. */
  ratio: number;
  /** Whole percent, rounded down so 99.6% never reads as 100% before the goal is met. */
  pct: number;
  remaining: number;
  reached: boolean;
  /** Raised beyond the goal. */
  over: number;
}

export function goalProgress(raised: number, goal: number): GoalProgress {
  const ratio = goal > 0 ? raised / goal : 0;
  return {
    ratio: clamp01(ratio),
    pct: Math.min(100, Math.max(0, Math.floor(ratio * 100))),
    remaining: Math.max(0, goal - raised),
    reached: goal > 0 && raised >= goal,
    over: Math.max(0, raised - goal),
  };
}

/** Milestones in order with reached flags, and the next one to reach. */
export function milestoneStates(milestones: GoalMilestone[], raised: number) {
  const list = [...milestones].sort((a, b) => a.at - b.at).map((m) => ({ ...m, reached: raised >= m.at }));
  return { list, next: list.find((m) => !m.reached) };
}

export interface DonationGoalProps extends Omit<ComponentProps<"section">, "children"> {
  raised: number;
  goal: number;
  /** What the goal is for, e.g. "Epoch 12 · Wildlife". */
  label: string;
  milestones?: GoalMilestone[];
  variant?: "jar" | "bar";
  tone?: InkTone;
  /** Extra line under the numbers ("312 holders gave"). */
  meta?: ReactNode;
  /** Fire the donation confetti when the goal is crossed (not when it loads already met). */
  celebrate?: boolean;
  headingLevel?: 2 | 3 | 4;
}

// Jar outline in a 120×180 box: rim, shoulders, body. The fill runs from y 172 (empty) to y 36 (full).
const JAR =
  "M34 6 H86 Q90 6 90 10 V22 Q90 28 96 32 Q112 44 112 70 V154 Q112 172 94 172 H26 Q8 172 8 154 V70 Q8 44 24 32 Q30 28 30 22 V10 Q30 6 34 6 Z";
const EMPTY_Y = 172;
const FULL_Y = 36;
const levelY = (ratio: number) => EMPTY_Y - ratio * (EMPTY_Y - FULL_Y);

function Jar({ ratio, pigment, deep, milestones, goal }: { ratio: number; pigment: string; deep: string; milestones: { at: number; reached: boolean }[]; goal: number }) {
  const reduced = useReducedMotion();
  const uid = useId().replace(/:/g, "");
  const y = levelY(ratio);
  const wave = "M0 6 Q15 0 30 6 T60 6 T90 6 T120 6 T150 6 T180 6 T210 6 T240 6 V200 H0 Z";
  return (
    <svg viewBox="0 0 120 180" className="h-48 w-32 shrink-0 @md:h-56 @md:w-[150px]" aria-hidden="true">
      <defs>
        <clipPath id={`jar-${uid}`}>
          <path d={JAR} />
        </clipPath>
        <filter id={`bleed-${uid}`} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves={3} seed={4} />
          <feDisplacementMap in="SourceGraphic" scale={6} />
        </filter>
        <linearGradient id={`ink-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={pigment} stopOpacity={0.42} />
          <stop offset="1" stopColor={deep} stopOpacity={0.5} />
        </linearGradient>
      </defs>
      <path d={JAR} fill="var(--paper)" />
      <g clipPath={`url(#jar-${uid})`}>
        <motion.g
          initial={reduced ? false : { y: EMPTY_Y + 8 }}
          animate={{ y: y - 6 }}
          transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 26, damping: 13, mass: 1.2 }}
          filter={`url(#bleed-${uid})`}
        >
          <motion.path
            d={wave}
            fill={pigment}
            fillOpacity={0.2}
            animate={reduced ? undefined : { x: [0, -60] }}
            transition={reduced ? undefined : { duration: 6, ease: "linear", repeat: Infinity }}
          />
          <motion.path
            d={wave}
            transform="translate(0 3)"
            fill={`url(#ink-${uid})`}
            animate={reduced ? undefined : { x: [-60, 0] }}
            transition={reduced ? undefined : { duration: 4.2, ease: "linear", repeat: Infinity }}
          />
        </motion.g>
      </g>
      {/* Milestone ticks on the glass. */}
      {milestones.map((m) => {
        const my = levelY(clamp01(m.at / goal));
        return <line key={m.at} x1={96} x2={110} y1={my} y2={my} stroke={m.reached ? "var(--ink)" : "var(--ink-muted)"} strokeWidth={1.5} strokeDasharray={m.reached ? undefined : "2 2"} />;
      })}
      <path d={JAR} fill="none" stroke="var(--ink)" strokeWidth={2.2} strokeLinejoin="round" />
      <path d="M20 80 Q18 110 22 140" fill="none" stroke="var(--paper-card)" strokeWidth={4} strokeLinecap="round" opacity={0.8} />
      <rect x={28} y={2} width={64} height={8} rx={3} fill="var(--terracotta)" opacity={0.85} />
    </svg>
  );
}

/**
 * Progress toward a donation target: a jar that fills with pigment (or a painted bar), the amount
 * and percentage, what's left, and milestones ticked off as they're passed.
 */
export function DonationGoal({
  raised,
  goal,
  label,
  milestones = [],
  variant = "jar",
  tone = "sage",
  meta,
  celebrate = true,
  headingLevel = 3,
  className,
  ...props
}: DonationGoalProps) {
  const titleId = `goal-${useId().replace(/:/g, "")}`;
  const reduced = useReducedMotion();
  const ink = INK_TONES[tone];
  const p = goalProgress(raised, goal);
  const { list, next } = milestoneStates(milestones, raised);
  const { fire } = useConfetti({ preset: "donation" });
  const meterRef = useRef<HTMLDivElement>(null);
  const wasReached = useRef(p.reached);
  useEffect(() => {
    if (p.reached && !wasReached.current && celebrate && meterRef.current) fire(meterRef.current);
    wasReached.current = p.reached;
  }, [p.reached, celebrate, fire]);

  const Heading = `h${headingLevel}` as const;
  const valueText = `${formatUsd(raised)} of ${formatUsd(goal)}, ${p.pct}%`;

  return (
    <section
      data-slot="donation-goal"
      data-reached={p.reached || undefined}
      aria-labelledby={titleId}
      className={cn("@container rounded-[26px] border border-line bg-card p-5", className)}
      {...props}
    >
      <div className={cn("flex gap-5", variant === "jar" ? "flex-col items-center @sm:flex-row @sm:items-start" : "flex-col")}>
        <div
          ref={meterRef}
          role="progressbar"
          aria-labelledby={titleId}
          aria-valuemin={0}
          aria-valuemax={goal}
          aria-valuenow={Math.min(raised, goal)}
          aria-valuetext={valueText}
          className={variant === "bar" ? "order-2 w-full" : undefined}
        >
          {variant === "jar" ? (
            <Jar ratio={p.ratio} pigment={ink.pigment} deep={ink.deep} milestones={list} goal={goal} />
          ) : (
            <div className="relative pt-1">
              <div className="relative h-5 overflow-hidden rounded-full bg-sand">
                <motion.div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ background: `linear-gradient(to right, color-mix(in oklab, ${ink.deep} 45%, transparent), color-mix(in oklab, ${ink.pigment} 70%, transparent))` }}
                  initial={reduced ? false : { width: "0%" }}
                  animate={{ width: `${p.ratio * 100}%` }}
                  transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 40, damping: 16 }}
                />
              </div>
              {list.map((m) => (
                <span
                  key={m.at}
                  aria-hidden="true"
                  className={cn("absolute top-0 h-7 w-0.5 -translate-x-1/2 rounded-full", m.reached ? "bg-ink" : "bg-ink-muted/60")}
                  style={{ left: `${clamp01(m.at / goal) * 100}%` }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 self-stretch">
          <Heading id={titleId} className="m-0 font-display text-xl font-semibold">
            {label}
          </Heading>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="num text-3xl font-semibold text-ink">{formatUsd(raised)}</span>
            <span className="text-sm text-ink-soft">
              of <span className="num">{formatUsd(goal)}</span>
            </span>
          </div>
          <p className={cn("m-0 text-sm font-semibold", p.reached ? ink.text : "text-ink-soft")}>
            {p.reached ? (
              <>Goal reached{p.over > 0 ? <> · {formatUsd(p.over)} over</> : null}</>
            ) : (
              <>
                <span className="num">{p.pct}%</span> · <span className="num">{formatUsd(p.remaining)}</span> to go
              </>
            )}
          </p>
          {meta ? <div className="text-sm text-ink-muted">{meta}</div> : null}
          {list.length ? (
            <ol className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
              {list.map((m) => (
                <li key={m.at} className="flex min-h-8 items-center gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full border",
                      m.reached ? "border-transparent bg-sage text-paper" : m === next ? "border-ochre-ink border-dashed" : "border-line-strong",
                    )}
                  >
                    {m.reached ? <Check className="size-3" strokeWidth={3} /> : null}
                  </span>
                  <span className={cn("min-w-0 flex-1", m.reached ? "text-ink" : "text-ink-soft")}>{m.label}</span>
                  <span className="num text-ink-muted">{formatUsd(m.at)}</span>
                  <span className="sr-only">{m.reached ? "reached" : m === next ? "next" : "not reached yet"}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </section>
  );
}
