"use client";

import { useQuery } from "@tanstack/react-query";
import { CopyButton } from "@varada/ui/components/data/copy-button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@varada/ui/components/ui/accordion";
import { Badge } from "@varada/ui/components/ui/badge";
import { CircleAlert, ShieldCheck } from "@varada/ui/components/ui/icons";
import { Progress } from "@varada/ui/components/ui/progress";
import { MAX_WEIGHT } from "@varada/sdk";
import { regionName, SourceLink } from "@/components/agent-common";
import { useDeps } from "@/components/providers";
import type { AgentRegionReport } from "@/lib/agents";
import type { PickProof } from "@/lib/indexer";
import { Markdown, SafeLink } from "@/lib/markdown";

/**
 * One region of an agent's weekly report: urgency, summary, ranked picks with their Merkle proofs,
 * newsletter and events. Everything here is LLM-written from untrusted news, so it is rendered as
 * text, through the safe Markdown subset, or as `SafeLink`s; never as HTML.
 *
 * `label` and `epoch` locate the picks' proofs on the indexer (shown once the region verifies).
 */
export function AgentRegionView({
  region,
  label,
  epoch,
  headingLevel = 3,
}: {
  region: AgentRegionReport;
  label?: string;
  epoch?: string;
  headingLevel?: 2 | 3;
}) {
  const deps = useDeps();
  const H = `h${headingLevel}` as "h2" | "h3";
  const Sub = `h${headingLevel + 1}` as "h3" | "h4";
  const name = regionName(region.region);

  // The proofs let anyone check a pick against the root on chain; only a verified region has them.
  const proofs = useQuery({
    queryKey: ["agent-pick-proofs", label, epoch, region.region],
    queryFn: () => deps.indexer.agentPicks(label!, BigInt(epoch!), region.region),
    enabled: Boolean(label && epoch && /^\d+$/.test(epoch) && region.verified && region.picks.length > 0),
    retry: false,
    staleTime: 300_000,
  });
  const proofOf = (p: { rank: number; orgId: string }): PickProof | undefined =>
    proofs.data?.items.find((x) => x.rank === p.rank && x.orgId.toLowerCase() === p.orgId.toLowerCase());

  return (
    <section aria-label={`${name} picks`} className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <H className="m-0 font-display text-2xl font-semibold text-ink">{name}</H>
        {region.verified ? (
          <Badge tone="cause" shape="pill">
            <ShieldCheck aria-hidden="true" />
            Verified on-chain
          </Badge>
        ) : (
          <Badge tone="live" shape="pill">
            <CircleAlert aria-hidden="true" />
            Not verified on-chain
          </Badge>
        )}
      </div>
      <p className="m-0 text-sm text-ink-soft">
        {region.verified
          ? "These picks match the root the agent submitted on chain."
          : region.picksRoot
            ? "The picks in this report do not match the root the agent submitted on chain, so they may not be the ones ballots use."
            : "The agent submitted no picks for this region on chain."}
        {region.picksRoot && (
          <>
            {" "}
            Root: <code className="break-all rounded bg-sand px-1.5 py-0.5 font-mono text-xs">{region.picksRoot}</code>
          </>
        )}
      </p>
      <Progress
        label="Urgency weight"
        value={region.weight}
        max={MAX_WEIGHT}
        valueText={`${region.weight} / ${MAX_WEIGHT}`}
        tone="cause"
        size="sm"
      />
      {region.summary && <p className="m-0 text-[15px] leading-relaxed text-ink">{region.summary}</p>}

      <Sub className="m-0 font-display text-xl font-semibold text-ink">This week&apos;s picks</Sub>
      {region.picks.length === 0 ? (
        <p className="m-0 text-sm text-ink-soft">No picks for {name} this week.</p>
      ) : (
        <ol aria-label={`${name} ranked picks`} className="m-0 grid grid-cols-1 list-none gap-3 p-0">
          {region.picks.map((p) => {
            const proof = proofOf(p);
            return (
              <li key={`${p.rank}-${p.orgId}`} className="grid grid-cols-1 gap-2 rounded-2xl border border-line bg-paper-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <p className="m-0 min-w-0 text-[15px] text-ink">
                    <strong>
                      #{p.rank + 1} {p.name}
                    </strong>
                  </p>
                  <span className="num shrink-0 text-sm text-ink-soft">score {p.score}/100</span>
                </div>
                <Progress value={p.score} aria-label={`Score ${p.score} out of 100`} tone="cause" size="sm" />
                {p.reasons && <p className="m-0 text-sm leading-relaxed text-ink-soft">{p.reasons}</p>}
                {p.sources.length > 0 && (
                  <p className="m-0 text-sm text-ink-soft">
                    Sources:{" "}
                    {p.sources.map((s, i) => (
                      <span key={i}>
                        {i > 0 && ", "}
                        <SourceLink url={s} />
                      </span>
                    ))}
                  </p>
                )}
                {region.verified && (
                  <Accordion type="single" collapsible>
                    <AccordionItem value="proof" className="border-b-0">
                      <AccordionTrigger className="min-h-11 py-2 text-sm">Merkle proof</AccordionTrigger>
                      <AccordionContent>
                        {proofs.isLoading ? (
                          <p role="status" className="m-0 text-sm text-ink-soft">Loading the proof</p>
                        ) : proof ? (
                          <div className="grid grid-cols-1 gap-2 text-xs">
                            <p className="m-0 text-ink-soft">
                              Leaf: rank {proof.rank}, catalogue index {proof.catalogIndex}, org <code className="break-all font-mono">{proof.orgId}</code>. Hashing it up through
                              these {proof.proof.length} siblings gives the root above.
                            </p>
                            <ol className="m-0 grid list-decimal gap-1 pl-5 font-mono text-[11px] text-ink-muted">
                              {proof.proof.map((h, i) => (
                                <li key={i} className="break-all">
                                  {h}
                                </li>
                              ))}
                            </ol>
                            <CopyButton value={JSON.stringify(proof.proof)} label="Copy proof" copiedLabel="Copied" size="sm" />
                          </div>
                        ) : (
                          <p className="m-0 text-sm text-ink-soft">The indexer has no proof for this pick right now.</p>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {region.newsletter && (
        <>
          <Sub className="m-0 font-display text-xl font-semibold text-ink">Newsletter</Sub>
          <Markdown source={region.newsletter} headingLevel={headingLevel + 2} />
        </>
      )}

      {region.events.length > 0 && (
        <>
          <Sub className="m-0 font-display text-xl font-semibold text-ink">Events</Sub>
          <ul aria-label={`${name} events`} className="m-0 grid list-disc gap-1.5 pl-5 text-[15px] text-ink-soft marker:text-ink-muted">
            {region.events.map((e, i) => (
              <li key={i}>
                <SafeLink href={e.url}>{e.title || e.url}</SafeLink>
                {e.date && ` (${e.date})`}
                {e.summary && `: ${e.summary}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
