// Adapted from 21st.dev @felipemenezes098/item-19 activity feed (id 29394): media, title, meta and time per row; Varada tag chips and live inserts.
"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@varada/ui/lib/utils";

/** Built-in kinds get their own chip colours; any other string renders as a neutral chip. */
export type ActivityKind = "buy" | "sell" | "give" | "vote" | "new" | (string & {});

const CHIP: Record<string, string> = {
  buy: "bg-sand text-gain",
  sell: "bg-terracotta-tint text-terracotta-strong",
  give: "bg-sage text-paper",
  vote: "bg-sage-tint text-sage-ink",
  new: "bg-ochre-tint text-ochre-ink",
};

export interface ActivityTagProps {
  kind: ActivityKind;
  /** Text on the chip; defaults to the kind in capitals. */
  children?: ReactNode;
  className?: string;
}

/** Small caps chip naming what happened (BUY, SELL, GIVE, VOTE, NEW). */
export function ActivityTag({ kind, children, className }: ActivityTagProps) {
  return (
    <span
      data-slot="activity-tag"
      data-kind={kind}
      className={cn(
        "inline-flex min-w-12 items-center justify-center rounded-md px-2 py-0.5 text-[11px] font-bold tracking-[0.08em] uppercase",
        CHIP[kind] ?? "bg-sand text-ink",
        className,
      )}
    >
      {children ?? kind}
    </span>
  );
}

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  /** Chip text override. */
  tag?: ReactNode;
  title: ReactNode;
  /** Second line: wallet, pair, cause… */
  meta?: ReactNode;
  /** Right-hand figure, e.g. "+$120.40" or "2.1 ETH". */
  amount?: ReactNode;
  amountTone?: "gain" | "loss" | "cause" | "neutral";
  /** Display time, e.g. "2m ago". */
  time?: string;
  /** Machine-readable time (ISO 8601) for the `<time>` element. */
  dateTime?: string;
  /** Makes the whole row a link. */
  href?: string;
}

const AMOUNT_TONE = { gain: "text-gain", loss: "text-loss", cause: "text-sage-ink", neutral: "text-ink" } as const;

export interface ActivityListProps {
  items: ActivityItem[];
  /** Names the feed for assistive tech. */
  label: string;
  /** Animate rows that arrive after the first render. */
  live?: boolean;
  density?: "comfortable" | "compact";
  empty?: ReactNode;
  className?: string;
}

/** Timeline / feed of trades, gifts, votes and launches. An ordered list; newest first by convention. */
export function ActivityList({ items, label, live = true, density = "comfortable", empty, className }: ActivityListProps) {
  const reduced = useReducedMotion();
  if (items.length === 0 && empty) return <div className={className}>{empty}</div>;
  const pad = density === "compact" ? "py-2" : "py-3";
  return (
    <ol aria-label={label} data-slot="activity-list" className={cn("flex flex-col divide-y divide-line", className)}>
      <AnimatePresence initial={false}>
        {items.map((item) => {
          const body = (
            <>
              <ActivityTag kind={item.kind}>{item.tag}</ActivityTag>
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-ink">{item.title}</span>
                {item.meta ? <span className="truncate text-sm text-ink-muted">{item.meta}</span> : null}
              </div>
              <div className="flex flex-col items-end text-right">
                {item.amount ? (
                  <span className={cn("num font-semibold whitespace-nowrap", AMOUNT_TONE[item.amountTone ?? "neutral"])}>{item.amount}</span>
                ) : null}
                {item.time ? (
                  <time dateTime={item.dateTime} className="num text-xs whitespace-nowrap text-ink-muted">
                    {item.time}
                  </time>
                ) : null}
              </div>
            </>
          );
          const row = "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3";
          return (
            <motion.li
              key={item.id}
              layout={live && !reduced ? "position" : false}
              initial={live && !reduced ? { opacity: 0, y: -8 } : false}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: 0.15 } }}
              transition={{ duration: 0.35 }}
            >
              {item.href ? (
                <a href={item.href} className={cn(row, pad, "min-h-11 rounded-lg px-2 hover:bg-sand/60")}>
                  {body}
                </a>
              ) : (
                <div className={cn(row, pad, "px-2")}>{body}</div>
              )}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}

export interface ActivityChipProps {
  item: Pick<ActivityItem, "kind" | "tag" | "title" | "amount" | "amountTone" | "time" | "href">;
  className?: string;
}

/** One-line pill for the live activity marquee. */
export function ActivityChip({ item, className }: ActivityChipProps) {
  const inner = (
    <>
      <ActivityTag kind={item.kind}>{item.tag}</ActivityTag>
      <span className="font-medium text-ink">{item.title}</span>
      {item.amount ? <span className={cn("num font-semibold", AMOUNT_TONE[item.amountTone ?? "neutral"])}>{item.amount}</span> : null}
      {item.time ? <span className="num text-xs text-ink-muted">{item.time}</span> : null}
    </>
  );
  const cls = cn(
    "inline-flex min-h-11 items-center gap-2.5 rounded-full border border-line bg-paper-card py-1.5 pr-4 pl-2 text-sm whitespace-nowrap",
    className,
  );
  return item.href ? (
    <a href={item.href} className={cn(cls, "hover:bg-sand")}>
      {inner}
    </a>
  ) : (
    <span className={cls}>{inner}</span>
  );
}
