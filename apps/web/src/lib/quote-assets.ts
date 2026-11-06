import { getAddress, isAddress, type Address } from "viem";
import { EXTERNAL_ADDRESSES, ONDO_TOKENS, ondoSymbolOf, type OndoTokenKind } from "@varada/sdk";
import type { QuoteAsset, QuoteAssetKind } from "@varada/ui/components/varada/quote-asset";
import type { ImageSource } from "@varada/ui/components/varada/shared";
import { ondoName } from "./ondo-names";
import type { QuoteAssetRow } from "./indexer";

/**
 * What the app knows about a quote asset: the library's {@link QuoteAsset} plus the on-chain
 * address and decimals the factory needs. Rows come from the quote registry's allowlist (the
 * indexer's `/quote-assets`); names, kinds and logos come from the SDK's Ondo list and the bundle.
 */
export interface AppQuoteAsset extends QuoteAsset {
  address: Address;
  decimals: number;
}

/** Ondo's own groupings, as library kinds. Currencies and portfolios are "tokenized assets". */
const ONDO_KIND: Record<OndoTokenKind, QuoteAssetKind> = { Stock: "stock", ETF: "etf", Currency: "rwa", Portfolio: "rwa" };

/**
 * Names for crypto quote assets. The registry decides which assets are launchable (any ERC-20 with
 * a route to USDC, whatever its `Kind` label); this table only names the ones the app knows. The
 * symbol doubles as the logo key under `public/assets/tokens`. An address not listed here still
 * appears, by its short address, so adding an asset on-chain never needs a web release.
 */
const CRYPTO: ReadonlyMap<string, { symbol: string; name: string }> = new Map(
  (
    [
      [EXTERNAL_ADDRESSES.weth, "WETH", "Wrapped Ether"],
      [EXTERNAL_ADDRESSES.usdc, "USDC", "USD Coin"],
      ["0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "WBTC", "Wrapped Bitcoin"],
      ["0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", "cbBTC", "Coinbase Wrapped BTC"],
      ["0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "wstETH", "Wrapped stETH"],
      ["0x514910771AF9Ca656af840dff83E8264EcF986CA", "LINK", "Chainlink"],
      ["0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "UNI", "Uniswap"],
      ["0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", "AAVE", "Aave"],
      ["0x6B175474E89094C44Da98b954EedeAC495271d0F", "DAI", "Dai"],
      ["0xdAC17F958D2ee523a2206206994597C13D831ec7", "USDT", "Tether USD"],
    ] as const
  ).map(([address, symbol, name]) => [address.toLowerCase(), { symbol, name }] as const),
);

export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** Symbol, name and kind of a quote asset by address; an unknown address shows as a crypto token by its short address. */
export function describeQuoteAsset(address: string): Pick<QuoteAsset, "symbol" | "name" | "kind"> {
  const crypto = CRYPTO.get(address.toLowerCase());
  if (crypto) return { ...crypto, kind: "crypto" };
  const ondo = ondoSymbolOf(address);
  if (ondo) return { symbol: ondo, name: ondoName(ondo), kind: ONDO_KIND[ONDO_TOKENS[ondo].kind] };
  const short = shortAddress(address);
  return { symbol: short, name: short, kind: "crypto" };
}

/** True for the registry's Ondo kind (1) or an address in the SDK's Ondo list. */
export function isOndoQuote(address: string, kind?: number): boolean {
  return kind === 1 || ondoSymbolOf(address) !== undefined;
}

/**
 * Quote assets for the launch Pair step and Discover's filters from the registry's active rows.
 * Every row is allowlisted, so each is launchable; `logo` resolves a symbol to a bundled or pack image.
 */
export function quoteAssetsFromRows(rows: readonly QuoteAssetRow[], logo: (symbol: string) => ImageSource | undefined): AppQuoteAsset[] {
  const seen = new Set<string>();
  const out: AppQuoteAsset[] = [];
  for (const r of rows) {
    if (!r.active || !isAddress(r.asset, { strict: false })) continue;
    const address = getAddress(r.asset.toLowerCase());
    if (seen.has(address)) continue;
    seen.add(address);
    const d = describeQuoteAsset(address);
    out.push({
      ...d,
      address,
      decimals: r.decimals ?? 18,
      logo: logo(d.symbol),
      launchable: { ok: true },
    });
  }
  return out;
}

/** The asset with this address, if it is in the list. */
export function findQuote<T extends { address: string }>(assets: readonly T[], address: string): T | undefined {
  return assets.find((a) => a.address.toLowerCase() === address.toLowerCase());
}
