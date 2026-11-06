"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@varada/ui/components/ui/button";
import { CauseLeaderboard, causeEntry, type LeaderboardEntry } from "@varada/ui/components/varada/cause-leaderboard";
import type { CauseName } from "@varada/ui/components/varada/cause-icon";
import { DonationGoal } from "@varada/ui/components/varada/donation-goal";
import { DonationTimeline, type Donation } from "@varada/ui/components/varada/donation-timeline";
import { ImpactBreakdown, type ImpactItem } from "@varada/ui/components/varada/impact-breakdown";
import { PaintedImage } from "@varada/ui/components/varada/painted-image";
import { PoolMeter } from "@varada/ui/components/varada/pool-meter";
import { RaisedCounter } from "@varada/ui/components/varada/raised-counter";
import { ASSETS } from "@/lib/assets.generated";
import { GallerySection, Specimen } from "../section";

/** Fixed sample clock, so the static export and the first client render agree. */
const BASE = Date.UTC(2026, 10, 6, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const GIFTS: { org: string; cause: CauseName; coin: string }[] = [
  { org: "WWF", cause: "wildlife", coin: "$HARAMBE" },
  { org: "charity: water", cause: "water", coin: "$GIGA" },
  { org: "GiveDirectly", cause: "poverty", coin: "$PARTY" },
  { org: "Gorilla Doctors", cause: "wildlife", coin: "$HARAMBE" },
  { org: "Room to Read", cause: "education", coin: "$TWH" },
  { org: "World Central Kitchen", cause: "hunger", coin: "$GIVE" },
];

const INITIAL_DONATIONS: Donation[] = [
  { id: "d1", org: "WWF", amount: 1240.5, cause: "wildlife", at: BASE - 4 * MIN, coin: "$HARAMBE", via: "live", txHref: "https://etherscan.io/" },
  { id: "d2", org: "charity: water", amount: 880, cause: "water", at: BASE - 52 * MIN, coin: "$GIGA", via: "live", txHref: "https://etherscan.io/" },
  { id: "d3", org: "Gorilla Doctors", amount: 6120, cause: "wildlife", at: BASE - 5 * HOUR, coin: "Epoch 11 pool", via: "pool", txHref: "https://etherscan.io/" },
  { id: "d4", org: "Room to Read", amount: 312.4, cause: "education", at: BASE - 26 * HOUR, coin: "$TWH", via: "live" },
];

const BREAKDOWN: ImpactItem[] = [
  { cause: "wildlife", amount: 21480, charities: 6 },
  { cause: "water", amount: 9120, charities: 3 },
  { cause: "hunger", amount: 6300, charities: 4 },
  { cause: "education", amount: 4890, charities: 2 },
  { cause: "poverty", amount: 3720, charities: 2 },
  { cause: "disaster", amount: 2700, charities: 3 },
];

const coinArt = (key: "cutouts/gorilla-mog" | "cutouts/party-hat" | "cutouts/tiger-wif-hat") => (
  <PaintedImage name={key} asset={ASSETS[key]} alt="" sizes="40px" />
);

function LiveCounterDemo() {
  const [total, setTotal] = useState(48210);
  const [to, setTo] = useState<string>();
  const n = useRef(0);
  useEffect(() => {
    const id = setInterval(() => {
      const gift = GIFTS[n.current++ % GIFTS.length]!;
      setTo(gift.org);
      setTotal((t) => Math.round((t + 4 + ((n.current * 37) % 60) + 0.4) * 100) / 100);
    }, 4000);
    return () => clearInterval(id);
  }, []);
  return (
    <RaisedCounter
      value={total}
      goal={60000}
      latestTo={to}
      headingLevel={3}
      caption="90% of every trading fee goes to charity, paid in USDC through Endaoment. A gift lands every few seconds in this demo."
    />
  );
}

function TimelineDemo() {
  const [now, setNow] = useState(BASE);
  const [items, setItems] = useState(INITIAL_DONATIONS);
  const n = useRef(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      const t = BASE + (Date.now() - start);
      const gift = GIFTS[n.current % GIFTS.length]!;
      n.current++;
      setNow(t);
      setItems((list) => [
        { id: `live-${n.current}`, org: gift.org, amount: 20 + ((n.current * 53) % 400) + 0.25, cause: gift.cause, at: t, coin: gift.coin, via: "live", txHref: "https://etherscan.io/" },
        ...list.slice(0, 5),
      ]);
    }, 7000);
    return () => clearInterval(id);
  }, []);
  return <DonationTimeline donations={items} now={now} />;
}

function GoalDemo() {
  const [raised, setRaised] = useState(48210);
  return (
    <div className="flex flex-col gap-3">
      <DonationGoal
        raised={raised}
        goal={60000}
        label="Epoch 12 · Wildlife"
        milestones={[
          { at: 15000, label: "Anti-poaching patrol, one month" },
          { at: 40000, label: "Ranger boots and radios" },
          { at: 60000, label: "Mobile gorilla vet clinic" },
        ]}
        meta="312 holders · 6 charities"
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="cause" onClick={() => setRaised((r) => r + 4000)}>
          Add $4,000
        </Button>
        <Button variant="soft" onClick={() => setRaised(48210)}>
          Reset
        </Button>
      </div>
    </div>
  );
}

function LeaderboardDemo() {
  const [epoch, setEpoch] = useState(0);
  const coins: LeaderboardEntry[][] = [
    [
      { id: "harambe", name: "Harambe", sub: "harambe.varada.eth", art: coinArt("cutouts/gorilla-mog"), raised: 21480, moved: 1 },
      { id: "twh", name: "Tiger wif hat", sub: "tiger-wif-hat.varada.eth", art: coinArt("cutouts/tiger-wif-hat"), raised: 12340, moved: -1 },
      { id: "party", name: "Party hat", sub: "partyhat.varada.eth", art: coinArt("cutouts/party-hat"), raised: 6890 },
    ],
    [
      { id: "harambe", name: "Harambe", sub: "harambe.varada.eth", art: coinArt("cutouts/gorilla-mog"), raised: 22900, moved: -1 },
      { id: "twh", name: "Tiger wif hat", sub: "tiger-wif-hat.varada.eth", art: coinArt("cutouts/tiger-wif-hat"), raised: 8800, moved: -1 },
      { id: "party", name: "Party hat", sub: "partyhat.varada.eth", art: coinArt("cutouts/party-hat"), raised: 24100, moved: 2 },
    ],
  ];
  return (
    <div className="flex flex-col gap-3">
      <CauseLeaderboard title="Top coins" period={epoch ? "Epoch 13" : "Epoch 12"} entries={coins[epoch]!} highlightId="harambe" />
      <Button variant="soft" className="self-start" onClick={() => setEpoch((e) => (e ? 0 : 1))}>
        {epoch ? "Back to epoch 12" : "Next epoch"}
      </Button>
    </div>
  );
}

export function ImpactSection() {
  return (
    <GallerySection
      id="impact"
      title="Raised for causes"
      intro="What the 90% has done: running totals, goals, where it went, who it reached. Amounts are USDC paid through Endaoment."
    >
      <Specimen label="Raised counter, live" source="21st.dev liquid-button + number-ticker">
        <LiveCounterDemo />
      </Specimen>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Raised counter, compact">
          <RaisedCounter value={1_284_300} level={0.78} compact size="md" tone="ochre" label="Raised all time" headingLevel={3} />
        </Specimen>
        <Specimen label="Pool meter">
          <PoolMeter
            epoch={12}
            amount={18420}
            target={30000}
            startsAt={BASE - 4 * DAY}
            endsAt={BASE + 3 * DAY}
            now={BASE}
            attributed="$14,960"
            carriedForward="$3,460"
            curator="wildlife.agent.varada.eth"
            onVote={() => {}}
          />
        </Specimen>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Donation goal, jar">
          <GoalDemo />
        </Specimen>
        <Specimen label="Donation goal, bar">
          <DonationGoal
            variant="bar"
            tone="ochre"
            raised={7420}
            goal={10000}
            label="$HARAMBE launch week"
            milestones={[
              { at: 2500, label: "First payout" },
              { at: 5000, label: "Gorilla Doctors grant" },
              { at: 10000, label: "Full goal" },
            ]}
          />
        </Specimen>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Impact by cause, bars">
          <ImpactBreakdown items={BREAKDOWN} limit={5} />
        </Specimen>
        <Specimen label="Impact by cause, grid">
          <ImpactBreakdown items={BREAKDOWN} variant="grid" title="Where it went" />
        </Specimen>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Donation timeline" source="21st.dev timeline">
          <TimelineDemo />
        </Specimen>
        <div className="flex flex-col gap-4">
          <Specimen label="Cause leaderboard" source="21st.dev leaderboard-table">
            <CauseLeaderboard
              period="All time"
              entries={[
                causeEntry("wildlife", 21480, 2),
                causeEntry("water", 9120, -1),
                causeEntry("hunger", 6300, 0),
                causeEntry("education", 4890, -1),
                causeEntry("refugees", 2100),
              ]}
            />
          </Specimen>
          <Specimen label="Coin leaderboard">
            <LeaderboardDemo />
          </Specimen>
        </div>
      </div>
    </GallerySection>
  );
}
