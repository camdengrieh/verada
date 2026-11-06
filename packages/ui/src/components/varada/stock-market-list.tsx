// Written for Varada: the Ondo explorer under its original names. It is the quote-asset list with the
// "Stocks & RWA" defaults; the same component shows crypto when the app passes crypto assets.
"use client";

import {
  QuoteAssetList,
  filterQuoteAssets,
  quoteKindCounts,
  type QuoteAssetListLinkProps,
  type QuoteAssetListProps,
  type QuoteAssetListSelectProps,
  type QuoteKindFilter,
  type QuoteListFilter,
  type QuoteSort,
} from "./quote-asset-list";

export type StockKindFilter = QuoteKindFilter;
export type StockSort = QuoteSort;
export type StockListFilter = QuoteListFilter;
export type StockMarketListLinkProps = QuoteAssetListLinkProps;
export type StockMarketListSelectProps = QuoteAssetListSelectProps;
export type StockMarketListProps = QuoteAssetListProps;

export const filterStockAssets = filterQuoteAssets;
export const stockKindCounts = quoteKindCounts;

/** Discover's "Stocks & RWA" tab and the Ondo half of the Pair step. */
export function StockMarketList(props: StockMarketListProps) {
  return <QuoteAssetList title="Stocks & RWA" searchLabel="Search Ondo assets" searchPlaceholder="Search NVDAon, Tesla, SPY…" recommendedSymbol={null} {...props} />;
}
