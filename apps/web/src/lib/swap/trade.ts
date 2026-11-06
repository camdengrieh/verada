import type { Address, PublicClient } from "viem";
import { quoteRoute, quoteTrade, type RouteQuote, type RoutingConfig, type SwapAsset, type TradeQuote, type TradeSide, type VaradaMarketToken } from "@varada/sdk";
import { usMarketSession, type ImpactStepLike } from "./calendar";
import { parseAmount, slippageToBps } from "./amounts";

export interface TradeClients {
  /** Public data: pools, fees, quotes. Never carries an address. */
  chain: PublicClient;
  /** Address-keyed reads (Ondo compliance of the user). Must be the account client of `account`. */
  accountClient?: PublicClient;
  account?: Address;
}

export interface TradeQuoteRequest {
  token: VaradaMarketToken;
  side: TradeSide;
  /** The asset paid with (buy) or received (sell). */
  asset: SwapAsset;
  /** What the user typed: the pay amount (exact-in). */
  amountText: string;
  slippagePct: number;
  routing?: RoutingConfig;
  now?: Date;
}

/** Raw amount the user is paying, or null when the input is empty or zero. */
export function payAmountRaw(req: Pick<TradeQuoteRequest, "token" | "side" | "asset" | "amountText">): bigint | null {
  const decimals = req.side === "buy" ? req.asset.decimals : (req.token.decimals ?? 18);
  return parseAmount(req.amountText, decimals);
}

/**
 * Quotes what the user typed (exact-in): best route, price impact, fees, limits, Ondo checks.
 * Resolves null for an empty amount. Rejects with a `SwapError` when it cannot be quoted.
 */
export async function requestTradeQuote(clients: TradeClients, req: TradeQuoteRequest): Promise<TradeQuote | null> {
  const amount = payAmountRaw(req);
  if (amount === null) return null;
  const session = usMarketSession(req.now ?? new Date());
  return quoteTrade(
    clients.chain,
    { token: req.token, side: req.side, asset: req.asset, amount, slippageBps: slippageToBps(req.slippagePct) },
    {
      routing: req.routing,
      compliance: {
        account: clients.account,
        accountClient: clients.accountClient,
        marketOpen: session.session === "open",
      },
    },
  );
}

/** Price impact in percent of `sizesUsd` along the route of `quote`, null where the route cannot fill the size. */
export async function quoteImpactLadder(chain: PublicClient, quote: TradeQuote, payUsd: number, sizesUsd: readonly number[]): Promise<ImpactStepLike[]> {
  const decimals = quote.payAsset.decimals;
  return Promise.all(
    sizesUsd.map(async (size) => {
      const amount = BigInt(Math.max(1, Math.floor((size / payUsd) * 10 ** Math.min(decimals, 15)))) * 10n ** BigInt(Math.max(0, decimals - 15));
      try {
        const q: RouteQuote = await quoteRoute(chain, quote.best.route, "exactIn", amount, quote.context);
        return { size, impact: q.priceImpactPct };
      } catch {
        return { size, impact: null };
      }
    }),
  );
}
