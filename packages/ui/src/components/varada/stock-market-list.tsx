// Adapted from 21st.dev @isaiahbjork/financial-markets-table (id 9045): grid rows with logo, name,
// price and a coloured daily-performance column. Rebuilt with tokens, ARIA table or radio-group
// semantics, search / kind / sort / launchable filters and a stacked layout under 768px.
"use client";

import { SearchX, Search } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "@verada/ui/components/ui/button";
import { Input, InputAddon, InputGroup, controlClasses } from "@verada/ui/components/ui/input";
import { Switch } from "@verada/ui/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@verada/ui/components/ui/toggle-group";
import { EmptyState } from "@verada/ui/components/data/empty-state";
import { cn } from "@verada/ui/lib/utils";
import { AssetKindBadge } from "./asset-kind-badge";
import { LIQUIDITY_TIER_LABEL, LiquidityMeter, formatUsdCompact, liquidityTier, type LiquidityThresholds } from "./liquidity-meter";
import { MARKET_SESSION_LABEL, MarketStatus, usMarketSession } from "./market-status";
import { PriceChange } from "./price-change";
import { DefaultLink, type LinkComponent } from "./shared";
import { DEFAULT_MIN_ROUTE_DEPTH, formatAssetPrice, launchability, type OndoAsset } from "./stock-market-card";
import { StockLogo } from "./stock-logo";

/**
 * The Ondo explorer: Discover's "Stocks & RWA" tab (link mode, each row opens the asset) and the
 * launch Pair step (select mode, a radio group; assets a coin can't pair with are disabled with the
 * reason). Filters live in the component; the asset data, clock and links come from the app.
 */

export type StockKindFilter = "all" | "stock" | "etf";
export type StockSort = "liquidity" | "change" | "name";

export interface StockListFilter {
  query?: string;
  kind?: StockKindFilter;
  sort?: StockSort;
  launchableOnly?: boolean;
  minDepthUsd?: number;
}

const depthOf = (a: OndoAsset) => a.routeDepthUsd ?? 0;

function matches(a: OndoAsset, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase().replace(/^\$/, "");
  if (!needle) return true;
  const sym = a.symbol.toLowerCase();
  return sym.includes(needle) || sym.replace(/on$/, "") === needle || a.name.toLowerCase().includes(needle);
}

/** Search and launchable filters only (what the kind chips count). */
function baseFilter(assets: readonly OndoAsset[], f: StockListFilter): OndoAsset[] {
  const min = f.minDepthUsd ?? DEFAULT_MIN_ROUTE_DEPTH;
  return assets.filter((a) => matches(a, f.query ?? "") && (!f.launchableOnly || launchability(a, min).ok));
}

/** Counts for the kind chips, after search and the launchable toggle. */
export function stockKindCounts(assets: readonly OndoAsset[], f: StockListFilter = {}): Record<StockKindFilter, number> {
  const base = baseFilter(assets, f);
  return { all: base.length, stock: base.filter((a) => a.kind === "stock").length, etf: base.filter((a) => a.kind === "etf").length };
}

/** Search (symbol or name), kind, launchable-only and sort, as the list applies them. */
export function filterStockAssets(assets: readonly OndoAsset[], f: StockListFilter = {}): OndoAsset[] {
  const kind = f.kind ?? "all";
  const out = baseFilter(assets, f).filter((a) => kind === "all" || a.kind === kind);
  const bySymbol = (a: OndoAsset, b: OndoAsset) => a.symbol.localeCompare(b.symbol, "en");
  switch (f.sort ?? "liquidity") {
    case "name":
      return out.sort(bySymbol);
    case "change":
      return out.sort((a, b) => (b.change24h ?? -Infinity) - (a.change24h ?? -Infinity) || bySymbol(a, b));
    default:
      return out.sort((a, b) => depthOf(b) - depthOf(a) || (b.poolLiquidityUsd ?? 0) - (a.poolLiquidityUsd ?? 0) || bySymbol(a, b));
  }
}

const SORT_LABEL: Record<StockSort, string> = {
  liquidity: "Liquidity, deepest first",
  change: "24h change, biggest gain first",
  name: "Name, A to Z",
};

interface ListCommon {
  assets: readonly OndoAsset[];
  now: Date;
  holidays?: readonly string[];
  earlyCloses?: readonly string[];
  /** Minimum route depth for "launchable" (USD, default $10K). */
  minDepthUsd?: number;
  thresholds?: LiquidityThresholds;
  /** Heading over the list (default "Stocks & RWA"). */
  title?: string;
  headingLevel?: 2 | 3 | 4;
  defaultQuery?: string;
  defaultKind?: StockKindFilter;
  defaultSort?: StockSort;
  defaultLaunchableOnly?: boolean;
  /** Replaces the default empty state. */
  empty?: ReactNode;
  className?: string;
}

export interface StockMarketListLinkProps extends ListCommon {
  mode?: "link";
  /** Where a row goes. */
  getHref: (asset: OndoAsset) => string;
  LinkComponent?: LinkComponent;
}

export interface StockMarketListSelectProps extends ListCommon {
  mode: "select";
  /** Selected symbol. */
  value: string | null | undefined;
  onValueChange: (symbol: string) => void;
  /** Accessible name of the radio group (default "Quote asset"). */
  groupLabel?: string;
}

export type StockMarketListProps = StockMarketListLinkProps | StockMarketListSelectProps;

/** Columns on wide screens: asset · price · 24h · market · liquidity · coins. */
const COLS = "md:grid-cols-[minmax(13rem,1.7fr)_minmax(6rem,0.7fr)_minmax(5.5rem,0.6fr)_minmax(8.5rem,0.9fr)_minmax(12rem,1.3fr)_minmax(4.5rem,0.5fr)]";
/** Phones: asset | price on the first line, liquidity | 24h, then market | coins. */
const ROW = cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 md:gap-y-0", COLS);
const CELL = {
  asset: "col-start-1 row-start-1 md:col-auto md:row-auto",
  price: "col-start-2 row-start-1 text-right md:col-auto md:row-auto",
  change: "col-start-2 row-start-2 text-right md:col-auto md:row-auto",
  market: "col-start-1 row-start-3 md:col-auto md:row-auto",
  liquidity: "col-start-1 row-start-2 min-w-0 md:col-auto md:row-auto",
  coins: "col-start-2 row-start-3 text-right md:col-auto md:row-auto",
};

export function StockMarketList(props: StockMarketListProps) {
  const {
    assets,
    now,
    holidays,
    earlyCloses,
    minDepthUsd = DEFAULT_MIN_ROUTE_DEPTH,
    thresholds,
    title = "Stocks & RWA",
    headingLevel = 2,
    defaultQuery = "",
    defaultKind = "all",
    defaultSort = "liquidity",
    defaultLaunchableOnly = false,
    empty,
    className,
  } = props;
  const id = useId();
  const [query, setQuery] = useState(defaultQuery);
  const [kind, setKind] = useState<StockKindFilter>(defaultKind);
  const [sort, setSort] = useState<StockSort>(defaultSort);
  const [launchableOnly, setLaunchableOnly] = useState(defaultLaunchableOnly);
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";

  const session = useMemo(() => usMarketSession(now, { holidays, earlyCloses }), [now, holidays, earlyCloses]);
  const filter: StockListFilter = { query, kind, sort, launchableOnly, minDepthUsd };
  const rows = filterStockAssets(assets, filter);
  const counts = stockKindCounts(assets, filter);
  const select = props.mode === "select";

  const clear = () => {
    setQuery("");
    setKind("all");
    setLaunchableOnly(false);
  };

  const summary = (a: OndoAsset) => {
    const launch = launchability(a, minDepthUsd);
    const tier = liquidityTier(a.routeDepthUsd, thresholds);
    const bits = [
      a.kind === "etf" ? "ETF" : a.kind === "rwa" ? "Real-world asset" : "Stock",
      a.price !== undefined ? formatAssetPrice(a.price) : "no price",
      a.change24h !== undefined ? (a.change24h > 0 ? `up ${a.change24h.toFixed(2)}%` : a.change24h < 0 ? `down ${Math.abs(a.change24h).toFixed(2)}%` : "unchanged") : null,
      a.paused ? MARKET_SESSION_LABEL.paused : MARKET_SESSION_LABEL[session.session],
      `${LIQUIDITY_TIER_LABEL[tier].toLowerCase()} liquidity`,
      `${a.coinsPaired ?? 0} ${a.coinsPaired === 1 ? "coin" : "coins"} paired`,
      launch.ok ? "launchable" : `not launchable: ${launch.reason}`,
    ];
    return bits.filter(Boolean).join(", ");
  };

  const cells = (a: OndoAsset, as: "cell" | "plain") => {
    const role = as === "cell" ? "cell" : undefined;
    const launch = launchability(a, minDepthUsd);
    return (
      <>
        <span role={role} className={cn("flex min-w-0 items-center gap-3", CELL.asset)}>
          {select ? (
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-line-strong bg-paper-card group-data-[state=checked]:border-primary"
            >
              <span className="size-2.5 rounded-full bg-primary opacity-0 group-data-[state=checked]:opacity-100" />
            </span>
          ) : null}
          <StockLogo symbol={a.symbol} kind={a.kind} src={a.logo?.src} srcSet={a.logo?.srcSet} size={36} decorative />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2">
              {as === "cell" && props.mode !== "select" ? (
                <AssetLink asset={a} href={props.getHref(a)} Link={props.LinkComponent ?? DefaultLink} />
              ) : (
                <span className="font-semibold text-ink">{a.symbol}</span>
              )}
              <AssetKindBadge kind={a.kind} className="px-1.5 py-0.5 text-[11px]" />
            </span>
            <span className="truncate text-[13px] text-ink-muted">{a.name}</span>
            {!launch.ok ? <span className="text-xs font-semibold text-terracotta-strong">Not launchable: {launch.reason}</span> : null}
          </span>
        </span>
        <span role={role} className={cn("num font-semibold", CELL.price)}>
          {a.price !== undefined ? formatAssetPrice(a.price) : <span className="font-normal text-ink-muted">No price</span>}
        </span>
        <span role={role} className={cn("text-sm", CELL.change)}>
          {a.change24h !== undefined ? <PriceChange value={a.change24h} decimals={2} /> : <span className="text-ink-muted">–</span>}
        </span>
        <span role={role} className={CELL.market}>
          <MarketStatus now={now} info={session} paused={a.paused} showCountdown={false} size="sm" />
        </span>
        <span role={role} className={CELL.liquidity}>
          <LiquidityMeter value={a.routeDepthUsd} label={`${a.symbol} route depth`} thresholds={thresholds} />
        </span>
        <span role={role} className={cn("text-[13px] text-ink-soft", CELL.coins)}>
          <span className="num font-semibold text-ink">{a.coinsPaired ?? 0}</span>
          <span className="md:sr-only"> {a.coinsPaired === 1 ? "coin" : "coins"}</span>
        </span>
      </>
    );
  };

  const header = (
    <div role={select ? undefined : "row"} aria-hidden={select ? true : undefined} className={cn(ROW, "hidden px-4 pb-2 md:grid")}>
      {["Asset", "Price", "24h", "Market", "Route depth", "Coins"].map((h, i) => (
        <span key={h} role={select ? undefined : "columnheader"} className={cn("kicker text-xs", i === 1 || i === 2 || i === 5 ? "text-right" : "")}>
          {h}
        </span>
      ))}
    </div>
  );

  const emptyState = empty ?? (
    <EmptyState
      size="compact"
      icon={<SearchX />}
      title="No assets match"
      body={launchableOnly ? "Try another search, or include assets without a deep enough route." : "Try another symbol or company name."}
      action={
        <Button variant="outline" size="sm" onClick={clear}>
          Clear filters
        </Button>
      }
    />
  );

  return (
    <section data-slot="stock-market-list" aria-labelledby={`${id}-title`} className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading id={`${id}-title`} className="m-0 text-2xl font-semibold">
          {title}
        </Heading>
        <span className="flex items-center gap-2 text-[13px] text-ink-muted">
          US market <MarketStatus now={now} info={session} />
        </span>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
        <InputGroup className="lg:max-w-xs">
          <InputAddon>
            <Search aria-hidden="true" />
          </InputAddon>
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search NVDAon, Tesla, SPY…" aria-label="Search Ondo assets" autoComplete="off" />
        </InputGroup>
        <ToggleGroup type="single" value={kind} onValueChange={(v) => setKind(v as StockKindFilter)} aria-label="Asset kind">
          {(
            [
              ["all", "All"],
              ["stock", "Stocks"],
              ["etf", "ETFs"],
            ] as const
          ).map(([k, label]) => (
            <ToggleGroupItem key={k} value={k} aria-label={`${label}, ${counts[k]}`}>
              {label} <span className="num text-xs font-medium text-ink-muted">{counts[k]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 lg:ml-auto">
          <span className="flex items-center gap-2">
            <label htmlFor={`${id}-sort`} className="text-sm font-semibold text-ink">
              Sort
            </label>
            <select id={`${id}-sort`} value={sort} onChange={(e) => setSort(e.target.value as StockSort)} className={cn(controlClasses, "h-11 w-auto px-3")}>
              {(Object.keys(SORT_LABEL) as StockSort[]).map((s) => (
                <option key={s} value={s}>
                  {SORT_LABEL[s]}
                </option>
              ))}
            </select>
          </span>
          <span className="flex min-h-11 items-center gap-2.5">
            <Switch id={`${id}-launchable`} checked={launchableOnly} onCheckedChange={setLaunchableOnly} />
            <label htmlFor={`${id}-launchable`} className="text-sm font-semibold text-ink">
              Launchable only
            </label>
          </span>
        </div>
      </div>

      <p aria-live="polite" className="m-0 text-[13px] text-ink-muted">
        {rows.length === assets.length ? `${rows.length} assets` : `${rows.length} of ${assets.length} assets`}
        {launchableOnly ? ` with a route at least ${formatUsdCompact(minDepthUsd)} deep` : null}
      </p>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-line bg-card">{emptyState}</div>
      ) : props.mode === "select" ? (
        <div className="flex flex-col">
          {header}
          <RadioGroup.Root
            value={props.value ?? ""}
            onValueChange={props.onValueChange}
            aria-label={props.groupLabel ?? "Quote asset"}
            className="flex flex-col gap-2"
          >
            {rows.map((a) => {
              const ok = launchability(a, minDepthUsd).ok;
              const descId = `${id}-${a.symbol}-desc`;
              return (
                <RadioGroup.Item
                  key={a.symbol}
                  value={a.symbol}
                  disabled={!ok}
                  aria-label={`${a.symbol}, ${a.name}`}
                  aria-describedby={descId}
                  className={cn(
                    ROW,
                    "group w-full rounded-2xl border-[1.5px] border-line bg-paper px-4 py-3 text-left text-ink transition-colors",
                    "hover:bg-paper-card data-[state=checked]:border-primary data-[state=checked]:bg-paper-card",
                    "disabled:cursor-not-allowed disabled:bg-sand/50 disabled:hover:bg-sand/50 [&:disabled>*]:opacity-75",
                  )}
                >
                  {cells(a, "plain")}
                  <span id={descId} className="sr-only">
                    {summary(a)}
                  </span>
                </RadioGroup.Item>
              );
            })}
          </RadioGroup.Root>
        </div>
      ) : (
        <div role="table" aria-labelledby={`${id}-title`} className="flex flex-col">
          <div role="rowgroup">{header}</div>
          <div role="rowgroup" className="flex flex-col divide-y divide-line overflow-hidden rounded-2xl border border-line bg-card">
            {rows.map((a) => (
              <div key={a.symbol} role="row" className={cn(ROW, "relative px-4 py-3 transition-colors focus-within:bg-paper hover:bg-paper")}>
                {cells(a, "cell")}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function AssetLink({ asset, href, Link }: { asset: OndoAsset; href: string; Link: LinkComponent }) {
  return (
    <Link
      href={href}
      aria-label={`${asset.symbol}, ${asset.name}`}
      className="font-semibold text-ink outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] hover:underline focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-ring"
    >
      {asset.symbol}
    </Link>
  );
}
