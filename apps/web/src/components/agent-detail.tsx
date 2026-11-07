"use client";

import { useQuery } from "@tanstack/react-query";
import { ActivityList, type ActivityItem } from "@varada/ui/components/data/activity-list";
import { EmptyState } from "@varada/ui/components/data/empty-state";
import { StatCard } from "@varada/ui/components/data/stat-card";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@varada/ui/components/ui/tabs";
import { CauseIcon } from "@varada/ui/components/varada/cause-icon";
import { EnsName } from "@varada/ui/components/varada/ens-name";
import { EnsProfileCard } from "@varada/ui/components/varada/ens-profile-card";
import { SubnameTree } from "@varada/ui/components/varada/subname-tree";
import { useMemo, useState } from "react";
import { AGENT_CATEGORIES, REGIONS, agentByLabel, agentName } from "@varada/sdk";
import { CauseCoins } from "@/components/causes/cause-coins";
import { agentCause, agentHref, agentsIndexHref, causeName, RelLink, regionName, usdcText } from "@/components/agent-common";
import { AgentDonatePanel } from "@/components/agent-donate";
import { AgentRegionView } from "@/components/agent-region";
import { useVaultBalances } from "@/components/agents/vault-balances";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText, shortAddress } from "@/components/use-tx";
import { getAgent, getAgentReport, getDonorBoard, regionReport, type AgentDetail as AgentInfo, type AgentReport, type DonorBoard } from "@/lib/agents";
import { loadTokens } from "@/lib/data";
import { agentGatewayUrl } from "@/lib/host";
import { Markdown } from "@/lib/markdown";
import { usdcAddress } from "@/lib/vault";

/** ERC-8004 identity registry on mainnet, where every agent holds its identity token. */
export const ERC8004_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const REGION_ORDER = new Map(REGIONS.map((r, i) => [r.slug, i]));

const SECTION = "grid grid-cols-1 gap-4 rounded-[26px] border border-line bg-card p-5";
const H2 = "m-0 font-display text-2xl font-semibold text-ink";

/** "3h ago" style time for a unix-seconds timestamp, relative to `now` (ms). */
function ago(seconds: number | undefined, nowMs: number): string | undefined {
  if (seconds === undefined) return undefined;
  const minutes = Math.max(0, Math.floor((nowMs - seconds * 1000) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const iso = (seconds: number | undefined) => (seconds === undefined ? undefined : new Date(seconds * 1000).toISOString());

/**
 * A curator agent's page: identity, vault, the weekly report (per-region picks with Merkle proofs,
 * newsletter, events), the report archive, totals, credited donors, recent gifts and the donate
 * flow. With `region`, the report shows that region only. `root` is the relative path from this page
 * to the site root ("./" on `<label>.agent.<parent>`, where the root page renders this).
 */
export function AgentDetail({ label, region, root = "./" }: { label: string; region?: string; root?: string }) {
  const config = useAppConfig();
  const deps = useDeps();
  const def = agentByLabel(label);
  const [chosenEpoch, setChosenEpoch] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["agent", label],
    queryFn: () => getAgent(deps.indexer, label),
    enabled: Boolean(def),
    retry: false,
  });
  const agent = detail.data ?? null;
  const epoch = chosenEpoch ?? agent?.latest?.epoch ?? null;
  const report = useQuery({
    queryKey: ["agent-report", label, epoch],
    queryFn: () => getAgentReport(deps.indexer, label, epoch!),
    enabled: Boolean(agent && epoch !== null),
    retry: false,
  });
  const donorBoard = useQuery({
    queryKey: ["agent-donors", label, region ?? null],
    queryFn: () => getDonorBoard(deps.indexer, label, { region }),
    enabled: Boolean(def),
    retry: false,
  });
  const balances = useVaultBalances(agent ? [agent.vault] : []);
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => loadTokens(config, deps), retry: false });

  if (!def) return <p role="alert">No curator agent has the name {label}.</p>;
  const ensName = agent?.ensName || agentName(def.ensLabel, config.ensParentName);
  const focus = region ? REGIONS.find((r) => r.slug === region) : undefined;
  if (region && !focus) return <p role="alert">Unknown region {region}.</p>;

  const title = agent?.name ?? def.label;
  const coins = (tokens.data?.data ?? []).filter((t) => t.label);

  return (
    <section aria-label={`${title} agent`} className="@container grid grid-cols-1 gap-8">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-2 text-sm text-ink-soft">
        <a href={agentsIndexHref(root)} className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline">
          All agents
        </a>
        {focus && (
          <>
            <span aria-hidden="true">/</span>
            <a href={agentHref(root, def.ensLabel)} className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline">
              {agent?.name ?? def.label}
            </a>
          </>
        )}
      </nav>

      <header className="grid grid-cols-1 gap-4 overflow-hidden rounded-[26px] border border-line bg-card p-5 @2xl:grid-cols-[auto_minmax(0,1fr)] @2xl:items-center @2xl:gap-6">
        <span className="grid size-24 place-items-center rounded-3xl bg-sage-tint @2xl:size-32">
          <CauseIcon cause={agentCause(def.ensLabel)} size={96} decorative />
        </span>
        <div className="grid grid-cols-1 min-w-0 gap-2">
          <p className="kicker m-0">Curator agent</p>
          <h1 className="m-0 font-display text-3xl font-semibold tracking-tight text-ink @2xl:text-4xl">
            {title}
            {focus ? `: ${focus.label}` : ""}
          </h1>
          <EnsName name={ensName} siteHref={agentGatewayUrl(def.ensLabel, config.ensParentName)} siteLabel="Open on eth.limo" />
          {agent && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={agent.active ? "cause" : "rwa"} shape="pill" dot>
                {agent.active ? "Active" : "Paused"}
              </Badge>
              <Badge tone="outline" shape="pill" title={`ERC-8004 identity registry ${ERC8004_IDENTITY_REGISTRY}`}>
                ERC-8004 #{agent.agentId}
              </Badge>
              <Badge tone="neutral" shape="pill">
                {causeName(agent.category)}
              </Badge>
            </div>
          )}
          {agent?.description && <p className="m-0 max-w-2xl text-[15px] text-ink-soft">{agent.description}</p>}
        </div>
      </header>

      {detail.isLoading && (
        <div role="status" aria-label="Loading the agent" className="grid grid-cols-1 gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}
      {detail.error && <p role="alert">Could not load agent: {errorText(detail.error)}</p>}
      {detail.data === null && <p role="alert">This agent is not registered yet.</p>}

      {agent && (
        <>
          <AgentFacts agent={agent} balance={balances.data?.get(agent.vault.toLowerCase())} balanceLoading={balances.isLoading} balanceOff={!usdcAddress(config.chainId)} />
          <ReportSection agent={agent} report={report.data ?? null} loading={report.isLoading} error={report.error} epoch={epoch} region={focus?.slug} root={root} />
          <ReportArchive agent={agent} epoch={epoch} onChoose={setChosenEpoch} />
          <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-2 @4xl:items-start">
            {/* The category bit comes from the SDK (static), not the indexer row: it keys the on-chain vault lookup. */}
            <AgentDonatePanel categoryBit={def.bit} vault={agent.vault} name={agent.name} />
            <AgentIdentity agent={agent} ensName={ensName} gateway={agentGatewayUrl(def.ensLabel, config.ensParentName)} chainId={config.chainId} />
          </div>
          <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-2 @4xl:items-start">
            <CreditedDonors agent={agent} />
            <RecentGifts agent={agent} report={report.data ?? null} />
          </div>
        </>
      )}

      <section aria-labelledby="agent-coins-h" className={SECTION}>
        <h2 id="agent-coins-h" className={H2}>
          Coins giving to {def.label.toLowerCase()}
        </h2>
        <p className="m-0 text-sm text-ink-soft">Coins that chose this cause at launch. Their trading fees fund its charities every week.</p>
        <CauseCoins categories={[def.slug]} causeName={def.label} root={root} />
      </section>

      <TopDonors board={donorBoard.data ?? null} loading={donorBoard.isLoading} failed={Boolean(donorBoard.error)} cause={def.label} region={focus ? regionName(focus.slug) : undefined} root={root} />

      <div className="grid grid-cols-1 gap-3">
        <h2 className={H2}>Where this name lives</h2>
        <SubnameTree
          coins={coins.slice(0, 4).map((t) => ({ label: t.label!, note: t.symbol ? `$${t.symbol}` : undefined, href: `${root}token/?address=${t.address}` }))}
          moreCoins={coins.length > 4 ? coins.length - 4 : undefined}
          agents={AGENT_CATEGORIES.slice(0, 5).map((c) => ({ cause: agentCause(c.ensLabel), href: agentHref(root, c.ensLabel) }))}
          moreAgents={AGENT_CATEGORIES.length - 5}
          active={ensName}
          LinkComponent={RelLink}
        />
      </div>
    </section>
  );
}

function AgentFacts({ agent, balance, balanceLoading, balanceOff }: { agent: AgentInfo; balance: bigint | undefined; balanceLoading: boolean; balanceOff: boolean }) {
  const donations = agent.totals?.donations ?? 0;
  const gifts = agent.totals?.gifts ?? 0;
  return (
    <section aria-label="Agent" className="grid grid-cols-1 gap-3">
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <StatCard
          label="In the vault"
          value={balance !== undefined ? usdcText(balance) : balanceLoading ? "…" : balanceOff ? "n/a" : "unavailable"}
          hint="Read from the chain now"
        />
        <StatCard label="Donated" value={usdcText(agent.totals?.donated ?? "0")} hint={`${usdcText(agent.totals?.donated ?? "0")} in ${donations} ${donations === 1 ? "donation" : "donations"}`} />
        <StatCard label="Given" value={usdcText(agent.totals?.given ?? "0")} hint={`${usdcText(agent.totals?.given ?? "0")} in ${gifts} ${gifts === 1 ? "gift" : "gifts"}`} />
        <StatCard label="Latest report" value={agent.latest ? `Epoch ${agent.latest.epoch}` : "None yet"} hint={agent.latest ? `Catalogue version ${agent.latest.catalogVersion}` : "The agent has not published one"} />
      </div>
      <p className="m-0 text-sm text-ink-muted">
        Vault <code className="break-all font-mono text-[13px] text-ink-soft">{agent.vault || "none"}</code>
      </p>
    </section>
  );
}

function ReportSection({
  agent,
  report,
  loading,
  error,
  epoch,
  region,
  root,
}: {
  agent: AgentInfo;
  report: AgentReport | null;
  loading: boolean;
  error: unknown;
  epoch: string | null;
  region?: string;
  root: string;
}) {
  const regions = useMemo(
    () => [...(report?.regions ?? [])].sort((a, b) => (REGION_ORDER.get(a.region) ?? 99) - (REGION_ORDER.get(b.region) ?? 99)),
    [report],
  );
  return (
    <section aria-label="Report" className={SECTION}>
      <h2 className={H2}>{epoch === null ? "Latest report" : `Report for epoch ${epoch}`}</h2>
      {epoch === null && <p className="m-0 text-sm text-ink-soft">No report published yet.</p>}
      {loading && (
        <div role="status" aria-label="Loading the report" className="grid grid-cols-1 gap-2">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}
      {Boolean(error) && <p role="alert">Could not load the report: {errorText(error)}</p>}
      {epoch !== null && !loading && !error && !report && <p role="alert">The report for epoch {epoch} is not available.</p>}
      {report && (
        <>
          {report.title && <h3 className="m-0 font-display text-xl font-semibold text-ink">{report.title}</h3>}
          {report.generatedAt && <p className="m-0 text-sm text-ink-muted">Written {report.generatedAt}. Catalogue version {report.catalogVersion}.</p>}
          {/* Intro headings nest under the nearest rendered heading: the title's h3, or the section's h2 without a title. */}
          {report.intro && <Markdown source={report.intro} baseLevel={report.title ? 3 : 2} />}
          <RegionLinks label={agent.label} current={region} root={root} />
          {region ? (
            <FocusedRegion report={report} region={region} label={agent.label} />
          ) : (
            <RegionTabs regions={regions} label={agent.label} epoch={report.epoch} root={root} />
          )}
        </>
      )}
    </section>
  );
}

/** Links to the per-region pages. */
function RegionLinks({ label, current, root }: { label: string; current?: string; root: string }) {
  const link = "inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold hover:bg-sand";
  return (
    <nav aria-label="Regions" className="flex flex-wrap items-center gap-1">
      {current ? (
        <a href={agentHref(root, label)} className={`${link} text-primary`}>
          All regions
        </a>
      ) : (
        <span className={`${link} bg-ink text-paper hover:bg-ink`}>All regions</span>
      )}
      {REGIONS.map((r) =>
        r.slug === current ? (
          <span key={r.slug} aria-current="page" className={`${link} bg-ink text-paper hover:bg-ink`}>
            {r.label}
          </span>
        ) : (
          <a key={r.slug} href={agentHref(root, label, r.slug)} className={`${link} text-primary`}>
            {r.label}
          </a>
        ),
      )}
    </nav>
  );
}

function FocusedRegion({ report, region, label }: { report: AgentReport; region: string; label: string }) {
  const r = regionReport(report, region);
  if (!r) return <p className="m-0 text-sm text-ink-soft">The agent published nothing for {regionName(region)} this week.</p>;
  return <AgentRegionView region={r} label={label} epoch={report.epoch} headingLevel={3} />;
}

/** One tab per region of the report (arrow keys, Home and End move between them). */
function RegionTabs({ regions, label, epoch, root }: { regions: AgentReport["regions"]; label: string; epoch: string; root: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (regions.length === 0) return <p className="m-0 text-sm text-ink-soft">This report has no regions.</p>;
  const value = regions.some((r) => r.region === selected) ? selected! : regions[0]!.region;
  return (
    <Tabs value={value} onValueChange={setSelected} variant="pill">
      <TabsList scrollable aria-label="Report regions" scrollLabels={{ previous: "Earlier regions", next: "More regions" }}>
        {regions.map((r) => (
          <TabsTrigger key={r.region} value={r.region}>
            {regionName(r.region)} ({r.picks.length})
          </TabsTrigger>
        ))}
      </TabsList>
      {regions.map((r) => (
        <TabsContent key={r.region} value={r.region} className="grid grid-cols-1 gap-3 outline-none">
          <AgentRegionView region={r} label={label} epoch={epoch} headingLevel={3} />
          <p className="m-0">
            <a href={agentHref(root, label, r.region)} className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline">
              Open the {regionName(r.region)} page
            </a>
          </p>
        </TabsContent>
      ))}
    </Tabs>
  );
}

function ReportArchive({ agent, epoch, onChoose }: { agent: AgentInfo; epoch: string | null; onChoose: (e: string) => void }) {
  return (
    <section aria-label="Report archive" className="grid grid-cols-1 gap-3">
      <h2 className={H2}>Report archive</h2>
      {agent.reports.length === 0 ? (
        <p className="m-0 text-sm text-ink-soft">No reports yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {agent.reports.map((r) => (
            <li key={r.epoch} className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant={r.epoch === epoch ? "ink" : "soft"} aria-pressed={r.epoch === epoch} onClick={() => onChoose(r.epoch)}>
                Epoch {r.epoch}
              </Button>
              {r.submittedAt !== undefined && <span className="num text-xs text-ink-muted">submitted {new Date(r.submittedAt * 1000).toISOString().replace(".000Z", "Z")}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** ERC-7930 interoperable address of an EVM contract, lowercase hex (as VaradaResolver builds it). */
export function erc7930(chainId: number, address: string): string {
  let ref = chainId.toString(16);
  if (ref.length % 2) ref = `0${ref}`;
  const len = (ref.length / 2).toString(16).padStart(2, "0");
  return `0x00010000${len}${ref}14${address.toLowerCase().replace(/^0x/, "")}`;
}

/** The agent's name on ENS and what its resolver answers for it (derived from the registry, as the resolver does). */
function AgentIdentity({ agent, ensName, gateway, chainId }: { agent: AgentInfo; ensName: string; gateway: string; chainId: number }) {
  const records = [
    { key: "description", value: agent.description },
    { key: "url", value: gateway, href: gateway },
    // ENSIP-25: the name attests this ERC-8004 identity (key = ERC-7930 address of the registry + agent id).
    { key: `agent-registration[${erc7930(chainId, ERC8004_IDENTITY_REGISTRY)}][${agent.agentId}]`, value: "1" },
    // ENSIP-26
    { key: "agent-endpoint[web]", value: gateway, href: gateway },
    { key: "agent-context", value: agent.description },
    { key: "varada.category", value: String(agent.categoryBit) },
  ];
  return (
    <EnsProfileCard
      name={ensName}
      description={agent.description || undefined}
      avatar={<CauseIcon cause={agentCause(agent.label)} size={72} decorative />}
      records={records}
      siteHref={gateway}
      wash="sage"
    />
  );
}

/**
 * The cause's biggest public on-chain donors this week: coins (Varada tokens' payouts) and any
 * wallet that donated directly to the cause's Endaoment orgs. A wallet shows its varada.eth name
 * when its primary name is one, else its address.
 */
function TopDonors({ board, loading, failed, cause, region, root }: { board: DonorBoard | null; loading: boolean; failed: boolean; cause: string; region?: string; root: string }) {
  const where = region ? `${cause} in ${region}` : cause;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const coins: ActivityItem[] = (board?.coins ?? []).map((c, i) => ({
    id: c.token,
    kind: "give",
    tag: `#${i + 1}`,
    title: (
      <a href={`${root}token/?address=${c.token}`} title={c.token} className="font-semibold text-primary underline-offset-4 hover:underline">
        {c.ensName ?? (c.symbol ? "$" + c.symbol : shortAddress(c.token))}
      </a>
    ),
    meta: `${plural(c.donations, "payout", "payouts")} to ${plural(c.orgs, "org", "orgs")}`,
    amount: usdcText(c.donated),
    amountTone: "cause",
  }));
  const wallets: ActivityItem[] = (board?.wallets ?? []).map((w, i) => ({
    id: w.address,
    kind: "give",
    tag: `#${i + 1}`,
    title: <span title={w.address}>{w.ensName ?? shortAddress(w.address)}</span>,
    meta: `${plural(w.donations, "donation", "donations")} to ${plural(w.orgs, "org", "orgs")}`,
    amount: usdcText(w.donated),
    amountTone: "cause",
  }));
  return (
    <section aria-label="Biggest donors this week" className={SECTION}>
      <h2 className={H2}>Biggest donors this week</h2>
      <p className="m-0 text-sm text-ink-soft">
        Public on-chain donations to {where} charities over the last 7 days. Coins give through their weekly and live payouts; wallets are any address that donated to these charities directly.
      </p>
      {loading && <Skeleton className="h-24 w-full" />}
      {failed && (
        <p role="alert" className="m-0 text-sm">
          Could not load the donor leaderboard.
        </p>
      )}
      {board && (
        <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-2 @4xl:items-start">
          <div className="grid grid-cols-1 gap-2">
            <h3 className="m-0 font-display text-lg font-semibold text-ink">Coins</h3>
            <ActivityList items={coins} label="Top donating coins" live={false} empty={<p className="m-0 text-sm text-ink-soft">No coin payouts this week.</p>} />
          </div>
          <div className="grid grid-cols-1 gap-2">
            <h3 className="m-0 font-display text-lg font-semibold text-ink">Wallets</h3>
            <ActivityList items={wallets} label="Top donating wallets" live={false} empty={<p className="m-0 text-sm text-ink-soft">No direct donations this week.</p>} />
          </div>
        </div>
      )}
    </section>
  );
}

/** Donations whose donors opted in to public credit. Anonymous donations never show an address. */
function CreditedDonors({ agent }: { agent: AgentInfo }) {
  const now = Date.now();
  const credited = agent.donors.filter((d): d is typeof d & { donor: string } => typeof d.donor === "string" && d.donor !== "");
  const items: ActivityItem[] = credited.map((d) => ({
    id: `${d.txHash}-${d.donor}`,
    kind: "give",
    tag: "Donor",
    title: <span title={d.donor}>{shortAddress(d.donor)}</span>,
    amount: usdcText(d.amount),
    amountTone: "cause",
    time: ago(d.timestamp, now),
    dateTime: iso(d.timestamp),
  }));
  return (
    <section aria-label="Credited donors" className={SECTION}>
      <h2 className={H2}>Credited donors</h2>
      <p className="m-0 text-sm text-ink-soft">Only donors who chose public credit are listed. Anonymous donations count in the totals above.</p>
      <ActivityList items={items} label="Credited donors" live={false} empty={<p className="m-0 text-sm text-ink-soft">No credited donors yet.</p>} />
    </section>
  );
}

function RecentGifts({ agent, report }: { agent: AgentInfo; report: AgentReport | null }) {
  const now = Date.now();
  const names = new Map<string, string>();
  for (const r of report?.regions ?? []) for (const p of r.picks) names.set(p.orgId.toLowerCase(), p.name);
  const items: ActivityItem[] = agent.gifts.map((g) => ({
    id: g.id || g.txHash,
    kind: "give",
    tag: "Gift",
    title: names.get(g.orgId.toLowerCase()) ?? shortAddress(g.org),
    meta: `${regionName(g.region)}, epoch ${g.epoch}`,
    amount: usdcText(g.amount),
    amountTone: "cause",
    time: ago(g.timestamp, now),
    dateTime: iso(g.timestamp),
  }));
  return (
    <section aria-label="Recent gifts" className={SECTION}>
      <h2 className={H2}>Recent gifts</h2>
      <ActivityList items={items} label="Recent gifts" live={false} empty={<EmptyState size="compact" title="No gifts yet" body="Gifts appear here when the agent pays a charity from its vault." />} />
    </section>
  );
}
