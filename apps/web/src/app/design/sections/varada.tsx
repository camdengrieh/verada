"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@varada/ui/components/ui/button";
import { ActivityFeed, type ActivityFeedItem } from "@varada/ui/components/varada/activity-feed";
import { ActivityTicker, type ActivityTickerItem } from "@varada/ui/components/varada/activity-ticker";
import { AssetKindBadge } from "@varada/ui/components/varada/asset-kind-badge";
import { BallotList } from "@varada/ui/components/varada/ballot-list";
import { BallotOption, BallotOptionGroup, type BallotOptionData } from "@varada/ui/components/varada/ballot-option";
import { CauseChip } from "@varada/ui/components/varada/cause-chip";
import { CAUSE_LABELS, CAUSE_NAMES, CauseIcon } from "@varada/ui/components/varada/cause-icon";
import { CausePoolCard } from "@varada/ui/components/varada/cause-pool-card";
import { CuratorAgentCard } from "@varada/ui/components/varada/curator-agent-card";
import { FeeSplitBar } from "@varada/ui/components/varada/fee-split-bar";
import { LiquidityPanel } from "@varada/ui/components/varada/liquidity-panel";
import { LogoMark } from "@varada/ui/components/varada/logo-mark";
import { ModeBadge } from "@varada/ui/components/varada/mode-badge";
import { PairChip } from "@varada/ui/components/varada/pair-chip";
import { PriceChange } from "@varada/ui/components/varada/price-change";
import { PrivacyPill, type PrivacyState } from "@varada/ui/components/varada/privacy-pill";
import { SiteHeader } from "@varada/ui/components/varada/site-header";
import { StockLogo } from "@varada/ui/components/varada/stock-logo";
import { TakeoverCard, type TakeoverVote } from "@varada/ui/components/varada/takeover-card";
import { TokenCard, type TokenSummary } from "@varada/ui/components/varada/token-card";
import { TokenRow } from "@varada/ui/components/varada/token-row";
import { TradePanel, type TradeSide } from "@varada/ui/components/varada/trade-panel";
import { VoteFlowDialog, type VoteFlowState } from "@varada/ui/components/varada/vote-flow-dialog";
import { useAssetUrl } from "@varada/ui/lib/assets";
import { GallerySection, Specimen } from "../section";

/* ---------- sample data (not live) ---------- */

function useTokens(): [TokenSummary, TokenSummary, TokenSummary, TokenSummary] {
  const url = useAssetUrl();
  const art = (path: string) => ({ src: url(path) });
  return [
    {
      name: "Harambe's Wish",
      symbol: "HARAMBE",
      ens: "harambe.varada.eth",
      art: art("assets/scenes/harambe-v1-960.webp"),
      artAlt: "Painted gorilla in rainbow shades",
      wash: "sage",
      giving: { mode: "weekly" },
      change24h: 18.42,
      quote: { symbol: "NVDAon", kind: "stock" },
      cause: "wildlife",
      marketCap: "$412K",
      volume24h: "$96K",
      liquidity: "$58K",
      raised: "$3,210",
      raisedPct: 64,
    },
    {
      name: "Gorilla Mog",
      symbol: "MOG",
      ens: "mog.varada.eth",
      art: art("assets/cutouts/gorilla-mog-320.webp"),
      artAlt: "Painted gorilla giving a sideways look",
      wash: "sky",
      giving: { mode: "live", cadence: "1h" },
      change24h: 42.0,
      quote: { symbol: "TSLAon", kind: "stock" },
      cause: "environment",
      marketCap: "$89K",
      volume24h: "$73K",
      liquidity: "$22K",
      raised: "$640",
      raisedPct: 14,
    },
    {
      name: "Tiger Wif Hat",
      symbol: "TIGR",
      ens: "tigr.varada.eth",
      art: art("assets/cutouts/tiger-wif-hat-320.webp"),
      artAlt: "Tiger in a knitted hat at a laptop",
      wash: "ochre",
      giving: { mode: "live", cadence: "24h" },
      change24h: -4.2,
      quote: { symbol: "WETH", kind: "crypto" },
      cause: "children",
      marketCap: "$268K",
      volume24h: "$41K",
      liquidity: "$36K",
      raised: "$1,905",
      raisedPct: 38,
    },
    {
      name: "Party King",
      symbol: "CROWN",
      ens: "crown.varada.eth",
      art: art("assets/cutouts/party-hat-320.webp"),
      artAlt: "Painted figure in a party hat",
      wash: "etf",
      giving: { mode: "weekly" },
      change24h: 0,
      quote: { symbol: "QQQon", kind: "etf" },
      cause: "hunger",
      marketCap: "$530K",
      volume24h: "$64K",
      liquidity: "$71K",
      raised: "$4,120",
      raisedPct: 82,
    },
  ];
}

const BALLOT: BallotOptionData[] = [
  { id: "1", org: "Save the Elephants", category: "wildlife", region: "Africa", source: "pinned" },
  { id: "2", org: "Wildlife SOS", category: "wildlife", region: "Asia", source: "pinned" },
  { id: "3", org: "Wildlife Conservation Network", category: "wildlife", region: "Global", source: "curated", score: "88/100" },
  { id: "4", org: "TRAFFIC International", category: "wildlife", region: "Global", source: "curated", score: "81/100" },
  { id: "5", org: "African Parks", category: "environment", region: "Africa", source: "curated", score: "79/100" },
  { id: "6", org: "Panthera", category: "wildlife", region: "Global", source: "curated", score: "77/100" },
  { id: "7", org: "Born Free USA", category: "animals", region: "North America", source: "rotation" },
  { id: "8", org: "Rainforest Trust", category: "environment", region: "Latin America & Caribbean", source: "rotation" },
  { id: "9", org: "Elephant Crisis Fund", category: "wildlife", region: "Africa", source: "rotation" },
  { id: "10", org: "Snow Leopard Trust", category: "wildlife", region: "Asia", source: "rotation" },
  { id: "11", org: "Innocence Project", category: "justice", region: "North America", source: "rotation" },
];

const TICKER: ActivityTickerItem[] = [
  { id: "t1", kind: "BUY", symbol: "$HARAMBE", text: "$1,240 via NVDAon" },
  { id: "t2", kind: "GIVE", symbol: "$MOG", text: "$84.10 to Rainforest Trust" },
  { id: "t3", kind: "NEW", symbol: "$SPLASH", text: "launched, paired with AAPLon" },
  { id: "t4", kind: "VOTE", symbol: "$GIGA", text: "212 ballots this epoch" },
  { id: "t5", kind: "SELL", symbol: "$TIGR", text: "$430 to WETH" },
  { id: "t6", kind: "GIVE", symbol: "$CROWN", text: "$1,050 to Feeding America" },
];

const FEED: ActivityFeedItem[] = [
  { id: "f1", symbol: "$ZEN", text: "gave to NAMI", ago: "just now", amount: "$412", cause: "mental-health", fresh: true },
  { id: "f2", symbol: "$MOG", text: "gave to Rainforest Trust", ago: "9 min ago", amount: "$84", cause: "environment" },
  { id: "f3", symbol: "$CROWN", text: "gave to Feeding America", ago: "1 h ago", amount: "$1,050", cause: "hunger" },
  { id: "f4", symbol: "$HARAMBE", text: "epoch 12 closed, Save the Elephants won", ago: "3 h ago", cause: "wildlife" },
  { id: "f5", symbol: "$FREE", text: "rotated to Innocence Project", ago: "5 h ago", cause: "justice" },
];

const NAV = [
  { href: "#varada-discover", label: "Discover" },
  { href: "#varada-launch", label: "Launch" },
  { href: "#varada-causes", label: "Causes" },
  { href: "#varada-governance", label: "Governance" },
  { href: "#varada-agents", label: "Agents" },
];

const noop = () => undefined;

/**
 * The same demo in a 360px column and in a wide one. The components are size containers, so this is
 * what they look like in a phone-width card versus a desktop column, whatever the window width.
 */
function NarrowWide({ children, stack, wideLabel = "Wide" }: { children: (width: "narrow" | "wide") => ReactNode; stack?: boolean; wideLabel?: string }) {
  return (
    <div className={stack ? "flex flex-col gap-5" : "flex flex-col gap-5 xl:flex-row xl:items-start"}>
      <figure className="m-0 flex w-full max-w-[360px] shrink-0 flex-col gap-2">
        <figcaption className="text-xs font-semibold text-ink-muted">360px</figcaption>
        {children("narrow")}
      </figure>
      <figure className="m-0 flex min-w-0 flex-1 flex-col gap-2">
        <figcaption className="text-xs font-semibold text-ink-muted">{wideLabel}</figcaption>
        {children("wide")}
      </figure>
    </div>
  );
}

/* ---------- interactive demos ---------- */

const NVDA_PRICE = 129.48;
const NVDA_BALANCE = 3402.18;
const HARAMBE_PER_NVDA = 30_655_000;

function TradeDemo() {
  const [side, setSide] = useState<TradeSide>("buy");
  const [amount, setAmount] = useState("9.65");
  const [slippage, setSlippage] = useState(1);
  const n = parseFloat(amount) || 0;
  const buying = side === "buy";
  const nvda = buying ? n : n / HARAMBE_PER_NVDA;
  const fee = nvda * NVDA_PRICE * 0.025;
  const out = buying ? n * HARAMBE_PER_NVDA : n / HARAMBE_PER_NVDA;
  const fmtOut = (v: number) => (buying ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toFixed(4));
  return (
    <TradePanel
      side={side}
      onSideChange={(s) => {
        setSide(s);
        setAmount("");
      }}
      pay={buying ? { symbol: "NVDAon", kind: "stock", balance: "3,402.18" } : { symbol: "$HARAMBE", kind: "crypto", balance: "38,900,000" }}
      receive={buying ? { symbol: "$HARAMBE" } : { symbol: "NVDAon", kind: "stock" }}
      payAmount={amount}
      onPayAmountChange={setAmount}
      payFiat={n ? `$${(nvda * NVDA_PRICE).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : undefined}
      receiveAmount={n ? fmtOut(out) : ""}
      payPriceUsd={buying ? NVDA_PRICE : undefined}
      onPickPayToken={noop}
      slippage={slippage}
      onSlippageChange={setSlippage}
      priceImpact={nvda > 50 ? 4.8 : nvda > 20 ? 1.6 : 0.42}
      minReceived={n ? fmtOut(out * (1 - slippage / 100)) : undefined}
      fee="2.5%"
      sniperFee={{ active: false }}
      causeAmount={n ? `$${(fee * 0.9).toFixed(2)}` : undefined}
      platformAmount={n ? `$${(fee * 0.1).toFixed(2)}` : undefined}
      causeName="the cause the holders pick this week"
      causeIcon="wildlife"
      blocker={buying && n > NVDA_BALANCE ? { label: "Insufficient NVDAon balance" } : !buying && n > 38_900_000 ? { label: "Insufficient $HARAMBE balance" } : null}
      onSubmit={noop}
    />
  );
}

function VoteDemo() {
  const [choice, setChoice] = useState("1");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<VoteFlowState>("confirm");
  const option = BALLOT.find((o) => o.id === choice) ?? BALLOT[0]!;

  // Simulated progress: encrypt, then the wallet signs, then sent.
  useEffect(() => {
    if (!open || (state !== "encrypting" && state !== "wallet")) return;
    const t = setTimeout(() => setState(state === "encrypting" ? "wallet" : "sent"), 1600);
    return () => clearTimeout(t);
  }, [open, state]);

  const openAt = (s: VoteFlowState) => {
    setState(s);
    setOpen(true);
  };

  return (
    <div className="flex flex-col gap-3">
      <BallotList
        options={BALLOT}
        value={choice}
        onValueChange={setChoice}
        footer={
          <>
            <span className="text-sm text-ink-soft @2xl:flex-[1_1_280px]">
              Your choice is encrypted in your browser. Nobody, including Varada, can see who you voted for; only the totals are decrypted when voting ends.
            </span>
            <Button variant="cause" size="lg" onClick={() => openAt("confirm")}>
              Vote for {option.org}
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-muted">Open the dialog at:</span>
        {(["confirm", "encrypting", "wallet", "sent", "error"] as const).map((s) => (
          <Button key={s} size="sm" variant="outline" onClick={() => openAt(s)}>
            {s}
          </Button>
        ))}
      </div>
      <VoteFlowDialog
        open={open}
        onOpenChange={setOpen}
        state={state}
        choice={{ org: option.org, category: option.category }}
        weight="38.9M $HARAMBE"
        onConfirm={() => setState("encrypting")}
        onRetry={() => setState("wallet")}
        error="Your wallet rejected the signature. Nothing was sent."
        failedStep={1}
      />
    </div>
  );
}

function TakeoverDemo() {
  const [vote, setVote] = useState<TakeoverVote | undefined>();
  return (
    <TakeoverCard
      status="active"
      proposal={
        <>
          Replace the controller with <span className="num">0x52e1…aa04</span>. It manages pins and the profile.
        </>
      }
      turnout={3.1}
      quorum={5}
      endsIn="ends in 1d 6h"
      myVote={vote}
      onVote={setVote}
    />
  );
}

const PRIVACY_STATES: PrivacyState[] = ["connecting", "private", "failed", "direct"];

function PrivacyDemo() {
  const [i, setI] = useState(1);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {PRIVACY_STATES.map((s) => (
          <PrivacyPill key={s} state={s} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <PrivacyPill state={PRIVACY_STATES[i] ?? "private"} onClick={() => setI((i + 1) % PRIVACY_STATES.length)} />
        <span className="text-sm text-ink-muted">As a button: click to cycle the states</span>
      </div>
    </div>
  );
}

/* ---------- section ---------- */

export function VaradaSection() {
  const tokens = useTokens();
  const [harambe, mog, tigr, crown] = tokens;

  return (
    <GallerySection
      id="varada"
      title="Varada components"
      intro="The pieces only Varada needs: coins, causes, giving modes, trading, private voting and the live strips. All presentational; the app passes data and callbacks in. They lay out for their own width (container queries), so the narrow and wide demos below differ whatever the window size. Sample data."
    >
      <Specimen label="Site header" source="21st.dev @ln-dev7/header-17 (id 26888) · radix Dialog sheet">
        <NarrowWide stack wideLabel="Full column">
          {() => (
            <div className="overflow-hidden rounded-xl border border-line">
              <SiteHeader
                className="static"
                links={NAV}
                activeHref="#varada-discover"
                homeHref="#varada"
                search={{}}
                privacy={<PrivacyPill state="private" />}
                wallet={<Button>Connect wallet</Button>}
              />
            </div>
          )}
        </NarrowWide>
        <p className="m-0 text-sm text-ink-muted">
          Press / to jump to search. The header collapses by its own width: wallet from 448px, search from 672px, privacy from 1024px, nav links from 1280px. Everything
          hidden is in the menu sheet.
        </p>
      </Specimen>

      <Specimen label="Activity ticker" source="21st.dev @kevingirelli/marquee (id 35200) · animate-marquee">
        <div className="overflow-hidden rounded-xl border border-line">
          <ActivityTicker items={TICKER} className="border-b-0" />
        </div>
        <p className="m-0 text-sm text-ink-muted">Pauses on hover and focus; with reduced motion it stops and scrolls by hand.</p>
      </Specimen>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Logo mark" source="Written for Varada">
          <div className="flex flex-wrap items-center gap-5">
            <LogoMark size={56} />
            <LogoMark size={40} ringColor="var(--sage)" />
            <LogoMark size={40} ringColor="var(--ochre)" />
            <span className="inline-flex rounded-2xl bg-ink p-3 text-paper">
              <LogoMark size={40} ringColor="var(--ochre)" />
            </span>
            <LogoMark size={24} />
          </div>
        </Specimen>
        <Specimen label="Privacy pill" source="Written for Varada">
          <PrivacyDemo />
        </Specimen>
      </div>

      <Specimen label="Cause icons · all 21 categories" source="Written for Varada · assets/causes/*">
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-0">
          {CAUSE_NAMES.map((c) => (
            <li key={c} className="flex items-center gap-2 text-sm">
              <CauseIcon cause={c} size={40} decorative />
              <span>{CAUSE_LABELS[c]}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-3">
          <CauseIcon cause="water" size={24} label="Clean water" />
          <CauseIcon cause="water" size={40} label="Clean water" />
          <CauseIcon cause="water" size={64} label="Clean water" />
          <span className="text-sm text-ink-muted">Labelled (alt text) at 24, 40 and 64 px</span>
        </div>
      </Specimen>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Cause chips" source="Written for Varada">
          <div className="flex flex-wrap items-center gap-2">
            <CauseChip cause="wildlife" />
            <CauseChip cause="wildlife" regions={["Africa", "Asia"]} />
            <CauseChip cause="justice" size="sm" />
            <CauseChip cause="mental-health" />
            <span className="rounded-xl bg-ink p-2">
              <CauseChip cause="hunger" tone="ink" />
            </span>
          </div>
        </Specimen>
        <Specimen label="Stock logos · lettered fallback (stock pack not published yet, so no src)" source="Written for Varada">
          <div className="flex flex-wrap items-center gap-3">
            <StockLogo symbol="NVDAon" size={40} />
            <StockLogo symbol="TSLAon" size={32} />
            <StockLogo symbol="SPYon" kind="etf" size={32} />
            <StockLogo symbol="QQQon" kind="etf" size={24} />
            <StockLogo symbol="WETH" kind="crypto" size={24} />
            <StockLogo symbol="AAPLon" size={16} />
          </div>
        </Specimen>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Pair chips · asset kinds" source="Written for Varada">
          <div className="flex flex-wrap items-center gap-2">
            <PairChip coinSymbol="HARAMBE" coinImage={harambe.art} quoteSymbol="NVDAon" />
            <PairChip coinSymbol="MOG" coinImage={mog.art} quoteSymbol="TSLAon" />
            <PairChip coinSymbol="TIGR" coinImage={tigr.art} quoteSymbol="WETH" quoteKind="crypto" />
            <PairChip coinSymbol="HARAMBE" quoteSymbol="NVDAon" quoteOnly label="Paired with NVDAon" />
          </div>
          <div className="flex flex-wrap gap-2">
            <AssetKindBadge kind="stock" />
            <AssetKindBadge kind="etf" />
            <AssetKindBadge kind="rwa" />
            <AssetKindBadge kind="crypto" />
          </div>
        </Specimen>
        <Specimen label="Giving mode · price change" source="Written for Varada">
          <div className="flex flex-wrap gap-2">
            <ModeBadge giving={{ mode: "weekly" }} />
            <ModeBadge giving={{ mode: "live", cadence: "1h" }} />
            <ModeBadge giving={{ mode: "live", cadence: "24h" }} long />
            <ModeBadge giving={{ mode: "live", cadence: "week" }} />
          </div>
          <div className="flex flex-wrap items-baseline gap-4 text-lg">
            <PriceChange value={18.42} />
            <PriceChange value={-4.2} />
            <PriceChange value={0} />
            <PriceChange value={6.13} decimals={2} showPeriod />
          </div>
        </Specimen>
      </div>

      <Specimen label="Fee split" source="Written for Varada">
        <div className="grid gap-6 md:grid-cols-2">
          <FeeSplitBar />
          <FeeSplitBar causeAmount="$28.11" platformAmount="$3.12" causeLabel="to Save the Elephants" platformLabel="to Varada" />
        </div>
      </Specimen>

      <Specimen label="Token cards" source="Written for Varada · A-Discover board">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-[18px]">
          {tokens.map((t, i) => (
            <TokenCard key={t.symbol} token={t} href={`#varada-token-${t.symbol.toLowerCase()}`} onBuy={noop} priority={i < 2} />
          ))}
        </div>
      </Specimen>

      <Specimen label="Token card · narrow and feature width" source="Container queries: stats fold under 288px, art moves left from 576px">
        <NarrowWide wideLabel="Feature slot">
          {(w) =>
            w === "narrow" ? (
              <TokenCard token={mog} href="#varada-token-mog" onBuy={noop} />
            ) : (
              <TokenCard token={harambe} href="#varada-token-harambe" onBuy={noop} className="max-w-3xl" />
            )
          }
        </NarrowWide>
      </Specimen>

      <Specimen label="Token rows · mobile lists and watchlists" source="Written for Varada · A-Mobile board">
        <NarrowWide wideLabel="Wide (desktop watchlist columns from 512px)">
          {() => (
            <div className="flex flex-col gap-3">
              {[harambe, mog, crown].map((t) => (
                <TokenRow key={t.symbol} token={t} href={`#varada-token-${t.symbol.toLowerCase()}`} />
              ))}
              <TokenRow
                token={tigr}
                href="#varada-token-tigr"
                trailing={
                  <Button size="sm" variant="soft" className="min-h-11" aria-pressed="true" aria-label="Watching Tiger Wif Hat">
                    Watching
                  </Button>
                }
              />
            </div>
          )}
        </NarrowWide>
      </Specimen>

      <div className="grid gap-4 lg:grid-cols-2">
        <Specimen
          label="Trade panel · interactive: buy presets in USD, sell percentages"
          source="21st.dev @ssychui/swap-ticket (id 27122) + @ravikatiyar162/swap-card (id 7804)"
        >
          <TradeDemo />
        </Specimen>
        <div className="flex flex-col gap-4">
          <Specimen label="Trade panel · WETH presets disabled until a wallet connects, sniper fee, high impact" source="The button label names what's in the way">
            <TradePanel
              side="buy"
              onSideChange={noop}
              pay={{ symbol: "WETH", kind: "crypto" }}
              receive={{ symbol: "$HARAMBE" }}
              payAmount="0.5"
              onPayAmountChange={noop}
              presetsDisabledReason="Connect a wallet to use the presets."
              receiveAmount="295,820,000"
              slippage={1}
              fee="2.5%"
              sniperFee={{ active: true, detail: "12% · ends in 4m" }}
              priceImpact={4.8}
              causeAmount="$28.11"
              causeName="Save the Elephants"
              causeIcon="wildlife"
              blocker={{ label: "Connect wallet", onAction: noop }}
              onSubmit={noop}
            />
          </Specimen>
          <Specimen label="Trade panel · sell, waiting for the wallet">
            <TradePanel
              side="sell"
              onSideChange={noop}
              pay={{ symbol: "$MOG", kind: "crypto", balance: "12,400,000" }}
              receive={{ symbol: "TSLAon", kind: "stock" }}
              payAmount="1200000"
              onPayAmountChange={noop}
              receiveAmount="0.3810"
              slippage={0.5}
              fee="2.5%"
              sniperFee={{ active: false }}
              priceImpact={1.6}
              minReceived="0.3791"
              causeAmount="$2.14"
              causeName="Rainforest Trust"
              causeIcon="environment"
              pending
              onSubmit={noop}
            />
          </Specimen>
        </div>
      </div>

      <Specimen label="Trade panel · WBTC and USDC presets, narrow and wide" source="Chips three to a row under 320px; inputs and details side by side from 672px">
        <NarrowWide>
          {(w) =>
            w === "narrow" ? (
              <TradePanel
                side="buy"
                onSideChange={noop}
                pay={{ symbol: "WBTC", kind: "crypto", balance: "0.0842" }}
                receive={{ symbol: "$HARAMBE" }}
                payAmount="0.001"
                onPayAmountChange={noop}
                payPriceUsd={97_120}
                payFiat="$97.12"
                receiveAmount="23,572,815"
                slippage={1}
                fee="2.5%"
                priceImpact={0.42}
                causeAmount="$2.19"
                causeName="Save the Elephants"
                causeIcon="wildlife"
                onSubmit={noop}
              />
            ) : (
              <TradePanel
                side="buy"
                onSideChange={noop}
                pay={{ symbol: "USDC", kind: "crypto", balance: "2,450.00" }}
                receive={{ symbol: "$TIGR" }}
                payAmount="100"
                onPayAmountChange={noop}
                payFiat="$100.00"
                receiveAmount="1,204,800"
                slippage={0.5}
                fee="2.5%"
                priceImpact={1.6}
                minReceived="1,198,776"
                causeAmount="$2.25"
                platformAmount="$0.25"
                causeName="Save the Children"
                causeIcon="children"
                onSubmit={noop}
              />
            )
          }
        </NarrowWide>
      </Specimen>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Specimen label="Liquidity · market closed" source="Written for Varada · A-Token board">
          <LiquidityPanel
            quote={{ symbol: "NVDAon", name: "NVIDIA (Ondo)", kind: "stock", description: "Tokenized stock · 18 decimals" }}
            poolLiquidity="$58,200"
            quotePrice="$129.48"
            routeDepth="$212K"
            lpStatus="Locked forever"
            route="Fees convert $HARAMBE → NVDAon → USDC before donation."
            warning
          />
        </Specimen>
        <Specimen label="Liquidity · WETH pair" source="Written for Varada">
          <LiquidityPanel
            quote={{ symbol: "WETH", name: "Wrapped Ether", kind: "crypto", description: "18 decimals" }}
            poolLiquidity="$36,040"
            quotePrice="$3,050.12"
            routeDepth="$48M"
            lpStatus="Locked forever"
            route="Fees convert $TIGR → WETH → USDC before donation."
          />
        </Specimen>
        <Specimen label="Cause pool" source="Written for Varada · A-Token board">
          <CausePoolCard
            epoch={12}
            countdown="closes in 2d 14h"
            amount="$1,284.60"
            attributed="$1,112.40"
            carriedForward="$172.20"
            ballot={{ pinned: 2, curated: 6, rotation: 24 }}
            curator="wildlife.agent.varada.eth"
            voteHref="#varada-vote"
          />
        </Specimen>
      </div>

      <Specimen label="Cards at 360px and wide" source="Liquidity, cause pool, takeover, curator agent and live giving">
        <NarrowWide>
          {() => (
            <div className="flex flex-col gap-4">
              <CausePoolCard
                epoch={12}
                countdown="closes in 2d 14h"
                amount="$1,284.60"
                attributed="$1,112.40"
                carriedForward="$172.20"
                ballot={{ pinned: 2, curated: 6, rotation: 24 }}
                curator="wildlife.agent.varada.eth"
                voteHref="#varada-vote"
              />
              <LiquidityPanel
                quote={{ symbol: "WBTC", name: "Wrapped Bitcoin", kind: "crypto", description: "8 decimals" }}
                poolLiquidity="$19,400"
                quotePrice="$97,120"
                routeDepth="$21M"
                lpStatus="Locked forever"
                route="Fees convert $MOG → WBTC → USDC before donation."
              />
              <TakeoverCard
                status="active"
                proposal={
                  <>
                    Replace the controller with <span className="num">0x52e1…aa04</span>. It manages pins and the profile.
                  </>
                }
                turnout={3.1}
                quorum={5}
                endsIn="ends in 1d 6h"
                onVote={noop}
              />
              <CuratorAgentCard
                ens="wildlife.agent.varada.eth"
                cause="wildlife"
                status="active"
                agentId={14}
                picks={6}
                rationale="Poaching pressure rose in East Africa after the drought."
                topPicks={[
                  { org: "Save the Elephants", score: "94/100" },
                  { org: "TRAFFIC International", score: "81/100" },
                ]}
                verified
              />
              <ActivityFeed items={FEED} />
            </div>
          )}
        </NarrowWide>
      </Specimen>

      <Specimen label="Ballot list and private vote flow" source="21st.dev @sean0205/c-radio-group-8 (id 28339) · @ddoemonn/task-steps (id 23569)">
        <NarrowWide>
          {(w) =>
            w === "narrow" ? (
              <BallotList
                options={BALLOT}
                defaultValue="1"
                footer={
                  <Button variant="cause" size="lg">
                    Vote privately
                  </Button>
                }
              />
            ) : (
              <VoteDemo />
            )
          }
        </NarrowWide>
      </Specimen>

      <Specimen label="Ballot options · unselected, selected, disabled" source="21st.dev @sean0205/c-radio-group-8 (id 28339)">
        <BallotOptionGroup defaultValue="b" aria-label="Ballot option states" className="max-w-md">
          <BallotOption option={{ id: "a", org: "Save the Elephants", category: "wildlife", region: "Africa", source: "pinned" }} />
          <BallotOption option={{ id: "b", org: "Innocence Project", category: "justice", region: "North America", source: "curated", score: "92/100" }} />
          <BallotOption option={{ id: "c", org: "Rainforest Trust", category: "environment", region: "Latin America & Caribbean", source: "rotation" }} />
          <BallotOption option={{ id: "d", org: "Snow Leopard Trust", category: "wildlife", region: "Asia", source: "rotation" }} disabled />
        </BallotOptionGroup>
      </Specimen>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Specimen label="Curator agent" source="Written for Varada · A-Vote board">
          <CuratorAgentCard
            ens="wildlife.agent.varada.eth"
            cause="wildlife"
            status="active"
            agentId={14}
            picks={6}
            rationale="Poaching pressure rose in East Africa after the drought. Rangers and anti-trafficking groups are the most urgent this week."
            topPicks={[
              { org: "Save the Elephants", score: "94/100" },
              { org: "Wildlife Conservation Network", score: "88/100" },
              { org: "TRAFFIC International", score: "81/100" },
            ]}
            verified
            reportHref="#varada-report"
          />
          <CuratorAgentCard ens="justice.agent.varada.eth" cause="justice" status="pending" wash="etf" verified={false} />
        </Specimen>
        <div className="flex flex-col gap-4">
          <Specimen label="Takeover · interactive" source="Written for Varada">
            <TakeoverDemo />
          </Specimen>
          <Specimen label="Takeover · can't vote, and passed">
            <TakeoverCard
              status="active"
              proposal="Replace the controller with 0x9b0c…e1f2."
              turnout={1.2}
              quorum={5}
              onVote={noop}
              disabledReason="Hold $MOG at the snapshot to vote."
            />
            <TakeoverCard status="passed" proposal="Controller replaced with 0x52e1…aa04." turnout={6.4} quorum={5} forPct={71} againstPct={29} />
          </Specimen>
        </div>
        <Specimen label="Live giving · list and empty" source="21st.dev @olewandowski1/activity-1 (id 28482)">
          <ActivityFeed items={FEED} />
          <ActivityFeed items={[]} title="Live giving" />
        </Specimen>
      </div>
    </GallerySection>
  );
}
