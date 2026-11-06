import { getAddress, type Address } from "viem";
import { EXTERNAL_ADDRESSES, isOndoToken, isUsdStable, loadUsdQuotes, makeUsdQuote, pickUsdQuote, type ReadClient, type RoutingConfig, type UsdQuote } from "@varada/sdk";
import { isPriceStale, usMarketSession } from "@varada/ui/components/varada/market-status";
import { US_MARKET_EARLY_CLOSES, US_MARKET_HOLIDAYS } from "./market-calendar";
import { describeQuoteAsset, type AppQuoteAsset } from "./quote-assets";

/**
 * USD for any quote asset, from the pools alone (no external oracle). Order of preference: a dollar
 * stablecoin is $1; otherwise the QuoteRegistry's fee route to USDC (the route fees really convert
 * along); otherwise the deepest route of pools the swap engine finds. The deeper of the two routes
 * wins when both exist, ties go to the registry. The math is in the SDK (`swap/usd.ts`).
 */

export const isStableAddress = isUsdStable;

/** USD per whole unit of a dollar stablecoin: exactly 1, with unbounded depth. */
export function stableUsdQuote(address: string): UsdQuote {
  return makeUsdQuote(address, "stable", [describeQuoteAsset(address).symbol], { priceUsd: 1, depthUsd: Infinity });
}

/** True when an Ondo stock/ETF is outside the regular US session (its pool price may lag the reference). */
export function ondoMarketClosed(address: string, now: Date): boolean {
  if (!isOndoToken(address)) return false;
  // Tokenized currencies and portfolios are not tied to the equity session.
  const kind = describeQuoteAsset(address).kind;
  if (kind !== "stock" && kind !== "etf") return false;
  return isPriceStale(usMarketSession(now, { holidays: US_MARKET_HOLIDAYS, earlyCloses: US_MARKET_EARLY_CLOSES }).session);
}

/** Registry-route prices already read onto the assets (see `readQuoteMarkets`), as USD quotes. */
export function registryUsdQuotes(assets: readonly AppQuoteAsset[]): Map<string, UsdQuote> {
  const out = new Map<string, UsdQuote>();
  for (const a of assets) {
    if (a.price === undefined || !Number.isFinite(a.price) || a.price <= 0 || a.routeDepthUsd === undefined) continue;
    out.set(a.address.toLowerCase(), makeUsdQuote(a.address, "registry", [...(a.route ?? [])], { priceUsd: a.price, depthUsd: a.routeDepthUsd }));
  }
  return out;
}

/** Discovery fallback: the deepest route of existing pools to USDC (see the SDK's `loadUsdQuotes`). */
export function loadDiscoveredUsdQuotes(client: ReadClient, assets: readonly { address: Address; decimals: number; symbol?: string }[], routing: RoutingConfig = {}): Promise<Map<string, UsdQuote>> {
  return loadUsdQuotes(client, assets, routing);
}

/**
 * Merges the sources into one map for `wanted` addresses: stablecoins at $1, otherwise the deeper of
 * the registry and discovered routes, with the Ondo market-closed flag set from `now`.
 */
export function mergeUsdQuotes(wanted: readonly string[], registry: ReadonlyMap<string, UsdQuote>, discovered: ReadonlyMap<string, UsdQuote>, now: Date): Map<string, UsdQuote> {
  const out = new Map<string, UsdQuote>();
  for (const w of wanted) {
    const k = w.toLowerCase();
    if (isStableAddress(k)) {
      out.set(k, stableUsdQuote(w));
      continue;
    }
    const q = pickUsdQuote(w, registry.get(k), discovered.get(k));
    out.set(k, q.priceUsd !== null && ondoMarketClosed(w, now) ? { ...q, marketClosed: true } : q);
  }
  return out;
}

/** Addresses the app always prices: USDC and WETH. */
export const BASE_PRICED: readonly Address[] = [getAddress(EXTERNAL_ADDRESSES.usdc), getAddress(EXTERNAL_ADDRESSES.weth)];
