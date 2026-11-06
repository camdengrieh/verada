"use client";

import { CuratorAgentCard, type CuratorStatus } from "@varada/ui/components/varada/curator-agent-card";
import { isCauseName, type CauseName } from "@varada/ui/components/varada/cause-icon";
import { agentName, causeIdOfOrg } from "@varada/sdk";
import type { Hex } from "viem";
import { useAppConfig } from "@/components/providers";
import { useSiteRel as useRel } from "@/components/governance/use-rel";
import type { AgentReport, AgentSummary } from "@/lib/agents";
import type { TokenFocus } from "@/lib/indexer";

export interface AgentPicks {
  agent: AgentSummary;
  report: AgentReport | null;
}

/** The regions of a report that count for a token: those in its focus, or all when it has none. */
export function focusRegions(report: AgentReport, focus: Pick<TokenFocus, "regions"> | null | undefined) {
  const slugs = focus?.regions ?? [];
  return slugs.length === 0 ? report.regions : report.regions.filter((r) => slugs.includes(r.region));
}

/** How many of the ballot's options this agent picked (matched by cause id, within the token's regions). */
export function picksOnBallot(report: AgentReport | null, focus: Pick<TokenFocus, "regions"> | null | undefined, optionIds: readonly string[]): number {
  if (!report) return 0;
  const onBallot = new Set(optionIds.map((o) => o.toLowerCase()));
  const picked = new Set<string>();
  for (const r of focusRegions(report, focus)) for (const p of r.picks) picked.add(causeIdOfOrg(p.orgId as Hex).toLowerCase());
  let n = 0;
  for (const id of picked) if (onBallot.has(id)) n += 1;
  return n;
}

/** The curator agents of a token's causes, each with what it picked for this ballot and whether the picks verify on chain. */
export function CuratorPicks({
  items,
  focus,
  optionIds,
  showPicks,
}: {
  items: AgentPicks[];
  focus: Pick<TokenFocus, "regions"> | null | undefined;
  optionIds: readonly string[];
  /** Count picks on this ballot (false before the ballot is prepared). */
  showPicks: boolean;
}) {
  const config = useAppConfig();
  const rel = useRel();
  if (items.length === 0) return null;
  return (
    <section aria-label="Curator agents" className="grid grid-cols-1 gap-3">
      <h3 className="m-0 font-display text-xl font-semibold text-ink">Curator agents for this token</h3>
      <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
        {items.map(({ agent, report }) => {
          const regions = report ? focusRegions(report, focus) : [];
          const top = regions
            .flatMap((r) => r.picks)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
          const rationale = regions.map((r) => r.summary).find((s) => s.trim() !== "");
          const cause: CauseName = isCauseName(agent.label) ? agent.label : "other";
          const status: CuratorStatus = agent.active ? "active" : "paused";
          return (
            <CuratorAgentCard
              key={agent.label}
              ens={agent.ensName || agentName(agent.label, config.ensParentName)}
              cause={cause}
              status={status}
              agentId={agent.agentId}
              picks={showPicks && report ? picksOnBallot(report, focus, optionIds) : undefined}
              rationale={rationale}
              topPicks={top.map((p) => ({ org: p.name, score: `${p.score}/100` }))}
              verified={report && regions.length > 0 ? regions.every((r) => r.verified) : undefined}
              reportHref={rel(`agent/${agent.label}/`)}
            />
          );
        })}
      </div>
    </section>
  );
}
