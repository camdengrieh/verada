"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeAbiParameters, formatEther, formatUnits, keccak256, toHex, type Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { useAppConfig } from "@/components/providers";

const DEV_WALLET_KEY = process.env.NEXT_PUBLIC_DEV_WALLET_KEY;

const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ERC20_BALANCE_OF = "0x70a08231";

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/** Helper for `pnpm dev:up`: shows the throwaway wallet the dev stack announces and tops it up. */
export default function DevWalletPage() {
  const config = useAppConfig();
  const rpcUrl = config.rpcUrl;
  const address = DEV_WALLET_KEY && /^0x[0-9a-fA-F]{64}$/.test(DEV_WALLET_KEY) ? privateKeyToAddress(DEV_WALLET_KEY as `0x${string}`) : undefined;
  const [eth, setEth] = useState<string>("...");
  const [usdc, setUsdc] = useState<string>("...");
  const [now, setNow] = useState<string>("...");
  const [note, setNote] = useState<string>("");

  const refresh = useCallback(async () => {
    if (!address || !rpcUrl) return;
    try {
      const [e, u, b] = await Promise.all([
        rpc<string>(rpcUrl, "eth_getBalance", [address, "latest"]),
        rpc<string>(rpcUrl, "eth_call", [{ to: USDC, data: `${ERC20_BALANCE_OF}${address.slice(2).padStart(64, "0")}` }, "latest"]),
        rpc<{ timestamp: string }>(rpcUrl, "eth_getBlockByNumber", ["latest", false]),
      ]);
      setEth(formatEther(BigInt(e)));
      setUsdc(formatUnits(BigInt(u), 6));
      setNow(new Date(Number(BigInt(b.timestamp)) * 1000).toISOString());
    } catch (err) {
      setNote(`RPC unreachable: ${(err as Error).message}`);
    }
  }, [address, rpcUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!address) {
    return (
      <section>
        <h1>Dev wallet</h1>
        <p>This build has no dev wallet. It exists only under <code>pnpm dev:up</code>.</p>
      </section>
    );
  }

  const act = async (label: string, fn: (url: string) => Promise<unknown>) => {
    if (!rpcUrl) return;
    try {
      await fn(rpcUrl);
      setNote(`${label}: done`);
    } catch (err) {
      setNote(`${label} failed: ${(err as Error).message}`);
    }
    await refresh();
  };

  const warp = (seconds: number) =>
    act(`Advance ${seconds}s`, async (url) => {
      await rpc(url, "evm_increaseTime", [seconds]);
      await rpc(url, "evm_mine");
    });

  return (
    <section>
      <h1>Dev wallet</h1>
      <p>
        A throwaway wallet on the local anvil fork, announced to this page over EIP-6963 as <strong>Varada Dev Wallet</strong>. Connect it from
        the header. It owns the fixture deployment and holds the fixture token.
      </p>
      <dl>
        <dt>Address</dt>
        <dd><code>{address}</code></dd>
        <dt>ETH</dt>
        <dd>{eth}</dd>
        <dt>USDC</dt>
        <dd>{usdc}</dd>
        <dt>Chain time</dt>
        <dd>{now}</dd>
        <dt>RPC</dt>
        <dd><code>{rpcUrl ?? "not configured"}</code></dd>
      </dl>
      <p className="flex flex-wrap gap-3">
        <button type="button" className="min-h-11 underline" onClick={() => act("Top up ETH", (u) => rpc(u, "anvil_setBalance", [address, toHex(1000n * 10n ** 18n)]))}>
          Set balance to 1000 ETH
        </button>
        <button
          type="button"
          className="min-h-11 underline"
          onClick={() =>
            act("Mint USDC", (u) => {
              // FiatToken keeps balances in the mapping at storage slot 9.
              const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [address, 9n]));
              return rpc(u, "anvil_setStorageAt", [USDC, slot, toHex(100_000n * 10n ** 6n, { size: 32 })]);
            })
          }
        >
          Set USDC balance to 100,000
        </button>
        <button type="button" className="min-h-11 underline" onClick={() => warp(3600)}>Advance 1 hour</button>
        <button type="button" className="min-h-11 underline" onClick={() => warp(86_400)}>Advance 1 day</button>
        <button type="button" className="min-h-11 underline" onClick={() => void refresh()}>Refresh</button>
      </p>
      {note && <p role="status">{note}</p>}
    </section>
  );
}
