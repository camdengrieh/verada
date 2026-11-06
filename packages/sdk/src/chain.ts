import type { Chain } from "viem";
import { mainnet } from "viem/chains";

/** Varada runs on Ethereum mainnet only. */
export const CHAIN_ID = 1 as const;
export const chain: Chain = mainnet;
export type VaradaChainId = typeof CHAIN_ID;
