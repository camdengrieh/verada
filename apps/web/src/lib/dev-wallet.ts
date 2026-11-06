/**
 * Local development wallet for `pnpm dev:up`: an EIP-1193 provider that signs with a throwaway key
 * against the local anvil fork and announces itself over EIP-6963, so the app's real wagmi config
 * discovers it like a browser wallet.
 *
 * Active only when `NEXT_PUBLIC_DEV_WALLET_KEY` was set at build time (the dev script sets it for
 * `next dev`). Without it every branch that reaches this module is dead code and the bundler drops
 * the module, so a published build never contains a key or this wallet.
 */
import { createWalletClient, hexToBigInt, http, isHex, numberToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

type Listener = (...args: unknown[]) => void;

export interface DevWallet {
  address: Address;
  dispose(): void;
}

interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export function installDevWallet(rpcUrl: string, privateKey: string, chainId: number): DevWallet {
  if (!isHex(privateKey) || privateKey.length !== 66) throw new Error("NEXT_PUBLIC_DEV_WALLET_KEY is not a 32-byte hex key");
  const account = privateKeyToAccount(privateKey);
  const chain = chainId === mainnet.id ? mainnet : { ...mainnet, id: chainId, name: "Local mainnet fork" };
  const client = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const listeners = new Map<string, Set<Listener>>();

  const provider = {
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return numberToHex(chainId);
        case "net_version":
          return String(chainId);
        case "wallet_switchEthereumChain":
          return null;
        case "personal_sign": {
          const [message] = params as [Hex];
          return account.signMessage({ message: { raw: message } });
        }
        case "eth_signTypedData_v4": {
          const [, json] = params as [Address, string];
          const typed = JSON.parse(json) as TypedData;
          const types = { ...typed.types };
          delete types.EIP712Domain;
          return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
        }
        case "eth_sendTransaction": {
          const [tx] = params as [{ to?: Address; data?: Hex; value?: Hex; gas?: Hex }];
          return client.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? hexToBigInt(tx.value) : undefined,
            gas: tx.gas ? hexToBigInt(tx.gas) : undefined,
          });
        }
        default: {
          const res = await fetch(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
          });
          const body = (await res.json()) as { result?: unknown; error?: { message: string } };
          if (body.error) throw new Error(body.error.message);
          return body.result;
        }
      }
    },
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
    },
  };

  const announce = () => {
    const detail = Object.freeze({
      info: { uuid: "00000000-0000-4000-8000-0000000000de", name: "Varada Dev Wallet", icon: "data:image/svg+xml;base64,PHN2Zy8+", rdns: "dev.varada.local" },
      provider,
    });
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  };
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  return { address: account.address, dispose: () => window.removeEventListener("eip6963:requestProvider", announce) };
}
