/** What the token page shows about a pool's quote asset, from its address (WETH, USDC or an Ondo token). */
import { EXTERNAL_ADDRESSES, ONDO_TOKENS, ondoSymbolOf } from "@varada/sdk";
import type { QuoteKind } from "@varada/ui/components/varada/stock-logo";

export interface QuoteInfo {
  address: string;
  /** `WETH`, `USDC`, `NVDAon`; the shortened address when the asset is not one the app knows. */
  symbol: string;
  /** "NVDA (Ondo tokenized stock)". */
  name: string;
  kind: QuoteKind;
  /** Ondo-issued (follows the US session) as opposed to crypto (always open). */
  ondo: boolean;
  /** A dollar stablecoin, so an amount of it is a dollar value. */
  usd: boolean;
}

const KIND: Record<string, QuoteKind> = { Stock: "stock", ETF: "etf", Currency: "rwa", Portfolio: "rwa" };
const KIND_WORD: Record<string, string> = { Stock: "tokenized stock", ETF: "tokenized ETF", Currency: "tokenized currency", Portfolio: "tokenized portfolio" };

export function quoteInfo(address: string | null | undefined): QuoteInfo | null {
  if (!address) return null;
  const a = address.toLowerCase();
  if (a === EXTERNAL_ADDRESSES.weth.toLowerCase()) return { address, symbol: "WETH", name: "Wrapped Ether", kind: "crypto", ondo: false, usd: false };
  if (a === EXTERNAL_ADDRESSES.usdc.toLowerCase()) return { address, symbol: "USDC", name: "USD Coin", kind: "crypto", ondo: false, usd: true };
  const sym = ondoSymbolOf(address);
  if (sym) {
    const k = ONDO_TOKENS[sym].kind;
    const ticker = sym.replace(/on$/, "");
    return { address, symbol: sym, name: `${ticker} (Ondo ${KIND_WORD[k] ?? "token"})`, kind: KIND[k] ?? "stock", ondo: true, usd: false };
  }
  return { address, symbol: `${address.slice(0, 6)}…${address.slice(-4)}`, name: address, kind: "crypto", ondo: false, usd: false };
}

/** NYSE full-day closures and early (13:00 ET) closes, as New York dates. */
export const US_MARKET_HOLIDAYS = [
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
] as const;
export const US_MARKET_EARLY_CLOSES = ["2026-11-27", "2026-12-24", "2027-11-26"] as const;
