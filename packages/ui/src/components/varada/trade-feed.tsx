// Adapted from 21st.dev @ssychui/trade-journal-table (id 27124): the quiet column head, one ruled
// row per fill and a written side pill. Reworked as Varada's live trade tape: rows arrive at the top
// with a one-off flash, side is written out with an arrow, the trader is an ENS chip, fees sent to
// the cause show as a chip, and the list holds still under the pointer with a "N new trades" pill.
// The compact TradeTicker below runs the same rows through the Marquee (21st.dev
// @kevingirelli/marquee, id 35200).
"use client";

import { ArrowDownRight, ArrowUpRight, ExternalLink, HandHeart } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState, type ComponentProps, type FocusEvent, type ReactNode } from "react";
import { Divider } from "@verada/ui/components/ui/divider";
import { Skeleton } from "@verada/ui/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@verada/ui/components/ui/toggle-group";
import { Marquee } from "@verada/ui/components/motion/marquee";
import { cn } from "@verada/ui/lib/utils";
import { EnsAddress } from "./ens-address";
import { shortenAddress } from "./ens-shared";
import type { TradeSide } from "./trade-panel";

export type { TradeSide };

export interface TradeItem {
  id: string;
  side: TradeSide;
  /** The wallet that sent the swap (the transaction's sender, not the router). */
  trader: { address: `0x${string}`; ens?: string };
  /** Coin amount bought or sold. */
  tokenAmount: number;
  /** "$HARAMBE" */
  tokenSymbol: string;
  /** Quote asset paid (buy) or received (sell). */
  quoteAmount: number;
  /** "NVDAon", "WETH" */
  quoteSymbol: string;
  /** Trade value in USD, when the quote has a price. */
  usd?: number;
  /** Cause share of this trade's fee, in USD. */
  causeUsd?: number;
  /** Unix seconds. */
  timestamp: number;
  txHash: `0x${string}`;
  /** Link for the transaction; defaults to Etherscan. */
  explorerUrl?: string;
}

export type TradeFilter = "all" | "buy" | "sell" | "large";

const count = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

/** "303.16M", "9,812", "0.4412". */
export function formatTokenAmount(n: number): string {
  if (n >= 100_000) return compact.format(n);
  if (n >= 1_000) return count.format(Math.round(n));
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

/** "$1,249", "$84.20", "$0.42". */
export function formatUsd(n: number): string {
  if (n >= 100) return `$${count.format(Math.round(n))}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "just now", "42s ago", "3 min ago", "5 h ago", then the date. */
export function formatAgo(timestamp: number, nowMs: number): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - timestamp));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3_600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)} h ago`;
  return new Date(timestamp * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Trades matching a filter tab. `large` keeps trades worth at least `largeUsd`. */
export function filterTrades(trades: readonly TradeItem[], filter: TradeFilter, largeUsd: number): TradeItem[] {
  if (filter === "all") return [...trades];
  if (filter === "large") return trades.filter((t) => (t.usd ?? 0) >= largeUsd);
  return trades.filter((t) => t.side === filter);
}

/** "3 new trades: 2 buys, 1 sell." */
export function tradeSummary(buys: number, sells: number): string {
  const n = buys + sells;
  const parts = [buys ? `${buys} ${buys === 1 ? "buy" : "buys"}` : null, sells ? `${sells} ${sells === 1 ? "sell" : "sells"}` : null].filter(Boolean);
  return `${n} new ${n === 1 ? "trade" : "trades"}: ${parts.join(", ")}.`;
}

const txUrl = (t: TradeItem) => t.explorerUrl ?? `https://etherscan.io/tx/${t.txHash}`;

/** Re-renders every `ms` so relative times move on. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "Buy" / "Sell" with an arrow; the colour only repeats what the word says. */
export function TradeSideBadge({ side, className }: { side: TradeSide; className?: string }) {
  const buy = side === "buy";
  const Icon = buy ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      data-side={side}
      className={cn(
        "inline-flex h-6 w-fit items-center gap-1 rounded-md px-1.5 text-xs font-semibold",
        buy ? "bg-sage-tint text-gain" : "bg-terracotta-tint text-loss",
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {buy ? "Buy" : "Sell"}
    </span>
  );
}

/** "+$28.10 to cause" */
export function CauseChip({ usd, label = "to cause", className }: { usd: number; label?: string; className?: string }) {
  return (
    <span className={cn("inline-flex w-fit items-center gap-1 whitespace-nowrap rounded-full bg-sage-tint px-2 py-0.5 text-[11px] font-semibold text-sage-ink", className)}>
      <HandHeart aria-hidden="true" className="size-3" />
      <span className="num">+{formatUsd(usd)}</span> {label}
    </span>
  );
}

const ROW_GRID = cn(
  // Phone: three short lines. Side · amount · value / time · quote / trader · tx.
  "grid grid-cols-[4.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1",
  // From 36rem: one ruled line per trade, columns as in the head.
  "@xl:grid-cols-[4.25rem_4.25rem_minmax(0,0.8fr)_minmax(0,1fr)_6.25rem_minmax(0,1.4fr)_2.75rem] @xl:gap-y-0",
);

const CELL = {
  time: "col-start-1 row-start-2 @xl:row-start-1",
  side: "col-start-1 row-start-1 @xl:col-start-2",
  amount: "col-start-2 row-start-1 @xl:col-start-3",
  quote: "col-start-2 row-start-2 @xl:col-start-4 @xl:row-start-1",
  value: "col-start-3 row-span-2 row-start-1 @xl:col-start-5 @xl:row-span-1",
  trader: "col-span-2 col-start-1 row-start-3 @xl:col-span-1 @xl:col-start-6 @xl:row-start-1",
  tx: "col-start-3 row-start-3 @xl:col-start-7 @xl:row-start-1",
};

function TradeRow({ trade, fresh, now, reduced }: { trade: TradeItem; fresh: boolean; now: number; reduced: boolean }) {
  // Fixed at mount, so later renders (the clock) don't restart or cut the flash.
  const [flash] = useState(fresh);
  const buy = trade.side === "buy";
  return (
    <motion.li
      layout={reduced ? false : "position"}
      data-trade={trade.id}
      data-fresh={flash || undefined}
      initial={flash && !reduced ? { opacity: 0, y: -10 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: 0.15 } }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        ROW_GRID,
        "rounded-xl border-b border-dashed border-line px-2 py-2.5 last:border-b-0 @xl:rounded-lg @xl:border-solid @xl:py-2",
        flash && (buy ? "animate-flash" : "animate-flash-loss"),
        "motion-reduce:animate-none",
      )}
    >
      <time dateTime={new Date(trade.timestamp * 1000).toISOString()} suppressHydrationWarning className={cn(CELL.time, "num whitespace-nowrap text-xs text-ink-muted")}>
        {formatAgo(trade.timestamp, now)}
      </time>
      <TradeSideBadge side={trade.side} className={CELL.side} />
      <span className={cn(CELL.amount, "min-w-0 truncate text-sm")}>
        <span className="num font-semibold text-ink">{formatTokenAmount(trade.tokenAmount)}</span> <span className="text-ink-soft @xl:sr-only">{trade.tokenSymbol}</span>
      </span>
      <span className={cn(CELL.quote, "min-w-0 truncate text-[13px] text-ink-soft @xl:text-sm")}>
        <span className="@xl:sr-only">for </span>
        <span className="num text-ink">{formatTokenAmount(trade.quoteAmount)}</span> {trade.quoteSymbol}
      </span>
      <span className={cn(CELL.value, "flex flex-col items-end gap-1 text-right")}>
        {trade.usd !== undefined ? (
          <span className="num text-sm font-semibold text-ink">{formatUsd(trade.usd)}</span>
        ) : (
          <span className="text-sm text-ink-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">no USD price</span>
          </span>
        )}
        {trade.causeUsd ? <CauseChip usd={trade.causeUsd} className="@xl:sr-only" /> : null}
        {trade.causeUsd ? (
          <span aria-hidden="true" className="hidden text-[11px] font-semibold text-sage-ink @xl:inline">
            +{formatUsd(trade.causeUsd)} to cause
          </span>
        ) : null}
      </span>
      <span className={cn(CELL.trader, "min-w-0")}>
        <span className="sr-only">by </span>
        <EnsAddress
          address={trade.trader.address}
          name={trade.trader.ens}
          direction="reverse"
          noCopy
          nameOnly
          className="min-h-9 max-w-full border-0 bg-transparent py-0 pl-0 [&_img]:size-6 [&>span:first-child]:size-6"
        />
      </span>
      <a
        href={txUrl(trade)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`View transaction ${shortenAddress(trade.txHash)} on the explorer`}
        className={cn(
          CELL.tx,
          "inline-flex size-11 items-center justify-center justify-self-end rounded-full text-ink-muted transition-colors hover:bg-sand hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        <ExternalLink aria-hidden="true" className="size-4" />
      </a>
    </motion.li>
  );
}

export interface TradeFeedProps extends Omit<ComponentProps<"section">, "children"> {
  /** Any order; shown newest first. */
  trades: readonly TradeItem[];
  title?: string;
  headingLevel?: 2 | 3 | 4;
  /** The "Large" tab keeps trades worth at least this many USD (default 1,000). */
  largeUsd?: number;
  /** Rows shown at once (default 12). */
  maxRows?: number;
  /** First trades still loading: skeleton rows. */
  loading?: boolean;
  emptyText?: string;
  /** Hold the list still while the pointer or focus is inside (default true). */
  pauseOnHover?: boolean;
  /** Announce new trades as a short summary for screen readers (default true). */
  announce?: boolean;
  /** Filter tab (controlled) … */
  filter?: TradeFilter;
  /** … or the starting tab. */
  defaultFilter?: TradeFilter;
  onFilterChange?: (filter: TradeFilter) => void;
  /** Hide the filter tabs. */
  hideFilters?: boolean;
  /** Next to the title, e.g. a "Live" badge. */
  action?: ReactNode;
  /** Under the list, e.g. "See all trades". */
  footer?: ReactNode;
}

const FILTERS: { value: TradeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "buy", label: "Buys" },
  { value: "sell", label: "Sells" },
  { value: "large", label: "Large" },
];

/**
 * The coin's live trade tape. A size container: stacked three-line rows on a phone, one ruled
 * row per trade with a column head from 36rem. New trades slide in at the top and flash once
 * (static with reduced motion). While the pointer or keyboard focus is inside, the list holds
 * still and a pill counts what arrived; the pill (or leaving) catches up.
 */
export function TradeFeed({
  trades,
  title = "Trades",
  headingLevel = 3,
  largeUsd = 1_000,
  maxRows = 12,
  loading,
  emptyText = "No trades yet. The first buy shows up here.",
  pauseOnHover = true,
  announce = true,
  filter: filterProp,
  defaultFilter = "all",
  onFilterChange,
  hideFilters,
  action,
  footer,
  className,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...props
}: TradeFeedProps) {
  const id = useId();
  const reduced = !!useReducedMotion();
  const now = useNow(5_000);
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const [innerFilter, setInnerFilter] = useState<TradeFilter>(defaultFilter);
  const filter = filterProp ?? innerFilter;
  const setFilter = (f: TradeFilter) => {
    if (filterProp === undefined) setInnerFilter(f);
    onFilterChange?.(f);
  };

  const sorted = useMemo(() => [...trades].sort((a, b) => b.timestamp - a.timestamp), [trades]);
  const matching = useMemo(() => filterTrades(sorted, filter, largeUsd), [sorted, filter, largeUsd]);

  // Held: every trade id present when the pointer or focus came in. Filters still apply while held;
  // trades that arrived since wait behind the pill.
  const [held, setHeld] = useState<Set<string> | null>(null);
  const hold = () => {
    if (pauseOnHover && !held) setHeld(new Set(trades.map((t) => t.id)));
  };
  const release = () => setHeld(null);
  const shown = (held ? matching.filter((t) => held.has(t.id)) : matching).slice(0, maxRows);
  const waiting = held ? matching.filter((t) => !held.has(t.id)).length : 0;

  // Trades seen in props so far; anything else is new (and flashes). Filter changes don't count.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(trades.map((t) => t.id));
  const fresh = (tradeId: string) => !seen.current!.has(tradeId);

  const [summary, setSummary] = useState("");
  const pending = useRef({ buys: 0, sells: 0 });
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const known = seen.current!;
    let buys = 0;
    let sells = 0;
    for (const t of trades) {
      if (known.has(t.id)) continue;
      known.add(t.id);
      if (t.side === "buy") buys++;
      else sells++;
    }
    if (!announce || buys + sells === 0) return;
    pending.current.buys += buys;
    pending.current.sells += sells;
    // At most one announcement every few seconds, however busy the coin is.
    flushTimer.current ??= setTimeout(() => {
      setSummary(tradeSummary(pending.current.buys, pending.current.sells));
      pending.current = { buys: 0, sells: 0 };
      flushTimer.current = null;
    }, 4_000);
  }, [trades, announce]);
  useEffect(() => () => void (flushTimer.current && clearTimeout(flushTimer.current)), []);

  const buys = matching.filter((t) => t.side === "buy").length;
  const symbol = sorted[0]?.tokenSymbol;

  return (
    <section
      data-slot="trade-feed"
      aria-labelledby={`${id}-title`}
      aria-busy={loading || undefined}
      className={cn("@container relative flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-card p-4 @md:p-5", className)}
      onPointerEnter={(e) => {
        onPointerEnter?.(e);
        if (e.pointerType !== "touch" && e.pointerType !== "pen") hold();
      }}
      onPointerLeave={(e) => {
        onPointerLeave?.(e);
        if (e.pointerType !== "touch" && e.pointerType !== "pen") release();
      }}
      onFocus={(e: FocusEvent<HTMLElement>) => {
        onFocus?.(e);
        hold();
      }}
      onBlur={(e: FocusEvent<HTMLElement>) => {
        onBlur?.(e);
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) release();
      }}
      {...props}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <Heading id={`${id}-title`} className="m-0 font-sans text-base font-semibold">
            {title}
          </Heading>
          {!loading && matching.length ? (
            <span className="num text-xs text-ink-muted">
              {count.format(matching.length)} {matching.length === 1 ? "trade" : "trades"}
              {filter === "all" ? ` · ${Math.round((buys / matching.length) * 100)}% buys` : ""}
            </span>
          ) : null}
          {action}
        </div>
        {hideFilters ? null : (
          <ToggleGroup aria-label="Show trades" size="sm" value={filter} onValueChange={(v) => v && setFilter(v as TradeFilter)}>
            {FILTERS.map((f) => (
              <ToggleGroupItem key={f.value} value={f.value} aria-label={f.value === "large" ? `Large, ${formatUsd(largeUsd)} or more` : undefined}>
                {f.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>

      <div aria-hidden="true" className={cn(ROW_GRID, "hidden border-b border-line px-2 pb-2 text-[11px] font-medium text-ink-muted @xl:grid")}>
        <span className={CELL.time}>Time</span>
        <span className={CELL.side}>Side</span>
        <span className={CELL.amount}>Amount{symbol ? ` (${symbol})` : ""}</span>
        <span className={CELL.quote}>Paid / received</span>
        <span className={cn(CELL.value, "text-right")}>Value</span>
        <span className={CELL.trader}>Trader</span>
        <span className={cn(CELL.tx, "text-right")}>Tx</span>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          <span className="sr-only">Loading trades…</span>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-2">
              <Skeleton className="h-6 w-14" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      ) : shown.length ? (
        <div className="relative">
          <AnimatePresence>
            {waiting > 0 ? (
              <motion.button
                key="new"
                type="button"
                onClick={release}
                initial={reduced ? false : { opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="absolute -top-1 left-1/2 z-10 inline-flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-paper shadow-float focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <ArrowUpRight aria-hidden="true" className="size-3.5 -rotate-45" />
                {waiting} new {waiting === 1 ? "trade" : "trades"}
              </motion.button>
            ) : null}
          </AnimatePresence>
          <ol aria-label={`${title}, newest first`} className="m-0 flex list-none flex-col p-0">
            <AnimatePresence initial={false} mode="popLayout">
              {shown.map((t) => (
                <TradeRow key={t.id} trade={t} fresh={fresh(t.id)} now={now} reduced={reduced} />
              ))}
            </AnimatePresence>
          </ol>
        </div>
      ) : (
        <p className="m-0 px-2 py-6 text-center text-sm text-ink-muted">
          {trades.length && filter !== "all" ? (filter === "large" ? `No trades of ${formatUsd(largeUsd)} or more yet.` : `No ${filter}s yet.`) : emptyText}
        </p>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {announce ? summary : ""}
      </p>

      {held && !waiting ? <span className="sr-only">Paused while you read.</span> : null}

      {footer ? (
        <>
          <Divider variant="dashed" />
          {footer}
        </>
      ) : null}
    </section>
  );
}

export interface TradeTickerProps extends Omit<ComponentProps<"div">, "children"> {
  trades: readonly TradeItem[];
  /** Latest trades shown (default 10). */
  limit?: number;
  /** Seconds for one loop. */
  duration?: number;
  label?: string;
}

/** The latest trades as a slow strip, for a coin header or the Discover page. */
export function TradeTicker({ trades, limit = 10, duration = 45, label = "Latest trades", className, ...props }: TradeTickerProps) {
  const latest = [...trades].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  if (!latest.length) return null;
  return (
    <Marquee data-slot="trade-ticker" label={label} duration={duration} gap="0.75rem" fade className={className} {...props}>
      {latest.map((t) => (
        <span key={t.id} className="inline-flex shrink-0 items-center gap-2 rounded-full border border-line bg-card py-1 pl-1 pr-3 text-[13px]">
          <TradeSideBadge side={t.side} className="rounded-full" />
          <span className="num font-semibold text-ink">{t.usd !== undefined ? formatUsd(t.usd) : `${formatTokenAmount(t.quoteAmount)} ${t.quoteSymbol}`}</span>
          <span className="text-ink-soft">{t.tokenSymbol}</span>
          <span className="text-ink-muted">· {t.trader.ens ?? shortenAddress(t.trader.address)}</span>
        </span>
      ))}
    </Marquee>
  );
}
