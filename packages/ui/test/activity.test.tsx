import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MobileTradesSheet } from "@varada/ui/components/mobile/mobile-trades-sheet";
import { bucketTakeaway, HolderInsights, holderVerdict } from "@varada/ui/components/varada/holder-insights";
import { HoldersTable, rankHolders, type HolderItem } from "@varada/ui/components/varada/holders-table";
import { filterTrades, formatAgo, formatTokenAmount, formatUsd, TradeFeed, TradeTicker, tradeSummary, type TradeItem } from "@varada/ui/components/varada/trade-feed";

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
  MotionGlobalConfig.skipAnimations = true;
});

afterEach(() => {
  vi.useRealTimers();
});

const NOW = Math.floor(Date.now() / 1000);
const hex = (n: number, len: number) => `0x${n.toString(16).padStart(len, "0")}` as `0x${string}`;

function trade(i: number, over: Partial<TradeItem> = {}): TradeItem {
  return {
    id: `t${i}`,
    side: i % 3 === 0 ? "sell" : "buy",
    trader: { address: hex(0xa000 + i, 40) },
    tokenAmount: 303_160_000,
    tokenSymbol: "$HARAMBE",
    quoteAmount: 9.65,
    quoteSymbol: "NVDAon",
    usd: i === 1 ? 1_249 : 120,
    causeUsd: 2.7,
    timestamp: NOW - i * 30,
    txHash: hex(0xbeef00 + i, 64),
    ...over,
  };
}

const TRADES = [1, 2, 3, 4, 5].map((i) => trade(i));

describe("trade feed helpers", () => {
  it("formats amounts, values and ages", () => {
    expect(formatTokenAmount(303_160_000)).toBe("303.16M");
    expect(formatTokenAmount(9.65)).toBe("9.65");
    expect(formatTokenAmount(0.0004412)).toBe("0.0004412");
    expect(formatUsd(1_249.4)).toBe("$1,249");
    expect(formatUsd(2.7)).toBe("$2.70");
    const now = NOW * 1000;
    expect(formatAgo(NOW - 3, now)).toBe("just now");
    expect(formatAgo(NOW - 42, now)).toBe("42s ago");
    expect(formatAgo(NOW - 185, now)).toBe("3 min ago");
    expect(formatAgo(NOW - 7_300, now)).toBe("2 h ago");
  });

  it("filters by side and size, and summarises arrivals", () => {
    expect(filterTrades(TRADES, "sell", 1_000).map((t) => t.id)).toEqual(["t3"]);
    expect(filterTrades(TRADES, "large", 1_000).map((t) => t.id)).toEqual(["t1"]);
    expect(tradeSummary(2, 1)).toBe("3 new trades: 2 buys, 1 sell.");
    expect(tradeSummary(1, 0)).toBe("1 new trade: 1 buy.");
  });
});

describe("TradeFeed", () => {
  it("lists trades newest first with the side written out", () => {
    render(<TradeFeed trades={[...TRADES].reverse()} />);
    const list = screen.getByRole("list", { name: "Trades, newest first" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-trade"))).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(rows[2]).toHaveTextContent("Sell");
    expect(rows[0]).toHaveTextContent("Buy");
    expect(rows[0]).toHaveTextContent("$1,249");
    expect(within(rows[0]!).getByRole("link", { name: /View transaction/ })).toHaveAttribute("href", expect.stringContaining("etherscan.io/tx/0x"));
  });

  it("switches between All, Buys, Sells and Large", async () => {
    render(<TradeFeed trades={TRADES} />);
    const group = screen.getByLabelText("Show trades");
    fireEvent.click(within(group).getByRole("radio", { name: "Sells" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    fireEvent.click(within(group).getByRole("radio", { name: /Large/ }));
    await waitFor(() => expect(screen.getAllByRole("listitem").map((r) => r.getAttribute("data-trade"))).toEqual(["t1"]));
  });

  it("explains an empty filter and shows skeletons while loading", () => {
    const { rerender } = render(<TradeFeed trades={[trade(2)]} defaultFilter="large" />);
    expect(screen.getByText("No trades of $1,000 or more yet.")).toBeInTheDocument();
    rerender(<TradeFeed trades={[]} loading />);
    expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading trades…")).toBeInTheDocument();
  });

  it("flashes new trades only, and holds still under the pointer", () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<TradeFeed trades={TRADES} />);
    expect(container.querySelector("[data-fresh]")).toBeNull();
    const feed = screen.getByRole("region");
    fireEvent.pointerEnter(feed, { pointerType: "mouse" });
    rerender(<TradeFeed trades={[trade(0, { timestamp: NOW + 5 }), ...TRADES]} />);
    // Held: the new trade waits behind the pill.
    expect(container.querySelector('[data-trade="t0"]')).toBeNull();
    const pill = screen.getByRole("button", { name: "1 new trade" });
    fireEvent.click(pill);
    expect(container.querySelector('[data-trade="t0"]')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4_100);
    });
    expect(screen.getByRole("status")).toHaveTextContent("1 new trade: 1 sell.");
  });

  it("flashes an arriving trade when not held", () => {
    const { rerender, container } = render(<TradeFeed trades={TRADES} />);
    rerender(<TradeFeed trades={[trade(0, { timestamp: NOW + 5 }), ...TRADES]} />);
    expect(container.querySelector('[data-trade="t0"]')).toHaveAttribute("data-fresh", "true");
    expect(container.querySelector('[data-trade="t1"]')).not.toHaveAttribute("data-fresh");
  });

  it("shows the cause share", () => {
    render(<TradeFeed trades={[trade(1)]} />);
    expect(screen.getAllByText(/to cause/).length).toBeGreaterThan(0);
  });

  it("renders the ticker strip", () => {
    render(<TradeTicker trades={TRADES} limit={3} />);
    expect(screen.getAllByText("$1,249").length).toBeGreaterThan(0);
  });
});

const HOLDERS: HolderItem[] = [
  { address: hex(1, 40), label: "pool", balance: 382_000_000_000, share: 38.2, usd: 1_609_000 },
  { address: hex(2, 40), ens: "silverback.eth", balance: 42_000_000_000, share: 4.2, usd: 176_900, change24h: 0.31 },
  { address: hex(3, 40), label: "creator", balance: 30_000_000_000, share: 3.0, usd: 126_400, change24h: -0.12 },
  { address: hex(4, 40), label: "locker", balance: 50_000_000_000, share: 5.0 },
  { address: hex(5, 40), balance: 22_000_000_000, share: 2.2 },
];

describe("HoldersTable", () => {
  it("ranks by share and tags known contracts", () => {
    expect(rankHolders(HOLDERS, false).map((h) => h.share)).toEqual([38.2, 5.0, 4.2, 3.0, 2.2]);
    expect(rankHolders(HOLDERS, true).map((h) => h.share)).toEqual([4.2, 3.0, 2.2]);
    render(<HoldersTable holders={HOLDERS} symbol="$HARAMBE" totalHolders={3_402} />);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveAttribute("data-label", "pool");
    expect(within(rows[0]!).getByText("Pool")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("LP locker")).toBeInTheDocument();
    expect(screen.getByText("Creator")).toBeInTheDocument();
    expect(screen.getByRole("region")).toHaveTextContent("of 3,402 holders");
  });

  it("hides the pool and locker with the switch", () => {
    render(<HoldersTable holders={HOLDERS} />);
    fireEvent.click(screen.getByRole("switch", { name: "Hide pool and locker" }));
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("silverback");
    expect(rows[0]).toHaveTextContent("up 0.31 pts");
  });

  it("expands past the first rows", () => {
    render(<HoldersTable holders={HOLDERS} initialRows={2} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Show all 5" }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(6);
  });
});

const BUCKETS = [
  { label: "Under $100", holders: 2_110, share: 3.1 },
  { label: "$100–1K", holders: 940, share: 9.4 },
  { label: "$1K–10K", holders: 300, share: 18.2 },
  { label: "Over $10K", holders: 52, share: 31.1 },
];

describe("HolderInsights", () => {
  it("gives a verdict at the shared thresholds", () => {
    expect(holderVerdict(24.1, 3)).toBe("spread");
    expect(holderVerdict(30, 3)).toBe("fair");
    expect(holderVerdict(12, 2)).toBe("spread");
    expect(holderVerdict(56.3, 3)).toBe("concentrated");
    expect(holderVerdict(10, 12.4)).toBe("concentrated");
  });

  it("writes the concentration out and compares holders with supply", () => {
    expect(bucketTakeaway(BUCKETS)).toBe("Most holders (62%) hold under $100; wallets holding over $10K have the most supply (31%).");
    render(<HolderInsights holders={3_402} newHolders24h={38} top10Share={24.1} creatorShare={3} poolShare={38.2} buckets={BUCKETS} history={[3200, 3300, 3402]} />);
    const card = screen.getByRole("region", { name: "Holder insights" });
    expect(card).toHaveAttribute("data-verdict", "spread");
    expect(card).toHaveTextContent("Spread out");
    expect(card).toHaveTextContent("Top 10 wallets hold 24% (excluding the pool).");
    expect(card).toHaveTextContent("+38 in 24h");
    expect(within(card).getByRole("button", { name: "What is concentration?" })).toBeInTheDocument();
    expect(within(card).getAllByRole("rowheader").map((r) => r.textContent)).toEqual(BUCKETS.map((b) => b.label));
  });
});

describe("MobileTradesSheet", () => {
  it("shows trades and holders as tabs, in place", () => {
    const onOpenChange = vi.fn();
    render(
      <MobileTradesSheet
        open
        inline
        onOpenChange={onOpenChange}
        symbol="$HARAMBE"
        name="Harambe's Wish"
        trades={TRADES}
        holders={HOLDERS}
        insights={{ holders: 3_402, top10Share: 24.1, creatorShare: 3, poolShare: 38.2, buckets: BUCKETS }}
      />,
    );
    const sheet = screen.getByRole("dialog", { name: "Harambe's Wish activity" });
    expect(within(sheet).getByRole("list", { name: /newest first/ })).toBeInTheDocument();
    fireEvent.mouseDown(within(sheet).getByRole("tab", { name: "Holders" }));
    fireEvent.click(within(sheet).getByRole("tab", { name: "Holders" }));
    expect(within(sheet).getByRole("region", { name: "Holder insights" })).toBeInTheDocument();
    // The phone table starts without the pool and locker.
    expect(within(sheet).getByRole("switch", { name: "Hide pool and locker" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
