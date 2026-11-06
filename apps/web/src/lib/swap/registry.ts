import { getAddress, type PublicClient } from "viem";
import { DEFAULT_HUBS, factoryQuoteAbi, quoteRegistryReadAbi, readQuoteRegistryAssets, readSwapAsset, type SwapAsset } from "@varada/sdk";
import { knownAsset } from "./tokens";

/** Most registry assets taken into routing and the asset picker: each adds pool reads per quote. */
export const MAX_REGISTRY_ASSETS = 12;

/**
 * The quote registry's active, allowlisted assets (WETH and the Ondo tokens that can be a pool's quote)
 * as swap assets, newest last, without the default hubs. Public data. Capped at {@link MAX_REGISTRY_ASSETS}
 * (the earliest added are kept).
 */
export async function loadRegistryAssets(chain: PublicClient, factory: `0x${string}`, limit = MAX_REGISTRY_ASSETS): Promise<SwapAsset[]> {
  const registry = await chain.readContract({ address: factory, abi: factoryQuoteAbi, functionName: "quoteRegistry" });
  const all = await readQuoteRegistryAssets(chain, registry);
  const hubs = new Set(DEFAULT_HUBS.map((h) => h.address.toLowerCase()));
  const candidates = all.filter((a) => !hubs.has(a.toLowerCase()));
  const active = await Promise.all(
    candidates.map((a) => chain.readContract({ address: registry, abi: quoteRegistryReadAbi, functionName: "isAllowed", args: [a] }).catch(() => false)),
  );
  const picked = candidates.filter((_, i) => active[i]).slice(0, limit);
  return Promise.all(picked.map(async (a) => knownAsset(a) ?? (await readSwapAsset(chain, getAddress(a)))));
}
