// Adapted from 21st.dev @kevingirelli/bar-chart (id 35239): one series of bars that grow from the
// baseline on first view, a hover/focus tooltip, and a keyboard slider over the bars (arrows, Home,
// End, Page Up/Down) with each bar announced. Redrawn as HTML bars for volume by hour, with the peak
// labelled and axis ticks thinned by container queries.
"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@verada/ui/lib/utils";
import { formatUsdCompact } from "./liquidity-meter";

export interface VolumeBar {
  /** "14:00", "Mon". */
  label: string;
  /** Volume in USD (or the unit `format` writes). */
  value: number;
}

export interface VolumeBarsProps {
  data: readonly VolumeBar[];
  title?: string;
  headingLevel?: 2 | 3 | 4;
  /** Series name for the slider and tooltip (default "Volume"). */
  name?: string;
  format?: (value: number) => string;
  /** Bar to mark: the `peak` (default), an index, or `none`. */
  highlight?: "peak" | "none" | number;
  /** Plot height in px (default 120). */
  height?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  /** Sentence under the chart; defaults to peak and total. */
  caption?: string | null;
  className?: string;
}

/** Index of the largest bar (first one on ties), -1 when empty. */
export function peakIndex(data: readonly VolumeBar[]): number {
  let at = -1;
  data.forEach((d, i) => {
    if (at < 0 || d.value > data[at]!.value) at = i;
  });
  return at;
}

/** Volume by hour as small bars, the peak marked in words and colour, with a keyboard-readable slider. */
export function VolumeBars({
  data,
  title = "Volume by hour",
  headingLevel = 3,
  name = "Volume",
  format = formatUsdCompact,
  highlight = "peak",
  height = 120,
  defaultIndex,
  onIndexChange,
  caption,
  className,
}: VolumeBarsProps) {
  const id = useId();
  const reduced = useReducedMotion();
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const peak = useMemo(() => peakIndex(data), [data]);
  const marked = highlight === "peak" ? peak : highlight === "none" ? -1 : highlight;
  const [active, setActive] = useState(() => defaultIndex ?? (marked >= 0 ? marked : data.length - 1));
  const [engaged, setEngaged] = useState(false);
  const max = Math.max(0, ...data.map((d) => d.value)) || 1;
  const total = data.reduce((s, d) => s + d.value, 0);
  const n = data.length;
  if (n === 0) return null;
  const index = Math.min(Math.max(active, 0), n - 1);
  const bar = data[index]!;

  const select = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), n - 1);
    if (clamped === index) return;
    setActive(clamped);
    onIndexChange?.(clamped);
  };
  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    setEngaged(true);
    select(Math.floor(((e.clientX - box.left) / box.width) * n));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.round(n / 6));
    const moves: Record<string, number> = {
      ArrowLeft: index - 1,
      ArrowDown: index - 1,
      ArrowRight: index + 1,
      ArrowUp: index + 1,
      PageDown: index - page,
      PageUp: index + page,
      Home: 0,
      End: n - 1,
    };
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setEngaged(true);
    select(next);
  };

  const valueText = `${bar.label}: ${format(bar.value)}${index === marked && highlight === "peak" ? ", the peak" : ""}`;
  const summary = caption === undefined ? (marked >= 0 ? `Peak ${data[marked]!.label} · ${format(data[marked]!.value)} · ${format(total)} in total` : `${format(total)} in total`) : caption;
  const center = ((index + 0.5) / n) * 100;
  // Thin the axis (more than 12 bars): every 6th label by default, every 3rd from @md, every 2nd from @2xl; always the ends.
  const tickClass = (i: number) => (n <= 12 || i === 0 || i === n - 1 || i % 6 === 0 ? "" : i % 3 === 0 ? "hidden @md:block" : i % 2 === 0 ? "hidden @2xl:block" : "hidden");

  return (
    <section data-slot="volume-bars" aria-labelledby={`${id}-title`} className={cn("@container flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 @md:p-5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Heading id={`${id}-title`} className="m-0 font-sans text-base font-semibold">
          {title}
        </Heading>
        <span className="num text-[13px] text-ink-muted">{format(total)}</span>
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label={`${name}, ${title.toLowerCase()}`}
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={index + 1}
        aria-valuetext={valueText}
        data-engaged={engaged ? "" : undefined}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => setEngaged(false)}
        onFocus={() => setEngaged(true)}
        onBlur={() => setEngaged(false)}
        onKeyDown={onKeyDown}
        className="relative mt-6 touch-pan-y rounded-md outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
        style={{ height }}
      >
        <div aria-hidden="true" className="absolute inset-0 flex items-end gap-[2px] border-b border-line-strong @md:gap-[3px]">
          {data.map((d, i) => {
            const isMarked = i === marked;
            const isActive = engaged && i === index;
            return (
              <motion.span
                key={`${d.label}-${i}`}
                data-bar={i}
                data-peak={isMarked ? "" : undefined}
                className={cn(
                  "min-w-0 flex-1 rounded-t-[3px] transition-colors",
                  isMarked ? "bg-terracotta" : "bg-sage/70",
                  isActive && (isMarked ? "bg-terracotta-strong" : "bg-sage"),
                  engaged && !isActive && "opacity-60",
                )}
                style={{ height: `${Math.max(1.5, (d.value / max) * 100)}%`, transformOrigin: "bottom" }}
                initial={reduced ? false : { scaleY: 0 }}
                whileInView={{ scaleY: 1 }}
                viewport={{ once: true, margin: "0px 0px -10% 0px" }}
                transition={{ duration: 0.5, delay: Math.min(0.6, i * 0.025), ease: [0.22, 1, 0.36, 1] }}
              />
            );
          })}
        </div>

        {marked >= 0 && !engaged ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -translate-x-1/2 pb-1 text-[11px] font-semibold whitespace-nowrap text-terracotta-strong"
            style={{ left: `${Math.min(88, Math.max(12, ((marked + 0.5) / n) * 100))}%`, bottom: `${Math.max(1.5, (data[marked]!.value / max) * 100)}%` }}
          >
            Peak <span className="num">{format(data[marked]!.value)}</span>
          </span>
        ) : null}

        {engaged ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-2 z-10 -translate-y-full rounded-lg bg-ink px-2.5 py-1.5 text-xs whitespace-nowrap text-paper shadow-float"
            style={center > 50 ? { right: `${100 - center}%` } : { left: `${center}%` }}
          >
            <span className="block text-paper/80">{bar.label}</span>
            <span className="num font-semibold">
              {name} {format(bar.value)}
            </span>
          </span>
        ) : null}
      </div>

      <div aria-hidden="true" className="flex h-4 text-[11px] text-ink-muted">
        {data.map((d, i) => (
          <span key={`${d.label}-${i}`} className="relative min-w-0 flex-1">
            <span className={cn("num absolute left-1/2 -translate-x-1/2 whitespace-nowrap", i === 0 && "left-0 translate-x-0", i === n - 1 && "right-0 left-auto translate-x-0", tickClass(i))}>
              {d.label}
            </span>
          </span>
        ))}
      </div>

      {summary ? <p className="m-0 mt-3 text-[13px] text-ink-muted">{summary}</p> : null}
    </section>
  );
}
