// Adapted from 21st.dev @isaiahbjork/financial-markets-table (id 9045): grid rows with logo, name, price
// and a coloured daily-performance column; the kind filter and token rows borrow from
// @ssychui/swap-ticket (id 27122)'s token picker. Rebuilt with tokens, ARIA table or radio-group
// semantics, search / kind / sort / launchable filters, and container queries: columns appear as the
// list itself gets wider (card rows, then Price and 24h, then liquidity and market, then route and coins).
"use client";

import { Search, SearchX } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "@verada/ui/components/ui/button";
import { Input, InputAddon, InputGroup, controlClasses } from "@verada/ui/components/ui/input";
import { Switch } from "@verada/ui/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@verada/ui/components/ui/toggle-group";
import { EmptyState } from "@verada/ui/components/data/empty-state";
import { cn } from "@verada/ui/lib/utils";
import { LIQUIDITY_TIER_LABEL, LiquidityMeter, formatUsdCompact, liquidityTier, type LiquidityThresholds } from "./liquidity-meter";
import { MARKET_SESSION_LABEL, MarketStatus, usMarketSession, type MarketSessionInfo } from "./market-status";
import { PriceChange } from "./price-change";
import {
  ASSET_KIND_SHORT,
  AlwaysOpen,
  DEFAULT_MIN_ROUTE_DEPTH,
  DEFAULT_QUOTE_SYMBOL,
  QuoteAssetLogo,
  followsUsSession,
  formatAssetPrice,
  isDirectUsdc,
  launchability,
  quoteMetaLine,
  type QuoteAsset,
} from "./quote-asset";
import { DefaultLink, type LinkComponent } from "./shared";

/**
 * The quote-asset explorer: Discover's pairs tab (link mode, each row opens the asset) and the launch
 * Pair step (select mode, a radio group; assets a coin can't pair with are disabled with the reason).
 * Filters live in the component; the asset data, clock and links come from the app.
 */

export type QuoteKindFilter = "all" | "crypto" | "stock" | "etf";
/** `featured`: crypto first, then by route depth. */
export type QuoteSort = "featured" | "liquidity" | "change" | "name";

export interface QuoteListFilter {
  query?: string;
  kind?: QuoteKindFilter;
  sort?: QuoteSort;
  launchableOnly?: boolean;
  minDepthUsd?: number;
}

const depthOf = (a: QuoteAsset) => (isDirectUsdc(a) ? Math.max(a.poolLiquidityUsd ?? 0, a.routeDepthUsd ?? 0) : (a.routeDepthUsd ?? 0));

function matches(a: QuoteAsset, q: string): boolean {
  const needle = q.trim().toLowerCase().replace(/^\$/, "");
  if (!needle) return true;
  const sym = a.symbol.toLowerCase();
  return sym.includes(needle) || sym.replace(/on$/, "") === needle || a.name.toLowerCase().includes(needle);
}

/** Search and launchable filters only (what the kind chips count). */
function baseFilter(assets: readonly QuoteAsset[], f: QuoteListFilter): QuoteAsset[] {
  const min = f.minDepthUsd ?? DEFAULT_MIN_ROUTE_DEPTH;
  return assets.filter((a) => matches(a, f.query ?? "") && (!f.launchableOnly || launchability(a, min).ok));
}

/** Counts for the kind chips, after search and the launchable toggle. RWAs count under All only. */
export function quoteKindCounts(assets: readonly QuoteAsset[], f: QuoteListFilter = {}): Record<QuoteKindFilter, number> {
  const base = baseFilter(assets, f);
  const n = (k: QuoteAsset["kind"]) => base.filter((a) => a.kind === k).length;
  return { all: base.length, crypto: n("crypto"), stock: n("stock"), etf: n("etf") };
}

/** Search (symbol or name), kind, launchable-only and sort, as the list applies them. */
export function filterQuoteAssets(assets: readonly QuoteAsset[], f: QuoteListFilter = {}): QuoteAsset[] {
  const kind = f.kind ?? "all";
  const out = baseFilter(assets, f).filter((a) => kind === "all" || a.kind === kind);
  const bySymbol = (a: QuoteAsset, b: QuoteAsset) => a.symbol.localeCompare(b.symbol, "en");
  const byDepth = (a: QuoteAsset, b: QuoteAsset) => depthOf(b) - depthOf(a) || (b.poolLiquidityUsd ?? 0) - (a.poolLiquidityUsd ?? 0) || bySymbol(a, b);
  switch (f.sort ?? "featured") {
    case "name":
      return out.sort(bySymbol);
    case "change":
      return out.sort((a, b) => (b.change24h ?? -Infinity) - (a.change24h ?? -Infinity) || bySymbol(a, b));
    case "liquidity":
      return out.sort(byDepth);
    default:
      return out.sort((a, b) => Number(b.kind === "crypto") - Number(a.kind === "crypto") || byDepth(a, b));
  }
}

const SORT_LABEL: Record<QuoteSort, string> = {
  featured: "Crypto first, then deepest",
  liquidity: "Liquidity, deepest first",
  change: "24h change, biggest gain first",
  name: "Name, A to Z",
};

const KIND_FILTERS: readonly [QuoteKindFilter, string][] = [
  ["all", "All"],
  ["crypto", "Crypto"],
  ["stock", "Stocks"],
  ["etf", "ETFs"],
];

interface ListCommon {
  assets: readonly QuoteAsset[];
  now: Date;
  holidays?: readonly string[];
  earlyCloses?: readonly string[];
  /** Minimum route depth for "launchable" (USD, default $10K). */
  minDepthUsd?: number;
  thresholds?: LiquidityThresholds;
  /** The coin pairing up, for the route column ("$HARAMBE → WETH → USDC"). */
  coinSymbol?: string;
  /** Heading over the list (default "Pair with"). */
  title?: string;
  headingLevel?: 2 | 3 | 4;
  /** Accessible name of the search box (default "Search assets"). */
  searchLabel?: string;
  searchPlaceholder?: string;
  /** Marked "Default" in its row (default WETH). Pass null for none. */
  recommendedSymbol?: string | null;
  defaultQuery?: string;
  defaultKind?: QuoteKindFilter;
  defaultSort?: QuoteSort;
  defaultLaunchableOnly?: boolean;
  /** Hide the search / kind / sort / launchable controls (a short fixed list). */
  hideControls?: boolean;
  /** Replaces the default empty state. */
  empty?: ReactNode;
  className?: string;
}

export interface QuoteAssetListLinkProps extends ListCommon {
  mode?: "link";
  /** Where a row goes. */
  getHref: (asset: QuoteAsset) => string;
  LinkComponent?: LinkComponent;
}

export interface QuoteAssetListSelectProps extends ListCommon {
  mode: "select";
  /** Selected symbol. */
  value: string | null | undefined;
  onValueChange: (symbol: string) => void;
  /** Accessible name of the radio group (default "Quote asset"). */
  groupLabel?: string;
}

export type QuoteAssetListProps = QuoteAssetListLinkProps | QuoteAssetListSelectProps;

/*
 * Container tiers (the list's own width, not the viewport):
 *  base   < 36rem  card rows: asset | price, liquidity | 24h, market | coins
 *  @xl   >= 36rem  compact table: asset · price · 24h
 *  @3xl  >= 48rem  + liquidity meter · market
 *  @5xl  >= 64rem  + fee route · coins paired
 */
const ROW = cn(
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5",
  "@xl:grid-cols-[minmax(0,1fr)_7.5rem_6rem] @xl:gap-y-0",
  "@3xl:grid-cols-[minmax(13rem,1.6fr)_7rem_5.5rem_minmax(11rem,1fr)_minmax(8.5rem,0.8fr)]",
  "@5xl:grid-cols-[minmax(13rem,1.5fr)_7rem_5.5rem_minmax(11rem,1fr)_minmax(10rem,1fr)_minmax(8.5rem,0.8fr)_4.5rem]",
);
const CELL = {
  asset: "col-start-1 row-start-1 @xl:col-auto @xl:row-auto",
  price: "col-start-2 row-start-1 text-right @xl:col-auto @xl:row-auto",
  change: "col-start-2 row-start-2 text-right @xl:col-auto @xl:row-auto",
  liquidity: "col-start-1 row-start-2 min-w-0 @xl:hidden @3xl:block @3xl:col-auto @3xl:row-auto",
  route: "hidden min-w-0 @5xl:block",
  market: "col-start-1 row-start-3 @xl:hidden @3xl:block @3xl:col-auto @3xl:row-auto",
  coins: "col-start-2 row-start-3 text-right @xl:hidden @5xl:block @5xl:col-auto @5xl:row-auto",
};
const HEADERS: readonly { key: keyof typeof CELL; label: string; className: string }[] = [
  { key: "asset", label: "Asset", className: "" },
  { key: "price", label: "Price", className: "text-right" },
  { key: "change", label: "24h", className: "text-right" },
  { key: "liquidity", label: "Liquidity", className: "hidden @3xl:block" },
  { key: "route", label: "Fee route", className: "hidden @5xl:block" },
  { key: "market", label: "Market", className: "hidden @3xl:block" },
  { key: "coins", label: "Coins", className: "hidden text-right @5xl:block" },
];

/** Every quote kind in one explorer: crypto, Ondo stocks and ETFs, with responsive columns. */
export function QuoteAssetList(props: QuoteAssetListProps) {
  const {
    assets,
    now,
    holidays,
    earlyCloses,
    minDepthUsd = DEFAULT_MIN_ROUTE_DEPTH,
    thresholds,
    coinSymbol,
    title = "Pair with",
    headingLevel = 2,
    searchLabel = "Search assets",
    searchPlaceholder = "Search WETH, NVDAon, Tesla…",
    recommendedSymbol = DEFAULT_QUOTE_SYMBOL,
    defaultQuery = "",
    defaultKind = "all",
    defaultSort = "featured",
    defaultLaunchableOnly = false,
    hideControls = false,
    empty,
    className,
  } = props;
  const id = useId();
  const [query, setQuery] = useState(defaultQuery);
  const [kind, setKind] = useState<QuoteKindFilter>(defaultKind);
  const [sort, setSort] = useState<QuoteSort>(defaultSort);
  const [launchableOnly, setLaunchableOnly] = useState(defaultLaunchableOnly);
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";

  const session = useMemo(() => usMarketSession(now, { holidays, earlyCloses }), [now, holidays, earlyCloses]);
  const filter: QuoteListFilter = { query, kind, sort, launchableOnly, minDepthUsd };
  const rows = filterQuoteAssets(assets, filter);
  const counts = quoteKindCounts(assets, filter);
  const present = useMemo(() => new Set(assets.map((a) => a.kind)), [assets]);
  const kindFilters = KIND_FILTERS.filter(([k]) => k === "all" || present.has(k));
  const hasSessioned = assets.some((a) => followsUsSession(a.kind));
  const hasCrypto = present.has("crypto");
  const select = props.mode === "select";

  const clear = () => {
    setQuery("");
    setKind("all");
    setLaunchableOnly(false);
  };

  const emptyState = empty ?? (
    <EmptyState
      size="compact"
      icon={<SearchX />}
      title="No assets match"
      body={launchableOnly ? "Try another search, or include assets without a deep enough route." : "Try another symbol or name."}
      action={
        <Button variant="outline" size="sm" onClick={clear}>
          Clear filters
        </Button>
      }
    />
  );

  return (
    <section data-slot="quote-asset-list" aria-labelledby={`${id}-title`} className={cn("@container flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Heading id={`${id}-title`} className="m-0 text-2xl font-semibold">
          {title}
        </Heading>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-muted">
          {hasSessioned ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="whitespace-nowrap">US market</span> <MarketStatus now={now} info={session} size="sm" />
            </span>
          ) : null}
          {hasCrypto ? <span className="hidden @md:inline">Crypto trades 24/7</span> : null}
        </span>
      </div>

      {hideControls ? null : (
        <div className="flex flex-col gap-3 @3xl:flex-row @3xl:flex-wrap @3xl:items-center">
          <InputGroup className="@3xl:max-w-xs">
            <InputAddon>
              <Search aria-hidden="true" />
            </InputAddon>
            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} aria-label={searchLabel} autoComplete="off" />
          </InputGroup>
          {kindFilters.length > 2 ? (
            <ToggleGroup type="single" value={kind} onValueChange={(v) => setKind(v as QuoteKindFilter)} aria-label="Asset kind" className="w-full max-w-full overflow-x-auto @xl:w-fit">
              {kindFilters.map(([k, label]) => (
                <ToggleGroupItem key={k} value={k} aria-label={`${label}, ${counts[k]}`} className="flex-1 gap-1 px-2.5 @xl:flex-none @xl:px-4">
                  {label} <span className="num hidden text-xs font-medium text-ink-muted @sm:inline">{counts[k]}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 @3xl:ml-auto">
            <span className="flex min-w-0 items-center gap-2">
              <label htmlFor={`${id}-sort`} className="text-sm font-semibold text-ink">
                Sort
              </label>
              <select id={`${id}-sort`} value={sort} onChange={(e) => setSort(e.target.value as QuoteSort)} className={cn(controlClasses, "h-11 w-auto min-w-0 max-w-full px-3")}>
                {(Object.keys(SORT_LABEL) as QuoteSort[]).map((s) => (
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
      )}

      <p aria-live="polite" className="m-0 text-[13px] text-ink-muted">
        {rows.length === assets.length ? `${rows.length} assets` : `${rows.length} of ${assets.length} assets`}
        {launchableOnly ? ` with a route at least ${formatUsdCompact(minDepthUsd)} deep` : null}
      </p>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-line bg-card">{emptyState}</div>
      ) : (
        <ListBody {...props} rows={rows} session={session} minDepthUsd={minDepthUsd} thresholds={thresholds} coinSymbol={coinSymbol} recommendedSymbol={recommendedSymbol} titleId={`${id}-title`} idBase={id} select={select} />
      )}
    </section>
  );
}

interface BodyProps {
  rows: QuoteAsset[];
  session: MarketSessionInfo;
  minDepthUsd: number;
  thresholds?: LiquidityThresholds;
  coinSymbol?: string;
  recommendedSymbol: string | null;
  titleId: string;
  idBase: string;
  select: boolean;
}

function ListBody(props: QuoteAssetListProps & BodyProps) {
  const { rows, session, minDepthUsd, thresholds, recommendedSymbol, titleId, idBase, select, now } = props;

  const summary = (a: QuoteAsset) => {
    const launch = launchability(a, minDepthUsd);
    const tier = liquidityTier(a.poolLiquidityUsd ?? a.routeDepthUsd, thresholds);
    const bits = [
      quoteMetaLine(a),
      a.price !== undefined ? formatAssetPrice(a.price) : "no price",
      a.change24h !== undefined ? (a.change24h > 0 ? `up ${a.change24h.toFixed(2)}%` : a.change24h < 0 ? `down ${Math.abs(a.change24h).toFixed(2)}%` : "unchanged") : null,
      followsUsSession(a.kind) ? (a.paused ? MARKET_SESSION_LABEL.paused : MARKET_SESSION_LABEL[session.session]) : "trades 24/7",
      `${LIQUIDITY_TIER_LABEL[tier].toLowerCase()} liquidity`,
      isDirectUsdc(a) ? "fees already USDC" : a.route && a.route.length > 1 ? `fees via ${a.route.slice(1).join(", ")}` : null,
      `${a.coinsPaired ?? 0} ${a.coinsPaired === 1 ? "coin" : "coins"} paired`,
      launch.ok ? "launchable" : `not launchable: ${launch.reason}`,
    ];
    return bits.filter(Boolean).join(", ");
  };

  const cells = (a: QuoteAsset, as: "cell" | "plain") => {
    const role = as === "cell" ? "cell" : undefined;
    const launch = launchability(a, minDepthUsd);
    const sessioned = followsUsSession(a.kind);
    const direct = isDirectUsdc(a);
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
          <QuoteAssetLogo asset={a} size={36} />
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              {as === "cell" && props.mode !== "select" ? (
                <AssetLink asset={a} href={props.getHref(a)} Link={props.LinkComponent ?? DefaultLink} />
              ) : (
                <span className="font-semibold text-ink">{a.symbol}</span>
              )}
              {recommendedSymbol === a.symbol ? <span className="shrink-0 rounded-full bg-sage-tint px-2 py-px text-[11px] font-semibold text-sage-ink">Default</span> : null}
            </span>
            <span className="truncate text-[13px] text-ink-muted">
              {a.name} · {ASSET_KIND_SHORT[a.kind]}
              {/* medium tier: no market column, so the session rides in the meta line */}
              <span className="hidden @xl:inline @3xl:hidden">
                {" · "}
                {sessioned ? (a.paused ? "Paused" : MARKET_SESSION_LABEL[session.session]) : "24/7"}
              </span>
            </span>
            {!launch.ok ? <span className="text-xs font-semibold text-terracotta-strong">Not launchable: {launch.reason}</span> : null}
          </span>
        </span>
        <span role={role} className={cn("num font-semibold", CELL.price)}>
          {a.price !== undefined ? formatAssetPrice(a.price) : <span className="font-normal text-ink-muted">No price</span>}
        </span>
        <span role={role} className={cn("text-sm", CELL.change)}>
          {a.change24h !== undefined ? <PriceChange value={a.change24h} decimals={2} /> : <span className="text-ink-muted">–</span>}
        </span>
        <span role={role} className={CELL.liquidity}>
          <LiquidityMeter value={direct ? (a.poolLiquidityUsd ?? a.routeDepthUsd) : a.routeDepthUsd} label={`${a.symbol} ${direct ? "pool depth" : "route depth"}`} thresholds={thresholds} />
        </span>
        <span role={role} className={cn("text-[13px]", CELL.route)}>
          {direct ? (
            <span className="font-semibold text-sage-ink">Direct USDC</span>
          ) : a.route && a.route.length > 1 ? (
            <span className="flex flex-col">
              <span className="truncate font-semibold text-ink">{a.route.join(" → ")}</span>
              {a.routeDepthUsd ? <span className="num text-xs text-ink-muted">{formatUsdCompact(a.routeDepthUsd)} deep</span> : null}
            </span>
          ) : (
            <span className="font-semibold text-terracotta-strong">No route</span>
          )}
        </span>
        <span role={role} className={CELL.market}>
          {sessioned ? <MarketStatus now={now} info={session} paused={a.paused} showCountdown={false} size="sm" /> : <AlwaysOpen compact />}
        </span>
        <span role={role} className={cn("text-[13px] text-ink-soft", CELL.coins)}>
          <span className="num font-semibold text-ink">{a.coinsPaired ?? 0}</span>
          <span className="@5xl:sr-only"> {a.coinsPaired === 1 ? "coin" : "coins"}</span>
        </span>
      </>
    );
  };

  const header = (
    <div role={select ? undefined : "row"} aria-hidden={select ? true : undefined} className={cn(ROW, "hidden px-4 pb-2 @xl:grid")}>
      {HEADERS.map((h) => (
        <span key={h.key} role={select ? undefined : "columnheader"} className={cn("text-xs font-semibold text-ink-muted", h.className)}>
          {h.label}
        </span>
      ))}
    </div>
  );

  if (props.mode === "select") {
    return (
      <div className="flex flex-col">
        {header}
        <RadioGroup.Root value={props.value ?? ""} onValueChange={props.onValueChange} aria-label={props.groupLabel ?? "Quote asset"} className="flex flex-col gap-2">
          {rows.map((a) => {
            const ok = launchability(a, minDepthUsd).ok;
            const descId = `${idBase}-${a.symbol}-desc`;
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
    );
  }

  return (
    <div role="table" aria-labelledby={titleId} className="flex flex-col">
      <div role="rowgroup">{header}</div>
      <div role="rowgroup" className="flex flex-col divide-y divide-dashed divide-line-strong overflow-hidden rounded-2xl border border-line bg-card">
        {rows.map((a) => (
          <div key={a.symbol} role="row" className={cn(ROW, "relative px-4 py-3 transition-colors focus-within:bg-paper hover:bg-paper")}>
            {cells(a, "cell")}
          </div>
        ))}
      </div>
    </div>
  );
}

function AssetLink({ asset, href, Link }: { asset: QuoteAsset; href: string; Link: LinkComponent }) {
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
