import { getAddress, type Address, type PublicClient } from "viem";
import { erc20Abi, factoryQuoteAbi, quoteRegistryReadAbi } from "./abis.js";
import { NATIVE_CURRENCY, type SwapAsset } from "./types.js";
import type { ReadClient } from "./pool.js";

/** The quote asset a token's pool is paired with (`VaradaFactory.quoteAssetOf`). */
export async function readQuoteAssetOf(client: ReadClient, factory: Address, token: Address): Promise<Address> {
  return getAddress(await client.readContract({ address: factory, abi: factoryQuoteAbi, functionName: "quoteAssetOf", args: [token] }));
}

/** Every asset ever allowlisted in the quote registry (active or not), in insertion order. */
export async function readQuoteRegistryAssets(client: ReadClient, registry: Address, opts: { limit?: number } = {}): Promise<Address[]> {
  const count = Number(await client.readContract({ address: registry, abi: quoteRegistryReadAbi, functionName: "quoteAssetCount" }));
  const n = Math.min(count, opts.limit ?? 500);
  const out = await Promise.all(Array.from({ length: n }, (_, i) => client.readContract({ address: registry, abi: quoteRegistryReadAbi, functionName: "quoteAssetAt", args: [BigInt(i)] })));
  return out.map((a) => getAddress(a));
}

/** Symbol and decimals of an ERC-20 as a {@link SwapAsset} (native ETH needs no read). */
export async function readSwapAsset(client: ReadClient, address: Address): Promise<SwapAsset> {
  if (address.toLowerCase() === NATIVE_CURRENCY) return { address: NATIVE_CURRENCY, symbol: "ETH", decimals: 18 };
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { address: getAddress(address), symbol, decimals: Number(decimals) };
}

/**
 * Balances of `owner` in the given assets (native ETH through `getBalance`). Address-keyed: the
 * client must be the app's account client (docs/PRIVACY.md).
 */
export async function readBalances(client: PublicClient, owner: Address, assets: readonly SwapAsset[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  await Promise.all(
    assets.map(async (a) => {
      const isNative = a.address.toLowerCase() === NATIVE_CURRENCY;
      const v = isNative ? await client.getBalance({ address: owner }) : await client.readContract({ address: a.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
      out.set(a.address.toLowerCase(), v);
    }),
  );
  return out;
}
