"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { readBalances, type SwapAsset } from "@varada/sdk";
import { useSwapClients } from "./use-swap-clients";

/**
 * Balances of the connected account in `assets` (native ETH included), read through the account
 * client: private RPC under the account's isolation key, never a direct connection. Refreshes every
 * 30 s and on `refresh()` (after a swap).
 */
export function useBalances(assets: readonly SwapAsset[]) {
  const { accountClient, account } = useSwapClients();
  const qc = useQueryClient();
  const key = ["swap-balances", account, assets.map((a) => a.address).join(",")] as const;
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(accountClient && account),
    refetchInterval: 30_000,
    staleTime: 10_000,
    queryFn: async () => {
      if (!accountClient || !account) return new Map<string, bigint>();
      return readBalances(accountClient, account, assets);
    },
  });
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ["swap-balances", account] }), [qc, account]);
  const of = useCallback((asset: SwapAsset): bigint | undefined => query.data?.get(asset.address.toLowerCase()), [query.data]);
  return { balances: query.data ?? new Map<string, bigint>(), balanceOf: of, loading: query.isLoading, error: query.error, refresh };
}

