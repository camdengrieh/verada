// Adapted from 21st.dev @arihantcodes_1f7b8c4d/leaderboard-table (id 30672): medal badges for the top
// three and a weekly rank-movement column with up/down chevrons. Rows here are causes or coins ranked
// by money raised, with a share bar, and they glide to their new places when the order changes.
"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@varada/ui/lib/utils";
import { CAUSE_SHORT_LABELS, CauseIcon, type CauseName } from "./cause-icon";
import { formatUsd } from "./impact-shared";
import { DefaultLink, type LinkComponent } from "./shared";

export interface LeaderboardEntry {
  id: string;
  /** Display name: a cause label, a coin name or an ENS name. */
  name: string;
  /** Second line ("$HARAMBE · harambe.varada.eth"). */
  sub?: string;
  /** Painted icon for a cause row. */
  cause?: CauseName;
  /** Coin art for a coin row (an <img> or PaintedImage). */
  art?: ReactNode;
  /** USD raised in the period. */
  raised: number;
  /** Places moved since the last period: +2 climbed two, -1 dropped one, 0 held. Omit for new entries. */
  moved?: number;
  href?: string;
}

/** "Up 2 places" / "Down 1 place" / "No change" / "New". */
export function movementText(moved: number | undefined): string {
  if (moved === undefined) return "New this period";
  if (moved === 0) return "No change";
  const n = Math.abs(moved);
  return `${moved > 0 ? "Up" : "Down"} ${n} ${n === 1 ? "place" : "places"}`;
}

function Movement({ moved }: { moved?: number }) {
  const text = movementText(moved);
  const glyph = moved === undefined ? "New" : moved > 0 ? `▲ ${moved}` : moved < 0 ? `▼ ${Math.abs(moved)}` : "–";
  return (
    <span
      data-direction={moved === undefined ? "new" : moved > 0 ? "up" : moved < 0 ? "down" : "flat"}
      className={cn(
        "num inline-flex min-w-10 justify-end text-xs font-semibold",
        moved === undefined ? "text-stock-ink" : moved > 0 ? "text-gain" : moved < 0 ? "text-loss" : "text-ink-muted",
      )}
    >
      <span aria-hidden="true">{glyph}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

const MEDAL: Record<number, string> = {
  1: "bg-ochre-tint text-ochre-ink ring-ochre/50",
  2: "bg-sand text-ink-soft ring-line-strong",
  3: "bg-terracotta-tint text-terracotta-strong ring-terracotta/30",
};

export interface CauseLeaderboardProps extends Omit<ComponentProps<"section">, "children"> {
  entries: LeaderboardEntry[];
  title?: string;
  /** "This epoch", "All time"… */
  period?: string;
  /** Highlight a row (the viewer's coin). */
  highlightId?: string;
  LinkComponent?: LinkComponent;
  headingLevel?: 2 | 3 | 4;
}

/** Top causes or coins by money raised, with medals, rank movement and a share bar. */
export function CauseLeaderboard({
  entries,
  title = "Top causes",
  period,
  highlightId,
  LinkComponent = DefaultLink,
  headingLevel = 3,
  className,
  ...props
}: CauseLeaderboardProps) {
  const titleId = `board-${useId().replace(/:/g, "")}`;
  const reduced = useReducedMotion();
  const ranked = [...entries].sort((a, b) => b.raised - a.raised);
  const top = ranked[0]?.raised ?? 0;
  // Without any previous period to compare with, a column of "New" says nothing: hide it.
  const trackMovement = entries.some((e) => e.moved !== undefined);
  const Heading = `h${headingLevel}` as const;

  return (
    <section data-slot="cause-leaderboard" aria-labelledby={titleId} className={cn("@container flex flex-col gap-3", className)} {...props}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading id={titleId} className="m-0 font-display text-xl font-semibold">
          {title}
        </Heading>
        {period ? <span className="kicker">{period}</span> : null}
      </div>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {ranked.map((e, i) => {
          const rank = i + 1;
          const icon = e.art ? (
            <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-sand [&_img]:size-full [&_img]:object-cover">{e.art}</span>
          ) : e.cause ? (
            <CauseIcon cause={e.cause} size={40} decorative />
          ) : null;
          const body = (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "num grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold",
                  MEDAL[rank] ? `ring-1 ring-inset ${MEDAL[rank]}` : "text-ink-muted",
                )}
              >
                {rank}
              </span>
              {icon}
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-[15px] font-semibold text-ink">{e.name}</span>
                  <span className="num shrink-0 text-sm font-semibold text-ink">{formatUsd(e.raised, { compact: true })}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-sand">
                    <span
                      className={cn("block h-full rounded-full", rank === 1 ? "bg-ochre" : "bg-sage/70")}
                      style={{ width: `${top ? (e.raised / top) * 100 : 0}%` }}
                    />
                  </span>
                  {trackMovement ? <Movement moved={e.moved} /> : null}
                </span>
                {e.sub ? <span className="truncate text-xs text-ink-muted">{e.sub}</span> : null}
              </span>
            </>
          );
          const rowClass = cn(
            "flex min-h-14 items-center gap-3 rounded-2xl px-2 py-2 transition-colors",
            e.id === highlightId ? "bg-sage-tint" : "hover:bg-sand/70",
          );
          return (
            <motion.li key={e.id} layout={reduced ? false : "position"} transition={{ type: "spring", stiffness: 380, damping: 34 }}>
              <span className="sr-only">Rank {rank}. </span>
              {e.href ? (
                <LinkComponent href={e.href} className={rowClass}>
                  {body}
                </LinkComponent>
              ) : (
                <div className={rowClass}>{body}</div>
              )}
            </motion.li>
          );
        })}
      </ol>
    </section>
  );
}

/** Ready-made row for a cause category. */
export function causeEntry(cause: CauseName, raised: number, moved?: number, extra: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return { id: cause, name: CAUSE_SHORT_LABELS[cause], cause, raised, moved, ...extra };
}
