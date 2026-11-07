"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { CATEGORIES } from "@varada/sdk";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Checkbox } from "@varada/ui/components/ui/checkbox";
import { Check, Flame, Globe, MapIcon, Plus } from "@varada/ui/components/ui/icons";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { CauseChip } from "@varada/ui/components/varada/cause-chip";
import { CauseIcon } from "@varada/ui/components/varada/cause-icon";
import { cn } from "@varada/ui/lib/utils";
import { agentCause, agentHref, regionName } from "@/components/agent-common";
import { RegionGlobe } from "@/components/donate/region-globe";
import { SplitDonate, type SplitTarget } from "@/components/donate/split-donate";
import { useRel } from "@/components/nav";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import { formatUsdc, getAgentReport, listAgents, type AgentReport } from "@/lib/agents";
import { causesQueryString } from "@/lib/causes-client";
import {
  AMOUNT_PRESETS,
  MAX_SPLIT,
  chosenCauses,
  donateQueryString,
  heatWord,
  parseDonateQuery,
  placeList,
  rankTrending,
  regionsInScope,
  splitAmount,
  trendingPicks,
  type CauseTrend,
} from "@/lib/just-donate";
import { parseUsdcInput } from "@/lib/vault";
import { MAP_REGIONS, type MapRegion } from "@/lib/world-dots";

const HEAT_TONE = { Urgent: "live", Rising: "rwa", Steady: "cause", Quiet: "outline" } as const;
const causeLabel = (slug: string) => CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;

function Kicker({ children }: { children: React.ReactNode }) {
  return <span className="kicker">{children}</span>;
}

/**
 * "Just donate": an amount, optionally places (globe, map or buttons) and up to three causes, and
 * the gift goes to the causes' curator vaults. Without a choice of cause it goes to the cause the
 * curators rate most urgent for the picked places this week. Trending causes and charities come
 * from the agents' newest reports (urgency per region, ranked picks); their text is LLM-written
 * from untrusted news, so it is rendered as plain text. State lives in the URL
 * (`?amount=&region=&cause=`), so a gift can be linked to.
 */
export function JustDonate() {
  const config = useAppConfig();
  const deps = useDeps();
  const rel = useRel();
  const amountId = useId();
  const whereId = useId();
  const [amount, setAmount] = useState("25");
  const [picked, setPicked] = useState<MapRegion[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [view, setView] = useState<"globe" | "map">("globe");
  const [credit, setCredit] = useState(false);
  const [ready, setReady] = useState(false);

  // Statically exported: the query string is only known in the browser.
  useEffect(() => {
    const q = parseDonateQuery(window.location.search);
    if (q.amount) setAmount(q.amount);
    setPicked(q.regions.filter((r): r is MapRegion => (MAP_REGIONS as readonly string[]).includes(r)));
    setChosen(q.causes);
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const next = `${window.location.pathname}${donateQueryString({ amount, regions: picked, causes: chosen })}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", next);
  }, [amount, picked, chosen, ready]);

  const agents = useQuery({ queryKey: ["agents"], queryFn: () => listAgents(deps.indexer), retry: false, staleTime: 300_000 });
  const withReports = (agents.data ?? []).filter((a) => a.latest);
  const reportQueries = useQueries({
    queries: withReports.map((a) => ({
      queryKey: ["agent-report", a.label, a.latest!.epoch],
      queryFn: () => getAgentReport(deps.indexer, a.label, a.latest!.epoch),
      retry: false,
      staleTime: 300_000,
    })),
  });
  const reportsReady = reportQueries.every((q) => !q.isLoading);
  // One string that changes when any report (or the set of agents) does, so the map is rebuilt only then.
  const reportsKey = withReports.map((a, i) => `${a.label}:${reportQueries[i]?.dataUpdatedAt ?? 0}`).join(",");
  const reports = useMemo(() => {
    const m = new Map<string, AgentReport | null>();
    withReports.forEach((a, i) => m.set(a.label, reportQueries[i]?.data ?? null));
    return m;
  }, [reportsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const trends = useMemo(() => rankTrending(agents.data ?? [], reports, picked), [agents.data, reports, picked]);
  const shownTrends = trends.slice(0, 6);
  const picks = useMemo(() => trendingPicks(trends.slice(0, 6), reports, picked, 6), [trends, reports, picked]);
  const gift = chosenCauses(trends, chosen);

  const pool = useQuery({
    queryKey: ["catalog-pool", gift.map((g) => g.slug).join(","), picked.join(",")],
    queryFn: () => deps.indexer.catalogPool(gift.map((g) => g.slug), regionsInScope(picked)),
    enabled: gift.length > 0,
    retry: false,
    staleTime: 300_000,
  });

  const parsed = parseUsdcInput(amount);
  const shares = parsed.ok ? splitAmount(parsed.amount, gift.length) : [];
  const targets: SplitTarget[] = gift.map((g, i) => ({ categoryBit: g.agent.categoryBit, vault: g.agent.vault, name: g.agent.name, amount: shares[i] ?? 0n }));
  const place = placeList(picked);

  const toggleRegion = (r: MapRegion) => setPicked((p) => (p.includes(r) ? p.filter((x) => x !== r) : [...p, r]));
  const toggleCause = (slug: string) =>
    setChosen((c) => {
      if (c.includes(slug)) return c.filter((x) => x !== slug);
      // The first manual pick keeps the trending pick the gift already showed, and adds to it.
      const base = c.length === 0 && gift[0] ? [gift[0].slug] : c;
      if (base.includes(slug)) return base;
      return base.length >= MAX_SPLIT ? base : [...base, slug];
    });

  const catalogueHref = `${rel("causes/")}${causesQueryString({ q: "", categories: gift.map((g) => g.slug), regions: picked })}#catalogue`;

  return (
    <div className="flex flex-col gap-12 pb-6">
      <section aria-labelledby="jd-h" className="@container grid grid-cols-1 gap-7 rounded-[32px] border border-line bg-card p-5 shadow-paper @4xl:grid-cols-2 @lg:p-8">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-3">
            <Kicker>Just donate</Kicker>
            <h1 id="jd-h" className="m-0 font-display text-4xl font-semibold leading-[1.04] @md:text-[56px]">
              Give where it&apos;s needed this week
            </h1>
            <p className="m-0 max-w-[34em] text-[17px] leading-relaxed text-ink-soft">
              Choose an amount, and a place on the globe if you like. Varada&apos;s curator agents read the week&apos;s news, rank the charities that can help most, and give your USDC to them on chain.
            </p>
          </div>

          <div className="flex flex-col gap-2.5">
            <label htmlFor={amountId} className="text-sm font-semibold text-ink">
              Amount
            </label>
            <InputGroup className="h-16 rounded-[18px]">
              <InputAddon className="font-display text-3xl text-ink-muted">$</InputAddon>
              <Input
                id={amountId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                className="num h-full text-3xl font-semibold"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={!parsed.ok && amount !== ""}
                aria-describedby={`${amountId}-hint`}
              />
              <InputAddon className="text-sm font-semibold">USDC</InputAddon>
            </InputGroup>
            <div role="group" aria-label="Amount presets" className="flex flex-wrap gap-2">
              {AMOUNT_PRESETS.map((p) => {
                const on = amount === String(p);
                return (
                  <Button key={p} type="button" size="sm" variant={on ? "cause" : "outline"} aria-pressed={on} className="num min-h-11 px-4" onClick={() => setAmount(String(p))}>
                    ${p}
                  </Button>
                );
              })}
            </div>
            <p id={`${amountId}-hint`} className={cn("m-0 text-[13px]", parsed.ok || amount === "" ? "text-ink-muted" : "text-terracotta-strong")}>
              {parsed.ok || amount === "" ? "Whole or decimal amounts, up to 6 decimals." : parsed.error}
            </p>
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span id={whereId} className="text-sm font-semibold text-ink">
                Where
              </span>
              <span className="text-[13px] text-ink-muted">Pick on the globe or here</span>
            </div>
            <div role="group" aria-labelledby={whereId} className="flex flex-wrap gap-2">
              <RegionButton label="Everywhere" on={picked.length === 0} onClick={() => setPicked([])} />
              {MAP_REGIONS.map((r) => (
                <RegionButton key={r} label={regionName(r)} dot on={picked.includes(r)} onClick={() => toggleRegion(r)} />
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3.5 rounded-[22px] bg-sand p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="m-0 font-display text-[22px] font-semibold">Your gift</h2>
              <span className="text-[13px] text-ink-soft">
                {chosen.length > 0 ? `Split evenly across ${gift.length} cause${gift.length === 1 ? "" : "s"}` : `Trending pick for ${place}`}
              </span>
            </div>
            {agents.isLoading || (!reportsReady && chosen.length === 0) ? (
              <Skeleton className="h-14 rounded-2xl" />
            ) : agents.error ? (
              <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-terracotta-tint px-3 py-2 text-sm text-terracotta-strong">
                <span>Could not load the curator agents: {errorText(agents.error)}</span>
                <Button size="sm" variant="outline" onClick={() => void agents.refetch()}>
                  Retry
                </Button>
              </div>
            ) : gift.length === 0 ? (
              <p className="m-0 rounded-xl bg-paper-card px-3 py-2 text-sm text-ink-soft">No curator vault is taking donations yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Where your gift goes">
                {gift.map((g, i) => (
                  <li key={g.slug} className="flex items-center gap-3 rounded-2xl bg-paper-card px-3 py-2.5">
                    <CauseIcon cause={agentCause(g.agent.label)} size={36} decorative />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[15px] font-semibold text-ink">{g.agent.name}</span>
                      <span className="truncate text-[13px] text-ink-muted">{g.agent.ensName}</span>
                    </span>
                    <span className="num text-[15px] font-semibold">{shares[i] !== undefined ? `$${formatUsdc(shares[i]!)}` : "—"}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-start gap-3">
              <Checkbox id="jd-credit" tone="cause" checked={credit} onCheckedChange={(v) => setCredit(v === true)} aria-label="Credit me publicly" />
              <label htmlFor="jd-credit" className="text-sm text-ink">
                Credit me publicly
                <span className="block text-ink-soft">Unchecked, your address is never listed on this site. It is still visible on chain, like any transaction.</span>
              </label>
            </div>
            <SplitDonate targets={targets} credit={credit} invalid={amount !== "" && !parsed.ok ? parsed.error : amount === "" ? "Enter an amount" : undefined} />
            <p className="m-0 text-[13px] leading-normal text-ink-soft">
              {gift.length > 1
                ? `Your wallet asks up to ${gift.length * 2} times: approve, then donate, for each cause.`
                : "Two wallet steps at most: approve, then donate."}{" "}
              {pool.data ? (
                <>
                  The curators give it on to charities they rank among{" "}
                  <a href={catalogueHref} className="font-semibold text-ink underline underline-offset-4">
                    {pool.data.toLocaleString("en-US")} in the catalogue
                  </a>{" "}
                  for {place}.
                </>
              ) : (
                `The curators give it on to the charities they rank for ${place}.`
              )}
            </p>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Kicker>Where · {place}</Kicker>
            <div role="group" aria-label="Globe or map" className="inline-flex rounded-full bg-sand p-1">
              <ViewButton on={view === "globe"} onClick={() => setView("globe")} icon={<Globe aria-hidden="true" />} label="Globe" />
              <ViewButton on={view === "map"} onClick={() => setView("map")} icon={<MapIcon aria-hidden="true" />} label="Map" />
            </div>
          </div>
          <div className={cn("mx-auto w-full", view === "globe" ? "max-w-[560px]" : "rounded-[22px] bg-sand p-4")}>
            <RegionGlobe picked={picked} onToggle={toggleRegion} view={view} />
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-2 text-[13px] text-ink-soft">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true" className="size-2.5 rounded-full bg-sage" />
              Picked
              <span aria-hidden="true" className="ml-2 size-2.5 rounded-full bg-line-strong" />
              Not picked
            </span>
            <span>{view === "globe" ? "Drag to turn · click a continent to add it" : "Click a continent to add it"}</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="tr-h" className="@container flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="flex flex-col gap-1">
            <Kicker>Trending this week</Kicker>
            <h2 id="tr-h" className="m-0 font-display text-2xl font-semibold @lg:text-3xl">
              Most urgent causes in {place}
            </h2>
          </div>
          <p className="m-0 max-w-[30em] text-sm text-ink-soft">Ranked by each curator&apos;s urgency for the places you picked. Add up to {MAX_SPLIT} to split your gift.</p>
        </div>
        {agents.isLoading || !reportsReady ? (
          <div className="grid grid-cols-1 gap-3.5 @xl:grid-cols-2 @4xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-44 rounded-[22px]" />
            ))}
          </div>
        ) : shownTrends.length === 0 ? (
          <p className="m-0 rounded-2xl border border-line bg-card px-4 py-3 text-sm text-ink-soft">No curator agent is taking donations yet.</p>
        ) : (
          <ol className="m-0 grid list-none grid-cols-1 gap-3.5 p-0 @xl:grid-cols-2 @4xl:grid-cols-3">
            {shownTrends.map((t, i) => (
              <TrendCard
                key={t.slug}
                trend={t}
                rank={i + 1}
                inGift={gift.includes(t)}
                full={chosen.length >= MAX_SPLIT && !chosen.includes(t.slug)}
                onToggle={() => toggleCause(t.slug)}
                agentLink={agentHref(rel(""), t.agent.label, t.hottest ?? undefined)}
                chosenByVisitor={chosen.includes(t.slug)}
              />
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="pk-h" className="@container flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="flex flex-col gap-1">
            <Kicker>Where it lands</Kicker>
            <h2 id="pk-h" className="m-0 font-display text-2xl font-semibold @lg:text-3xl">
              Charities the curators are backing
            </h2>
          </div>
          <a href={catalogueHref} className="text-sm font-semibold text-ink underline-offset-4 hover:underline">
            Browse every charity{picked.length ? ` in ${place}` : ""}
          </a>
        </div>
        {agents.isLoading || !reportsReady ? (
          <div className="grid grid-cols-1 gap-3.5 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-36 rounded-[20px]" />
            ))}
          </div>
        ) : picks.length === 0 ? (
          <p className="m-0 rounded-2xl border border-line bg-card px-4 py-3 text-sm text-ink-soft">
            The curators have not published picks for {place} this week yet. Gifts wait in their vaults until they do.
          </p>
        ) : (
          <ul className="m-0 grid list-none grid-cols-1 gap-3.5 p-0 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {picks.map((p) => (
              <li key={`${p.agentLabel}-${p.orgId}`} className="flex min-w-0 flex-col gap-2.5 rounded-[20px] border border-line bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="m-0 font-display text-lg font-semibold leading-snug [overflow-wrap:anywhere]">{p.name}</h3>
                  <span className="num shrink-0 rounded-lg bg-sage-tint px-2 py-1 text-[13px] font-semibold text-sage-ink" title="The curator's score, 0 to 100">
                    {p.score}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <CauseChip cause={agentCause(p.agentLabel)} label={causeLabel(p.causeSlug)} size="sm" />
                  <Badge tone="neutral" shape="pill">
                    {regionName(p.region)}
                  </Badge>
                </div>
                {p.reasons && <p className="m-0 line-clamp-3 text-sm leading-normal text-ink-soft">{p.reasons}</p>}
                <a href={agentHref(rel(""), p.agentLabel, p.region)} className="mt-auto text-[13px] text-ink-muted underline-offset-4 hover:underline">
                  Ranked by {p.agentLabel}.agent · see the picks and proofs
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="hw-h" className="@container flex flex-col gap-5 rounded-[28px] bg-ink p-6 text-paper @lg:p-8">
        <h2 id="hw-h" className="m-0 font-display text-[28px] font-semibold text-paper">
          How a gift travels
        </h2>
        <ol className="m-0 grid list-none grid-cols-1 gap-5 p-0 @2xl:grid-cols-3">
          {[
            ["You give USDC", "Approve and donate from your wallet, once per cause. Anonymous on this site unless you ask to be credited."],
            ["It waits in the curator's vault", "Each cause has an agent vault. It can only give to catalogue charities in its own cause, and nothing can be withdrawn."],
            ["The curator gives it on", "Every week it ranks charities by region and sends gifts through Endaoment. Each pick is proven against a root on chain."],
          ].map(([title, body], i) => (
            <li key={title} className="flex flex-col gap-2">
              <span className="num font-semibold text-ochre">{String(i + 1).padStart(2, "0")}</span>
              <span className="text-[17px] font-semibold">{title}</span>
              <span className="text-sm leading-relaxed text-paper/80">{body}</span>
            </li>
          ))}
        </ol>
        <p className="m-0 text-[13px] text-paper/70">
          Curator vaults on {config.ensParentName}: one agent per cause, each with its own page, reports and donors.
        </p>
      </section>
    </div>
  );
}

function RegionButton({ label, on, dot, onClick }: { label: string; on: boolean; dot?: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-full border-[1.5px] px-4 text-sm font-semibold transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35",
        on ? "border-sage bg-sage text-[#f7f3e8] dark:text-paper" : "border-line-strong bg-card text-ink hover:bg-sand",
      )}
    >
      {dot && <span aria-hidden="true" className={cn("size-2 rounded-full", on ? "bg-current" : "bg-sage/70")} />}
      {label}
    </button>
  );
}

function ViewButton({ on, onClick, icon, label }: { on: boolean; onClick(): void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-ink outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/35 [&_svg]:size-4",
        on ? "bg-card shadow-paper" : "hover:bg-line/60",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function TrendCard({
  trend: t,
  rank,
  inGift,
  chosenByVisitor,
  full,
  onToggle,
  agentLink,
}: {
  trend: CauseTrend;
  rank: number;
  inGift: boolean;
  chosenByVisitor: boolean;
  full: boolean;
  onToggle(): void;
  agentLink: string;
}) {
  const heat = heatWord(t.weight);
  return (
    <li className={cn("flex min-w-0 flex-col gap-3 rounded-[22px] border-[1.5px] p-4 transition-colors", inGift ? "border-sage bg-sage-tint/50" : "border-line bg-card")}>
      <div className="flex items-center gap-3">
        <span className="num w-6 text-[13px] font-semibold text-ink-muted">{String(rank).padStart(2, "0")}</span>
        <CauseIcon cause={agentCause(t.agent.label)} size={44} decorative />
        <span className="min-w-0 flex-1 text-base font-semibold leading-tight text-ink">{t.agent.name}</span>
        <Badge tone={HEAT_TONE[heat]} shape="pill" className="shrink-0">
          {heat === "Urgent" && <Flame aria-hidden="true" />}
          {heat}
        </Badge>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sand" role="meter" aria-label={`Urgency for ${t.agent.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(t.weight / 100)}>
        <div
          className={cn("h-full rounded-full", heat === "Urgent" ? "bg-terracotta" : heat === "Rising" ? "bg-ochre" : "bg-sage")}
          style={{ width: `${Math.max(2, Math.round(t.weight / 100))}%` }}
        />
      </div>
      <p className="m-0 line-clamp-3 text-sm leading-normal text-ink-soft">{t.summary || t.agent.description || "No report for these places yet this week."}</p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <a href={agentLink} className="text-[13px] text-ink-muted underline-offset-4 hover:underline">
          {t.hottest ? `Hottest: ${regionName(t.hottest)}` : "Curator agent"}
          <span className="sr-only"> · {t.agent.name} curator</span>
        </a>
        <Button type="button" size="sm" variant={inGift ? "cause" : "outline"} aria-pressed={chosenByVisitor} disabled={full} onClick={onToggle} className="min-h-10">
          {inGift ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
          {chosenByVisitor ? "In your gift" : inGift ? "Trending pick" : full ? `${MAX_SPLIT} max` : "Add to gift"}
        </Button>
      </div>
    </li>
  );
}
