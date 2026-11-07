"use client";

import { useId, useState, type ReactNode } from "react";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { Button, buttonVariants } from "@varada/ui/components/ui/button";
import { Card } from "@varada/ui/components/ui/card";
import { CircleAlert, HandHeart, Search } from "@varada/ui/components/ui/icons";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Label } from "@varada/ui/components/ui/label";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { CauseChip } from "@varada/ui/components/varada/cause-chip";
import { EnsName } from "@varada/ui/components/varada/ens-name";
import { cn } from "@varada/ui/lib/utils";
import { categoryLabelOf, regionLabelOf } from "@/components/causes/org-card";
import { useAppConfig } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import { causeNameOfSlug } from "@/lib/causes-client";
import { matchAgentNames, MIN_QUERY, namePaths, ORG_NAMESPACE, type AgentName, type OrgNameHit } from "@/lib/org-names";
import { useDebounced, useNameRel, useOrgNameSearch } from "./use-org-names";

export interface OrgNameSearchProps {
  /** Relative path to the site root ("./", "../") for result links; default: the app's site root. */
  root?: string;
  /** Visible label of the search field. Default "Search charity names". */
  label?: ReactNode;
  /** Query to start with (e.g. from the URL). */
  defaultQuery?: string;
  /** Also match `agent.<parent>` and the curator agents' names (default true). */
  includeAgents?: boolean;
  /** Heading level of each result's org name (default 3). */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);
const MAX_CHIPS = 2;

/**
 * Search over Varada's registered ENS names: every charity's `<label>.org.<parent>` (by org name,
 * label or full name, or EIN) through the indexer's catalogue search, which ranks exact matches
 * first and then by catalogue rank, and pages 20 at a time; plus the agent names, matched locally.
 * Each result shows the name (copyable), the org, its causes, and links to give to it and to see it
 * in the catalogue. Links are relative to `root`, so they work under Swarm and ENS gateway prefixes.
 */
export function OrgNameSearch({ root, label = "Search charity names", defaultQuery = "", includeAgents = true, headingLevel = 3, className }: OrgNameSearchProps) {
  const { ensParentName } = useAppConfig();
  const rel = useNameRel(root);
  const inputId = useId();
  const statusId = useId();
  const [query, setQuery] = useState(defaultQuery);
  const debounced = useDebounced(query, 250);
  const { q, results, total, hits, unavailable } = useOrgNameSearch(debounced);
  const agents = includeAgents ? matchAgentNames(q, ensParentName) : [];
  const short = q.length < MIN_QUERY;
  const typing = normalizeLen(query) >= MIN_QUERY && query !== debounced;

  const status = short
    ? `Type at least ${MIN_QUERY} letters of a charity's name, its ${ORG_NAMESPACE}.${ensParentName} name or its EIN.`
    : results.isLoading || typing
      ? "Searching names…"
      : results.isError || unavailable
        ? ""
        : total === null
          ? ""
          : `${fmt(total + agents.length)} ${total + agents.length === 1 ? "name matches" : "names match"} “${q}”`;

  return (
    <div data-slot="org-name-search" className={cn("@container flex flex-col gap-4", className)}>
      <form role="search" onSubmit={(e) => e.preventDefault()} className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={inputId}>{label}</Label>
        <InputGroup>
          <InputAddon>
            <Search aria-hidden="true" />
          </InputAddon>
          <Input
            id={inputId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Name, label.${ORG_NAMESPACE}.${ensParentName} or EIN`}
            autoComplete="off"
            spellCheck={false}
            maxLength={120}
            aria-describedby={statusId}
          />
        </InputGroup>
        <p id={statusId} role="status" aria-live="polite" className="m-0 min-h-5 text-[13px] text-ink-muted">
          {status}
        </p>
      </form>

      {agents.length > 0 && <AgentResults agents={agents} rel={rel} headingLevel={headingLevel} />}

      {!short && results.isLoading && (
        <div aria-hidden="true" className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
          <Skeleton className="h-36 rounded-[20px]" />
          <Skeleton className="h-36 rounded-[20px]" />
        </div>
      )}
      {!short && results.isError && (
        <EmptyState size="compact" icon={<CircleAlert />} role="alert" title="The name search did not go through" body={errorText(results.error)} />
      )}
      {!short && unavailable && (
        <EmptyState size="compact" icon={<CircleAlert />} title="Name search is unavailable right now" body="The indexer has no catalogue loaded. Try again in a few minutes." />
      )}
      {!short && !results.isLoading && !results.isError && !unavailable && total === 0 && agents.length === 0 && (
        <EmptyState size="compact" icon={<Search />} title="No names match" body="Try part of the charity's name, its EIN, or fewer words." />
      )}
      {hits.length > 0 && (
        <ul aria-label="Charity names" className="m-0 grid list-none grid-cols-1 gap-3 p-0 @2xl:grid-cols-2">
          {hits.map((h) => (
            <li key={h.org.causeId} className="min-w-0">
              <NameResult hit={h} rel={rel} headingLevel={headingLevel} />
            </li>
          ))}
        </ul>
      )}
      {results.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void results.fetchNextPage()} disabled={results.isFetchingNextPage}>
            {results.isFetchingNextPage ? "Loading…" : "More names"}
          </Button>
        </div>
      )}
    </div>
  );
}

const normalizeLen = (s: string) => s.trim().length;

function NameResult({ hit, rel, headingLevel }: { hit: OrgNameHit; rel(path: string): string; headingLevel: 2 | 3 | 4 }) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const { org } = hit;
  const place = [org.state, org.country].filter(Boolean).join(", ");
  const shown = org.categories.slice(0, MAX_CHIPS);
  return (
    <Card data-slot="org-name-result" className="flex h-full min-w-0 flex-col gap-3 p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <EnsName name={hit.ensName} size="md" />
        <Heading className="m-0 font-display text-base font-semibold leading-snug text-ink-soft [overflow-wrap:anywhere]">{org.name}</Heading>
        <p className="m-0 text-[13px] text-ink-muted">
          {[place, org.ein ? `EIN ${org.ein}` : null, org.regions.length ? org.regions.map(regionLabelOf).join(" · ") : null].filter(Boolean).join(" · ") ||
            "Catalogue organization"}
        </p>
      </div>
      {shown.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Causes">
          {shown.map((slug) => (
            <li key={slug} className="max-w-full">
              <a href={rel(namePaths.cause(slug))} className="inline-flex max-w-full rounded-full focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40" aria-label={`All ${categoryLabelOf(slug)} charities`}>
                <CauseChip cause={causeNameOfSlug(slug)} label={categoryLabelOf(slug)} size="sm" />
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        <a href={rel(namePaths.donate(org.orgId))} className={buttonVariants({ variant: "cause", size: "sm" })} aria-label={`Give to ${org.name}`}>
          <HandHeart aria-hidden="true" />
          Give
        </a>
        <a href={rel(namePaths.catalogue(hit.label))} className={buttonVariants({ variant: "ghost", size: "sm" })} aria-label={`${org.name} in the catalogue`}>
          In the catalogue
        </a>
      </div>
    </Card>
  );
}

function AgentResults({ agents, rel, headingLevel }: { agents: AgentName[]; rel(path: string): string; headingLevel: 2 | 3 | 4 }) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <section aria-label="Curator agent names" className="flex flex-col gap-2">
      <Heading className="kicker m-0">Curator agents</Heading>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {agents.map((a) => (
          <li key={a.name}>
            <Card data-slot="agent-name-result" className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span className="flex min-w-0 flex-col">
                <EnsName name={a.name} size="sm" />
                <span className="text-[13px] text-ink-muted">{a.title}</span>
              </span>
              <a href={rel(a.path)} className={buttonVariants({ variant: "ghost", size: "sm" })} aria-label={`Open ${a.name}`}>
                Open
              </a>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
