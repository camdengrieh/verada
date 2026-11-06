// Adapted from 21st.dev @kuratlielia/timeline (id 19574, demo 35051): markers that pop in, a connector
// that draws toward the next row as rows come into view, new rows sliding in at the top while the
// rest glide down, and a polite announcement of new entries. Rebuilt on Tailwind tokens, with cause
// icons as markers and a slot for the transaction link.
"use client";

import { ExternalLink } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "@varada/ui/lib/utils";
import { CAUSE_SHORT_LABELS, CauseIcon, type CauseName } from "./cause-icon";
import { formatUsd } from "./impact-shared";

export interface Donation {
  id: string;
  /** Receiving charity. */
  org: string;
  /** USD. */
  amount: number;
  cause: CauseName;
  /** When it was paid: epoch ms, ISO string or Date. */
  at: number | string | Date;
  /** Coin whose fees paid it ("$HARAMBE"). */
  coin?: string;
  /** Weekly pool payout or live donation. */
  via?: "pool" | "live";
  /** Explorer link for the payout transaction. */
  txHref?: string;
}

const toMs = (at: Donation["at"]) => (at instanceof Date ? at.getTime() : typeof at === "number" ? at : new Date(at).getTime());

/** "Just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(at: Donation["at"], now: number): string {
  const minutes = Math.max(0, Math.floor((now - toMs(at)) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface DonationTimelineProps extends Omit<ComponentProps<"section">, "children"> {
  donations: Donation[];
  /** Reference time for "5m ago" labels (the app owns the clock; pass a ticking value to refresh). */
  now: number;
  title?: string;
  /** Replace the default "View transaction" link. */
  renderTx?: (d: Donation) => ReactNode;
  headingLevel?: 2 | 3 | 4;
}

function Row({ d, now, last, fresh, index, renderTx }: { d: Donation; now: number; last: boolean; fresh: boolean; index: number; renderTx?: (d: Donation) => ReactNode }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(false);
  const delay = reduced ? 0 : Math.min(index, 6) * 0.08 + (fresh ? 0.12 : 0);
  const amount = formatUsd(d.amount);
  const iso = new Date(toMs(d.at)).toISOString();
  return (
    <motion.li
      layout={reduced ? false : "position"}
      className="relative grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0"
      initial={fresh && !reduced ? { opacity: 0, y: -10, filter: "blur(4px)" } : false}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
      onViewportEnter={() => setShown(true)}
      viewport={{ once: true, amount: 0.3 }}
    >
      <motion.span
        aria-hidden="true"
        className="relative z-[1] grid size-11 place-items-center rounded-full border border-line bg-card"
        initial={reduced ? false : { scale: 0.4, opacity: 0 }}
        animate={shown || reduced ? { scale: 1, opacity: 1 } : undefined}
        transition={{ type: "spring", stiffness: 420, damping: 22, delay }}
      >
        <CauseIcon cause={d.cause} size={30} decorative />
      </motion.span>
      {last ? null : (
        <motion.span
          aria-hidden="true"
          className="absolute bottom-0 left-[21px] top-11 w-0.5 origin-top rounded-full bg-line-strong"
          initial={reduced ? false : { scaleY: 0 }}
          animate={shown || reduced ? { scaleY: 1 } : undefined}
          transition={{ type: "spring", stiffness: 120, damping: 24, delay: delay + 0.1 }}
        />
      )}
      <div className="flex min-w-0 flex-col gap-0.5 pt-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="m-0 min-w-0 text-[15px] text-ink">
            <span className="num font-semibold text-sage-ink">{amount}</span> to <span className="font-semibold">{d.org}</span>
          </p>
          <time dateTime={iso} className="num shrink-0 text-xs text-ink-muted">
            {relativeTime(d.at, now)}
          </time>
        </div>
        <p className="m-0 text-[13px] text-ink-soft">
          {CAUSE_SHORT_LABELS[d.cause]}
          {d.coin ? <> · from {d.coin}</> : null}
          {d.via ? <> · {d.via === "pool" ? "weekly pool" : "live donation"}</> : null}
        </p>
        {renderTx ? (
          renderTx(d)
        ) : d.txHref ? (
          <a
            href={d.txHref}
            target="_blank"
            rel="noopener noreferrer"
            className="-ml-2 inline-flex min-h-11 items-center gap-1 self-start rounded-full px-2 text-[13px] font-semibold text-terracotta underline-offset-2 hover:underline"
          >
            View transaction
            <ExternalLink aria-hidden="true" className="size-3.5" />
            <span className="sr-only">
              {" "}
              for {amount} to {d.org} (opens in a new tab)
            </span>
          </a>
        ) : null}
      </div>
    </motion.li>
  );
}

/**
 * Recent payouts as a timeline: amount and charity, cause icon as the marker, coin and giving mode,
 * time ago and the transaction link. New donations slide in at the top and are announced.
 */
export function DonationTimeline({ donations, now, title = "Recent donations", renderTx, headingLevel = 3, className, ...props }: DonationTimelineProps) {
  const titleId = `donations-${useId().replace(/:/g, "")}`;
  const sorted = [...donations].sort((a, b) => toMs(b.at) - toMs(a.at));

  // Rows that arrive after the first render are fresh: they animate in and are announced.
  const ids = sorted.map((d) => d.id).join("|");
  const [known, setKnown] = useState(() => ({ ids, set: new Set(sorted.map((d) => d.id)), fresh: new Set<string>(), announcement: "" }));
  if (known.ids !== ids) {
    const added = sorted.filter((d) => !known.set.has(d.id));
    setKnown({
      ids,
      set: new Set(sorted.map((d) => d.id)),
      fresh: new Set([...known.fresh, ...added.map((d) => d.id)]),
      announcement: added.length
        ? `New donation${added.length > 1 ? "s" : ""}: ${added.map((d) => `${formatUsd(d.amount)} to ${d.org}`).join(", ")}`
        : known.announcement,
    });
  }
  const Heading = `h${headingLevel}` as const;

  return (
    <section data-slot="donation-timeline" aria-labelledby={titleId} className={cn("flex flex-col gap-4", className)} {...props}>
      <Heading id={titleId} className="m-0 font-display text-xl font-semibold">
        {title}
      </Heading>
      {sorted.length === 0 ? (
        <p className="m-0 text-sm text-ink-muted">No donations yet. The first payout shows here.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0">
          <AnimatePresence initial={false}>
            {sorted.map((d, i) => (
              <Row key={d.id} d={d} now={now} last={i === sorted.length - 1} fresh={known.fresh.has(d.id)} index={i} renderTx={renderTx} />
            ))}
          </AnimatePresence>
        </ol>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {known.announcement}
      </span>
    </section>
  );
}
