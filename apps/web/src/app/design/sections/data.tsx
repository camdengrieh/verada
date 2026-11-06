"use client";

import { ActivityChip, ActivityList, type ActivityItem } from "@verada/ui/components/data/activity-list";
import { CopyButton } from "@verada/ui/components/data/copy-button";
import { Countdown } from "@verada/ui/components/data/countdown";
import { DataTable, dataTableColumns } from "@verada/ui/components/data/data-table";
import { EmptyState } from "@verada/ui/components/data/empty-state";
import { FileDropzone } from "@verada/ui/components/data/file-dropzone";
import { ChartTimeframes, PriceChart, type PriceCandle } from "@verada/ui/components/data/price-chart";
import { Sparkline } from "@verada/ui/components/data/sparkline";
import { Delta, StatCard } from "@verada/ui/components/data/stat-card";
import { Stepper, type StepperStep } from "@verada/ui/components/data/stepper";
import { Marquee } from "@verada/ui/components/motion/marquee";
import { NumberTicker } from "@verada/ui/components/motion/number-ticker";
import { Badge } from "@verada/ui/components/ui/badge";
import { Button } from "@verada/ui/components/ui/button";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GallerySection, Specimen } from "../section";

/* ── Inline icons (the web app does not depend on lucide-react) ─────────── */

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-5">
      {children}
    </svg>
  );
}
const SearchX = () => (
  <Glyph>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5M8.5 8.5l5 5M13.5 8.5l-5 5" />
  </Glyph>
);
const Rocket = () => (
  <Glyph>
    <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 12a12 12 0 0 1 11-9 12 12 0 0 1-9 11zM12 15l-3-3" />
  </Glyph>
);
const Coins = () => (
  <Glyph>
    <circle cx="9" cy="9" r="6" />
    <path d="M15.5 9.6A6 6 0 1 1 9.6 15.5" />
  </Glyph>
);
const Ballot = () => (
  <Glyph>
    <rect x="3" y="11" width="18" height="10" rx="2" />
    <path d="m8 6 3 3 5-5" />
  </Glyph>
);

/* ── Sample data (illustrative values only) ─────────────────────────────── */

type Coin = {
  id: string;
  name: string;
  symbol: string;
  pair: string;
  price: number;
  change24h: number;
  mcap: number;
  volume: number;
  liquidity: number;
  raised: number;
  trend: number[];
};

/** Deterministic PRNG so server and client render the same sample numbers. */
function mulberry32(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function walk(seed: number, n: number, start: number, drift: number): number[] {
  const rand = mulberry32(seed);
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    v = Math.max(start * 0.2, v * (1 + (rand() - 0.5 + drift) * 0.08));
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

const RAW: Omit<Coin, "id" | "trend">[] = [
  { name: "Harambe Forever", symbol: "HARAMBE", pair: "NVDAon", price: 0.004218, change24h: 18.42, mcap: 4_210_000, volume: 812_400, liquidity: 640_000, raised: 12_480 },
  { name: "Gigachad Giving", symbol: "GIGA", pair: "WETH", price: 0.000914, change24h: -4.1, mcap: 2_870_000, volume: 501_200, liquidity: 410_500, raised: 8_920 },
  { name: "Tiger Wif Hat", symbol: "TWH", pair: "SPYon", price: 0.0218, change24h: 6.75, mcap: 1_940_000, volume: 288_000, liquidity: 352_000, raised: 6_115 },
  { name: "Statue of Kindness", symbol: "KIND", pair: "QQQon", price: 0.00731, change24h: 2.04, mcap: 1_310_000, volume: 140_900, liquidity: 220_400, raised: 5_302 },
  { name: "Ocean Cleanup Cat", symbol: "OCAT", pair: "WETH", price: 0.000052, change24h: -12.9, mcap: 980_000, volume: 402_300, liquidity: 118_000, raised: 4_790 },
  { name: "Moon Trees", symbol: "TREE", pair: "TSLAon", price: 0.00144, change24h: 31.6, mcap: 860_500, volume: 377_000, liquidity: 96_200, raised: 3_884 },
  { name: "Library Frog", symbol: "READ", pair: "AAPLon", price: 0.000388, change24h: -0.62, mcap: 642_000, volume: 58_100, liquidity: 88_000, raised: 2_610 },
  { name: "Meal Doge", symbol: "MEAL", pair: "WETH", price: 0.0000917, change24h: 4.4, mcap: 515_800, volume: 77_400, liquidity: 70_300, raised: 2_045 },
  { name: "Clean Water Ape", symbol: "H2O", pair: "MSFTon", price: 0.00602, change24h: -7.85, mcap: 402_100, volume: 39_900, liquidity: 61_800, raised: 1_377 },
  { name: "Bee Keepers", symbol: "BUZZ", pair: "IWMon", price: 0.0011, change24h: 0, mcap: 288_000, volume: 12_600, liquidity: 40_100, raised: 682 },
];

const COINS: Coin[] = RAW.map((c, i) => ({
  ...c,
  id: `0x${(0x7f3a00 + i * 0x1111).toString(16)}c21e`,
  trend: walk(11 + i, 24, 1, c.change24h / 400),
}));

const ETFS = new Set(["SPYon", "QQQon", "IWMon"]);
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const price = (n: number) => `$${n.toLocaleString("en-US", { maximumSignificantDigits: 4, minimumSignificantDigits: 2 })}`;
const coinId = (c: Coin) => c.id;
const coinLabel = (c: Coin) => c.name;

function PairBadge({ pair }: { pair: string }) {
  return (
    <Badge tone={pair === "WETH" ? "outline" : ETFS.has(pair) ? "etf" : "stock"} className="num">
      {pair}
    </Badge>
  );
}

const col = dataTableColumns<Coin>();
const COLUMNS = col.columns([
  col.accessor("name", {
    header: "Coin",
    meta: { pinned: true },
    cell: ({ row }) => (
      <span className="flex items-center gap-3">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-terracotta-tint font-display text-sm font-bold text-terracotta-strong">
          {row.original.symbol.slice(0, 2)}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-ink">{row.original.name}</span>
          <span className="num text-xs text-ink-muted">${row.original.symbol}</span>
        </span>
      </span>
    ),
  }),
  col.accessor("pair", { header: "Pair", meta: { priority: 3 }, cell: (info) => <PairBadge pair={info.getValue()} /> }),
  col.accessor("price", { header: "Price", meta: { numeric: true }, cell: (info) => price(info.getValue()) }),
  col.accessor("change24h", { header: "24h", meta: { numeric: true, priority: 2 }, cell: (info) => <Delta value={info.getValue()} /> }),
  col.display({
    id: "trend",
    header: "7d",
    meta: { priority: 5 },
    cell: ({ row }) => <Sparkline data={row.original.trend} width={88} height={28} animate={false} />,
  }),
  col.accessor("mcap", { header: "Market cap", meta: { numeric: true, priority: 4 }, cell: (info) => usdCompact.format(info.getValue()) }),
  col.accessor("volume", { header: "Volume 24h", meta: { numeric: true, priority: 4 }, cell: (info) => usdCompact.format(info.getValue()) }),
  col.accessor("liquidity", { header: "Liquidity", meta: { numeric: true, priority: 5 }, cell: (info) => usdCompact.format(info.getValue()) }),
  col.accessor("raised", {
    header: "Raised for causes",
    meta: { numeric: true, priority: 3 },
    cell: (info) => <span className="font-semibold text-sage-ink">{usd.format(info.getValue())}</span>,
  }),
]);

const NEW_LAUNCHES: Omit<Coin, "id" | "trend">[] = [
  { name: "Seed Bank Sloth", symbol: "SEED", pair: "WETH", price: 0.000021, change24h: 0, mcap: 42_000, volume: 3_100, liquidity: 9_800, raised: 14 },
  { name: "Shelter Pup", symbol: "PUP", pair: "NVDAon", price: 0.00008, change24h: 0, mcap: 61_500, volume: 5_400, liquidity: 12_000, raised: 31 },
  { name: "Reef Guardian", symbol: "REEF", pair: "SPYon", price: 0.00012, change24h: 0, mcap: 33_900, volume: 2_200, liquidity: 8_400, raised: 9 },
];

function makeCandles(seed: number, count: number, step: number, start: number): PriceCandle[] {
  const rand = mulberry32(seed);
  const t0 = Date.UTC(2026, 9, 1) / 1000;
  const out: PriceCandle[] = [];
  let prev = start;
  for (let i = 0; i < count; i++) {
    const open = prev;
    const close = Math.max(start * 0.3, open * (1 + (rand() - 0.47) * 0.06));
    const high = Math.max(open, close) * (1 + rand() * 0.02);
    const low = Math.min(open, close) * (1 - rand() * 0.02);
    out.push({ time: t0 + i * step, open, high, low, close, volume: Math.round(20_000 + rand() * 90_000 + Math.abs(close - open) * 4e7) });
    prev = close;
  }
  return out;
}

const TIMEFRAMES = ["1H", "24H", "7D", "30D"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];
const TF_SHAPE: Record<Timeframe, { count: number; step: number; seed: number }> = {
  "1H": { count: 60, step: 60, seed: 3 },
  "24H": { count: 96, step: 900, seed: 7 },
  "7D": { count: 84, step: 7200, seed: 19 },
  "30D": { count: 120, step: 21600, seed: 41 },
};

const ACTIVITY: ActivityItem[] = [
  { id: "a1", kind: "buy", title: "0x91c…4e2 bought $HARAMBE", meta: "via NVDAon pool", amount: "+$1,240.00", amountTone: "gain", time: "12s ago" },
  { id: "a2", kind: "give", title: "Weekly pool sent to Ocean Conservancy", meta: "Epoch 11 · 412 voters", amount: "$3,884.10", amountTone: "cause", time: "3m ago" },
  { id: "a3", kind: "sell", title: "vitalik-fan.eth sold $GIGA", meta: "via WETH pool", amount: "−$318.55", amountTone: "loss", time: "5m ago" },
  { id: "a4", kind: "vote", title: "Private ballot cast for Clean Water", meta: "Encrypted · epoch 12", time: "6m ago" },
  { id: "a5", kind: "new", title: "$TREE launched on TSLAon", meta: "Cause focus: reforestation", amount: "$860K mcap", time: "18m ago" },
  { id: "a6", kind: "buy", title: "0x4ab…9f0 bought $TWH", meta: "via SPYon pool", amount: "+$402.18", amountTone: "gain", time: "21m ago" },
];

const LIVE_POOL: Omit<ActivityItem, "id">[] = [
  { kind: "buy", title: "0x2d7…a11 bought $KIND", meta: "via QQQon pool", amount: "+$96.40", amountTone: "gain", time: "now" },
  { kind: "give", title: "Instant gift to GiveDirectly", meta: "From $MEAL fees", amount: "$42.08", amountTone: "cause", time: "now" },
  { kind: "sell", title: "0x8e0…55c sold $OCAT", meta: "via WETH pool", amount: "−$210.00", amountTone: "loss", time: "now" },
  { kind: "vote", title: "Private ballot cast for Animal Welfare", meta: "Encrypted · epoch 12", time: "now" },
];

function StepBody({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line-strong bg-paper p-5 text-ink-soft">{children}</div>;
}

const LAUNCH_STEPS: StepperStep[] = [
  { id: "identity", label: "Identity", description: "Name, ticker and logo", content: <StepBody>Coin name, $TICKER, logo and a short story. (Placeholder body.)</StepBody> },
  { id: "giving", label: "Giving mode", description: "Instant or weekly pool", content: <StepBody>Send fees to one cause instantly, or into the weekly community pool. (Placeholder body.)</StepBody> },
  { id: "pair", label: "Pair", description: "WETH or a tokenized stock", content: <StepBody>Pair with WETH or an Ondo stock or ETF such as NVDAon or SPYon. (Placeholder body.)</StepBody> },
  { id: "cause", label: "Cause focus", description: "What the coin funds", content: <StepBody>Pick a cause focus from the catalogue. (Placeholder body.)</StepBody> },
  { id: "fees", label: "Fees", description: "Trading fee and split", content: <StepBody>Trading fee and how it splits between causes and the platform. (Placeholder body.)</StepBody> },
  { id: "review", label: "Review", description: "Check and launch", content: <StepBody>Everything above in one place before you sign. (Placeholder body.)</StepBody> },
];

/** Next Sunday 00:00 UTC: the weekly epoch boundary. */
function nextEpochClose(now: number): number {
  const d = new Date(now);
  const days = (7 - d.getUTCDay()) % 7 || 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days);
}

/* ── Section ────────────────────────────────────────────────────────────── */

export function DataSection() {
  return (
    <GallerySection
      id="data"
      title="Data, motion and trading"
      intro="Tables, numbers, charts and flows for discovery, trading and launching. Every number is set in JetBrains Mono with tabular figures; gains and losses carry a glyph as well as a colour. Sample values only."
    >
      <StatsDemo />
      <TableDemo />
      <ChartDemo />
      <ActivityDemo />
      <StepperDemo />
      <div className="grid gap-4 lg:grid-cols-2">
        <CountdownDemo />
        <DropzoneDemo />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Specimen label="Copy button" source="21st.dev @ddoemonn/copy-button (id 23529)">
          <div className="flex flex-wrap items-center gap-3">
            <CopyButton value="0x7f3a9c04d1b2e8f6a5c3d7e9b1f2a4c6d8e0c21e" label="Copy contract address">
              <span className="num">0x7f3a…c21e</span>
            </CopyButton>
            <CopyButton value="harambe.agent.varada.eth" label="Copy ENS name" variant="outline">
              <span className="num">harambe.agent.varada.eth</span>
            </CopyButton>
            <CopyButton value="0x7f3a9c04d1b2e8f6a5c3d7e9b1f2a4c6d8e0c21e" label="Copy address" iconOnly variant="ghost" />
            <CopyButton value="https://varada.eth.limo/coin/harambe" label="Copy link" copiedLabel="Link copied" />
          </div>
          <p className="text-sm text-ink-muted">The icon and label confirm in place, and a polite status message says &ldquo;Copied&rdquo;.</p>
        </Specimen>
        <Specimen label="Empty state" source="21st.dev @cnippet-dev/cnippet-empty (id 19745)">
          <EmptyState
            icon={<SearchX />}
            title="No coins match those filters"
            body="Try a different pair or clear the cause filter to see every launch."
            action={
              <>
                <Button variant="outline">Clear filters</Button>
                <Button>
                  <Rocket />
                  Launch a coin
                </Button>
              </>
            }
          />
          <EmptyState
            size="compact"
            icon={<Ballot />}
            title="No votes yet this epoch"
            body="Ballots are private; totals appear when the epoch closes."
            className="rounded-xl bg-sand"
          />
        </Specimen>
      </div>
    </GallerySection>
  );
}

function StatsDemo() {
  const [raised, setRaised] = useState(48_210);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Raised for causes"
          icon={<Coins />}
          value={raised}
          format={{ style: "currency", currency: "USD", maximumFractionDigits: 0 }}
          delta={12.4}
          deltaSuffix="vs last epoch"
          trend={[31, 33, 32, 36, 38, 37, 41, 44, 43, 46, 48]}
          trendLabel="Raised for causes over 11 epochs, rising"
          trendTone="cause"
          hint="All coins, all time"
        />
        <StatCard
          label="Volume 24h"
          value={1_920_400}
          format={{ style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }}
          delta={-3.1}
          deltaSuffix="vs yesterday"
          trend={[2.1, 2.3, 2.2, 2.0, 1.9, 2.05, 1.92]}
          trendLabel="Volume over 7 days, slightly down"
        />
        <StatCard label="Coins launched" value={1_284} delta={42} deltaFormat={(n) => `${n}`} deltaSuffix="this week" />
        <StatCard tone="ink" label="Votes this epoch" value={3_912} delta={8.6} deltaSuffix="turnout" hint="Epoch 12 · ballots stay encrypted until close" />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm text-ink-soft">
        <Button size="sm" variant="cause" onClick={() => setRaised((r) => r + 1_250)}>
          Simulate a $1,250 gift
        </Button>
        <span>
          NumberTicker counts up on first view and springs to new values:{" "}
          <strong className="text-ink">
            <NumberTicker value={raised} format={{ style: "currency", currency: "USD", maximumFractionDigits: 0 }} />
          </strong>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        StatCard from 21st.dev @ravikatiyar162/stats-card-2 (id 8412) · NumberTicker from @dillionverma/number-ticker (id 1282) · Sparkline from
        @kuratlielia/sparkline (id 35038)
      </p>
    </div>
  );
}

function TableDemo() {
  const [coins, setCoins] = useState<Coin[]>(COINS);
  const [loading, setLoading] = useState(false);
  const [empty, setEmpty] = useState(false);
  const added = useRef(0);

  const addLaunch = () => {
    const next = NEW_LAUNCHES[added.current % NEW_LAUNCHES.length]!;
    added.current += 1;
    const n = added.current;
    setCoins((list) => [{ ...next, id: `0xnew${n}`, trend: walk(90 + n, 24, 1, 0) }, ...list]);
  };

  return (
    <Specimen label="Discover table" source="21st.dev @kuratlielia/sortable-data-table (id 35036) on @tanstack/react-table v9">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={addLaunch}>
          Add a new launch (flashes)
        </Button>
        <Button size="sm" variant="soft" aria-pressed={loading} onClick={() => setLoading((v) => !v)}>
          Loading state
        </Button>
        <Button size="sm" variant="soft" aria-pressed={empty} onClick={() => setEmpty((v) => !v)}>
          Empty state
        </Button>
      </div>
      <DataTable
        caption="Discover: coins by market cap"
        columns={COLUMNS}
        data={empty ? [] : coins}
        getRowId={coinId}
        getRowLabel={coinLabel}
        initialSorting={[{ id: "mcap", desc: true }]}
        loading={loading}
        selectable
        itemName={{ one: "coin", other: "coins" }}
        maxHeight="34rem"
        empty={
          <EmptyState
            size="compact"
            icon={<SearchX />}
            title="No coins yet"
            body="Be the first to launch a coin for a cause."
            action={<Button size="sm">Launch a coin</Button>}
          />
        }
      />
      <p className="text-sm text-ink-muted">
        Narrow the window: liquidity and the 7d trend go first, then market cap and volume, then pair and raised. Coin, price and 24h stay.
        Headers are buttons inside <code className="num">aria-sort</code> column headers; the header sticks while the box scrolls.
      </p>
    </Specimen>
  );
}

function ChartDemo() {
  const [tf, setTf] = useState<Timeframe>("24H");
  const [kind, setKind] = useState<"candles" | "area">("candles");
  const [loading, setLoading] = useState(false);
  const candles = useMemo(() => {
    const shape = TF_SHAPE[tf];
    return makeCandles(shape.seed, shape.count, shape.step, 0.0036);
  }, [tf]);
  const first = candles[0]!;
  const last = candles.at(-1)!;
  const change = ((last.close - first.open) / first.open) * 100;

  return (
    <Specimen label="Price chart" source="Written for Varada on lightweight-charts v5 · readout after 21st.dev @ssychui/candle-chart (id 22250)">
      <PriceChart
        kind={kind}
        candles={candles}
        loading={loading}
        height={340}
        formatPrice={(n) => n.toFixed(6)}
        label={`$HARAMBE priced in NVDAon, ${tf}, ${change >= 0 ? "up" : "down"} ${Math.abs(change).toFixed(2)}%`}
        toolbar={
          <>
            <div className="flex flex-col">
              <span className="kicker">$HARAMBE / NVDAon</span>
              <span className="flex items-baseline gap-3">
                <span className="num text-2xl font-semibold">{last.close.toFixed(6)}</span>
                <Delta value={change} suffix={tf} />
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <ChartTimeframes options={TIMEFRAMES} value={tf} onChange={(v) => setTf(v as Timeframe)} />
              <ChartTimeframes
                label="Chart style"
                options={["Candles", "Area"]}
                value={kind === "candles" ? "Candles" : "Area"}
                onChange={(v) => setKind(v === "Area" ? "area" : "candles")}
              />
            </div>
          </>
        }
      />
      <div>
        <Button size="sm" variant="soft" aria-pressed={loading} onClick={() => setLoading((v) => !v)}>
          Loading skeleton
        </Button>
      </div>
      <p className="text-sm text-ink-muted">
        The library loads inside an effect, so static export renders only the skeleton. Colours are read from the CSS tokens and follow the
        theme; a ResizeObserver keeps the canvas at the card width.
      </p>
    </Specimen>
  );
}

function ActivityDemo() {
  const [feed, setFeed] = useState<ActivityItem[]>(ACTIVITY.slice(0, 5));
  const n = useRef(0);
  const push = () => {
    const item = LIVE_POOL[n.current % LIVE_POOL.length]!;
    n.current += 1;
    const id = `live-${n.current}`;
    setFeed((list) => [{ ...item, id }, ...list].slice(0, 7));
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Specimen label="Live activity marquee" source="21st.dev @kevingirelli/marquee (id 35200)" className="lg:col-span-2">
        <Marquee label="Live activity" duration={50} gap="0.75rem">
          {ACTIVITY.map((a) => (
            <ActivityChip key={a.id} item={a} />
          ))}
        </Marquee>
        <Marquee label="Coins by 24h change" direction="right" duration={36} gap="1.5rem" className="text-sm">
          {COINS.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-2 whitespace-nowrap">
              <span className="font-semibold">${c.symbol}</span>
              <Delta value={c.change24h} />
            </span>
          ))}
        </Marquee>
        <p className="text-sm text-ink-muted">Pauses on hover, on keyboard focus and off screen. With reduced motion it stands still and scrolls by hand.</p>
      </Specimen>
      <Specimen label="Activity feed" source="21st.dev @felipemenezes098/item-19 (id 29394)">
        <ActivityList label="Recent activity" items={feed} />
        <div>
          <Button size="sm" variant="outline" onClick={push}>
            Simulate new activity
          </Button>
        </div>
      </Specimen>
      <Specimen label="Activity tags and sparklines">
        <div className="flex flex-wrap gap-2">
          {(["buy", "sell", "give", "vote", "new"] as const).map((k) => (
            <ActivityChip key={k} item={{ kind: k, title: k === "give" ? "Gift sent" : k === "vote" ? "Ballot cast" : "$HARAMBE" }} />
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-6">
          <figure className="flex flex-col gap-1">
            <Sparkline data={COINS[0]!.trend} label="HARAMBE 24 hour trend, up" />
            <figcaption className="text-xs text-ink-muted">auto: gain</figcaption>
          </figure>
          <figure className="flex flex-col gap-1">
            <Sparkline data={COINS[4]!.trend} label="OCAT 24 hour trend, down" />
            <figcaption className="text-xs text-ink-muted">auto: loss</figcaption>
          </figure>
          <figure className="flex flex-col gap-1">
            <Sparkline data={[3, 4, 4, 6, 5, 7, 9]} tone="cause" area={false} label="Gifts per day, rising" />
            <figcaption className="text-xs text-ink-muted">cause, line only</figcaption>
          </figure>
          <figure className="flex flex-col gap-1">
            <Sparkline data={[5, 5.2, 4.9, 5.4, 5.6, 5.5]} tone="stock" label="NVDAon reference price" />
            <figcaption className="text-xs text-ink-muted">stock</figcaption>
          </figure>
        </div>
      </Specimen>
    </div>
  );
}

function StepperDemo() {
  const [done, setDone] = useState(false);
  const [index, setIndex] = useState(0);
  return (
    <div className="grid gap-4">
      <Specimen label="Launch stepper · horizontal" source="21st.dev @ddoemonn/wizard-steps (id 23576)">
        <Stepper
          label="Launch steps"
          steps={LAUNCH_STEPS}
          index={index}
          complete={done}
          onIndexChange={(i) => {
            setDone(false);
            setIndex(i);
          }}
          onComplete={() => setDone(true)}
          finishLabel="Launch coin"
          completeContent={
            <div className="flex flex-col items-start gap-3">
              <p className="text-ink-soft">Your coin is ready to sign. (Placeholder.)</p>
              <Button
                variant="outline"
                onClick={() => {
                  setDone(false);
                  setIndex(0);
                }}
              >
                Start over
              </Button>
            </div>
          }
        />
      </Specimen>
      <Specimen label="Launch stepper · vertical side rail" source="21st.dev @ddoemonn/wizard-steps (id 23576), side rail written for Varada">
        <Stepper label="Launch steps (side rail)" orientation="vertical" steps={LAUNCH_STEPS} defaultIndex={2} headingLevel={4} />
      </Specimen>
    </div>
  );
}

function CountdownDemo() {
  const [epochClose, setEpochClose] = useState<number | null>(null);
  const [demoTarget, setDemoTarget] = useState<number | null>(null);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    setEpochClose(nextEpochClose(Date.now()));
  }, []);
  return (
    <Specimen label="Countdown" source="Written for Varada · segments after 21st.dev @anubra266/countdown-timer (id 6067)">
      {epochClose ? (
        <Countdown to={epochClose} label="Epoch 12 voting closes in" />
      ) : (
        <span aria-hidden="true" className="num text-3xl text-ink-muted">
          --
        </span>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {demoTarget ? (
          <Countdown key={demoTarget} to={demoTarget} variant="inline" label="Demo epoch" doneText="Closed · tallying votes" onDone={() => setClosed(true)} />
        ) : null}
        <Button
          size="sm"
          variant="cause"
          onClick={() => {
            setClosed(false);
            setDemoTarget(Date.now() + 10_000);
          }}
        >
          Run a 10 second epoch
        </Button>
        {closed ? <Badge tone="cause">onDone fired</Badge> : null}
      </div>
      <p className="text-sm text-ink-muted">The digits are hidden from screen readers; a polite live region speaks the time left once a minute.</p>
    </Specimen>
  );
}

function DropzoneDemo() {
  const [logo, setLogo] = useState<File | null>(null);
  return (
    <Specimen label="Logo dropzone" source="21st.dev @joyco/file-dropzone (id 19201)">
      <FileDropzone label="Coin logo" hint="Square works best." value={logo} onChange={setLogo} name="logo" />
      <p className="num text-sm text-ink-muted">{logo ? `Selected: ${logo.name}` : "No file selected"}</p>
      <FileDropzone label="Cause banner (form error state)" error="A banner is required before you can publish." />
    </Specimen>
  );
}
