"use client";

import { useCallback } from "react";
import type { Address } from "viem";
import { useAccount, useSwitchChain } from "wagmi";
import { useAppConfig } from "@/components/providers";

export interface WalletGate {
  address?: Address;
  connected: boolean;
  /** The wallet is connected but on another network than the app's. */
  wrongChain: boolean;
  switching: boolean;
  /** Ask the wallet to switch to the app's network. */
  switchToApp(): void;
  /** What to tell the user instead of a vote or donate button, or null when the wallet is ready. */
  blockedReason: string | null;
}

/** Wallet readiness for any write: connected, and on the network the app's contracts live on. */
export function useWalletGate(): WalletGate {
  const config = useAppConfig();
  const { address, chainId, isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const wrongChain = Boolean(isConnected && chainId !== undefined && chainId !== config.chainId);
  const switchToApp = useCallback(() => switchChain({ chainId: config.chainId }), [switchChain, config.chainId]);
  const blockedReason = !isConnected || !address ? "Connect a wallet to continue." : wrongChain ? "Your wallet is on a different network than Varada." : null;
  return { address, connected: Boolean(isConnected && address), wrongChain, switching: isPending, switchToApp, blockedReason };
}
