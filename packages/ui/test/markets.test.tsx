import { fireEvent, render, screen, within } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LiquidityMeter, liquidityFraction, liquidityTier } from "@verada/ui/components/varada/liquidity-meter";
import { MarketStatus, formatTimeUntil, newYorkParts, usMarketSession } from "@verada/ui/components/varada/market-status";
import { PriceImpactLadder, ladderSeverity } from "@verada/ui/components/varada/price-impact-ladder";
import { StockMarketCard, launchability, type OndoAsset } from "@verada/ui/components/varada/stock-market-card";
import { StockMarketList, filterStockAssets, stockKindCounts } from "@verada/ui/components/varada/stock-market-list";
import {
  TradePanel,
  defaultBuyPresets,
  percentOfBalance,
  usdToTokenAmount,
  type TradePanelProps,
  type TradeSide,
} from "@verada/ui/components/varada/trade-panel";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  MotionGlobalConfig.skipAnimations = true;
});

const at = (iso: string) => new Date(iso);

describe("usMarketSession", () => {
  it("opens at 9:30 New York time in winter (EST, UTC-5)", () => {
    expect(usMarketSession(at("2026-01-13T14:29:00Z")).session).toBe("pre");
    const open = usMarketSession(at("2026-01-13T14:30:00Z"));
    expect(open.session).toBe("open");
    expect(open.nextEvent).toBe("closes");
    expect(open.next?.toISOString()).toBe("2026-01-13T21:00:00.000Z");
  });

  it("opens at 9:30 New York time in summer (EDT, UTC-4)", () => {
    expect(usMarketSession(at("2026-07-14T13:29:00Z")).session).toBe("pre");
    expect(usMarketSession(at("2026-07-14T13:30:00Z")).session).toBe("open");
    expect(usMarketSession(at("2026-07-14T19:59:00Z")).session).toBe("open");
    expect(usMarketSession(at("2026-07-14T20:00:00Z")).session).toBe("after");
  });

  it("finds Monday's open across the spring DST change", () => {
    // Saturday 7 March 2026 is still EST; Monday 9 March is EDT.
    const s = usMarketSession(at("2026-03-07T15:00:00Z"));
    expect(s.session).toBe("closed");
    expect(s.tradingDay).toBe(false);
    expect(s.next?.toISOString()).toBe("2026-03-09T13:30:00.000Z");
  });

  it("finds Monday's open across the autumn DST change", () => {
    // Friday 30 October 2026 after the close is EDT; Monday 2 November is EST.
    const s = usMarketSession(at("2026-10-30T21:30:00Z"));
    expect(s.session).toBe("after");
    expect(s.next?.toISOString()).toBe("2026-11-02T14:30:00.000Z");
  });

  it("is closed overnight and on Sunday, and before 4:00 it waits for today's open", () => {
    expect(usMarketSession(at("2026-01-14T01:30:00Z")).session).toBe("closed"); // 20:30 Tuesday
    const early = usMarketSession(at("2026-01-14T08:00:00Z")); // 03:00 Wednesday
    expect(early.session).toBe("closed");
    expect(early.next?.toISOString()).toBe("2026-01-14T14:30:00.000Z");
    expect(usMarketSession(at("2026-01-11T17:00:00Z")).session).toBe("closed"); // Sunday
  });

  it("honours holidays, early closes and pauses", () => {
    const holidays = ["2026-11-26"];
    const thanksgiving = usMarketSession(at("2026-11-26T16:00:00Z"), { holidays });
    expect(thanksgiving.session).toBe("closed");
    expect(thanksgiving.next?.toISOString()).toBe("2026-11-27T14:30:00.000Z");
    const half = usMarketSession(at("2026-11-27T18:30:00Z"), { holidays, earlyCloses: ["2026-11-27"] });
    expect(half.session).toBe("after");
    expect(usMarketSession(at("2026-11-27T17:00:00Z"), { earlyCloses: ["2026-11-27"] }).next?.toISOString()).toBe("2026-11-27T18:00:00.000Z");
    const paused = usMarketSession(at("2026-01-13T15:00:00Z"), { paused: true });
    expect(paused).toMatchObject({ session: "paused", next: null });
  });

  it("reads New York wall time through Intl", () => {
    expect(newYorkParts(at("2026-07-04T04:00:00Z"))).toMatchObject({ year: 2026, month: 7, day: 4, hour: 0, weekday: 6 });
    expect(formatTimeUntil(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatTimeUntil(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(formatTimeUntil(30_000)).toBe("under a minute");
  });

  it("renders the pill with the time to the next change", () => {
    const { rerender } = render(<MarketStatus now={at("2026-01-13T14:30:00Z")} />);
    expect(screen.getByText("Market open")).toBeInTheDocument();
    expect(screen.getByText("6h 30m")).toHaveAttribute("datetime", "2026-01-13T21:00:00.000Z");
    rerender(<MarketStatus now={at("2026-01-13T14:30:00Z")} paused />);
    expect(screen.getByText("Paused by Ondo")).toBeInTheDocument();
    expect(screen.queryByText(/closes in/)).toBeNull();
  });
});

function Harness(props: Partial<TradePanelProps> & { initialSide?: TradeSide }) {
  const { initialSide = "buy", ...rest } = props;
  const [side, setSide] = useState<TradeSide>(initialSide);
  const [amount, setAmount] = useState("");
  return (
    <TradePanel
      side={side}
      onSideChange={setSide}
      pay={side === "buy" ? { symbol: "WETH", kind: "crypto", balance: "1.8421" } : { symbol: "$HARAMBE", kind: "crypto", balance: "38,900,000" }}
      receive={side === "buy" ? { symbol: "$HARAMBE" } : { symbol: "WETH", kind: "crypto" }}
      payAmount={amount}
      onPayAmountChange={setAmount}
      receiveAmount=""
      slippage={1}
      fee="2.5%"
      causeName="Save the Elephants"
      onSubmit={() => {}}
      {...rest}
    />
  );
}

describe("TradePanel presets", () => {
  it("fills the pay input from a WETH preset and shows it pressed until edited", async () => {
    const onPreset = vi.fn();
    render(<Harness onPreset={onPreset} />);
    const group = screen.getByRole("group", { name: "Amount presets in WETH" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["0.01", "0.05", "0.1", "0.5", expect.stringMatching(/^Max/)]);

    fireEvent.click(screen.getByRole("button", { name: "Pay 0.05 WETH" }));
    const input = screen.getByLabelText("You pay");
    expect(input).toHaveValue("0.05");
    expect(screen.getByRole("button", { name: "Pay 0.05 WETH" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Pay 0.1 WETH" })).toHaveAttribute("aria-pressed", "false");
    expect(onPreset).toHaveBeenLastCalledWith({ key: "0.05", amount: "0.05", percent: undefined });

    fireEvent.click(screen.getByRole("button", { name: "Use your whole WETH balance" }));
    expect(input).toHaveValue("1.8421");

    fireEvent.change(input, { target: { value: "0.07" } });
    for (const chip of within(group).getAllByRole("button")) expect(chip).toHaveAttribute("aria-pressed", "false");
    await screen.findByRole("button", { name: "Review buy" });
  });

  it("moves between chips with the arrow keys", () => {
    render(<Harness />);
    const first = screen.getByRole("button", { name: "Pay 0.01 WETH" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Pay 0.05 WETH" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("button", { name: "Use your whole WETH balance" })).toHaveFocus();
  });

  it("converts USD presets into a priced pay asset", () => {
    expect(usdToTokenAmount(100, 129.48)).toBe("0.77232");
    const presets = defaultBuyPresets("NVDAon", 129.48);
    expect(presets.map((p) => p.label)).toEqual(["$50", "$100", "$250", "$500"]);
    expect(presets[1]).toMatchObject({ amount: "0.77232", detail: "0.7723 NVDAon" });
    expect(defaultBuyPresets("USDC").map((p) => p.amount)).toEqual(["50", "100", "250", "500"]);

    const onPayAmountChange = vi.fn();
    render(<Harness pay={{ symbol: "NVDAon", kind: "stock", balance: "3,402.18" }} payPriceUsd={129.48} onPayAmountChange={onPayAmountChange} />);
    fireEvent.click(screen.getByRole("button", { name: /^Pay \$250 in NVDAon/ }));
    expect(onPayAmountChange).toHaveBeenLastCalledWith(usdToTokenAmount(250, 129.48));
  });

  it("sells a percent of the coin balance and shows the resulting amount", async () => {
    render(<Harness initialSide="sell" />);
    const group = screen.getByRole("group", { name: "Sell a share of your $HARAMBE balance" });
    expect(within(group).getAllByRole("button").map((b) => b.firstChild?.textContent)).toEqual(["10%", "25%", "50%", "75%", "Max"]);
    const quarter = screen.getByRole("button", { name: "Use 25% of your $HARAMBE balance" });
    expect(quarter).toHaveAccessibleDescription("9725000 $HARAMBE");
    expect(quarter).toHaveTextContent("9.73M");
    fireEvent.click(quarter);
    expect(screen.getByLabelText("You pay")).toHaveValue("9725000");
    expect(quarter).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Use your whole $HARAMBE balance" }));
    expect(screen.getByLabelText("You pay")).toHaveValue("38900000");
    expect(percentOfBalance("3,402.18", 25)).toBe("850.545");
    expect(percentOfBalance("0.3", 10)).toBe("0.03");
    await screen.findByRole("button", { name: "Review sell" });
  });

  it("disables the chips with a reason when there is no balance", () => {
    render(<Harness pay={{ symbol: "WETH", kind: "crypto" }} />);
    const chip = screen.getByRole("button", { name: "Pay 0.01 WETH" });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAccessibleDescription("No WETH balance");
    expect(screen.getByText("No WETH balance")).toBeVisible();
  });

  it("can hide the chips", () => {
    render(<Harness buyPresets={false} />);
    expect(screen.queryByRole("group", { name: /Amount presets/ })).toBeNull();
  });
});

describe("LiquidityMeter", () => {
  it("grades depth by threshold, in words as well as colour", () => {
    expect(liquidityTier(0)).toBe("none");
    expect(liquidityTier(undefined)).toBe("none");
    expect(liquidityTier(24_999)).toBe("thin");
    expect(liquidityTier(25_000)).toBe("ok");
    expect(liquidityTier(250_000)).toBe("deep");
    expect(liquidityTier(30_000, { ok: 50_000, deep: 500_000 })).toBe("thin");
    expect(liquidityFraction(10_000_000)).toBe(1);
    expect(liquidityFraction(100_000)).toBeCloseTo(0.5);
  });

  it("labels the meter", () => {
    const { rerender } = render(<LiquidityMeter value={58_200} label="Route depth" />);
    const meter = screen.getByRole("meter", { name: "Route depth" });
    expect(meter).toHaveAttribute("aria-valuetext", "Route depth: $58.2K, ok");
    expect(screen.getByText("OK")).toBeInTheDocument();
    rerender(<LiquidityMeter value={0} label="Route depth" />);
    expect(screen.getByText("No liquidity")).toBeInTheDocument();
    expect(screen.getByRole("meter").querySelectorAll("[data-lit]")).toHaveLength(0);
  });
});

describe("PriceImpactLadder", () => {
  it("flags sizes over the warning threshold", () => {
    expect(ladderSeverity(0.4)).toBe("low");
    expect(ladderSeverity(1.2)).toBe("caution");
    expect(ladderSeverity(3)).toBe("warn");
    expect(ladderSeverity(null)).toBe("unfillable");
    render(
      <PriceImpactLadder
        steps={[
          { size: 100, impact: 0.08 },
          { size: 1_000, impact: 0.6 },
          { size: 10_000, impact: 4.1 },
          { size: 50_000, impact: null },
        ]}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => r.getAttribute("data-severity"))).toEqual(["low", "low", "warn", "unfillable"]);
    expect(within(rows[2]!).getByText("High")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Can't fill")).toBeInTheDocument();
    expect(screen.getByText(/2 of 4 sizes are over it/)).toBeInTheDocument();
  });
});

const ASSETS: OndoAsset[] = [
  { symbol: "NVDAon", name: "NVIDIA", kind: "stock", price: 129.48, change24h: 2.1, routeDepthUsd: 1_200_000, route: ["NVDAon", "USDC"], coinsPaired: 14 },
  { symbol: "TSLAon", name: "Tesla", kind: "stock", price: 248.5, change24h: -3.4, routeDepthUsd: 310_000, route: ["TSLAon", "USDC"], coinsPaired: 6 },
  { symbol: "PLTRon", name: "Palantir", kind: "stock", price: 41.2, change24h: 5.6, routeDepthUsd: 4_100, route: ["PLTRon", "WETH", "USDC"], coinsPaired: 1 },
  { symbol: "AMDon", name: "Advanced Micro Devices", kind: "stock", price: 152.1, change24h: 0.4, routeDepthUsd: 0, route: [] },
  { symbol: "SPYon", name: "SPDR S&P 500 ETF Trust", kind: "etf", price: 571.3, change24h: 0.6, routeDepthUsd: 860_000, route: ["SPYon", "USDC"], coinsPaired: 9 },
  { symbol: "GLDon", name: "SPDR Gold Shares", kind: "etf", price: 241.8, change24h: -0.2, routeDepthUsd: 18_000, route: ["GLDon", "USDC"], coinsPaired: 2, paused: true },
];
const NOW = at("2026-01-13T15:00:00Z");

describe("filterStockAssets", () => {
  it("searches symbol and name, filters kind and launchable, and sorts", () => {
    expect(filterStockAssets(ASSETS, { query: "nvda" }).map((a) => a.symbol)).toEqual(["NVDAon"]);
    expect(filterStockAssets(ASSETS, { query: "gold" }).map((a) => a.symbol)).toEqual(["GLDon"]);
    expect(filterStockAssets(ASSETS, { kind: "etf" }).map((a) => a.symbol)).toEqual(["SPYon", "GLDon"]);
    expect(filterStockAssets(ASSETS).map((a) => a.symbol)).toEqual(["NVDAon", "SPYon", "TSLAon", "GLDon", "PLTRon", "AMDon"]);
    expect(filterStockAssets(ASSETS, { sort: "change" })[0]?.symbol).toBe("PLTRon");
    expect(filterStockAssets(ASSETS, { sort: "name" }).map((a) => a.symbol)).toEqual(["AMDon", "GLDon", "NVDAon", "PLTRon", "SPYon", "TSLAon"]);
    expect(filterStockAssets(ASSETS, { launchableOnly: true }).map((a) => a.symbol)).toEqual(["NVDAon", "SPYon", "TSLAon", "GLDon"]);
    expect(stockKindCounts(ASSETS, { launchableOnly: true })).toEqual({ all: 4, stock: 2, etf: 2 });
    expect(launchability(ASSETS[2]!)).toEqual({ ok: false, reason: "Route depth $4.1K is under the $10K minimum" });
    expect(launchability(ASSETS[3]!)).toEqual({ ok: false, reason: "No route to USDC" });
  });
});

describe("StockMarketList", () => {
  it("filters rows by search, kind chip and the launchable toggle", () => {
    render(<StockMarketList assets={ASSETS} now={NOW} getHref={(a) => `/stocks/${a.symbol}/`} />);
    const table = screen.getByRole("table", { name: "Stocks & RWA" });
    const bodyRows = () => within(table).getAllByRole("row").filter((r) => within(r).queryAllByRole("cell").length > 0);
    expect(bodyRows()).toHaveLength(6);
    expect(screen.getByRole("link", { name: "NVDAon, NVIDIA" })).toHaveAttribute("href", "/stocks/NVDAon/");

    fireEvent.click(screen.getByRole("radio", { name: "ETFs, 2" }));
    expect(bodyRows().map((r) => within(r).getByRole("link").textContent)).toEqual(["SPYon", "GLDon"]);

    fireEvent.click(screen.getByRole("radio", { name: "All, 6" }));
    fireEvent.click(screen.getByRole("switch", { name: "Launchable only" }));
    expect(bodyRows()).toHaveLength(4);
    expect(screen.getByText(/4 of 6 assets/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Ondo assets" }), { target: { value: "zzz" } });
    expect(screen.getByText("No assets match")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(bodyRows()).toHaveLength(6);
  });

  it("sorts with the sort control", () => {
    render(<StockMarketList assets={ASSETS} now={NOW} getHref={(a) => `/stocks/${a.symbol}/`} />);
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "name" } });
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["AMDon", "GLDon", "NVDAon", "PLTRon", "SPYon", "TSLAon"]);
  });

  it("works as a radio group in the launch Pair step", () => {
    function Pick() {
      const [value, setValue] = useState<string | null>("SPYon");
      return <StockMarketList mode="select" assets={ASSETS} now={NOW} value={value} onValueChange={setValue} />;
    }
    render(<Pick />);
    const group = screen.getByRole("radiogroup", { name: "Quote asset" });
    expect(within(group).getByRole("radio", { name: "SPYon, SPDR S&P 500 ETF Trust" })).toBeChecked();
    const nvda = within(group).getByRole("radio", { name: "NVDAon, NVIDIA" });
    fireEvent.click(nvda);
    expect(nvda).toBeChecked();
    const pltr = within(group).getByRole("radio", { name: "PLTRon, Palantir" });
    expect(pltr).toBeDisabled();
    expect(pltr).toHaveAccessibleDescription(/not launchable: Route depth \$4\.1K is under the \$10K minimum/);
    expect(within(group).getByRole("radio", { name: "GLDon, SPDR Gold Shares" })).toHaveAccessibleDescription(/Paused by Ondo/);
  });
});

describe("StockMarketCard", () => {
  it("shows the stale note, route hops and launchability", () => {
    render(
      <StockMarketCard
        asset={{ ...ASSETS[0]!, poolLiquidityUsd: 2_400_000, reserves: { base: { symbol: "NVDAon", usd: 1_250_000 }, quote: { symbol: "USDC", usd: 1_150_000 } } }}
        now={at("2026-01-14T02:00:00Z")}
        coinSymbol="HARAMBE"
      />,
    );
    expect(screen.getByText("Market closed")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/NVDAon prices can be stale until Wed 9:30\sAM ET/);
    expect(within(screen.getByRole("list", { name: "Fee route to USDC" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["$HARAMBE", "NVDAon", "USDC"]);
    expect(screen.getByRole("img", { name: /52% NVDAon/ })).toBeInTheDocument();
    expect(screen.getByText("Launchable.")).toBeInTheDocument();
  });
});
