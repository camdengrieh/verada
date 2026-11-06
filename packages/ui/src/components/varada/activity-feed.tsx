// Adapted from 21st.dev @olewandowski1/activity-1 (id 28482): recent-activity card rows
"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { Divider } from "@varada/ui/components/ui/divider";
import { cn } from "@varada/ui/lib/utils";
import { CauseIcon, type CauseName } from "./cause-icon";

export interface ActivityFeedItem {
  id: string;
  /** "$ZEN" */
  symbol: string;
  /** "gave to NAMI" */
  text: ReactNode;
  /** "2 min ago" */
  ago: string;
  /** "$412"; omit for events without money (rotations, epoch closes). */
  amount?: string;
  cause: CauseName;
  /** Newly arrived: flashes once (static with reduced motion). */
  fresh?: boolean;
}

export interface ActivityFeedProps extends Omit<ComponentProps<"section">, "children"> {
  items: readonly ActivityFeedItem[];
  title?: string;
  /** Announce new items politely to screen readers. Off by default: busy feeds get noisy. */
  announce?: boolean;
  /** Under the list, e.g. a "See all donations" link. */
  footer?: ReactNode;
  emptyText?: string;
}

/**
 * "Live giving": donations, rotations and epoch closes as they settle. A size container: the list
 * runs in two columns from 672px.
 */
export function ActivityFeed({ items, title = "Live giving", announce, footer, emptyText = "No donations yet.", className, ...props }: ActivityFeedProps) {
  const titleId = `feed-${useId().replace(/:/g, "")}`;
  return (
    <section aria-labelledby={titleId} data-slot="activity-feed" className={cn("@container flex flex-col gap-3.5 rounded-[24px] border border-line bg-card p-5", className)} {...props}>
      <h2 id={titleId} className="m-0 font-display text-xl font-semibold @2xs:text-[22px]">
        {title}
      </h2>
      {items.length ? (
        <ul
          aria-live={announce ? "polite" : undefined}
          aria-relevant="additions"
          className="m-0 flex list-none flex-col p-0 @2xl:grid @2xl:grid-cols-2 @2xl:gap-x-8"
        >
          {items.map((f) => (
            <li
              key={f.id}
              className={cn(
                "flex items-center gap-2.5 rounded-lg border-b border-dashed border-line py-3 first:pt-0 last:border-b-0 last:pb-0",
                // Two columns: the first row has no top padding and the last row no rule.
                "@2xl:nth-2:pt-0 @2xl:[&:nth-last-child(2):nth-child(odd)]:border-b-0 @2xl:[&:nth-last-child(2):nth-child(odd)]:pb-0",
                f.fresh && "animate-flash motion-reduce:animate-none",
              )}
            >
              <CauseIcon cause={f.cause} size={36} decorative className="@max-2xs:size-8" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm">
                  <strong>{f.symbol}</strong> {f.text}
                </span>
                <span className="text-xs text-ink-muted">{f.ago}</span>
              </div>
              <span className="num shrink-0 text-sm font-semibold">
                {f.amount ?? (
                  <>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">no amount</span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-ink-muted">{emptyText}</p>
      )}
      {footer ? (
        <>
          <Divider variant="dashed" />
          {footer}
        </>
      ) : null}
    </section>
  );
}
