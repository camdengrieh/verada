"use client";

import type { ReactNode } from "react";
import { StatCard } from "@varada/ui/components/data/stat-card";
import { Card } from "@varada/ui/components/ui/card";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { cn } from "@varada/ui/lib/utils";
import { useAppConfig } from "@/components/providers";
import { AGENT_NAMESPACE, ORG_NAMESPACE } from "@/lib/org-names";
import { useNamesCount } from "./use-org-names";

export interface OrgNamesStatProps {
  /** What the number counts. Default "Registered ENS names". */
  label?: ReactNode;
  /** `card`: a StatCard tile (default). `inline`: the number and label in a line of text. */
  variant?: "card" | "inline";
  /** Count `agent.<parent>` and the curator agents' names as well as the charity names (default true). */
  includeAgents?: boolean;
  /** StatCard tone (card variant). */
  tone?: "paper" | "ink" | "sand";
  /** Count up on first view (card variant, default true). */
  animate?: boolean;
  className?: string;
}

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);

/**
 * How many ENS names Varada has registered: every `<label>.org.<parent>` in the catalogue build the
 * indexer has loaded (`/api/catalog` `names.count`), plus the agent names unless `includeAgents` is
 * false. While the count is unknown (no catalogue, older indexer) the card shows a dash and the
 * inline form renders nothing; it never shows a made-up number.
 */
export function OrgNamesStat({ label = "Registered ENS names", variant = "card", includeAgents = true, tone = "paper", animate = true, className }: OrgNamesStatProps) {
  const { ensParentName } = useAppConfig();
  const count = useNamesCount();
  const n = count.data ? (includeAgents ? count.data.total : count.data.orgNames) : null;

  if (variant === "inline") {
    if (count.isLoading) {
      return (
        <span data-slot="org-names-stat" role="status" className={cn("inline-block align-middle", className)}>
          {/* Skeleton's look as a span: it sits inside running text. */}
          <span aria-hidden="true" className="inline-block h-5 w-40 rounded-lg bg-sand motion-safe:animate-pulse" />
          <span className="sr-only">Loading the name count</span>
        </span>
      );
    }
    if (n === null) return null;
    return (
      <span data-slot="org-names-stat" className={cn("inline-flex items-baseline gap-1.5", className)}>
        <span className="num font-semibold text-ink">{fmt(n)}</span>
        <span className="text-ink-muted">{label}</span>
      </span>
    );
  }

  if (count.isLoading) {
    return (
      <Card tone={tone} data-slot="org-names-stat" role="status" aria-label="Loading the name count" className={cn("gap-3", className)}>
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-3 w-56" />
      </Card>
    );
  }
  const hint = count.data
    ? includeAgents
      ? `${fmt(count.data.orgNames)} charities under ${ORG_NAMESPACE}.${ensParentName}, and ${fmt(count.data.agentNames)} curator agent names under ${AGENT_NAMESPACE}.${ensParentName}`
      : `Charities under ${ORG_NAMESPACE}.${ensParentName}`
    : "The count is unavailable right now.";
  return (
    <div data-slot="org-names-stat" className={className}>
      <StatCard label={label} value={n ?? "–"} tone={tone} animate={animate} hint={hint} />
    </div>
  );
}
