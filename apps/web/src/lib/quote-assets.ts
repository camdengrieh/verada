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

const CRYPTO: ReadonlyMap<string, { symbol: string; name: string }> = new Map([
  [EXTERNAL_ADDRESSES.weth.toLowerCase(), { symbol: "WETH", name: "Wrapped Ether" }],
  [EXTERNAL_ADDRESSES.usdc.toLowerCase(), { symbol: "USDC", name: "USD Coin" }],
]);

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
