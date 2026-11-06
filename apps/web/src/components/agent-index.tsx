"use client";

import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { StatCard } from "@varada/ui/components/data/stat-card";
import { Badge } from "@varada/ui/components/ui/badge";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Search, User } from "@varada/ui/components/ui/icons";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@varada/ui/components/ui/tabs";
import { CauseIcon } from "@varada/ui/components/varada/cause-icon";
import { SubnameTree } from "@varada/ui/components/varada/subname-tree";
import { useMemo, useState } from "react";
import { AGENT_CATEGORIES, REGIONS, agentName } from "@varada/sdk";
import { agentCause, agentHref, causeName, RelLink, regionName, usdcText } from "@/components/agent-common";
import { useVaultBalances } from "@/components/agents/vault-balances";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import { listAgents, type AgentSummary } from "@/lib/agents";
import { loadTokens } from "@/lib/data";
import { usdcAddress } from "@/lib/vault";

/** One agent as the index shows it: the indexer row, or just the SDK's definition while the indexer is down. */
interface Row {
  label: string;
  name: string;
  ensName: string;
  active: boolean | null;
  agent: AgentSummary | null;
}

/** Every curator agent (one per cause) with its state, newest report epoch and vault balance. */
export function AgentIndex({ root = "./" }: { root?: string }) {
  const config = useAppConfig();
  const deps = useDeps();
  const [region, setRegion] = useState("");
  const [query, setQuery] = useState("");
  const { data, error, isLoading } = useQuery({ queryKey: ["agents"], queryFn: () => listAgents(deps.indexer), retry: false });
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => loadTokens(config, deps), retry: false });

  // The agents are fixed by the SDK, so their pages are still reachable without the indexer.
  const rows: Row[] = useMemo(
    () =>
      data && !error
        ? data.map((a) => ({ label: a.label, name: a.name, ensName: a.ensName || agentName(a.label, config.ensParentName), active: a.active, agent: a }))
        : error
          ? AGENT_CATEGORIES.map((c) => ({ label: c.ensLabel, name: c.label, ensName: agentName(c.ensLabel, config.ensParentName), active: null, agent: null }))
          : [],
    [data, error, config.ensParentName],
  );

  const balances = useVaultBalances(rows.map((r) => r.agent?.vault ?? ""));
  const q = query.trim().toLowerCase();
  const shown = rows.filter((r) => !q || `${r.name} ${r.ensName} ${r.label}`.toLowerCase().includes(q));

  const totals = useMemo(() => {
    let donated = 0n;
    let given = 0n;
    let active = 0;
    for (const a of data ?? []) {
      donated += BigInt(a.totals?.donated ?? "0");
      given += BigInt(a.totals?.given ?? "0");
      if (a.active) active += 1;
    }
    return { donated, given, active };
  }, [data]);
  const held = balances.data ? [...balances.data.values()].reduce((n, v) => n + v, 0n) : undefined;

  const coins = (tokens.data?.data ?? []).filter((t) => t.label);

  return (
    <section aria-label="Curator agents" className="@container grid grid-cols-1 gap-8">
      <div className="grid grid-cols-1 gap-2">
        <p className="kicker m-0">Curator agents</p>
        <h1 className="m-0 font-display text-4xl font-semibold tracking-tight text-ink @3xl:text-5xl">Curator agents</h1>
        <p className="m-0 max-w-2xl text-[15px] text-ink-soft">
          Each cause has a curator agent. Every week it reads the news for its cause, ranks up to 32 charities per region for the next ballots, publishes its picks on
          chain with a report, and gives from its own USDC vault to the charities it ranks.
        </p>
      </div>

      {data && (
        <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
          <StatCard label="Agents" value={data.length} animate={false} hint={`${totals.active} active`} />
          <StatCard label="Donated" value={usdcText(totals.donated)} hint="To every vault, credited or not" />
          <StatCard label="Given" value={usdcText(totals.given)} hint="Paid out to charities" />
          <StatCard label="In vaults" value={held !== undefined ? usdcText(held) : balances.isLoading ? "…" : "unavailable"} hint="Read from the chain now" />
        </div>
      )}

      {isLoading && (
        <div role="status" aria-label="Loading agents" className="grid grid-cols-1 gap-3 @3xl:grid-cols-2 @6xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-48 w-full rounded-[26px]" />
          ))}
        </div>
      )}
      {Boolean(error) && (
        <p role="alert" className="m-0 rounded-xl bg-terracotta-tint px-3 py-2 text-sm text-terracotta-strong">
          Could not load agents: {errorText(error)}
        </p>
      )}
      {data && data.length === 0 && (
        <EmptyState icon={<User />} title="No agents are registered yet" body="Curator agents appear here once the registry lists them." />
      )}

      {rows.length > 0 && (
        <div className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] @3xl:items-center">
            <InputGroup>
              <InputAddon>
                <Search aria-hidden="true" />
              </InputAddon>
              <label htmlFor="agent-search" className="sr-only">
                Search agents by cause
              </label>
              <Input id="agent-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search causes" />
            </InputGroup>
            <Tabs value={region || "all"} onValueChange={(v) => setRegion(v === "all" ? "" : v)} variant="pill">
              <TabsList scrollable aria-label="Region" scrollLabels={{ previous: "Earlier regions", next: "More regions" }}>
                <TabsTrigger value="all">All regions</TabsTrigger>
                {REGIONS.map((r) => (
                  <TabsTrigger key={r.slug} value={r.slug}>
                    {r.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          {shown.length === 0 ? (
            <p role="status" className="m-0 rounded-2xl bg-paper px-4 py-6 text-center text-sm text-ink-soft">
              No cause matches “{query}”.
            </p>
          ) : (
            <ul aria-label="Agents" className="m-0 grid grid-cols-1 list-none gap-3 p-0 @3xl:grid-cols-2 @6xl:grid-cols-3">
              {shown.map((r) => (
                <AgentCard key={r.label} row={r} root={root} region={region} balance={r.agent ? balances.data?.get(r.agent.vault.toLowerCase()) : undefined} balanceLoading={balances.isLoading} balanceOff={!usdcAddress(config.chainId)} />
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        <h2 className="m-0 font-display text-2xl font-semibold text-ink">Every agent has a name</h2>
        <p className="m-0 max-w-2xl text-sm text-ink-soft">
          Agents live under <code className="font-mono">agent.{config.ensParentName}</code> and resolve to their vault, so a name is all a donor needs.
        </p>
        <SubnameTree
          coins={coins.slice(0, 5).map((t) => ({ label: t.label!, note: t.symbol ? `$${t.symbol}` : undefined, href: `${root}token/?address=${t.address}` }))}
          moreCoins={coins.length > 5 ? coins.length - 5 : undefined}
          agents={AGENT_CATEGORIES.slice(0, 6).map((c) => ({ cause: agentCause(c.ensLabel), href: agentHref(root, c.ensLabel) }))}
          moreAgents={AGENT_CATEGORIES.length - 6}
          LinkComponent={RelLink}
        />
      </div>
    </section>
  );
}

function AgentCard({
  row,
  root,
  region,
  balance,
  balanceLoading,
  balanceOff,
}: {
  row: Row;
  root: string;
  region: string;
  balance: bigint | undefined;
  balanceLoading: boolean;
  balanceOff: boolean;
}) {
  const a = row.agent;
  return (
    <li className="relative grid grid-cols-1 gap-3 rounded-[26px] border border-line bg-card p-4 transition-colors focus-within:border-line-strong hover:bg-paper-card hover:shadow-paper">
      <div className="flex items-start gap-3">
        <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-sage-tint">
          <CauseIcon cause={agentCause(row.label)} size={56} decorative />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate font-display text-xl font-semibold text-ink">
            <a
              href={agentHref(root, row.label)}
              className="no-underline after:absolute after:inset-0 after:rounded-[26px] after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
            >
              {row.name}
            </a>
          </h2>
          <p className="m-0 truncate text-[13px] text-ink-muted">{row.ensName}</p>
        </div>
        {row.active !== null && (
          <Badge tone={row.active ? "cause" : "rwa"} shape="pill">
            {row.active ? "Active" : "Paused"}
          </Badge>
        )}
      </div>
      <p className="sr-only">Cause: {causeName(a?.category ?? null)}.</p>
      {a ? (
        <dl className="m-0 grid grid-cols-2 gap-2 text-sm">
          <Stat term="Vault holds" value={balance !== undefined ? usdcText(balance) : balanceLoading ? "Reading…" : balanceOff ? "n/a" : "unavailable"} />
          <Stat term="Latest report" value={a.latest ? `epoch ${a.latest.epoch}` : "none yet"} />
          <Stat term="Donated" value={usdcText(a.totals?.donated ?? "0")} />
          <Stat term="Given" value={usdcText(a.totals?.given ?? "0")} />
        </dl>
      ) : (
        <p className="m-0 text-sm text-ink-soft">Totals need the indexer.</p>
      )}
      {region && (
        <a
          href={agentHref(root, row.label, region)}
          className="relative z-[1] inline-flex min-h-11 items-center self-start text-sm font-semibold text-primary underline-offset-4 hover:underline"
        >
          See {regionName(region)} picks
        </a>
      )}
    </li>
  );
}

function Stat({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 rounded-xl bg-paper px-3 py-2">
      <dt className="kicker text-[11px]">{term}</dt>
      <dd className="num m-0 min-w-0 [overflow-wrap:anywhere] text-ink">{value}</dd>
    </div>
  );
}
