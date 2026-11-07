import { createConfig } from "wagmi";
import { mainnet } from "wagmi/chains";
import type { PrivateRpc } from "./private-rpc";

/**
 * Reads made through wagmi (hooks, receipts, simulations) go through the private RPC,
 * isolated under the connected account. Signing and broadcasting go through the
 * user's wallet and its own RPC, which this app does not control.
 *
 * `chainId` is the app's network (`AppConfig.chainId`). It is mainnet except on a local fork of
 * mainnet that keeps anvil's own chain id (31337): wagmi must know that chain, or every write and
 * receipt read for it fails with "Chain not configured".
 */
export function createWagmiConfig(rpc: PrivateRpc, chainId: number = mainnet.id) {
  const chain = chainId === mainnet.id ? mainnet : { ...mainnet, id: chainId, name: "Local mainnet fork" };
  return createConfig({
    chains: [chain],
    // No explicit connectors: wallets are discovered via EIP-6963. Avoids bundling the full connector barrel.
    transports: { [chain.id]: rpc.transport() },
  });
}
