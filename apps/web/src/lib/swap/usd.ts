import { DAI, USDC, USDT, type SwapAsset } from "@varada/sdk";

const STABLES = new Set([USDC.address, USDT.address, DAI.address].map((a) => a.toLowerCase()));

/**
 * Dollar-pegged assets are priced at $1. Every other asset is priced by the shared pricing layer
 * (`@/lib/usd-pricing`, `@/hooks/use-usd-quotes`): the registry route first, the deepest discovered
 * route of v4 pools as the fallback.
 */
export const isStable = (a: SwapAsset): boolean => STABLES.has(a.address.toLowerCase());
