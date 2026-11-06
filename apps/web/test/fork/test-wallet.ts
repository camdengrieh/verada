/**
 * An EIP-1193 wallet for the fork-backed flow tests: it signs with a fresh private key against the
 * fork node, can sit on another chain, can reject the next request, and announces itself over
 * EIP-6963 so the app's real wagmi config discovers it exactly like a browser wallet.
 */
import { createWalletClient, http, numberToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

type Listener = (...args: unknown[]) => void;

export interface TestWallet {
  address: Address;
  /** Chain the wallet reports (what `eth_chainId` returns). */
  chainId: number;
  /** Methods the app called, in order. */
  calls: { method: string; params?: unknown }[];
  /** Reject the next `n` signing requests as the user declining (EIP-1193 code 4001). */
  rejectNext(n?: number): void;
  /** Move the wallet to another chain and emit `chainChanged`, like a user switching in the wallet. */
  setChain(chainId: number): void;
  /** Make `wallet_switchEthereumChain` fail (the wallet refuses to switch). */
  refuseSwitch: boolean;
  announce(): void;
  /** Stop answering EIP-6963 provider requests (call between tests so only one wallet is discoverable). */
  dispose(): void;
}

export function createTestWallet(opts: { rpcUrl: string; privateKey: Hex; chainId?: number }): TestWallet {
  const account = privateKeyToAccount(opts.privateKey);
  const client = createWalletClient({ account, chain: mainnet, transport: http(opts.rpcUrl) });
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((l) => l(...args));
  let rejects = 0;

  const wallet: TestWallet = {
    address: account.address,
    chainId: opts.chainId ?? 1,
    calls: [],
    refuseSwitch: false,
    rejectNext(n = 1) {
      rejects = n;
    },
    setChain(chainId) {
      wallet.chainId = chainId;
      emit("chainChanged", numberToHex(chainId));
    },
    dispose() {
      window.removeEventListener("eip6963:requestProvider", onRequest);
    },
    announce() {
      const detail = Object.freeze({
        info: { uuid: "00000000-0000-4000-8000-000000000001", name: "Fork Test Wallet", icon: "data:image/svg+xml;base64,PHN2Zy8+", rdns: "test.varada.fork" },
        provider,
      });
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    },
  };

  const declined = () => Object.assign(new Error("User rejected the request."), { code: 4001, name: "UserRejectedRequestError" });

  const provider = {
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      wallet.calls.push({ method, params });
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return numberToHex(wallet.chainId);
        case "net_version":
          return String(wallet.chainId);
        case "wallet_switchEthereumChain": {
          if (wallet.refuseSwitch) throw declined();
          const [{ chainId }] = params as [{ chainId: Hex }];
          wallet.setChain(Number(chainId));
          return null;
        }
        case "eth_sendTransaction":
        case "personal_sign":
        case "eth_signTypedData_v4": {
          if (rejects > 0) {
            rejects -= 1;
            throw declined();
          }
          if (method !== "eth_sendTransaction") throw new Error(`${method} is not supported by the test wallet`);
          const [tx] = params as [{ to: Address; data?: Hex; value?: Hex; gas?: Hex }];
          return client.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          });
        }
        default: {
          // Everything else is a read the wallet answers from its own node.
          const res = await fetch(opts.rpcUrl, {
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

  const onRequest = () => wallet.announce();
  window.addEventListener("eip6963:requestProvider", onRequest);
  return wallet;
}
