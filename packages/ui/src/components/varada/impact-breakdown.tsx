// Written for Varada: money raised split by cause category, as painted bars or a treemap-like grid
// of tiles sized by their share. Shares round with the largest-remainder method so they sum to 100.
"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId, type ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";
import { CAUSE_SHORT_LABELS, CauseIcon, type CauseName } from "./cause-icon";
import { formatUsd } from "./impact-shared";

export interface ImpactItem {
  cause: CauseName;
  /** USD raised. */
  amount: number;
  /** Overrides the catalogue's short label. */
  label?: string;
  /** Charities paid in this category. */
  charities?: number;
}

export interface ImpactShare extends ImpactItem {
  /** Whole percent; all shares sum to 100 (when the total is above zero). */
  share: number;
  /** Exact fraction of the total, 0–1. */
  ratio: number;
}

/** Sorts by amount and adds whole-percent shares that sum to exactly 100. */
export function breakdownShares(items: ImpactItem[]): ImpactShare[] {
  const sorted = [...items].filter((i) => i.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = sorted.reduce((s, i) => s + i.amount, 0);
  if (total <= 0) return sorted.map((i) => ({ ...i, share: 0, ratio: 0 }));
  const raw = sorted.map((i) => (i.amount / total) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((s, n) => s + n, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left--;
  }
  return sorted.map((item, i) => ({ ...item, share: floors[i] ?? 0, ratio: item.amount / total }));
}

const PIGMENTS = ["var(--sage)", "var(--ochre)", "var(--sky)", "var(--terracotta)", "var(--etf-ink)"];
const TINTS = ["bg-sage-tint", "bg-ochre-tint", "bg-stock-tint", "bg-terracotta-tint", "bg-etf-tint"];

export interface ImpactBreakdownProps extends Omit<ComponentProps<"section">, "children"> {
  items: ImpactItem[];
  title?: string;
  variant?: "bars" | "grid";
  /** Rows to show before "+ N more categories" (bars only). */
  limit?: number;
  headingLevel?: 2 | 3 | 4;
}

/** Where the money went, by cause category: icon, label, amount and share. */
export function ImpactBreakdown({ items, title = "Raised by cause", variant = "bars", limit, headingLevel = 3, className, ...props }: ImpactBreakdownProps) {
  const titleId = `impact-${useId().replace(/:/g, "")}`;
  const reduced = useReducedMotion();
  const shares = breakdownShares(items);
  const max = shares[0]?.amount ?? 0;
  const shown = limit ? shares.slice(0, limit) : shares;
  const hidden = shares.length - shown.length;
  const total = shares.reduce((s, i) => s + i.amount, 0);
  const Heading = `h${headingLevel}` as const;

  return (
    <section data-slot="impact-breakdown" aria-labelledby={titleId} className={cn("@container flex flex-col gap-3", className)} {...props}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading id={titleId} className="m-0 font-display text-xl font-semibold">
          {title}
        </Heading>
        <span className="text-sm text-ink-muted">
          <span className="num font-semibold text-ink">{formatUsd(total)}</span> across {shares.length} {shares.length === 1 ? "cause" : "causes"}
        </span>
      </div>

      {variant === "bars" ? (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {shown.map((s, i) => (
            <li key={s.cause} className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
              <CauseIcon cause={s.cause} size={36} decorative className="row-span-2" />
              <span className="min-w-0 truncate text-sm font-semibold text-ink">
                {s.label ?? CAUSE_SHORT_LABELS[s.cause]}
                {s.charities ? <span className="font-normal text-ink-muted"> · {s.charities} charities</span> : null}
              </span>
              <span className="num text-sm font-semibold text-ink">
                {formatUsd(s.amount)} <span className="font-normal text-ink-muted">{s.share}%</span>
              </span>
              <span aria-hidden="true" className="col-span-2 col-start-2 h-2.5 overflow-hidden rounded-full bg-sand">
                <motion.span
                  className="block h-full origin-left rounded-full"
                  style={{ width: `${max ? (s.amount / max) * 100 : 0}%`, background: PIGMENTS[i % PIGMENTS.length], opacity: 0.85 }}
                  initial={reduced ? false : { scaleX: 0 }}
                  whileInView={{ scaleX: 1 }}
                  viewport={{ once: true, amount: 0.5 }}
                  transition={{ type: "spring", stiffness: 60, damping: 18, delay: reduced ? 0 : i * 0.05 }}
                />
              </span>
            </li>
          ))}
          {hidden > 0 ? (
            <li className="pl-12 text-sm text-ink-muted">
              + {hidden} more {hidden === 1 ? "category" : "categories"}
            </li>
          ) : null}
        </ul>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {shown.map((s, i) => (
            <motion.li
              key={s.cause}
              className={cn(
                "relative flex min-h-28 min-w-0 flex-col justify-between gap-2 overflow-hidden rounded-2xl p-3",
                TINTS[i % TINTS.length],
              )}
              // Tiles grow in proportion to their amount; the basis keeps small ones legible.
              style={{ flexGrow: Math.max(1, Math.round(s.ratio * 100)), flexBasis: i === 0 ? "14rem" : "9rem" }}
              initial={reduced ? false : { opacity: 0, scale: 0.96 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.35, delay: reduced ? 0 : i * 0.05 }}
            >
              <CauseIcon cause={s.cause} size={i === 0 ? 64 : 44} decorative className="self-end" />
              <span className="flex flex-col">
                <span className="text-sm font-semibold text-ink">{s.label ?? CAUSE_SHORT_LABELS[s.cause]}</span>
                <span className="num text-sm text-ink-soft">
                  {formatUsd(s.amount)} · {s.share}%
                </span>
              </span>
            </motion.li>
          ))}
        </ul>
      )}
    </section>
  );
}
