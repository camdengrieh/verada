// Written for Varada. Identity header layout (logo, name, quiet meta line, price at the end) follows
// 21st.dev @haydenbleasel/ticker (id 19171); the kind glyph on the logo corner is Varada's own.
import { Building2, Coins, Gem, Layers } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@verada/ui/lib/utils";
import { formatUsdCompact } from "./liquidity-meter";
import type { ImpactStep } from "./price-impact-ladder";
import type { ImageSource } from "./shared";
import { StockLogo, type QuoteKind } from "./stock-logo";

/**
 * What a Varada coin is paired with. Two families: major mainnet crypto (WETH, WBTC, cbBTC, wstETH,
 * USDC, USDT, DAI, LINK, UNI, AAVE), which trades around the clock, and Ondo tokenized stocks and
 * ETFs (`NVDAon`, `SPYon`), whose prices track the US session and go stale outside it or while Ondo
 * pauses a token. Fees convert to USDC through the pool, then along the quote's route.
 */
export type QuoteAssetKind = QuoteKind;

/** A quote asset as the explorer, the launch Pair step and Discover show it. All data comes from the app. */
export interface QuoteAsset {
  /** `WETH`, `NVDAon` */
  symbol: string;
  /** "Wrapped Ether", "NVIDIA", "SPDR S&P 500 ETF Trust". */
  name: string;
  /** Crypto trades 24/7; stock, ETF and RWA follow the US session. */
  kind: QuoteAssetKind;
  /** Who issues the token, for the meta line. Defaults to "Ondo" for stock, ETF and RWA; none for crypto. */
  issuer?: string;
  logo?: ImageSource;
  /** USD price. */
  price?: number;
  /** 24h change in percent. */
  change24h?: number;
  /** 24h volume of the token's pool, USD. */
  volume24hUsd?: number;
  /** Ondo has paused minting and redemption for this token (stock, ETF, RWA only). */
  paused?: boolean;
  /** Liquidity of the token's own pool, USD. */
  poolLiquidityUsd?: number;
  /** Depth on the route that turns this token into USDC, USD. 0 or missing: no usable route. Ignored for USDC itself. */
  routeDepthUsd?: number;
  /** The pool's two sides in USD, for the split bar. */
  reserves?: { base: { symbol: string; usd: number }; quote: { symbol: string; usd: number } };
  /**
   * Hops from this token to USDC, starting with the token: ["NVDAon", "WETH", "USDC"]. `["USDC"]` (or the
   * USDC asset itself) means fees are already USDC. Empty: no route.
   */
  route?: readonly string[];
  /** Estimated impact by trade size on that route. */
  impact?: readonly ImpactStep[];
  /** Varada coins already paired with this token. */
  coinsPaired?: number;
  /** Overrides the computed launchability (e.g. the app knows of a compliance block). */
  launchable?: { ok: boolean; reason?: string };
}

/** Ondo tokenized asset; the same shape as any quote asset (kept for existing imports). */
export type OndoAsset = QuoteAsset;

export interface Launchability {
  ok: boolean;
  /** Why not, in a sentence fragment ("Route depth $3.1K is under the $10K minimum"). */
  reason?: string;
}

export const DEFAULT_MIN_ROUTE_DEPTH = 10_000;
/** The quote a new coin starts with in the Pair step. */
export const DEFAULT_QUOTE_SYMBOL = "WETH";

/** True when fees are USDC already (the USDC asset, or a one-hop `["USDC"]` route). */
export function isDirectUsdc(asset: Pick<QuoteAsset, "symbol" | "route">): boolean {
  return asset.symbol === "USDC" || (asset.route?.length === 1 && asset.route[0] === "USDC");
}

/** Stocks, ETFs and RWAs follow the US session; crypto trades around the clock. */
export function followsUsSession(kind: QuoteAssetKind): boolean {
  return kind !== "crypto";
}

/** A coin can pair with an asset when fees can reach USDC (a route exists) and that route is deep enough. */
export function launchability(asset: QuoteAsset, minDepthUsd = DEFAULT_MIN_ROUTE_DEPTH): Launchability {
  if (asset.launchable) return asset.launchable;
  if (isDirectUsdc(asset)) return { ok: true };
  if (!asset.route || asset.route.length < 2 || !asset.routeDepthUsd) return { ok: false, reason: "No route to USDC" };
  if (asset.routeDepthUsd < minDepthUsd) {
    return { ok: false, reason: `Route depth ${formatUsdCompact(asset.routeDepthUsd)} is under the ${formatUsdCompact(minDepthUsd)} minimum` };
  }
  return { ok: true };
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "$129.48", "$64,210.00"; prices under $1 keep four decimals. */
export function formatAssetPrice(price: number): string {
  return price < 1 ? `$${price.toFixed(4)}` : usd.format(price);
}

/** Long kind names for meta lines and screen-reader text. */
export const ASSET_KIND_NAME: Record<QuoteAssetKind, string> = {
  crypto: "Crypto",
  stock: "Tokenized stock",
  etf: "Tokenized ETF",
  rwa: "Tokenized asset",
};

/** Short kind names for filters and compact rows. */
export const ASSET_KIND_SHORT: Record<QuoteAssetKind, string> = { crypto: "Crypto", stock: "Stock", etf: "ETF", rwa: "RWA" };

/** The issuer shown in the meta line: the asset's own, else Ondo for tokenized assets. */
export function assetIssuer(asset: Pick<QuoteAsset, "kind" | "issuer">): string | undefined {
  return asset.issuer ?? (asset.kind === "crypto" ? undefined : "Ondo");
}

/** "NVIDIA · Tokenized stock · Ondo", "Wrapped Bitcoin · Crypto". */
export function quoteMetaLine(asset: Pick<QuoteAsset, "name" | "kind" | "issuer">, short = false): string {
  return [asset.name, short ? ASSET_KIND_SHORT[asset.kind] : ASSET_KIND_NAME[asset.kind], assetIssuer(asset)].filter(Boolean).join(" · ");
}

/** "$HARAMBE" from "HARAMBE" or "$HARAMBE"; "Your coin" when there is none. */
export function coinTicker(coinSymbol?: string): string {
  return coinSymbol ? `$${coinSymbol.replace(/^\$/, "")}` : "Your coin";
}

/**
 * Every hop fees take, starting at the coin: ["$HARAMBE", "WETH", "USDC"]. For a USDC quote that is
 * ["$HARAMBE", "USDC"]. Null when there is no route.
 */
export function feeRouteHops(asset: Pick<QuoteAsset, "symbol" | "route">, coinSymbol?: string): string[] | null {
  if (isDirectUsdc(asset)) return [coinTicker(coinSymbol), "USDC"];
  if (!asset.route || asset.route.length < 2) return null;
  return [coinTicker(coinSymbol), ...asset.route];
}

/** "$HARAMBE → WETH → USDC", "Direct to USDC", or "No route to USDC". */
export function feeRouteText(asset: Pick<QuoteAsset, "symbol" | "route">, coinSymbol?: string): string {
  const hops = feeRouteHops(asset, coinSymbol);
  if (!hops) return "No route to USDC";
  return hops.join(" → ");
}

/* ---------- kind mark ---------- */

const KIND_ICON: Record<QuoteAssetKind, typeof Coins> = { crypto: Coins, stock: Building2, etf: Layers, rwa: Gem };

/** Pigment per kind: the tint behind the glyph and the ink on it. */
export const KIND_TONE: Record<QuoteAssetKind, { tint: string; ink: string; dot: string }> = {
  crypto: { tint: "bg-ochre-tint", ink: "text-ochre-ink", dot: "bg-ochre" },
  stock: { tint: "bg-stock-tint", ink: "text-stock-ink", dot: "bg-sky" },
  etf: { tint: "bg-etf-tint", ink: "text-etf-ink", dot: "bg-etf-ink" },
  rwa: { tint: "bg-sage-tint", ink: "text-sage-ink", dot: "bg-sage" },
};

export interface QuoteKindMarkProps extends Omit<ComponentProps<"span">, "children"> {
  kind: QuoteAssetKind;
  /** `glyph` is a small tinted disc with an icon; `dot` a plain tinted dot. */
  variant?: "glyph" | "dot";
  /** Pixel size of the disc (glyph) or dot. */
  size?: number;
}

/**
 * The quiet kind signal: a tinted disc with a small icon (coins, building, layers, gem) or a dot.
 * Decorative: the kind is always written in the meta line beside it.
 */
export function QuoteKindMark({ kind, variant = "glyph", size, className, ...props }: QuoteKindMarkProps) {
  const tone = KIND_TONE[kind];
  if (variant === "dot") {
    const s = size ?? 8;
    return <span aria-hidden="true" data-slot="quote-kind-mark" data-kind={kind} className={cn("inline-block shrink-0 rounded-full", tone.dot, className)} style={{ width: s, height: s }} {...props} />;
  }
  const s = size ?? 18;
  const Icon = KIND_ICON[kind];
  return (
    <span
      aria-hidden="true"
      data-slot="quote-kind-mark"
      data-kind={kind}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full", tone.tint, tone.ink, className)}
      style={{ width: s, height: s }}
      {...props}
    >
      <Icon style={{ width: Math.round(s * 0.6), height: Math.round(s * 0.6) }} strokeWidth={2.25} />
    </span>
  );
}

/* ---------- logo with kind ---------- */

export interface QuoteAssetLogoProps {
  asset: Pick<QuoteAsset, "symbol" | "kind" | "logo">;
  /** Logo size in px; the kind glyph scales with it. */
  size?: number;
  /** Show the kind glyph on the lower-right corner (default true). */
  showKind?: boolean;
  className?: string;
}

/** Real logo (lettered fallback when there is none) with a small kind glyph tucked on its corner. */
export function QuoteAssetLogo({ asset, size = 36, showKind = true, className }: QuoteAssetLogoProps) {
  const mark = Math.max(14, Math.round(size * 0.42));
  return (
    <span data-slot="quote-asset-logo" className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <StockLogo symbol={asset.symbol} kind={asset.kind} src={asset.logo?.src} srcSet={asset.logo?.srcSet} size={size} decorative />
      {showKind ? <QuoteKindMark kind={asset.kind} size={mark} className="absolute -right-1 -bottom-1 ring-2 ring-card" /> : null}
    </span>
  );
}

/* ---------- identity header ---------- */

export interface QuoteAssetIdentityProps extends Omit<ComponentProps<"div">, "children" | "title"> {
  asset: Pick<QuoteAsset, "symbol" | "name" | "kind" | "logo" | "issuer">;
  size?: number;
  /** Replaces the symbol text (e.g. a link). */
  title?: ReactNode;
  /** Short kind names ("Stock" rather than "Tokenized stock"), for rows. */
  compactMeta?: boolean;
  /** Extra text after the meta line ("Market closed"). */
  metaExtra?: ReactNode;
  /** Something after the symbol on the first line (e.g. a "Recommended" tag). */
  adornment?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  /** Render the symbol as a plain span instead of a heading. */
  plain?: boolean;
}

/**
 * Logo, symbol and one quiet meta line: "NVIDIA · Tokenized stock · Ondo", "Wrapped Bitcoin · Crypto".
 * No shouty kind chip; the kind shows as a small glyph on the logo and as words in the meta line.
 */
export function QuoteAssetIdentity({
  asset,
  size = 40,
  title,
  compactMeta,
  metaExtra,
  adornment,
  headingLevel = 3,
  plain,
  className,
  ...props
}: QuoteAssetIdentityProps) {
  const Heading = plain ? "span" : (`h${headingLevel}` as "h2" | "h3" | "h4");
  return (
    <div data-slot="quote-asset-identity" className={cn("flex min-w-0 items-center gap-3", className)} {...props}>
      <QuoteAssetLogo asset={asset} size={size} />
      <div className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <Heading className="m-0 truncate font-sans text-base leading-tight font-semibold text-ink">{title ?? asset.symbol}</Heading>
          {adornment}
        </span>
        <span className="truncate text-[13px] text-ink-muted">
          {quoteMetaLine(asset, compactMeta)}
          {metaExtra ? <> · {metaExtra}</> : null}
        </span>
      </div>
    </div>
  );
}

/** "Trades 24/7", the quiet stand-in for the market-hours pill on crypto quotes. */
export function AlwaysOpen({ className, compact, ...props }: Omit<ComponentProps<"span">, "children"> & { compact?: boolean }) {
  return (
    <span
      data-slot="always-open"
      title="Crypto markets never close"
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-ink-muted", compact && "text-xs", className)}
      {...props}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-sage" />
      Trades 24/7
    </span>
  );
}
