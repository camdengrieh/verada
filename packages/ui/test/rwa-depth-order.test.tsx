import { fireEvent, render, screen, within } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { beforeAll, describe, expect, it } from "vitest";
import { orderPairOptions, MobilePairPicker } from "@varada/ui/components/mobile/mobile-pair-picker";
import { compareByDepth, fillStatus, sortByDepth } from "@varada/ui/components/varada/quote-order";
import { QuoteAssetList, filterQuoteAssets } from "@varada/ui/components/varada/quote-asset-list";
import type { QuoteAsset } from "@varada/ui/components/varada/quote-asset";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  MotionGlobalConfig.skipAnimations = true;
});

const NOW = new Date("2026-01-13T15:00:00Z");
const rwa = (symbol: string, routeDepthUsd: number | undefined, extra: Partial<QuoteAsset> = {}): QuoteAsset => ({
  symbol,
  name: symbol,
  kind: "stock",
  route: routeDepthUsd ? [symbol, "WETH", "USDC"] : undefined,
  routeDepthUsd,
  ...extra,
});

describe("sortByDepth", () => {
  it("orders deepest first, ties by symbol, unrouted last", () => {
    const out = sortByDepth([
      { symbol: "ZZZ" },
      { symbol: "B", depthUsd: 50_000 },
      { symbol: "A", depthUsd: 50_000 },
      { symbol: "C", depthUsd: 900_000 },
      { symbol: "AAA", depthUsd: Number.NaN },
      { symbol: "D", depthUsd: 5_000_000, routed: false },
    ]);
    expect(out.map((x) => x.symbol)).toEqual(["C", "A", "B", "D", "AAA", "ZZZ"]);
  });

  it("is stable and does not mutate its input", () => {
    const input = [{ symbol: "B", depthUsd: 1 }, { symbol: "A", depthUsd: 1 }];
    const copy = [...input];
    expect(sortByDepth(input).map((x) => x.symbol)).toEqual(["A", "B"]);
    expect(input).toEqual(copy);
    expect(compareByDepth({ symbol: "A" }, { symbol: "A" })).toBe(0);
  });

  it("classifies fill status", () => {
    expect(fillStatus({ routed: false }, 10_000)).toBe("cant-fill");
    expect(fillStatus({ routed: true, depthUsd: 0 }, 10_000)).toBe("cant-fill");
    expect(fillStatus({ routed: true, depthUsd: 4_000 }, 10_000)).toBe("thin");
    expect(fillStatus({ routed: true, depthUsd: 40_000 }, 10_000)).toBe("ok");
    expect(fillStatus({ routed: false, direct: true }, 10_000)).toBe("ok");
  });
});

describe("filterQuoteAssets ordering", () => {
  const rwas = [rwa("TSLAon", 80_000), rwa("BRK.Bon", undefined), rwa("NVDAon", 600_000), rwa("AAPLon", 80_000), rwa("HOODon", 4_000)];
  it("lists RWAs by depth, then symbol, with unrouted last", () => {
    expect(filterQuoteAssets(rwas, { sort: "liquidity" }).map((a) => a.symbol)).toEqual(["NVDAon", "AAPLon", "TSLAon", "HOODon", "BRK.Bon"]);
    expect(filterQuoteAssets(rwas).map((a) => a.symbol)).toEqual(["NVDAon", "AAPLon", "TSLAon", "HOODon", "BRK.Bon"]);
  });
});

describe("QuoteAssetList RWA rows", () => {
  const rwas = [rwa("HOODon", 4_000), rwa("BRK.Bon", undefined), rwa("NVDAon", 600_000, { paused: true })];
  it("orders select rows, marks thin / can't fill / paused and disables the unrouted one", () => {
    render(<QuoteAssetList mode="select" assets={rwas} now={NOW} value={null} onValueChange={() => undefined} hideControls />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["NVDAon, NVDAon", "HOODon, HOODon", "BRK.Bon, BRK.Bon"]);
    expect(radios[2]).toBeDisabled();
    expect(radios[1]).toBeDisabled(); // under the $10K minimum depth
    expect(within(radios[0]!).getByText("Paused")).toBeInTheDocument();
    expect(radios[1]!.querySelector('[data-fill="thin"]')).not.toBeNull();
    expect(within(radios[2]!).getByText("Can’t fill")).toBeInTheDocument();
    expect(within(radios[2]!).getByText(/Not launchable: No route to USDC/)).toBeInTheDocument();
  });

  it("shows skeleton placeholders while loading", () => {
    render(<QuoteAssetList mode="select" assets={[]} loading now={NOW} value={null} onValueChange={() => undefined} hideControls />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("No assets match")).not.toBeInTheDocument();
  });
});

describe("MobilePairPicker ordering", () => {
  it("orders by depth with disabled / can't-fill last, and shows markers", async () => {
    const stocks = [
      { symbol: "BRK.Bon", name: "Berkshire", kind: "stock" as const, depthPct: 0, fill: "cant-fill" as const, disabled: true },
      { symbol: "TSLAon", name: "Tesla", kind: "stock" as const, depthPct: 58 },
      { symbol: "HOODon", name: "Robinhood", kind: "stock" as const, depthPct: 6, fill: "thin" as const },
      { symbol: "NVDAon", name: "NVIDIA", kind: "stock" as const, depthPct: 64 },
    ];
    expect(orderPairOptions(stocks).map((o) => o.symbol)).toEqual(["NVDAon", "TSLAon", "HOODon", "BRK.Bon"]);
    render(<MobilePairPicker open onOpenChange={() => {}} crypto={[]} stocks={stocks} defaultTab="stocks" onConfirm={() => {}} />);
    const sheet = await screen.findByRole("dialog", { name: "Pair it with" });
    fireEvent.mouseDown(within(sheet).getByRole("tab", { name: /Stocks/ }));
    const names = within(sheet).getAllByRole("radio").map((r) => r.getAttribute("aria-label"));
    expect(names.map((n) => n!.split(",")[0])).toEqual(["NVDAon", "TSLAon", "HOODon", "BRK.Bon"]);
    expect(names[2]).toContain("thin");
    expect(names[3]).toContain("can't fill");
  });
});
