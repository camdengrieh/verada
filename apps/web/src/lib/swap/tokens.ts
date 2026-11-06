import { getAddress, isAddress, zeroAddress, type Address, type PublicClient } from "viem";
import {
  DEFAULT_HUBS,
  ONDO_DECIMALS,
  detectMode,
  factoryQuoteAbi,
  isOndoToken,
  ondoSymbolOf,
  readQuoteAssetOf,
  readSwapAsset,
  type SwapAsset,
  type VaradaMarketToken,
  type VaradaMode,
} from "@varada/sdk";
import type { AppConfig } from "../config";
import type { IndexerClient } from "../indexer";

/** What the token page knows about a token; everything but address and symbol is optional and read when missing. */
export interface TradeTokenInput {
  address: string;
  symbol: string;
  name?: string;
  /** The token's hook (indexer `token.hook`). */
  hook?: string | null;
  /** The quote asset of the pool, when known. */
  quote?: string | null;
  mode?: VaradaMode;
  /** ENS label, for display. */
  label?: string;
}

const KNOWN = new Map<string, SwapAsset>([...DEFAULT_HUBS].map((a) => [a.address.toLowerCase(), a]));

/** Symbol and decimals of an asset address without a network read when it is a known hub or Ondo token. */
export function knownAsset(address: string): SwapAsset | null {
  if (!isAddress(address)) return null;
  const hub = KNOWN.get(address.toLowerCase());
  if (hub) return hub;
  if (isOndoToken(address)) return { address: getAddress(address), symbol: ondoSymbolOf(address) ?? "Ondo", decimals: ONDO_DECIMALS };
  return null;
}

/** The assets offered for paying (buy) and receiving (sell): the hubs plus the token's quote asset. */
export function tradeAssets(quote: SwapAsset): SwapAsset[] {
  const list = [...DEFAULT_HUBS];
  if (!list.some((a) => a.address.toLowerCase() === quote.address.toLowerCase())) list.push(quote);
  return list;
}

export interface ResolveDeps {
  chain: PublicClient;
  indexer?: Pick<IndexerClient, "get">;
  cfg: Pick<AppConfig, "factoryAddress">;
}

function hex(v: unknown): Address | null {
  return typeof v === "string" && isAddress(v) && v.toLowerCase() !== zeroAddress ? getAddress(v) : null;
}

/**
 * Turns the token page's token into what the engine trades: its hook and quote asset. Takes them from
 * the input when given, else the indexer's token row (`hook`), else the chain: the factory's
 * `quoteAssetOf`, and whichever of the factory's two hooks has configured the token.
 */
export async function resolveMarketToken(deps: ResolveDeps, input: TradeTokenInput): Promise<VaradaMarketToken> {
  if (!isAddress(input.address)) throw new Error("Not a token address");
  const address = getAddress(input.address);
  let hook = hex(input.hook);
  let quoteAddr = hex(input.quote);

  if ((!hook || !quoteAddr) && deps.indexer) {
    try {
      const row = (await deps.indexer.get(`/api/tokens/${address}`)) as Record<string, unknown> | null;
      hook ??= hex(row?.hook);
      quoteAddr ??= hex(row?.quote) ?? hex(row?.quoteAsset);
    } catch {
      // the chain fallback below answers
    }
  }
  const factory = deps.cfg.factoryAddress;
  if (!quoteAddr) {
    if (!factory) throw new Error("Cannot find this token's quote asset: no indexer data and no factory address configured");
    quoteAddr = await readQuoteAssetOf(deps.chain, factory, address);
  }
  if (!hook) {
    if (!factory) throw new Error("Cannot find this token's hook: no indexer data and no factory address configured");
    const [weekly, live] = await Promise.all([
      deps.chain.readContract({ address: factory, abi: factoryQuoteAbi, functionName: "hook" }),
      deps.chain.readContract({ address: factory, abi: factoryQuoteAbi, functionName: "liveHook" }).catch(() => zeroAddress as Address),
    ]);
    for (const candidate of [weekly, live]) {
      if (candidate === zeroAddress) continue;
      const ok = await deps.chain
        .readContract({ address: candidate, abi: [{ type: "function", name: "configured", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bool" }] }] as const, functionName: "configured", args: [address] })
        .catch(() => false);
      if (ok) {
        hook = getAddress(candidate);
        break;
      }
    }
    if (!hook) throw new Error("This token is not configured on any Varada hook");
  }
  const quote = knownAsset(quoteAddr) ?? (await readSwapAsset(deps.chain, quoteAddr));
  const mode = input.mode ?? (await detectMode(deps.chain, hook));
  return { address, symbol: input.symbol, decimals: 18, hook, quote, mode };
}

