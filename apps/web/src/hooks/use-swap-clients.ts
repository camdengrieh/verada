"use client";

import { useMemo } from "react";
import type { PublicClient } from "viem";
import { useAccount } from "wagmi";
import { useDeps, usePrivateRpc } from "@/components/providers";
import { createAccountClient } from "@/lib/account-reads";
import type { TradeClients } from "@/lib/swap/trade";

/**
 * The two read clients of the trade flow. `chain` is public (pools, fees, quotes: no address ever
 * travels with it). `accountClient` is keyed by the connected account and goes through the private
 * RPC under that account's own isolation key (docs/PRIVACY.md); it is the only way balances,
 * allowances and the Ondo compliance check of the user's address are read.
 */
export function useSwapClients(): TradeClients & { chain: PublicClient } {
  const deps = useDeps();
  const rpc = usePrivateRpc();
  const { address } = useAccount();
  const accountClient = useMemo(() => (address ? createAccountClient(rpc, address) : undefined), [rpc, address]);
  return useMemo(() => ({ chain: deps.chain(), accountClient, account: address }), [deps, accountClient, address]);
}
