import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { HoldersTable } from "@verada/ui/components/varada/holders-table";
import { TradeFeed, TradeTicker, type TradeItem } from "@verada/ui/components/varada/trade-feed";

// Its own file: motion reads prefers-reduced-motion once per module instance.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const T = (i: number): TradeItem => ({
  id: `r${i}`,
  side: "buy",
  trader: { address: `0x${String(i).padStart(40, "0")}` },
  tokenAmount: 1_000,
  tokenSymbol: "$HARAMBE",
  quoteAmount: 0.4,
  quoteSymbol: "WETH",
  usd: 1_249,
  timestamp: 1_800_000_000 - i,
  txHash: `0x${String(i).padStart(64, "0")}`,
});

describe("reduced motion", () => {
  it("adds a new trade in place, without the slide or the flash", () => {
    const { rerender, container } = render(<TradeFeed trades={[T(2)]} />);
    rerender(<TradeFeed trades={[T(1), T(2)]} />);
    const row = container.querySelector('[data-trade="r1"]') as HTMLElement;
    expect(row).toHaveAttribute("data-fresh", "true");
    expect(row.className).toContain("motion-reduce:animate-none");
    expect(row.style.opacity).not.toBe("0");
    expect(row.style.transform).not.toMatch(/translate/);
  });

  it("draws holder share bars at full length straight away", () => {
    const { container } = render(
      <HoldersTable
        holders={[
          { address: "0x0000000000000000000000000000000000000001", balance: 10, share: 4 },
          { address: "0x0000000000000000000000000000000000000002", balance: 5, share: 2 },
        ]}
      />,
    );
    const bars = container.querySelectorAll<HTMLElement>("tbody tr td:nth-child(2) [data-share-bar]");
    expect(bars[0]!.style.width).toBe("100%");
    expect(bars[1]!.style.width).toBe("50%");
  });

  it("turns the ticker into a hand-scrolled strip", () => {
    render(<TradeTicker trades={[T(1), T(2)]} />);
    expect(screen.getByRole("region", { name: "Latest trades" })).toBeInTheDocument();
  });
});
