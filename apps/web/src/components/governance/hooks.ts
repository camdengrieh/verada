"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import { useAppConfig, useDeps, usePrivateRpc } from "@/components/providers";
import { createAccountClient } from "@/lib/account-reads";
import { listAgents } from "@/lib/agents";
import { loadCauses } from "@/lib/data";
import { readStanding } from "@/lib/governance";

/** Registry causes by lowercase cause id (names of orgs that have already won once). Shares the cache of the token page. */
export function useCauseRegistry() {
  const deps = useDeps();
  return useQuery({ queryKey: ["causes"], queryFn: () => loadCauses(deps), retry: false, staleTime: 300_000 });
}

/** Catalogue orgs for ballot option cause ids (names, categories, regions). */
export function useCatalogOrgs(causeIds: readonly string[]) {
  const deps = useDeps();
  const ids = [...new Set(causeIds.map((c) => c.toLowerCase()))].sort();
  return useQuery({
    queryKey: ["catalog-causes", ids.join(",")],
    queryFn: () => deps.indexer.catalogCauses(ids),
    enabled: ids.length > 0,
    retry: false,
    staleTime: 300_000,
  });
}

/** Every registered curator agent. */
export function useAgentList() {
  const deps = useDeps();
  return useQuery({ queryKey: ["agents"], queryFn: () => listAgents(deps.indexer), retry: false, staleTime: 60_000 });
}

/** The clock in unix seconds, refreshed every `everyMs` so "open" turns into "counting" without a reload. */
export function useNowSeconds(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

export const standingKey = (governor: string | undefined, token: string, epoch: bigint | undefined, account: string | undefined) =>
  ["standing", governor, token.toLowerCase(), epoch?.toString(), account?.toLowerCase()] as const;

/**
 * The connected account's weight and `hasVoted` for a token's epoch, read through the account's own
 * isolated private client (never the indexer, docs/PRIVACY.md).
 */
export function useStanding(token: string, epoch: bigint | undefined, enabled = true) {
  const config = useAppConfig();
  const rpc = usePrivateRpc();
  const { address: account } = useAccount();
  const client = useMemo(() => (account ? createAccountClient(rpc, account) : null), [rpc, account]);
  return useQuery({
    queryKey: standingKey(config.governorAddress, token, epoch, account),
    queryFn: () => readStanding(client!, config.governorAddress as Address, token as Address, epoch!, account!),
    enabled: Boolean(enabled && client && account && epoch !== undefined && config.governorAddress),
    retry: false,
  });
}
