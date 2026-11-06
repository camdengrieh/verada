import { fireEvent, render, screen, within } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BuySellPressure, buyShare, pressureVerdict } from "@varada/ui/components/varada/buy-sell-pressure";
import { HolderDistribution, holderSegments } from "@varada/ui/components/varada/holder-distribution";
import { KpiTile } from "@varada/ui/components/varada/kpi-tile";
import { TradingMetricsBar, priceFormat, tradingMetrics } from "@varada/ui/components/varada/trading-metrics-bar";
import { VolumeBars, peakIndex } from "@varada/ui/components/varada/volume-bars";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // motion's useInView / whileInView need an IntersectionObserver; jsdom has none.
  globalThis.IntersectionObserver ??= class {
    constructor(private cb: IntersectionObserverCallback) {}
    observe(el: Element) {
      this.cb([{ isIntersecting: true, target: el, intersectionRatio: 1 } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  MotionGlobalConfig.skipAnimations = true;
});

const METRICS = tradingMetrics({
  priceUsd: 0.00004213,
  change24h: 18.4,
  marketCapUsd: 4_213_000,
  marketCapChange: 18.4,
  volume24hUsd: 1_284_000,
  volumeChange: -6.2,
  liquidityUsd: 612_000,
  holders: 3_402,
  holdersChange: 4.1,
  feesToCausesUsd: 28_410,
  feesChange: 12,
});

describe("TradingMetricsBar", () => {
  it("builds the standard seven metrics with tiny-price formatting", () => {
    expect(METRICS.map((m) => m.key)).toEqual(["price", "mcap", "volume", "liquidity", "holders", "fees"]);
    expect(new Intl.NumberFormat("en-US", priceFormat(0.00004213)).format(0.00004213)).toBe("$0.00004213");
    expect(new Intl.NumberFormat("en-US", priceFormat(3412.5)).format(3412.5)).toBe("$3,412.50");
  });

  it("names each metric and writes deltas with a glyph and words", () => {
    render(<TradingMetricsBar metrics={METRICS} animate={false} />);
    const bar = screen.getByRole("region", { name: "Trading metrics" });
    expect(within(bar).getAllByRole("term").map((t) => t.textContent)).toEqual(["Price", "Market cap", "Volume 24h", "Liquidity", "Holders", "Fees to causes"]);
    expect(within(bar).getByText("$0.00004213")).toBeInTheDocument();
    expect(within(bar).getByText("$28.41K")).toBeInTheDocument();
    const volume = bar.querySelector('[data-metric="volume"]')!;
    expect(volume.querySelector('[data-slot="delta"]')).toHaveAttribute("data-direction", "down");
    expect(volume).toHaveTextContent("▼");
    expect(volume).toHaveTextContent("down");
    expect(bar.className).toMatch(/@container/);
  });

  it("animates with NumberTicker and keeps the final value for screen readers", () => {
    render(<TradingMetricsBar metrics={METRICS} />);
    expect(document.querySelectorAll('[data-slot="number-ticker"]')).toHaveLength(6);
    expect(screen.getByText("3,402", { selector: ".sr-only" })).toBeInTheDocument();
  });

  it("offers a keyboard-scrollable strip for narrow containers", () => {
    render(<TradingMetricsBar metrics={METRICS} narrow="scroll" animate={false} />);
    const strip = screen.getByRole("region", { name: "Trading metrics, scrolls sideways" });
    expect(strip).toHaveAttribute("tabindex", "0");
  });
});

describe("HolderDistribution", () => {
  it("lists every group and summarises the bar", () => {
    render(<HolderDistribution segments={holderSegments({ pool: 38.2, top10: 24.1, creator: 3, otherHolders: 3_391 })} totalHolders={3_402} />);
    expect(screen.getByRole("img", { name: /Liquidity pool 38%, Top 10 holders 24%, Creator 3\.0%, Everyone else 35%/ })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("3,391 wallets")).toBeInTheDocument();
    expect(screen.getByText("No single group dominates the supply.")).toBeInTheDocument();
  });

  it("warns when the supply is concentrated", () => {
    render(<HolderDistribution segments={holderSegments({ pool: 20, top10: 58, creator: 12 })} />);
    expect(screen.getByRole("note")).toHaveTextContent(/Top 10 wallets hold 58% of supply; The creator holds 12%/);
  });
});

describe("BuySellPressure", () => {
  const windows = [
    { key: "1h", buys: 412, sells: 251, buyVolumeUsd: 48_200, sellVolumeUsd: 30_100 },
    { key: "24h", buys: 3_120, sells: 3_410 },
  ];

  it("computes the share and verdict", () => {
    expect(buyShare(windows[0]!)).toBeCloseTo(0.6214, 3);
    expect(buyShare({ key: "x", buys: 0, sells: 0 })).toBe(0.5);
    expect(pressureVerdict(0.62)).toBe("buyers");
    expect(pressureVerdict(0.5)).toBe("balanced");
    expect(pressureVerdict(0.4)).toBe("sellers");
  });

  it("switches windows and says who leads in words", () => {
    const onValueChange = vi.fn();
    render(<BuySellPressure windows={windows} onValueChange={onValueChange} />);
    expect(screen.getByRole("img", { name: /Last 1h: 62% buys, 38% sells by trades\. 412 buys, 251 sells\. Buyers lead\./ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "24h" }));
    expect(onValueChange).toHaveBeenCalledWith("24h");
    expect(screen.getByRole("img", { name: /Last 24h: 48% buys.*Balanced/ })).toBeInTheDocument();
  });

  it("draws a split bar when asked, by volume", () => {
    render(<BuySellPressure windows={windows} variant="bar" basis="volume" />);
    expect(screen.getByRole("img", { name: /62% buys, 38% sells by volume/ })).toBeInTheDocument();
    expect(screen.getByText("▲ Buys 62%")).toBeInTheDocument();
  });
});

describe("VolumeBars", () => {
  const data = Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, "0")}:00`, value: h === 14 ? 48_200 : 2_000 + h * 300 }));

  it("finds and labels the peak", () => {
    expect(peakIndex(data)).toBe(14);
    render(<VolumeBars data={data} />);
    expect(document.querySelector("[data-peak]")).toHaveAttribute("data-bar", "14");
    expect(screen.getByText(/Peak 14:00 · \$48\.2K/)).toBeInTheDocument();
  });

  it("is a slider over the bars for keyboards", () => {
    const onIndexChange = vi.fn();
    render(<VolumeBars data={data} onIndexChange={onIndexChange} />);
    const slider = screen.getByRole("slider", { name: "Volume, volume by hour" });
    expect(slider).toHaveAttribute("aria-valuetext", "14:00: $48.2K, the peak");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider).toHaveAttribute("aria-valuetext", "15:00: $6.5K");
    expect(onIndexChange).toHaveBeenLastCalledWith(15);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(slider).toHaveAttribute("aria-valuenow", "1");
  });
});

describe("KpiTile", () => {
  const periods = [
    { key: "24h", value: 1_284_000, delta: -6.2, trend: [3, 4, 3, 5, 4, 6] },
    { key: "7d", value: 8_910_000, delta: 22.5, trend: [2, 3, 5, 4, 6, 8] },
  ];

  it("switches period and updates value, delta and sparkline", () => {
    render(<KpiTile label="Volume" periods={periods} format={{ style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }} animate={false} />);
    expect(screen.getByRole("heading", { name: "Volume" })).toBeInTheDocument();
    expect(screen.getByText("$1.28M")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="delta"]')).toHaveAttribute("data-direction", "down");
    fireEvent.click(screen.getByRole("radio", { name: "7d" }));
    expect(screen.getByText("$8.91M")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="delta"]')).toHaveAttribute("data-direction", "up");
    expect(screen.getByRole("img", { name: /7d trend/ })).toBeInTheDocument();
  });
});
