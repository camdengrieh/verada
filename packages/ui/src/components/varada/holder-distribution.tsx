// Adapted from 21st.dev @8starlabs/partition-bar (id 26545): one bar split into proportional segments
// with titles and values under each. Reworked as a holder breakdown (pool, top 10, creator, others)
// with hover tooltips, a written legend, concentration warnings and container-query legend columns.
"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@varada/ui/components/ui/tooltip";
import { cn } from "@varada/ui/lib/utils";

export type HolderTone = "pool" | "top10" | "creator" | "others" | "muted";

export interface HolderSegment {
  key: string;
  label: string;
  /** Share of supply, percent. */
  percent: number;
  /** Wallets in this group, when it is a count ("10", "3,402"). */
  holders?: number;
  /** One line for the tooltip and legend ("Tokens sitting in the Uniswap pool"). */
  description?: string;
  tone?: HolderTone;
}

const TONE: Record<HolderTone, string> = {
  pool: "bg-sky",
  top10: "bg-ochre",
  creator: "bg-terracotta",
  others: "bg-sage",
  muted: "bg-line-strong",
};

/** Shares (percent of supply) at which holdings count as concentrated; HolderInsights uses them too. */
export const CONCENTRATION = { top10: 50, creator: 10 } as const;

export interface HolderShares {
  /** Supply in the pool, percent. */
  pool: number;
  /** Top 10 wallets (excluding pool and creator), percent. */
  top10: number;
  /** Creator wallet, percent. */
  creator: number;
  /** Everyone else; defaults to what's left of 100. */
  others?: number;
  /** Wallets outside the top 10 and the creator. */
  otherHolders?: number;
}

/** The standard four groups with labels, tones and descriptions. */
export function holderSegments(s: HolderShares): HolderSegment[] {
  const others = s.others ?? Math.max(0, 100 - s.pool - s.top10 - s.creator);
  return [
    { key: "pool", label: "Liquidity pool", percent: s.pool, tone: "pool", description: "Tokens in the Uniswap pool, available to trade" },
    { key: "top10", label: "Top 10 holders", percent: s.top10, holders: 10, tone: "top10", description: "The ten largest wallets, not counting the pool or the creator" },
    { key: "creator", label: "Creator", percent: s.creator, holders: 1, tone: "creator", description: "The wallet that launched the coin" },
    { key: "others", label: "Everyone else", percent: others, holders: s.otherHolders, tone: "others", description: "Every other holder" },
  ];
}

export interface HolderDistributionProps {
  segments: readonly HolderSegment[];
  /** Total holders, for the summary line. */
  totalHolders?: number;
  title?: string;
  headingLevel?: 2 | 3 | 4;
  /** Warn when the top 10 hold at least this share (default 50). */
  warnTop10At?: number;
  /** Warn when the creator holds at least this share (default 10). */
  warnCreatorAt?: number;
  className?: string;
}

const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
const count = new Intl.NumberFormat("en-US");

/** Who holds the supply: a stacked bar with tooltips and a written legend, flagged when concentrated. */
export function HolderDistribution({ segments, totalHolders, title = "Holder distribution", headingLevel = 3, warnTop10At = CONCENTRATION.top10, warnCreatorAt = CONCENTRATION.creator, className }: HolderDistributionProps) {
  const id = useId();
  const reduced = useReducedMotion();
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const total = segments.reduce((s, x) => s + Math.max(0, x.percent), 0) || 1;
  const top10 = segments.find((s) => s.key === "top10")?.percent ?? 0;
  const creator = segments.find((s) => s.key === "creator")?.percent ?? 0;
  const warnings = [
    top10 >= warnTop10At ? `Top 10 wallets hold ${pct(top10)} of supply` : null,
    creator >= warnCreatorAt ? `The creator holds ${pct(creator)}` : null,
  ].filter((w): w is string => Boolean(w));
  const spoken = segments.map((s) => `${s.label} ${pct(s.percent)}`).join(", ");

  return (
    <section data-slot="holder-distribution" aria-labelledby={`${id}-title`} className={cn("@container flex flex-col gap-4 rounded-2xl border border-line bg-card p-4 @md:p-5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Heading id={`${id}-title`} className="m-0 font-sans text-base font-semibold">
          {title}
        </Heading>
        {totalHolders !== undefined ? (
          <span className="text-[13px] text-ink-muted">
            <span className="num font-semibold text-ink">{count.format(totalHolders)}</span> holders
          </span>
        ) : null}
      </div>

      <div role="img" aria-label={`${title}: ${spoken}`} className="flex h-3.5 w-full gap-[3px]">
        {segments.map((s, i) =>
          s.percent > 0 ? (
            <Tooltip key={s.key}>
              <TooltipTrigger asChild>
                <motion.span
                  data-segment={s.key}
                  className={cn("h-full min-w-1 rounded-full", TONE[s.tone ?? "muted"])}
                  style={{ flexBasis: `${(s.percent / total) * 100}%`, transformOrigin: "left center" }}
                  initial={reduced ? false : { scaleX: 0, opacity: 0 }}
                  animate={{ scaleX: 1, opacity: 1 }}
                  transition={{ duration: 0.5, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] }}
                />
              </TooltipTrigger>
              <TooltipContent>
                <span className="block font-semibold">
                  {s.label} · <span className="num">{pct(s.percent)}</span>
                </span>
                {s.description ? <span className="block text-paper/80">{s.description}</span> : null}
              </TooltipContent>
            </Tooltip>
          ) : null,
        )}
      </div>

      <ul className="m-0 grid list-none gap-x-5 gap-y-3 p-0 @sm:grid-cols-2 @3xl:grid-cols-4">
        {segments.map((s) => (
          <li key={s.key} className="flex min-w-0 gap-2.5">
            <span aria-hidden="true" className={cn("mt-1 size-2.5 shrink-0 rounded-[3px]", TONE[s.tone ?? "muted"])} />
            <span className="flex min-w-0 flex-col">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[13px] font-semibold text-ink">{s.label}</span>
                <span className="num text-[13px] font-semibold text-ink">{pct(s.percent)}</span>
              </span>
              {s.holders !== undefined && s.holders > 1 ? <span className="text-xs text-ink-muted">{count.format(s.holders)} wallets</span> : null}
              {s.description ? <span className="hidden text-xs text-ink-muted @lg:block">{s.description}</span> : null}
            </span>
          </li>
        ))}
      </ul>

      {warnings.length ? (
        <p role="note" className="m-0 flex gap-2 rounded-xl bg-ochre-tint px-3 py-2.5 text-[13px] text-ochre-ink">
          <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>
            <strong>Concentrated.</strong> {warnings.join("; ")}. Large sells from a few wallets can move the price.
          </span>
        </p>
      ) : (
        <p className="m-0 flex gap-2 text-[13px] text-sage-ink">
          <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>No single group dominates the supply.</span>
        </p>
      )}
    </section>
  );
}
