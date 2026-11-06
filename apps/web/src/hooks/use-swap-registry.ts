"use client";

import { useQuery } from "@tanstack/react-query";
import { useAppConfig } from "@/components/providers";
import { loadRegistryAssets } from "@/lib/swap/registry";
import { useSwapClients } from "./use-swap-clients";

/**
 * The quote registry's allowlisted assets, offered as pay / receive assets and used as extra routing
 * nodes. Empty without a configured factory or when the registry cannot be read.
 */
export function useRegistryAssets() {
  const cfg = useAppConfig();
  const { chain } = useSwapClients();
  return useQuery({
    queryKey: ["swap-registry-assets", cfg.factoryAddress],
    enabled: Boolean(cfg.factoryAddress),
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: () => loadRegistryAssets(chain, cfg.factoryAddress!),
  });
}
