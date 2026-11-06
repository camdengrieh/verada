/** Block explorer links for transactions. Only Ethereum mainnet (and a local fork of it) has one. */
import { CHAIN_ID } from "@varada/sdk";

const EXPLORER = "https://etherscan.io";

/** `https://etherscan.io/tx/<hash>` on mainnet; undefined elsewhere (a local fork has no explorer). */
export function txUrl(chainId: number, hash: string | undefined): string | undefined {
  if (!hash || chainId !== CHAIN_ID || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return undefined;
  return `${EXPLORER}/tx/${hash}`;
}
