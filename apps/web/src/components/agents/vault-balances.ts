"use client";

import { useQuery } from "@tanstack/react-query";
import { useAppConfig, useDeps } from "@/components/providers";
import { readVaultBalances, usdcAddress } from "@/lib/vault";

/**
 * USDC held by each agent vault, read from the chain through the public-scope private RPC. Keys are
 * lowercase vault addresses; a vault that could not be read is absent (show "unavailable").
 */
export function useVaultBalances(vaults: readonly string[]) {
  const config = useAppConfig();
  const deps = useDeps();
  const usdc = usdcAddress(config.chainId);
  const key = [...new Set(vaults.filter(Boolean).map((v) => v.toLowerCase()))].sort();
  return useQuery({
    queryKey: ["vault-balances", config.chainId, key.join(",")],
    queryFn: () => readVaultBalances(deps.chain(), usdc!, key),
    enabled: Boolean(usdc && key.length > 0),
    retry: false,
    staleTime: 60_000,
  });
}
