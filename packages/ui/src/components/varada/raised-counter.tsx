// Written for Varada: the total raised over a rising watercolour fill (InkFill, adapted from 21st.dev
// @good-listener/liquid-button id 23994) and the count from motion/number-ticker (21st.dev
// @dillionverma/number-ticker id 1282). Live gifts drop into the ink and float a "+$12.40" chip.
"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { NumberTicker } from "@varada/ui/components/motion/number-ticker";
import { cn } from "@varada/ui/lib/utils";
import { InkFill, clamp01, formatUsd, usdFormatOptions, useThrottledAnnouncement } from "./impact-shared";
import { PaperGrain } from "./watercolour";

export type InkTone = "sage" | "ochre" | "sky" | "terracotta";

export const INK_TONES: Record<InkTone, { pigment: string; deep: string; text: string }> = {
  sage: { pigment: "var(--sage)", deep: "var(--sky)", text: "text-sage-ink" },
  ochre: { pigment: "var(--ochre)", deep: "var(--terracotta)", text: "text-ochre-ink" },
  sky: { pigment: "var(--sky)", deep: "var(--sage)", text: "text-stock-ink" },
  terracotta: { pigment: "var(--terracotta)", deep: "var(--ochre)", text: "text-terracotta-strong" },
};

export interface RaisedCounterProps extends Omit<ComponentProps<"section">, "children"> {
  /** Total raised, in USD. */
  value: number;
  label?: string;
  /** Fill toward a goal (level = value / goal). Without one, `level` sets the fill. */
  goal?: number;
  /** 0–1 fill when there's no goal. */
  level?: number;
  /** Who the latest gift went to, shown on the increment chip ("to WWF"). */
  latestTo?: string;
  caption?: ReactNode;
  compact?: boolean;
  size?: "md" | "lg";
  tone?: InkTone;
  /** Minimum ms between screen-reader updates of the total. */
  announceEvery?: number;
  /** Heading level for the label. */
  headingLevel?: 2 | 3 | 4;
}

interface Drop {
  id: number;
  delta: number;
  to?: string;
}

/**
 * The big number: total raised for causes, counting up when it scrolls into view and springing to
 * each new total, while pigment rises behind it like ink in water. Each increase drops a bead of ink
 * and floats the amount. Screen readers hear the total at most every 30 seconds.
 */
export function RaisedCounter({
  value,
  label = "Raised for causes",
  goal,
  level,
  latestTo,
  caption,
  compact,
  size = "lg",
  tone = "sage",
  announceEvery = 30_000,
  headingLevel = 2,
  className,
  ...props
}: RaisedCounterProps) {
  const titleId = `raised-${useId().replace(/:/g, "")}`;
  const reduced = useReducedMotion();
  const ink = INK_TONES[tone];
  const fill = goal ? clamp01(value / goal) : clamp01(level ?? 0.62);
  const prev = useRef(value);
  const [drops, setDrops] = useState<Drop[]>([]);
  const seq = useRef(0);
  // Read at the moment the value changes, not as a trigger of its own.
  const latestToRef = useRef(latestTo);
  latestToRef.current = latestTo;

  useEffect(() => {
    const delta = value - prev.current;
    prev.current = value;
    if (delta <= 0) return;
    const id = ++seq.current;
    setDrops((d) => [...d.slice(-2), { id, delta, to: latestToRef.current }]);
    const t = setTimeout(() => setDrops((d) => d.filter((x) => x.id !== id)), 2400);
    return () => clearTimeout(t);
  }, [value]);

  const spokenTotal = `${label}: ${formatUsd(value)}${goal ? ` of ${formatUsd(goal)}` : ""}`;
  const announcement = useThrottledAnnouncement(spokenTotal, announceEvery);
  const Heading = `h${headingLevel}` as const;

  return (
    <section
      data-slot="raised-counter"
      aria-labelledby={titleId}
      className={cn(
        "@container relative isolate overflow-hidden rounded-[28px] border border-line bg-card",
        size === "lg" ? "min-h-56 p-6 @md:p-8" : "min-h-40 p-5",
        className,
      )}
      {...props}
    >
      <InkFill level={fill} pigment={ink.pigment} deep={ink.deep} wave={size === "lg" ? 9 : 6} className="-z-10" />
      <PaperGrain className="-z-10" />

      {/* Ink beads falling into the fill on each gift. */}
      <AnimatePresence>
        {reduced
          ? null
          : drops.map((d, i) => (
              <motion.span
                key={`drop-${d.id}`}
                aria-hidden="true"
                className="absolute top-0 -z-10 size-3 rounded-full"
                style={{ left: `${62 + i * 9}%`, background: ink.pigment, opacity: 0.6 }}
                initial={{ y: -12, scale: 0.8 }}
                animate={{ y: [-12, 220], scale: [0.8, 1, 0.4], opacity: [0.7, 0.7, 0] }}
                exit={{ opacity: 0 }}
                transition={{ duration: 1.1, ease: "easeIn" }}
              />
            ))}
      </AnimatePresence>

      <div className="relative flex flex-col gap-2">
        <Heading id={titleId} className="kicker m-0 font-sans">
          {label}
        </Heading>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <NumberTicker
            value={value}
            format={usdFormatOptions(value, compact)}
            className={cn("font-semibold leading-none tracking-tight text-ink", size === "lg" ? "text-5xl @md:text-6xl @2xl:text-7xl" : "text-4xl")}
          />
          <span className="relative inline-flex h-7 min-w-24 items-center" aria-hidden="true">
            <AnimatePresence>
              {drops.slice(-1).map((d) => (
                <motion.span
                  key={`chip-${d.id}`}
                  className={cn("num absolute left-0 whitespace-nowrap rounded-full bg-card/90 px-2.5 py-0.5 text-sm font-semibold shadow-paper", ink.text)}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, y: -14 }}
                  transition={{ type: "spring", stiffness: 260, damping: 22 }}
                >
                  +{formatUsd(d.delta)}
                  {d.to ? <span className="font-sans font-medium text-ink-soft"> to {d.to}</span> : null}
                </motion.span>
              ))}
            </AnimatePresence>
          </span>
        </div>
        {goal ? (
          <p className="m-0 text-sm text-ink-soft">
            <span className="num font-semibold text-ink">{Math.round(fill * 100)}%</span> of the{" "}
            <span className="num">{formatUsd(goal)}</span> goal
          </p>
        ) : null}
        {caption ? <div className="mt-auto max-w-prose pt-4 text-sm text-ink-soft">{caption}</div> : null}
      </div>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </section>
  );
}
