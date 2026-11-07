"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DataTable, dataTableColumns } from "@varada/ui/components/data/data-table";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Button } from "@varada/ui/components/ui/button";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@varada/ui/components/ui/toggle-group";
import { CircleAlert, Coins, Search } from "@varada/ui/components/ui/icons";
import { ModeBadge } from "@varada/ui/components/varada/mode-badge";
import { PairChip } from "@varada/ui/components/varada/pair-chip";
import { PriceChange } from "@varada/ui/components/varada/price-change";
import { TokenCard, type TokenSummary as CardToken } from "@varada/ui/components/varada/token-card";
import { TokenRow } from "@varada/ui/components/varada/token-row";
import { CauseChip } from "@varada/ui/components/varada/cause-chip";
import type { DiscoverToken } from "@/lib/discover-client";
import { givingOf, maxRaisedOf, quoteUsdValue, toCardToken, tokenPath, type CardContext } from "@/lib/discover";
import { formatUsdPrice } from "@/lib/token-market";
import { compact, formatSmallNumber, timeAgo, unitsToNumber } from "@/lib/format";
import { useSentinel } from "./hooks";

export type ResultsView = "cards" | "list" | "table";

const VIEW_KEY = "varada:discover:view";

/** The remembered view; null when none was chosen or storage is unavailable. */
export function readView(): ResultsView | null {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return v === "cards" || v === "list" || v === "table" ? v : null;
  } catch {
    return null;
  }
}

function saveView(v: ResultsView) {
  try {
    window.localStorage.setItem(VIEW_KEY, v);
  } catch {
    // a private window or blocked storage: the choice just doesn't persist
  }
}

/** Cards on phones, the table from 1024px, unless the person picked one. */
export function useResultsView(): [ResultsView, (v: ResultsView) => void] {
  const [view, setView] = useState<ResultsView>("cards");
  useEffect(() => {
    const stored = readView();
    setView(stored ?? (window.matchMedia("(min-width: 1024px)").matches ? "table" : "cards"));
  }, []);
  return [
    view,
    (v) => {
      setView(v);
      saveView(v);
    },
  ];
}

export function ViewToggle({ value, onChange }: { value: ResultsView; onChange(v: ResultsView): void }) {
  return (
    <ToggleGroup aria-label="Layout" value={value} onValueChange={(v) => v && onChange(v as ResultsView)} size="sm">
      <ToggleGroupItem value="cards">Cards</ToggleGroupItem>
      <ToggleGroupItem value="list">List</ToggleGroupItem>
      <ToggleGroupItem value="table" className="max-md:hidden">
        Table
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

/* ---------- table ---------- */

interface Row {
  id: string;
  href: string;
  card: CardToken;
  token: DiscoverToken;
  /** Sort keys: null changes sort last. */
  change: number;
  price: number;
  /** Token price in dollars with its "~" flag, null when the quote asset has no price. */
  priceUsd: { usd: number; approx: boolean } | null;
  cap: number;
  volume: number;
  liquidity: number;
  holders: number;
  raised: number;
  age: number;
}

const col = dataTableColumns<Row>();

function tableRows(tokens: readonly DiscoverToken[], ctx: CardContext, href: (path: string) => string): Row[] {
  return tokens.map((t) => {
    const m = t.market;
    const qd = m?.quoteDecimals ?? 18;
    // Sort keys are dollars when the quote is priced, so a WETH pair and an NVDAon pair order against each other.
    const perQuote = m?.quote ? (ctx.usd?.(m.quote)?.priceUsd ?? null) : null;
    const k = perQuote ?? 1;
    const card = toCardToken(t, ctx);
    return {
      id: t.address,
      href: href(tokenPath(t.address)),
      card,
      token: t,
      change: m?.change24h ?? -Infinity,
      price: m?.price != null ? m.price * k : -1,
      priceUsd: m?.price != null && m.quote ? quoteUsdValue(m.price, m.quote, ctx) : null,
      cap: m && m.price !== null && m.supply !== null ? m.price * unitsToNumber(m.supply, 18) * k : -1,
      volume: m ? unitsToNumber(m.volume24hQuote, qd) * k : -1,
      liquidity: m ? unitsToNumber(m.quoteInPool, qd) * k : -1,
      holders: m?.holders ?? -1,
      raised: unitsToNumber(t.raised, 6),
      age: t.createdAt ?? 0,
    };
  });
}

const dash = <span className="text-ink-muted">–</span>;

function buildColumns(nowSeconds: number) {
  return col.columns([
    col.accessor((r) => r.token.name, {
      id: "name",
      header: "Coin",
      meta: { pinned: true, label: "Coin" },
      cell: ({ row }) => {
        const r = row.original;
        return (
          <a href={r.href} className="flex min-w-0 items-center gap-3 rounded-lg text-ink no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {r.card.art ? (
              <img src={r.card.art.src} alt="" width={36} height={36} loading="lazy" className="size-9 shrink-0 rounded-full bg-sand object-cover" />
            ) : (
              <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-terracotta-tint font-display text-sm font-bold text-terracotta-strong">
                {r.token.symbol.slice(0, 2).toUpperCase()}
              </span>
            )}
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-semibold">{r.card.name}</span>
              <span className="num truncate text-xs text-ink-muted">
                ${r.token.symbol} · {r.card.ens}
              </span>
            </span>
          </a>
        );
      },
    }),
    col.accessor((r) => r.card.quote.symbol, {
      id: "pair",
      header: "Pair",
      meta: { priority: 3, label: "Pair" },
      cell: ({ row }) => <PairChip coinSymbol={row.original.token.symbol} quoteSymbol={row.original.card.quote.symbol} quoteKind={row.original.card.quote.kind} quoteLogo={row.original.card.quote.logo} label={row.original.card.quote.symbol} quoteOnly />,
    }),
    col.accessor("price", {
      header: "Price",
      meta: { numeric: true, priority: 3, label: "Price in its pair" },
      cell: ({ row }) => {
        const m = row.original.token.market;
        if (m?.price == null) return dash;
        const inQuote = `${formatSmallNumber(m.price)} ${row.original.card.quote.symbol}`;
        const usd = row.original.priceUsd;
        return usd ? <span title={inQuote}>{formatUsdPrice(usd.usd, usd.approx)}</span> : <span title={`In ${row.original.card.quote.symbol}`}>{formatSmallNumber(m.price)}</span>;
      },
    }),
    col.accessor("change", {
      header: "24h",
      meta: { numeric: true, priority: 2, label: "24h change" },
      cell: ({ row }) => <PriceChange value={row.original.token.market?.change24h ?? null} />,
    }),
    col.accessor("cap", { header: "Market cap", meta: { numeric: true, priority: 4, label: "Market cap in its pair" }, cell: ({ row }) => (row.original.token.market ? row.original.card.marketCap : dash) }),
    col.accessor("volume", { header: "Volume 24h", meta: { numeric: true, priority: 4, label: "Volume over 24 hours in its pair" }, cell: ({ row }) => (row.original.token.market ? row.original.card.volume24h : dash) }),
    col.accessor("liquidity", { header: "Liquidity", meta: { numeric: true, priority: 5, label: "Quote asset in the pool" }, cell: ({ row }) => (row.original.token.market ? row.original.card.liquidity : dash) }),
    col.accessor("holders", { header: "Holders", meta: { numeric: true, priority: 5, label: "Holders" }, cell: ({ row }) => (row.original.token.market?.holders == null ? dash : compact(row.original.token.market.holders)) }),
    col.accessor("raised", {
      header: "Raised",
      meta: { numeric: true, priority: 2, label: "Raised for causes" },
      cell: ({ row }) => <span className="font-semibold text-sage-ink">{row.original.card.raised}</span>,
    }),
    col.display({
      id: "giving",
      header: "Giving",
      meta: { priority: 4, label: "Giving mode" },
      enableSorting: false,
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-1">
          <ModeBadge giving={givingOf(row.original.token)} />
          {row.original.card.causeLabel ? <span className="text-xs text-ink-muted">{row.original.card.causeLabel}</span> : <CauseChip cause={row.original.card.cause} size="sm" />}
        </span>
      ),
    }),
    col.accessor("age", {
      header: "Age",
      meta: { numeric: true, priority: 5, label: "Launched" },
      cell: ({ row }) => <span className="text-ink-soft">{row.original.token.createdAt ? timeAgo(row.original.token.createdAt, nowSeconds) : "–"}</span>,
    }),
  ]);
}

/* ---------- views ---------- */

export function ResultsSkeleton({ view }: { view: ResultsView }) {
  return (
    <div aria-busy="true" className={view === "cards" ? "grid gap-4 md:grid-cols-2 xl:grid-cols-3" : "flex flex-col gap-3"}>
      <p className="sr-only" role="status">
        Loading coins
      </p>
      {Array.from({ length: view === "cards" ? 6 : 8 }, (_, i) =>
        view === "cards" ? <Skeleton key={i} className="h-[27rem] rounded-[24px]" /> : <Skeleton key={i} className="h-20 rounded-[20px]" />,
      )}
    </div>
  );
}

export interface TokenResultsProps {
  tokens: readonly DiscoverToken[];
  ctx: Omit<CardContext, "maxRaised">;
  view: ResultsView;
  href(path: string): string;
  nowSeconds: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
  /** The scroller holding the list, when it is not the page (pull to refresh on phones). */
  scrollRoot?: Element | null;
  footer?: ReactNode;
}

/** Cards, compact rows or the sortable table, with an infinite-scroll sentinel and a Load more button. */
export function TokenResults({ tokens, ctx, view, href, nowSeconds, hasMore, loadingMore, onLoadMore, scrollRoot, footer }: TokenResultsProps) {
  const full: CardContext = useMemo(() => ({ ...ctx, maxRaised: maxRaisedOf(tokens, ctx.ethUsd) }), [ctx, tokens]);
  const sentinel = useSentinel(onLoadMore, hasMore && !loadingMore, scrollRoot);
  const go = (path: string) => () => {
    window.location.href = href(path);
  };
  const rows = useMemo(() => (view === "table" ? tableRows(tokens, full, href) : []), [view, tokens, full, href]);
  const columns = useMemo(() => buildColumns(nowSeconds), [nowSeconds]);

  return (
    <div className="flex flex-col gap-4">
      {view === "table" ? (
        <DataTable<Row>
          caption="Coins on Varada"
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          getRowLabel={(r) => r.card.name}
          itemName={{ one: "coin", other: "coins" }}
          flashNewRows={false}
        />
      ) : view === "list" ? (
        <ul className="m-0 grid list-none gap-3 p-0 xl:grid-cols-2">
          {tokens.map((t) => {
            const c = toCardToken(t, full);
            return (
              <li key={t.address} className="min-w-0">
                <TokenRow token={c} href={href(tokenPath(t.address))} />
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="m-0 grid list-none gap-4 p-0 md:grid-cols-2 xl:grid-cols-3">
          {tokens.map((t, i) => (
            <li key={t.address} className="min-w-0">
              <TokenCard token={toCardToken(t, full)} href={href(tokenPath(t.address))} onBuy={go(tokenPath(t.address))} priority={i < 3} />
            </li>
          ))}
        </ul>
      )}
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading more coins" : "Load more coins"}
          </Button>
        </div>
      ) : tokens.length > 0 ? (
        <p className="m-0 text-center text-sm text-ink-muted">That is every coin for these filters.</p>
      ) : null}
      {footer}
    </div>
  );
}

export function ResultsError({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <EmptyState
      icon={<CircleAlert />}
      title="Could not load coins"
      body={message}
      action={
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

export function ResultsEmpty({ filtered, onClear, launchHref }: { filtered: boolean; onClear(): void; launchHref: string }) {
  return filtered ? (
    <EmptyState
      icon={<Search />}
      title="No coins match"
      body="Try another search, or loosen the pair, cause or mode."
      action={
        <Button variant="outline" onClick={onClear}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={<Coins />}
      title="No coins yet"
      body="Be the first to launch a coin that gives."
      action={
        <a href={launchHref} className="inline-flex min-h-11 items-center rounded-full bg-primary px-5 font-semibold text-primary-foreground no-underline">
          Launch a coin
        </a>
      }
    />
  );
}
