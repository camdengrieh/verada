import { positionReserves, readPoolState, tokenPriceInQuote, varadaPoolKey, type SwapAsset, type VaradaMarketToken } from "@varada/sdk";
import type { PublicClient } from "viem";
import type { MarketSnapshot } from "../indexer";

export interface PoolMarket {
  quote: SwapAsset;
  /** Quote per whole token, from the pool's current price. */
  priceInQuote: number | null;
  priceUsd: number | null;
  /** USD per whole quote asset, when known. */
  quoteUsd: number | null;
  /** Pool liquidity `L` (raw). */
  liquidity: bigint;
  /** Reserves held by the locked position, in whole units. Estimated from the launch supply. */
  reserves: { token: number; quote: number } | null;
  /** Value of both sides of the pool. */
  tvlQuote: number | null;
  tvlUsd: number | null;
  /** Price times total supply. */
  marketCapUsd: number | null;
  /** Percent change over the indexer's window (24 h), null without enough trades. */
  change24hPct: number | null;
  volume24hQuote: number | null;
  volume24hUsd: number | null;
  trades24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  buyShare24h: number | null;
  lastTradeAt: number | null;
  /** Where the price came from: the pool (always) and whether the indexer added stats. */
  source: { price: "pool"; stats: "indexer" | "none" };
}

export interface MarketIndexer {
  market(token: string, hours?: number): Promise<MarketSnapshot | null>;
}

/**
 * Price, depth and 24 h stats of a token's pool. The price and liquidity are read from the pool
 * (`StateView`) so they are right even when the indexer lags; the 24 h change and volume come from the
 * indexer's `market()` and are null when it is unavailable.
 */
export async function loadPoolMarket(args: { chain: PublicClient; indexer?: MarketIndexer; token: VaradaMarketToken; quoteUsd?: number | null }): Promise<PoolMarket> {
  const { chain, token } = args;
  const key = varadaPoolKey(token.address, token.quote.address, token.hook);
  const tokenDecimals = token.decimals ?? 18;
  const tokenIsCurrency0 = key.currency0.toLowerCase() === token.address.toLowerCase();
  const [state, supply, snapshot] = await Promise.all([
    readPoolState(chain, key),
    chain.readContract({ address: token.address, abi: [{ type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const, functionName: "totalSupply" }).catch(() => null),
    args.indexer ? args.indexer.market(token.address, 24).catch(() => null) : Promise.resolve(null),
  ]);
  const quoteUsd = args.quoteUsd ?? null;
  const sqrtPrice = Number(state.sqrtPriceX96) / 2 ** 96;
  const priceInQuote = state.initialized ? tokenPriceInQuote({ sqrtPrice, tokenIsCurrency0, tokenDecimals, quoteDecimals: token.quote.decimals }) : null;
  const priceUsd = priceInQuote !== null && quoteUsd !== null ? priceInQuote * quoteUsd : null;

  const raw = supply !== null && state.initialized ? positionReserves({ sqrtPrice, liquidity: Number(state.liquidity), supply: Number(supply), tokenIsCurrency0 }) : null;
  const reserves = raw ? { token: raw.token / 10 ** tokenDecimals, quote: raw.quote / 10 ** token.quote.decimals } : null;
  const tvlQuote = reserves && priceInQuote !== null ? reserves.quote + reserves.token * priceInQuote : null;
  const tvlUsd = tvlQuote !== null && quoteUsd !== null ? tvlQuote * quoteUsd : null;

  let change24hPct: number | null = null;
  let volume24hQuote: number | null = null;
  if (snapshot) {
    const first = snapshot.hourly.find((h) => h.closePrice !== null && h.closePrice > 0);
    const last = [...snapshot.hourly].reverse().find((h) => h.closePrice !== null)?.closePrice ?? snapshot.price;
    if (first?.closePrice && last) change24hPct = ((last - first.closePrice) / first.closePrice) * 100;
    const qd = snapshot.quoteDecimals ?? token.quote.decimals;
    volume24hQuote = Number(snapshot.window.volumeQuote) / 10 ** qd;
  }
  return {
    quote: token.quote,
    priceInQuote,
    priceUsd,
    quoteUsd,
    liquidity: state.liquidity,
    reserves,
    tvlQuote,
    tvlUsd,
    marketCapUsd: supply !== null && priceUsd !== null ? (Number(supply) / 10 ** tokenDecimals) * priceUsd : null,
    change24hPct,
    volume24hQuote,
    volume24hUsd: volume24hQuote !== null && quoteUsd !== null ? volume24hQuote * quoteUsd : null,
    trades24h: snapshot?.window.trades ?? null,
    buys24h: snapshot?.window.buys ?? null,
    sells24h: snapshot?.window.sells ?? null,
    buyShare24h: snapshot?.window.buyShare ?? null,
    lastTradeAt: snapshot?.lastTradeAt ?? null,
    source: { price: "pool", stats: snapshot ? "indexer" : "none" },
  };
}
