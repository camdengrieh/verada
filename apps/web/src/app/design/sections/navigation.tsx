"use client";
// Written for Varada: gallery for tab variants, tooltips (spring, cursor-follow, info tips, fee
// breakdown, avatar groups) and the Divider in realistic compositions.

import { AvatarTooltipGroup, type AvatarPerson } from "@varada/ui/components/ui/avatar-tooltip-group";
import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Divider } from "@varada/ui/components/ui/divider";
import { HandHeart, Vote, Wallet } from "@varada/ui/components/ui/icons";
import { InfoTerm, InfoTip } from "@varada/ui/components/ui/info-tip";
import { FeeTooltip } from "@varada/ui/components/ui/rich-tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@varada/ui/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@varada/ui/components/ui/tooltip";
import { CAUSE_NAMES, CAUSE_SHORT_LABELS, CauseIcon } from "@varada/ui/components/varada/cause-icon";
import type { ReactNode } from "react";
import { GallerySection, Specimen } from "../section";

/* ───────────────────────────────────────────────────────────────── tabs ── */

function Panel({ children }: { children: ReactNode }) {
  return <p className="text-[15px] text-ink-soft">{children}</p>;
}

function BrushTabs() {
  return (
    <Specimen label="Brush" source="Written for Varada on Radix Tabs">
      <Tabs defaultValue="trades" variant="brush">
        <TabsList aria-label="$HARAMBE activity">
          <TabsTrigger value="trades">Trades</TabsTrigger>
          <TabsTrigger value="holders">Holders</TabsTrigger>
          <TabsTrigger value="votes">
            <Vote aria-hidden="true" /> Votes
          </TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>
        <TabsContent value="trades">
          <Panel>412 trades in the last 24 hours, $6,180 of fees to Wildlife rescue.</Panel>
        </TabsContent>
        <TabsContent value="holders">
          <Panel>2,914 holders. The top ten hold 18% of supply.</Panel>
        </TabsContent>
        <TabsContent value="votes">
          <Panel>Epoch 12 closes in 2 days. Ballots stay encrypted until then.</Panel>
        </TabsContent>
        <TabsContent value="about">
          <Panel>A coin for the silverbacks. 90% of every fee goes to the pool.</Panel>
        </TabsContent>
      </Tabs>
    </Specimen>
  );
}

function SegmentedTabs() {
  return (
    <Specimen label="Segmented" source="21st.dev @educalvolpz/animated-tabs (24930)">
      <Tabs defaultValue="1d" variant="segmented" className="max-w-sm">
        <TabsList aria-label="Chart range" className="w-full">
          {["1H", "1D", "1W", "1M", "All"].map((r) => (
            <TabsTrigger key={r} value={r.toLowerCase()} className="px-2">
              {r}
            </TabsTrigger>
          ))}
        </TabsList>
        {["1h", "1d", "1w", "1m", "all"].map((r) => (
          <TabsContent key={r} value={r}>
            <Panel>
              Showing <span className="num">{r.toUpperCase()}</span> of $HARAMBE against ETH.
            </Panel>
          </TabsContent>
        ))}
      </Tabs>
    </Specimen>
  );
}

function CardTabs() {
  return (
    <Specimen label="Folder" source="21st.dev @originui/tabs, file tabs (425)">
      <Tabs defaultValue="overview" variant="card">
        <TabsList aria-label="Clean water dossier">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="vault">Vault</TabsTrigger>
          <TabsTrigger value="curator">Curator</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <div className="flex items-start gap-3">
            <CauseIcon cause="water" size={44} decorative />
            <Panel>Wells, filters and sanitation in places without them. Paid out 14 times since launch.</Panel>
          </div>
        </TabsContent>
        <TabsContent value="vault">
          <Panel>
            <span className="num font-semibold text-ink">$48,210 USDC</span> waiting for epoch 12.
          </Panel>
        </TabsContent>
        <TabsContent value="curator">
          <Panel>
            Curated by <span className="num text-ink">water.agent.varada.eth</span>, which shortlists vetted charities each epoch.
          </Panel>
        </TabsContent>
      </Tabs>
    </Specimen>
  );
}

function VerticalTabs() {
  return (
    <Specimen label="Vertical" source="21st.dev @0xUrvish/vertical-tabs (10473)">
      <Tabs defaultValue="ballot" variant="vertical">
        <TabsList aria-label="Governance">
          <TabsTrigger value="ballot">Current ballot</TabsTrigger>
          <TabsTrigger value="history">Epoch history</TabsTrigger>
          <TabsTrigger value="payouts">Payouts</TabsTrigger>
          <TabsTrigger value="rules">How voting works</TabsTrigger>
        </TabsList>
        <TabsContent value="ballot">
          <Panel>Twelve causes on the ballot. Pins keep last epoch&apos;s winner on; rotation brings in three new ones.</Panel>
        </TabsContent>
        <TabsContent value="history">
          <Panel>Epoch 11 went to Clean water with 41% of the vote.</Panel>
        </TabsContent>
        <TabsContent value="payouts">
          <Panel>$212,400 USDC paid to 31 charities so far.</Panel>
        </TabsContent>
        <TabsContent value="rules">
          <Panel>One token, one vote, encrypted end to end. Arrow up and down to move between these.</Panel>
        </TabsContent>
      </Tabs>
    </Specimen>
  );
}

function ScrollableTabs() {
  const causes = CAUSE_NAMES.filter((c) => c !== "other");
  return (
    <Specimen label="Scrollable" source="21st.dev @kuratlielia/tabs (35021)">
      <p className="text-sm text-ink-muted">Twenty causes on a phone: the row scrolls, the edges fade and the arrows page through.</p>
      <Tabs defaultValue="wildlife" variant="pill">
        <TabsList aria-label="Causes" scrollable scrollLabels={{ previous: "Earlier causes", next: "More causes" }}>
          {causes.map((c) => (
            <TabsTrigger key={c} value={c}>
              {CAUSE_SHORT_LABELS[c]}
            </TabsTrigger>
          ))}
        </TabsList>
        {causes.map((c) => (
          <TabsContent key={c} value={c}>
            <div className="flex items-center gap-3">
              <CauseIcon cause={c} size={40} decorative />
              <Panel>{CAUSE_SHORT_LABELS[c]}: coins launched for this cause and its pool this epoch.</Panel>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </Specimen>
  );
}

/* ───────────────────────────────────────────────────────────── tooltips ── */

function TooltipStyles() {
  return (
    <Specimen label="Tooltip entries" source="ui/tooltip · 21st.dev @manuarora700/animated-tooltip (791), @unlumen/floating-tooltip (25221)">
      <p className="text-sm text-ink-soft">Hover, tab to them or tap on a phone. Escape or a tap elsewhere closes them.</p>
      <div className="flex flex-wrap gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">Fade</Button>
          </TooltipTrigger>
          <TooltipContent>The default: a quick fade and zoom</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">Spring</Button>
          </TooltipTrigger>
          <TooltipContent animation="spring">Pops in like a dab of paint</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" className="px-10">
              Follow the cursor
            </Button>
          </TooltipTrigger>
          <TooltipContent followCursor>Sways with your pointer</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="soft">Paper tone</Button>
          </TooltipTrigger>
          <TooltipContent tone="paper" animation="spring" side="bottom">
            For richer content on the page colour
          </TooltipContent>
        </Tooltip>
      </div>
    </Specimen>
  );
}

function SummaryRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 text-[15px]">
      <span className="inline-flex items-center gap-1 text-ink-soft">{label}</span>
      <span className="num text-ink">{children}</span>
    </div>
  );
}

function TradeSummary() {
  return (
    <Specimen label="Info tips and fee breakdown" source="ui/info-tip + ui/rich-tooltip · written for Varada">
      <div className="flex max-w-md flex-col rounded-2xl border border-line bg-paper p-4">
        <SummaryRow label="You pay">0.50 ETH</SummaryRow>
        <Divider variant="dashed" />
        <SummaryRow
          label={
            <>
              Price impact <InfoTip entry="price-impact" />
            </>
          }
        >
          0.42%
        </SummaryRow>
        <Divider variant="dashed" />
        <SummaryRow
          label={
            <>
              Max slippage <InfoTip entry="slippage" />
            </>
          }
        >
          0.5%
        </SummaryRow>
        <Divider variant="dashed" />
        <SummaryRow label="Trading fee">
          <FeeTooltip rate="1%" fee="0.005 ETH" toCause="0.0045 ETH" toPlatform="0.0005 ETH" cause="Wildlife">
            <button
              type="button"
              className="num inline-flex min-h-11 items-center rounded-md px-1 text-ink underline decoration-sage decoration-dotted decoration-2 underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
            >
              0.005 ETH
            </button>
          </FeeTooltip>
        </SummaryRow>
      </div>
      <p className="max-w-xl text-[15px] text-ink-soft">
        Votes are private thanks to <InfoTerm entry="fhe" />: you choose a cause each <InfoTerm entry="epoch" label="epoch" />, and the{" "}
        <InfoTerm entry="cause-pool" label="cause pool" /> pays the winner.
      </p>
    </Specimen>
  );
}

const HOLDERS: AvatarPerson[] = [
  { id: "h1", name: "silverback.eth", detail: "4.2% of supply" },
  { id: "h2", name: "Mira Okafor", detail: "3.1% of supply" },
  { id: "h3", name: "0x7f3a…c21e", detail: "2.6% of supply" },
  { id: "h4", name: "gorillagrove.eth", detail: "2.2% of supply" },
  { id: "h5", name: "Tomás Reyes", detail: "1.9% of supply" },
  { id: "h6", name: "Anika Shah", detail: "1.4% of supply" },
  { id: "h7", name: "banana.fund", detail: "1.1% of supply" },
  { id: "h8", name: "0x91be…44d0", detail: "0.9% of supply" },
];

const CURATORS: AvatarPerson[] = (["water", "wildlife", "hunger", "education", "disaster"] as const).map((c) => ({
  id: c,
  name: CAUSE_SHORT_LABELS[c],
  detail: `${c}.agent.varada.eth`,
}));

function AvatarGroups() {
  return (
    <Specimen label="Avatar tooltip group" source="21st.dev @manuarora700/animated-tooltip (791), @arihantcodes/avatar-stack (27756)">
      <div className="flex flex-wrap items-center gap-x-10 gap-y-6 pt-10">
        <div className="flex flex-col gap-2">
          <span className="kicker">Top holders</span>
          <AvatarTooltipGroup people={HOLDERS} label="Top holders of $HARAMBE" max={5} />
        </div>
        <Divider orientation="vertical" className="hidden h-14 sm:flex" />
        <div className="flex flex-col gap-2">
          <span className="kicker">Curator agents</span>
          <AvatarTooltipGroup people={CURATORS} label="Curator agents on this ballot" size="lg" />
        </div>
      </div>
    </Specimen>
  );
}

/* ────────────────────────────────────────────────────────── dividers ── */

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-24 flex-1 flex-col gap-1">
      <span className="kicker">{label}</span>
      <span className="num text-xl font-semibold text-ink">{value}</span>
      {note ? <span className="text-xs text-ink-muted">{note}</span> : null}
    </div>
  );
}

function DividersInUse() {
  return (
    <Specimen label="Dividers in use" source="ui/divider · written for Varada">
      <div className="grid gap-4 lg:grid-cols-2">
        {/* card sections */}
        <div className="flex flex-col gap-4 rounded-2xl border border-line bg-paper p-5">
          <div className="flex items-center gap-3">
            <CauseIcon cause="wildlife" size={44} decorative />
            <div className="flex flex-col">
              <span className="font-display text-lg font-semibold">Wildlife rescue pool</span>
              <span className="text-sm text-ink-muted">Epoch 12 · closes in 2 days</span>
            </div>
          </div>
          <Divider variant="brush" />
          <div className="flex flex-wrap items-stretch gap-4">
            <Metric label="In the pool" value="$31,204" note="USDC" />
            <Divider orientation="vertical" />
            <Metric label="Coins" value="14" />
            <Divider orientation="vertical" />
            <Metric label="Voters" value="2,481" />
          </div>
          <Divider label="Recent gifts" decorative={false} />
          <ul className="flex flex-col">
            {[
              ["$HARAMBE", "$109.20"],
              ["$GIVEDOGE", "$41.80"],
              ["$MUDRA", "$12.05"],
            ].map(([coin, amount], i) => (
              <li key={coin} className="flex flex-col">
                {i > 0 ? <Divider variant="dashed" /> : null}
                <div className="flex min-h-11 items-center justify-between text-[15px]">
                  <span className="num font-semibold">{coin}</span>
                  <span className="num text-sage-ink">{amount}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* labelled "or" between actions, section breaks */}
        <div className="flex flex-col gap-4 rounded-2xl border border-line bg-paper p-5">
          <span className="font-display text-lg font-semibold">Support Clean water</span>
          <Button>
            <Wallet aria-hidden="true" /> Buy $SPLASH with ETH
          </Button>
          <Divider label="or" />
          <Button variant="cause">
            <HandHeart aria-hidden="true" /> Give 50 USDC directly
          </Button>
          <p className="text-sm text-ink-muted">Buying funds the cause through fees; a direct gift goes to its vault in full.</p>
          <Divider variant="ornament" />
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="cause">Pinned</Badge>
            <Divider orientation="vertical" variant="dashed" className="h-6" />
            <span className="text-sm text-ink-soft">Last epoch&apos;s winner</span>
          </div>
          <Divider variant="dashed" label="Epoch 12" tone="var(--ochre)" decorative={false} />
          <p className="text-sm text-ink-soft">Ballots open. Your vote stays private until the tally.</p>
        </div>
      </div>
    </Specimen>
  );
}

/* ────────────────────────────────────────────────────────────── section ── */

export function NavigationSection() {
  return (
    <GallerySection
      id="navigation"
      title="Tabs, tooltips and dividers"
      intro="Six tab styles on Radix Tabs (all arrow-key driven), tooltips that open on hover, focus or tap, and dividers doing their jobs inside real layouts."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <BrushTabs />
        <SegmentedTabs />
        <CardTabs />
        <VerticalTabs />
      </div>
      <ScrollableTabs />
      <div className="grid gap-4 lg:grid-cols-2">
        <TooltipStyles />
        <TradeSummary />
      </div>
      <AvatarGroups />
      <DividersInUse />
    </GallerySection>
  );
}
