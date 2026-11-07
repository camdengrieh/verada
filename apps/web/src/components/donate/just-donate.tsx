"use client";

import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CATEGORIES, causeIdOfOrg } from "@varada/sdk";
import type { Hex } from "viem";
import { FlipWords } from "@varada/ui/components/motion/flip-words";
import { Marquee } from "@varada/ui/components/motion/marquee";
import { NumberTicker } from "@varada/ui/components/motion/number-ticker";
import { ScrollReveal } from "@varada/ui/components/motion/scroll-reveal";
import { SpotlightCard } from "@varada/ui/components/motion/spotlight-card";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Checkbox } from "@varada/ui/components/ui/checkbox";
import { Check, Flame, Globe, HandHeart, MapIcon, Plus, Search, X } from "@varada/ui/components/ui/icons";
import { Input, InputAddon, InputGroup } from "@varada/ui/components/ui/input";
import { Skeleton } from "@varada/ui/components/ui/skeleton";
import { CauseChip } from "@varada/ui/components/varada/cause-chip";
import { CauseIcon } from "@varada/ui/components/varada/cause-icon";
import { cn } from "@varada/ui/lib/utils";
import { agentCause, agentHref, regionName } from "@/components/agent-common";
import { useDebounced } from "@/components/catalog-browser";
import { DepositAddress } from "@/components/donate/deposit-address";
import { DirectDonate } from "@/components/donate/direct-donate";
import { RegionGlobe } from "@/components/donate/region-globe";
import { SplitDonate, type SplitTarget } from "@/components/donate/split-donate";
import { useRel } from "@/components/nav";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText } from "@/components/use-tx";
import { formatUsdc, getAgentReport, listAgents, type AgentReport } from "@/lib/agents";
import { causesQueryString } from "@/lib/causes-client";
import type { CatalogOrg } from "@/lib/indexer";
import {
  AMOUNT_PRESETS,
  MAX_SPLIT,
  chosenCauses,
  donateQueryString,
  featuredPicks,
  heatWord,
  parseDonateQuery,
  placeList,
  rankTrending,
  regionsInScope,
  splitAmount,
  type CauseTrend,
  type TrendingPick,
} from "@/lib/just-donate";
import { orgEnsName } from "@/lib/org-donate";
import { parseUsdcInput } from "@/lib/vault";
import { MAP_REGIONS, type MapRegion } from "@/lib/world-dots";

const HEAT_TONE = { Urgent: "live", Rising: "rwa", Steady: "cause", Quiet: "outline" } as const;
const causeLabel = (slug: string) => CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
const causeArt = (slug: string) => agentCause(CATEGORIES.find((x) => x.slug === slug)?.ensLabel ?? "other");
const SEARCH_PAGE = 12;
const isOrgId = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s);

/** The charity picked for a direct gift: catalogue data when we have it. */
type Charity = Pick<CatalogOrg, "orgId" | "name"> & Partial<Pick<CatalogOrg, "ethOrgId" | "label" | "categories" | "regions" | "country" | "state">>;

function Kicker({ children }: { children: React.ReactNode }) {
  return <span className="kicker">{children}</span>;
}

/**
 * "Just donate": an amount, optionally places (globe, map or buttons), and where it goes: through
 * the curator agents (up to three causes; without a choice, the cause they rate most urgent for the
 * places this week), or straight to one charity, picked from the curators' featured picks across
 * causes and regions or from a search of the whole catalogue. Every destination shows its ENS name
 * and deposit address with copy buttons. Trending causes and picks come from the agents' newest
 * reports; their text is LLM-written from untrusted news, so it is rendered as plain text. State
 * lives in the URL (`?amount=&region=&cause=&org=`), so a gift can be linked to.
 */
export function JustDonate() {
  const config = useAppConfig();
  const deps = useDeps();
  const rel = useRel();
  const amountId = useId();
  const whereId = useId();
  const searchId = useId();
  const giftRef = useRef<HTMLHeadingElement>(null);
  const [amount, setAmount] = useState("25");
  const [picked, setPicked] = useState<MapRegion[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [charity, setCharity] = useState<Charity | null>(null);
  const [mode, setMode] = useState<"curators" | "charity">("curators");
  const [view, setView] = useState<"globe" | "map">("globe");
  const [credit, setCredit] = useState(false);
  const [ready, setReady] = useState(false);
  const [linkedOrg, setLinkedOrg] = useState("");
  const [qInput, setQInput] = useState("");
  const [searchAll, setSearchAll] = useState(false);

  // Statically exported: the query string is only known in the browser.
  useEffect(() => {
    const q = parseDonateQuery(window.location.search);
    if (q.amount) setAmount(q.amount);
    setPicked(q.regions.filter((r): r is MapRegion => (MAP_REGIONS as readonly string[]).includes(r)));
    setChosen(q.causes);
    if (q.org) {
      setLinkedOrg(q.org);
      setMode("charity");
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const org = mode === "charity" ? (charity?.orgId ?? linkedOrg) : "";
    const next = `${window.location.pathname}${donateQueryString({ amount, regions: picked, causes: chosen, org })}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", next);
  }, [amount, picked, chosen, ready, mode, charity, linkedOrg]);

  // A charity linked by org id: its catalogue record.
  const linked = useQuery({
    queryKey: ["catalog-org", linkedOrg],
    queryFn: () => deps.indexer.catalogOrg(linkedOrg),
    enabled: Boolean(linkedOrg) && !charity,
    retry: false,
    staleTime: 600_000,
  });
  useEffect(() => {
    if (linked.data?.org && !charity) setCharity(linked.data.org);
  }, [linked.data, charity]);

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
  const featured = useMemo(() => featuredPicks(trends, reports, picked, 9), [trends, reports, picked]);
  const gift = chosenCauses(trends, chosen);

  // Catalogue records (ENS labels, places) for the featured picks.
  const featuredIds = featured.filter((p) => isOrgId(p.orgId)).map((p) => causeIdOfOrg(p.orgId as Hex));
  const featuredOrgs = useQuery({
    queryKey: ["catalog-causes", featuredIds.join(",")],
    queryFn: () => deps.indexer.catalogCauses(featuredIds),
    enabled: featuredIds.length > 0,
    retry: false,
    staleTime: 600_000,
  });
  const recordOf = (p: TrendingPick) => (isOrgId(p.orgId) ? featuredOrgs.data?.get(causeIdOfOrg(p.orgId as Hex).toLowerCase()) : undefined);

  const pool = useQuery({
    queryKey: ["catalog-pool", gift.map((g) => g.slug).join(","), picked.join(",")],
    queryFn: () => deps.indexer.catalogPool(gift.map((g) => g.slug), regionsInScope(picked)),
    enabled: gift.length > 0,
    retry: false,
    staleTime: 300_000,
  });

  // Search of the whole catalogue: by name, ENS label or EIN, within the picked places and causes.
  const q = useDebounced(qInput.trim());
  const searchCategories = searchAll ? [] : chosen;
  const searchRegions = searchAll ? [] : picked;
  const search = useInfiniteQuery({
    queryKey: ["donate-search", q, searchCategories.join(","), searchRegions.join(",")],
    queryFn: ({ pageParam }) => deps.indexer.catalogSearch({ q, categories: searchCategories, regions: searchRegions, offset: pageParam, limit: SEARCH_PAGE }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const seen = all.reduce((n, p) => n + (p?.items.length ?? 0), 0);
      return last && seen < last.total ? seen : undefined;
    },
    enabled: ready,
    retry: false,
    staleTime: 120_000,
  });
  const results = (search.data?.pages ?? []).flatMap((p) => p?.items ?? []);
  const resultTotal = search.data?.pages[0]?.total;

  const parsed = parseUsdcInput(amount);
  const shares = parsed.ok ? splitAmount(parsed.amount, gift.length) : [];
  const targets: SplitTarget[] = gift.map((g, i) => ({ categoryBit: g.agent.categoryBit, vault: g.agent.vault, name: g.agent.name, amount: shares[i] ?? 0n }));
  const place = placeList(picked);
  const amountError = amount !== "" && !parsed.ok ? parsed.error : amount === "" ? "Enter an amount" : undefined;

  const toggleRegion = (r: MapRegion) => setPicked((p) => (p.includes(r) ? p.filter((x) => x !== r) : [...p, r]));
  const toggleCause = (slug: string) => {
    setMode("curators");
    setChosen((c) => {
      if (c.includes(slug)) return c.filter((x) => x !== slug);
      // The first manual pick keeps the trending pick the gift already showed, and adds to it.
      const base = c.length === 0 && gift[0] ? [gift[0].slug] : c;
      if (base.includes(slug)) return base;
      return base.length >= MAX_SPLIT ? base : [...base, slug];
    });
  };
  const giveTo = (c: Charity) => {
    setCharity(c);
    setLinkedOrg("");
    setMode("charity");
    giftRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    giftRef.current?.focus({ preventScroll: true });
  };

  const catalogueHref = `${rel("causes/")}${causesQueryString({ q: "", categories: gift.map((g) => g.slug), regions: picked })}#catalogue`;
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });

  return (
    <div className="flex flex-col gap-12 pb-6">
      <section aria-labelledby="jd-h" className="@container grid grid-cols-1 gap-7 rounded-[32px] border border-line bg-card p-5 shadow-paper @4xl:grid-cols-2 @lg:p-8">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-3">
            <Kicker>Just donate</Kicker>
            <h1 id="jd-h" className="m-0 font-display text-4xl font-semibold leading-[1.04] @md:text-[56px]">
              Give where it&apos;s needed this week
            </h1>
            {shownTrends.length > 1 && (
              <p className="m-0 font-display text-2xl text-ink-soft">
                Most urgent now: <FlipWords words={shownTrends.slice(0, 5).map((t) => t.agent.name.toLowerCase())} className="font-semibold text-ink" />
              </p>
            )}
            <p className="m-0 max-w-[34em] text-[17px] leading-relaxed text-ink-soft">
              Choose an amount, and a place on the globe if you like. Let Varada&apos;s curator agents route it to the charities they rank most urgent, or give it
              straight to one charity yourself. Every gift is USDC on chain.
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 ref={giftRef} tabIndex={-1} className="m-0 scroll-mt-24 font-display text-[22px] font-semibold outline-none">
                Your gift
              </h2>
              <div role="group" aria-label="Give through" className="inline-flex rounded-full bg-paper-card p-1">
                <ViewButton on={mode === "curators"} onClick={() => setMode("curators")} label="Curators" />
                <ViewButton on={mode === "charity"} onClick={() => setMode("charity")} label="One charity" />
              </div>
            </div>

            {mode === "curators" ? (
              <>
                <p className="m-0 text-[13px] text-ink-soft">
                  {chosen.length > 0 ? `Split evenly across ${gift.length} cause${gift.length === 1 ? "" : "s"}.` : `The trending pick for ${place}.`} Each curator gives it on to
                  the charities it ranks this week.
                </p>
                {agents.isLoading || (!reportsReady && chosen.length === 0) ? (
                  <Skeleton className="h-20 rounded-2xl" />
                ) : agents.error ? (
                  <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-terracotta-tint px-3 py-2 text-sm text-terracotta-strong">
                    <span>Could not load the curator agents: {errorText(agents.error)}</span>
                    <Button size="sm" variant="outline" onClick={() => void agents.refetch()}>
                      Retry
                    </Button>
                  </div>
                ) : gift.length === 0 ? (
                  <p className="m-0 rounded-xl bg-paper-card px-3 py-2 text-sm text-ink-soft">No curator vault is taking donations yet. You can still give to one charity.</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Where your gift goes">
                    {gift.map((g, i) => (
                      <li key={g.slug} className="flex flex-col gap-2 rounded-2xl bg-paper-card px-3 py-2.5">
                        <div className="flex items-center gap-3">
                          <CauseIcon cause={agentCause(g.agent.label)} size={36} decorative />
                          <span className="min-w-0 flex-1 text-[15px] font-semibold text-ink">{g.agent.name}</span>
                          <span className="num text-[15px] font-semibold">{shares[i] !== undefined ? `$${formatUsdc(shares[i]!)}` : "—"}</span>
                        </div>
                        {g.agent.vault && <DepositAddress address={g.agent.vault} name={g.agent.ensName || null} chainId={config.chainId} label={`${g.agent.name} curator vault`} />}
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
                <SplitDonate targets={targets} credit={credit} invalid={amountError} />
                <p className="m-0 text-[13px] leading-normal text-ink-soft">
                  {gift.length > 1 ? `Your wallet asks up to ${gift.length * 2} times: approve, then donate, for each cause.` : "Two wallet steps at most: approve, then donate."}{" "}
                  {pool.data ? (
                    <>
                      The curators choose among{" "}
                      <a href={catalogueHref} className="font-semibold text-ink underline underline-offset-4">
                        <NumberTicker value={pool.data} /> charities in the catalogue
                      </a>{" "}
                      for {place}.
                    </>
                  ) : null}
                </p>
              </>
            ) : charity ? (
              <>
                <div className="flex flex-col gap-2 rounded-2xl bg-paper-card px-3.5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="m-0 font-display text-lg font-semibold leading-snug [overflow-wrap:anywhere]">{charity.name}</h3>
                    <Button type="button" size="icon-sm" variant="ghost" onClick={() => setCharity(null)} aria-label={`Choose another charity instead of ${charity.name}`}>
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                  {(charity.categories?.length || charity.regions?.length) ? (
                    <div className="flex flex-wrap gap-1.5">
                      {charity.categories?.slice(0, 2).map((c) => <CauseChip key={c} cause={causeArt(c)} label={causeLabel(c)} size="sm" />)}
                      {charity.regions?.slice(0, 3).map((r) => (
                        <Badge key={r} tone="neutral" shape="pill">
                          {regionName(r)}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <DirectDonate key={charity.orgId} org={charity} amount={parsed.ok ? parsed.amount : null} invalid={amountError} />
                </div>
                <p className="m-0 text-[13px] leading-normal text-ink-soft">One gift, straight to the charity&apos;s Endaoment account: approve, then donate. No curator in between.</p>
              </>
            ) : linkedOrg && linked.isLoading ? (
              <Skeleton className="h-28 rounded-2xl" />
            ) : (
              <div className="flex flex-col gap-3 rounded-2xl bg-paper-card px-3.5 py-3">
                <p className="m-0 text-sm text-ink-soft">
                  {linkedOrg && linked.isFetched && !linked.data ? "That charity is not in the catalogue. " : ""}Pick a charity the curators feature, or search every charity in the
                  catalogue.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="soft" size="sm" onClick={() => scrollTo("featured")}>
                    Featured charities
                  </Button>
                  <Button type="button" variant="soft" size="sm" onClick={() => scrollTo("search")}>
                    <Search aria-hidden="true" />
                    Search
                  </Button>
                </div>
              </div>
            )}
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

      {shownTrends.length > 0 && featured.length > 0 && (
        <div className="-mx-4 flex flex-col gap-2 overflow-hidden md:mx-0 md:rounded-2xl md:border md:border-line md:bg-card md:py-2">
          <Marquee label="Trending causes this week" duration={38} gap="0.75rem" fade>
            {shownTrends.map((t) => (
              <span key={t.slug} className="inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-sand py-1 pl-1 pr-3 text-sm font-semibold text-ink">
                <CauseIcon cause={agentCause(t.agent.label)} size={24} decorative />
                {t.agent.name}
                <span className="text-xs font-normal text-ink-muted">{heatWord(t.weight)}</span>
              </span>
            ))}
          </Marquee>
          <Marquee label="Charities the curators feature" direction="right" duration={44} gap="0.75rem" fade>
            {featured.map((p) => (
              <span key={`${p.agentLabel}-${p.orgId}`} className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-line px-3 py-1 text-sm text-ink-soft">
                <span className="font-semibold text-ink">{p.name}</span>
                <span className="text-xs">{regionName(p.region)}</span>
              </span>
            ))}
          </Marquee>
        </div>
      )}

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
          <ScrollReveal>
          <ol className="m-0 grid list-none grid-cols-1 gap-3.5 p-0 @xl:grid-cols-2 @4xl:grid-cols-3">
            {shownTrends.map((t, i) => (
              <TrendCard
                key={t.slug}
                trend={t}
                rank={i + 1}
                inGift={mode === "curators" && gift.includes(t)}
                full={chosen.length >= MAX_SPLIT && !chosen.includes(t.slug)}
                onToggle={() => toggleCause(t.slug)}
                agentLink={agentHref(rel(""), t.agent.label, t.hottest ?? undefined)}
                chosenByVisitor={mode === "curators" && chosen.includes(t.slug)}
              />
            ))}
          </ol>
          </ScrollReveal>
        )}
      </section>

      <section id="featured" aria-labelledby="ft-h" className="@container flex scroll-mt-24 flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="flex flex-col gap-1">
            <Kicker>Featured by the curators</Kicker>
            <h2 id="ft-h" className="m-0 font-display text-2xl font-semibold @lg:text-3xl">
              Charities to give to directly
            </h2>
          </div>
          <p className="m-0 max-w-[30em] text-sm text-ink-soft">This week&apos;s top picks, spread across causes and regions{picked.length ? ` in ${place}` : ""}.</p>
        </div>
        {agents.isLoading || !reportsReady ? (
          <div className="grid grid-cols-1 gap-3.5 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-44 rounded-[20px]" />
            ))}
          </div>
        ) : featured.length === 0 ? (
          <p className="m-0 rounded-2xl border border-line bg-card px-4 py-3 text-sm text-ink-soft">
            The curators have not published picks for {place} this week yet. Search the catalogue below instead.
          </p>
        ) : (
          <ul className="m-0 grid list-none grid-cols-1 gap-3.5 p-0 @2xl:grid-cols-2 @5xl:grid-cols-3" aria-label="Featured charities">
            {featured.map((p) => {
              const rec = recordOf(p);
              return (
                <CharityCard
                  key={`${p.agentLabel}-${p.orgId}`}
                  name={p.name}
                  ens={orgEnsName(rec?.label, config.ensParentName)}
                  causes={[p.causeSlug]}
                  regions={[p.region]}
                  score={p.score}
                  reasons={p.reasons}
                  selected={mode === "charity" && charity?.orgId.toLowerCase() === p.orgId.toLowerCase()}
                  onGive={isOrgId(p.orgId) ? () => giveTo(rec ?? { orgId: p.orgId, name: p.name }) : undefined}
                  credit={
                    <a href={agentHref(rel(""), p.agentLabel, p.region)} className="text-[13px] text-ink-muted underline-offset-4 hover:underline">
                      Ranked by {p.agentLabel}.agent
                    </a>
                  }
                />
              );
            })}
          </ul>
        )}
      </section>

      <section id="search" aria-labelledby="sr-h" className="@container flex scroll-mt-24 flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Kicker>Every charity</Kicker>
          <h2 id="sr-h" className="m-0 font-display text-2xl font-semibold @lg:text-3xl">
            Search the catalogue
          </h2>
        </div>
        <div className="flex flex-col gap-3 @3xl:flex-row @3xl:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label htmlFor={searchId} className="text-sm font-semibold text-ink">
              Name, ENS name or EIN
            </label>
            <InputGroup>
              <InputAddon>
                <Search aria-hidden="true" />
              </InputAddon>
              <Input id={searchId} type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="e.g. food bank, givedirectly, 27-1661997" autoComplete="off" />
            </InputGroup>
          </div>
          {(picked.length > 0 || chosen.length > 0) && (
            <div className="flex items-center gap-2.5 pb-2.5">
              <Checkbox id="jd-search-all" checked={searchAll} onCheckedChange={(v) => setSearchAll(v === true)} />
              <label htmlFor="jd-search-all" className="text-sm text-ink">
                Search everywhere, every cause
              </label>
            </div>
          )}
        </div>
        <p className="m-0 text-[13px] text-ink-muted" aria-live="polite">
          {resultTotal === undefined || resultTotal === null
            ? search.isLoading
              ? "Searching…"
              : ""
            : `${resultTotal.toLocaleString("en-US")} ${resultTotal === 1 ? "charity" : "charities"}${searchRegions.length ? ` in ${placeList(searchRegions)}` : ""}${
                searchCategories.length ? ` for ${searchCategories.map(causeLabel).join(", ")}` : ""
              }`}
        </p>
        {search.error ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-terracotta-tint px-3 py-2 text-sm text-terracotta-strong">
            <span>Could not search the catalogue: {errorText(search.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void search.refetch()}>
              Retry
            </Button>
          </div>
        ) : search.data && search.data.pages[0] === null ? (
          <p className="m-0 rounded-2xl border border-line bg-card px-4 py-3 text-sm text-ink-soft">The catalogue is not available right now.</p>
        ) : search.isLoading ? (
          <div className="grid grid-cols-1 gap-3.5 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-36 rounded-[20px]" />
            ))}
          </div>
        ) : results.length === 0 ? (
          <p className="m-0 rounded-2xl border border-line bg-card px-4 py-3 text-sm text-ink-soft">No charity matches. Try another name, or search everywhere.</p>
        ) : (
          <>
            <ul className="m-0 grid list-none grid-cols-1 gap-3.5 p-0 @2xl:grid-cols-2 @5xl:grid-cols-3" aria-label="Search results">
              {results.map((o) => (
                <CharityCard
                  key={o.orgId}
                  name={o.name}
                  ens={orgEnsName(o.label, config.ensParentName)}
                  causes={o.categories}
                  regions={o.regions}
                  place={[o.state, o.country].filter(Boolean).join(", ")}
                  selected={mode === "charity" && charity?.orgId.toLowerCase() === o.orgId.toLowerCase()}
                  onGive={() => giveTo(o)}
                />
              ))}
            </ul>
            {search.hasNextPage && (
              <Button type="button" variant="outline" className="self-center" onClick={() => void search.fetchNextPage()} disabled={search.isFetchingNextPage}>
                {search.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="hw-h" className="@container flex flex-col gap-5 rounded-[28px] bg-ink p-6 text-paper @lg:p-8">
        <h2 id="hw-h" className="m-0 font-display text-[28px] font-semibold text-paper">
          How a gift travels
        </h2>
        <ol className="m-0 grid list-none grid-cols-1 gap-5 p-0 @2xl:grid-cols-3">
          {[
            ["You give USDC", "Approve and donate from your wallet: once per cause, or once for a charity. Every destination shows its ENS name and the address it resolves to."],
            ["Through a curator, or direct", "A curator vault can only give to catalogue charities in its own cause, and nothing can be withdrawn. A direct gift goes straight to the charity's Endaoment account."],
            ["It reaches the charity", "Curators rank charities by region every week and give through Endaoment, each pick proven against a root on chain. Endaoment takes its platform fee."],
          ].map(([title, body], i) => (
            <li key={title} className="flex flex-col gap-2">
              <span className="num font-semibold text-ochre">{String(i + 1).padStart(2, "0")}</span>
              <span className="text-[17px] font-semibold">{title}</span>
              <span className="text-sm leading-relaxed text-paper/80">{body}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function CharityCard({
  name,
  ens,
  causes,
  regions,
  place,
  score,
  reasons,
  selected,
  onGive,
  credit,
}: {
  name: string;
  ens: string | null;
  causes: readonly string[];
  regions: readonly string[];
  place?: string;
  score?: number;
  reasons?: string;
  selected: boolean;
  onGive?: () => void;
  credit?: React.ReactNode;
}) {
  return (
    <SpotlightCard asChild pigment={selected ? "var(--sage)" : "var(--ochre)"} size={260}>
      <li className={cn("flex min-w-0 flex-col gap-2.5 rounded-[20px] border bg-card p-4", selected ? "border-sage shadow-paper" : "border-line")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="m-0 font-display text-lg font-semibold leading-snug [overflow-wrap:anywhere]">{name}</h3>
          {ens && <span className="truncate text-[13px] text-ink-muted">{ens}</span>}
          {place && <span className="text-[13px] text-ink-muted">{place}</span>}
        </div>
        {score !== undefined && (
          <span className="num shrink-0 rounded-lg bg-sage-tint px-2 py-1 text-[13px] font-semibold text-sage-ink" title="The curator's score, 0 to 100">
            {score}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {causes.slice(0, 2).map((c) => (
          <CauseChip key={c} cause={causeArt(c)} label={causeLabel(c)} size="sm" />
        ))}
        {causes.length > 2 && (
          <Badge tone="outline" shape="pill">
            +{causes.length - 2}
          </Badge>
        )}
        {regions.slice(0, 2).map((r) => (
          <Badge key={r} tone="neutral" shape="pill">
            {regionName(r)}
          </Badge>
        ))}
      </div>
      {reasons && <p className="m-0 line-clamp-3 text-sm leading-normal text-ink-soft">{reasons}</p>}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        {credit ?? <span />}
        {onGive && (
          <Button type="button" size="sm" variant={selected ? "cause" : "outline"} aria-pressed={selected} onClick={onGive} className="min-h-10">
            {selected ? <Check aria-hidden="true" /> : <HandHeart aria-hidden="true" />}
            {selected ? "Selected" : "Donate directly"}
            <span className="sr-only"> to {name}</span>
          </Button>
        )}
      </div>
      </li>
    </SpotlightCard>
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

function ViewButton({ on, onClick, icon, label }: { on: boolean; onClick(): void; icon?: React.ReactNode; label: string }) {
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
    <SpotlightCard asChild pigment={heat === "Urgent" ? "var(--terracotta)" : "var(--ochre)"} size={260}>
      <li className={cn("flex min-w-0 flex-col gap-3 rounded-[22px] border-[1.5px] p-4 transition-colors", inGift ? "border-sage bg-sage-tint/50" : "border-line bg-card")}>
      <div className="flex items-center gap-3">
        <span className="num w-6 text-[13px] font-semibold text-ink-muted">{String(rank).padStart(2, "0")}</span>
        <CauseIcon cause={agentCause(t.agent.label)} size={44} decorative />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-semibold leading-tight text-ink">{t.agent.name}</span>
          {t.agent.ensName && <span className="truncate text-xs text-ink-muted">{t.agent.ensName}</span>}
        </span>
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
    </SpotlightCard>
  );
}
