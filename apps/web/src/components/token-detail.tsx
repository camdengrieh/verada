"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { isValidLabel } from "@varada/sdk";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Button } from "@varada/ui/components/ui/button";
import { useAppConfig, useDeps } from "@/components/providers";
import { TokenHeroSkeleton } from "@/components/token/token-hero";
import { TokenView } from "@/components/token/token-view";
import { useRel } from "@/components/nav";
import { loadTokenDetail, resolveTokenLabel } from "@/lib/data";
import { readTokenAddress } from "@/lib/token-address";

/** A full-width notice: loading, not found, or an error with a way forward. */
function Notice({ role, title, body, action }: { role: "status" | "alert"; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <section role={role} className="rounded-[32px] border border-line bg-card">
      <EmptyState headingLevel={2} title={title} body={body} action={action} />
    </section>
  );
}

/**
 * Single client-side page for every token. The token comes from the URL (`?address=`), or, on a
 * token's own ENS name or at `token/?label=`, from the label (resolved on-chain, then through the indexer).
 */
export function TokenDetail({ label: labelProp }: { label?: string | null }) {
  const config = useAppConfig();
  const deps = useDeps();
  const rel = useRel();
  const [fromUrl, setFromUrl] = useState<string | null | undefined>(undefined);
  const [urlLabel, setUrlLabel] = useState<string | null>(null);

  useEffect(() => {
    if (labelProp) return;
    const read = () => {
      const a = readTokenAddress(window.location.search, window.location.hash);
      setFromUrl(a);
      // token/?label=<label>: the plain-DNS route (<site>/<label>, via 404.html) lands here.
      const l = new URLSearchParams(window.location.search).get("label")?.trim().toLowerCase() ?? "";
      setUrlLabel(a === null && isValidLabel(l) ? l : null);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [labelProp]);
  const label = labelProp ?? urlLabel;

  const resolved = useQuery({
    queryKey: ["label-address", label],
    queryFn: () => resolveTokenLabel(config, deps, label as string),
    enabled: Boolean(label),
    retry: false,
  });

  const address = label ? resolved.data?.data : fromUrl;
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ["token-detail", address],
    queryFn: () => loadTokenDetail(config, deps, address as string),
    enabled: Boolean(address),
    retry: false,
  });

  const home = <Button variant="outline" onClick={() => (window.location.href = rel(""))}>See all tokens</Button>;
  if (label) {
    if (resolved.isLoading) return <div role="status" aria-label={`Resolving ${label}.${config.ensParentName}`}><span className="sr-only">Resolving {label}.{config.ensParentName}</span><TokenHeroSkeleton /></div>;
    if (resolved.error)
      return (
        <Notice
          role="alert"
          title={`Could not resolve ${label}.${config.ensParentName}`}
          body={resolved.error instanceof Error ? resolved.error.message : "unknown error"}
          action={<Button variant="outline" onClick={() => void resolved.refetch()}>Try again</Button>}
        />
      );
    if (resolved.data && !resolved.data.data) return <Notice role="alert" title="No such token" body={`No token has the name ${label}.${config.ensParentName}.`} action={home} />;
  } else {
    if (fromUrl === undefined) return <TokenHeroSkeleton />;
    if (fromUrl === null) return <Notice role="alert" title="Which token?" body="Provide a token address or label, e.g. token/?address=0x... or token/?label=name" action={home} />;
  }
  if (!address || !isAddress(address)) return <TokenHeroSkeleton />;
  const token = data?.data;
  const tokenAddress = getAddress(address) as Address;

  if (isLoading) return <TokenHeroSkeleton />;
  if (error)
    return (
      <Notice
        role="alert"
        title="Could not load this token"
        body={error instanceof Error ? error.message : "unknown error"}
        action={<Button variant="outline" onClick={() => void refetch()}>Try again</Button>}
      />
    );
  if (data && !token) return <Notice role="alert" title="Token not found" body="Neither the indexer nor the chain knows a token at this address." action={home} />;
  if (!token) return <TokenHeroSkeleton />;
  return <TokenView address={tokenAddress} token={token} source={data?.source} />;
}
