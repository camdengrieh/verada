"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { Countdown } from "@varada/ui/components/data/countdown";
import { Card } from "@varada/ui/components/ui/card";
import { Badge } from "@varada/ui/components/ui/badge";
import { CauseIcon, isCauseName } from "@varada/ui/components/varada/cause-icon";
import { CausePoolCard } from "@varada/ui/components/varada/cause-pool-card";
import { CuratorAgentCard } from "@varada/ui/components/varada/curator-agent-card";
import { FeeSplitBar } from "@varada/ui/components/varada/fee-split-bar";
import { PoolMeter } from "@varada/ui/components/varada/pool-meter";
import { useCatalogNames } from "@/components/catalog-browser";
import { ballotMix, causeName, useCauses, useEpochView } from "@/components/epoch-panel";
import { useAppConfig, useDeps } from "@/components/providers";
import { agentPath, agentsForFocus, listAgents } from "@/lib/agents";
import type { TokenDetail, TokenFeeTotals } from "@/lib/indexer";
import { causeNameOfOrg, poolFigures, usdcToUsd, type LiveView } from "@/lib/token-data";
import { untilText, usdText } from "@/lib/token-view";
import { shownOptionSources } from "@/components/epoch-panel";
import { ballotOptions } from "@/lib/profile";
import { useRel } from "@/components/nav";

/** This week's cause pool: the amount so far, when voting closes and how the ballot is made up. */
export function PoolSummary({ token, detail, onVote }: { token: Address; detail: TokenDetail; onVote: () => void }) {
  const config = useAppConfig();
  const view = useEpochView(token);
  const agents = useAgentsFor(detail);
  if (!config.governorAddress || !view.data) return null;
  const { epoch, detail: ed } = view.data;
  const pool = poolFigures(ed);
  if (!ed || !pool || ed.start === undefined || ed.end === undefined) return null;

  const { options, frozen } = ballotOptions({ prepared: Boolean(ed.prepared || ed.poll?.opened), epochOptions: ed.options, pinned: detail.shortlist });
  const mix = frozen ? ballotMix(shownOptionSources(true, options, ed)) : null;
  const closing = untilText(ed.end, Date.now());
  const curator = agents[0]?.ensName || undefined;
  const voteLabel = ed.poll?.closed || !closing ? "See the result" : "Vote privately";
  const common = { amount: usdText(usdcToUsd(pool.total)), attributed: usdText(usdcToUsd(pool.earned)), carriedForward: usdText(usdcToUsd(pool.carriedIn)) };

  if (mix) {
    return <CausePoolCard epoch={Number(epoch)} countdown={closing ? `closes in ${closing}` : "voting closed"} {...common} ballot={mix} curator={curator} onVote={onVote} voteLabel={voteLabel} />;
  }
  return (
    <PoolMeter
      epoch={Number(epoch)}
      amount={usdcToUsd(pool.total)}
      startsAt={ed.start * 1000}
      endsAt={ed.end * 1000}
      attributed={common.attributed}
      carriedForward={common.carriedForward}
      curator={curator}
      onVote={onVote}
      voteLabel={voteLabel === "Vote privately" && !frozen ? "See the ballot" : voteLabel}
      headingLevel={2}
    />
  );
}

/** A live-donation token's rotation: who is being given to now and when it changes. */
export function LiveSummary({ live }: { live: LiveView }) {
  const causes = useCauses();
  const ids = [live.designatedCause, live.nextCause?.causeId].filter((x): x is string => Boolean(x));
  const names = useCatalogNames(ids);
  const name = (id: string) => causeName(causes.data, id, names.data);
  const designated = live.designatedCause?.toLowerCase();
  const next = live.nextCause;
  return (
    <Card tone="ink" className="gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 font-display text-xl font-semibold">Giving now</h2>
        <Badge tone="cause" dot>
          Live donation{live.cadence ? ` · ${live.cadence}` : ""}
        </Badge>
      </div>
      {designated ? (
        <div className="flex items-center gap-3">
          <CauseIcon cause={causeNameOfOrg(names.data?.get(designated))} size={44} decorative />
          <div className="flex min-w-0 flex-col">
            <strong className="truncate text-lg">{name(designated)}</strong>
            <span className="text-sm text-paper/75">receives every swap&apos;s cause share as it happens</span>
          </div>
        </div>
      ) : (
        <p className="m-0 text-sm text-paper/80">No cause is designated for this rotation yet.</p>
      )}
      {live.rotation && live.rotation.nextRotationAt > 0 ? (
        <div className="flex flex-col gap-1 text-sm">
          <Countdown to={live.rotation.nextRotationAt * 1000} label="Next rotation in" variant="inline" doneText="Rotating now" />
          {next ? <span className="text-paper/75">Next: {name(next.causeId)}</span> : null}
        </div>
      ) : null}
      <dl className="m-0 grid grid-cols-2 gap-3 border-t border-paper/20 pt-3 text-sm">
        <div>
          <dt className="text-paper/70">Donated</dt>
          <dd className="num m-0 text-lg font-semibold">{usdText(usdcToUsd(live.totals.donated))}</dd>
        </div>
        <div>
          <dt className="text-paper/70">Waiting to go out</dt>
          <dd className="num m-0 text-lg font-semibold">{usdText(usdcToUsd(live.totals.pending))}</dd>
        </div>
      </dl>
    </Card>
  );
}

export function FeeSplit({ feeTotals }: { feeTotals: TokenFeeTotals | null | undefined }) {
  return (
    <Card className="gap-3 p-5">
      <h2 className="m-0 font-sans text-base font-semibold">Where each trading fee goes</h2>
      <FeeSplitBar
        causeShare={90}
        causeAmount={feeTotals ? usdText(usdcToUsd(BigInt(feeTotals.causeAmount))) : undefined}
        platformAmount={feeTotals ? usdText(usdcToUsd(BigInt(feeTotals.platformAmount))) : undefined}
      />
    </Card>
  );
}

function useAgentsFor(detail: TokenDetail) {
  const deps = useDeps();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => listAgents(deps.indexer), enabled: Boolean(detail.focus), retry: false, staleTime: 300_000 });
  return agents.data ? agentsForFocus(agents.data, detail.focus) : [];
}

/**
 * The curator agents whose cause is in the token's focus: each ranks charities for its cause every
 * week, and its picks can fill the ballot slots after the pins.
 */
export function CuratedBy({ focus }: { focus: TokenDetail["focus"] }) {
  const config = useAppConfig();
  const deps = useDeps();
  const rel = useRel();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => listAgents(deps.indexer), enabled: Boolean(focus), retry: false, staleTime: 300_000 });
  if (!focus) return null;
  const matching = agents.data ? agentsForFocus(agents.data, focus) : [];
  return (
    <section aria-label="Curated by" className="flex flex-col gap-3">
      <h2 className="m-0 font-display text-2xl font-semibold">Curated by</h2>
      {agents.isLoading && <p role="status" className="m-0 text-sm text-ink-soft">Loading curator agents</p>}
      {agents.error && <p role="note" className="m-0 text-sm text-ink-soft">Curator agents are unavailable right now.</p>}
      {agents.data && matching.length === 0 && <p className="m-0 text-sm text-ink-soft">No curator agent covers this token&apos;s causes yet.</p>}
      {matching.length > 0 && (
        <>
          <p className="m-0 text-sm text-ink-soft">Curator agents for this token&apos;s causes. Their weekly picks fill the ballot slots after the pinned causes.</p>
          <ul className="m-0 grid list-none gap-3 p-0">
            {matching.map((a) => (
              <li key={a.label}>
                <CuratorAgentCard
                  ens={a.ensName || `${a.label}.agent.${config.ensParentName}`}
                  cause={isCauseName(a.label) ? a.label : "other"}
                  status={a.active ? "active" : "paused"}
                  agentId={a.agentId || undefined}
                  rationale={a.description || undefined}
                  reportHref={rel(agentPath(a.label))}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
