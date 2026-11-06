import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BottomTabBar, varadaTabs } from "@varada/ui/components/mobile/bottom-tab-bar";
import { FilterButton, FilterSheet, countFilters, type FilterGroup, type FilterValue } from "@varada/ui/components/mobile/filter-sheet";
import { MobileHeader } from "@varada/ui/components/mobile/mobile-header";
import { MobilePairPicker } from "@varada/ui/components/mobile/mobile-pair-picker";
import { MobileTradeSheet, type MobileTradeSheetProps } from "@varada/ui/components/mobile/mobile-trade-sheet";
import { MobileVoteSheet } from "@varada/ui/components/mobile/mobile-vote-sheet";
import { PullToRefresh, resistPull } from "@varada/ui/components/mobile/pull-to-refresh";
import { StickyActionBar } from "@varada/ui/components/mobile/sticky-action-bar";
import { TokenSwipeRow } from "@varada/ui/components/mobile/swipe-row";
import { TokenCarousel } from "@varada/ui/components/mobile/token-carousel";
import { defaultBuyPresets, isStablecoin } from "@varada/ui/components/varada/trade-panel";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  MotionGlobalConfig.skipAnimations = true;
});

const TABS = varadaTabs({ discover: "/", trade: "/trade/", vote: "/vote/", me: "/me/" }, { vote: { badge: 2, badgeLabel: "2 open ballots" } });

describe("BottomTabBar", () => {
  it("marks the active tab with aria-current and puts Launch in the middle", () => {
    render(<BottomTabBar tabs={TABS} activeHref="/vote/" launch={{ href: "/launch/" }} />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent?.replace(/,.*$/, "").replace(/^\d+/, ""))).toEqual(["Discover", "Trade", "Launch", "Vote", "Me"]);
    expect(within(nav).getByRole("link", { name: /^Vote/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: /^Vote/ })).toHaveAccessibleName(/^Vote\s?, 2 open ballots$/);
    expect(within(nav).getByRole("link", { name: "Discover" })).not.toHaveAttribute("aria-current");
    expect(within(nav).getByRole("link", { name: "Launch" })).toHaveAttribute("href", "/launch/");
  });

  it("runs a launch callback and hides on scroll down when asked", () => {
    const onLaunch = vi.fn();
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    render(<BottomTabBar tabs={TABS} activeHref="/" launch={{ onClick: onLaunch, label: "Launch a coin" }} hideOnScroll scrollContainer={scroller} />);
    fireEvent.click(screen.getByRole("button", { name: "Launch a coin" }));
    expect(onLaunch).toHaveBeenCalledTimes(1);

    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav).not.toHaveAttribute("data-hidden");
    act(() => {
      scroller.scrollTop = 300;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(nav).toHaveAttribute("data-hidden", "true");
    act(() => {
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(nav).not.toHaveAttribute("data-hidden");
    scroller.remove();
  });
});

const TOKEN = {
  name: "Harambe's Wish",
  symbol: "HARAMBE",
  change24h: 18.4,
  quote: { symbol: "NVDAon", kind: "stock" as const },
  cause: "wildlife" as const,
  marketCap: "$412K",
  raised: "$3,210",
};

describe("SwipeRow", () => {
  it("offers every swipe action through the Actions button", async () => {
    const onWatch = vi.fn();
    const onBuy = vi.fn();
    render(<TokenSwipeRow token={TOKEN} href="/token/harambe/" onWatch={onWatch} onBuy={onBuy} />);
    const toggle = screen.getByRole("button", { name: "Actions for Harambe's Wish" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Actions for Harambe's Wish" })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const group = screen.getByRole("group", { name: "Actions for Harambe's Wish" });
    const watch = within(group).getByRole("button", { name: "Watch" });
    await waitFor(() => expect(watch).toHaveFocus());
    expect(watch).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(within(group).getByRole("button", { name: "Buy" }));
    expect(onBuy).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();

    fireEvent.click(toggle);
    fireEvent.keyDown(screen.getByRole("button", { name: "Watch" }), { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(onWatch).not.toHaveBeenCalled();
    // The row itself is still one link.
    expect(screen.getByRole("link", { name: /Harambe's Wish/ })).toHaveAttribute("href", "/token/harambe/");
  });
});

const GROUPS: FilterGroup[] = [
  {
    id: "sort",
    label: "Sort by",
    type: "single",
    options: [
      { value: "trending", label: "Trending" },
      { value: "new", label: "New" },
      { value: "raised", label: "Most raised" },
    ],
  },
  {
    id: "pair",
    label: "Paired with",
    type: "multi",
    options: [
      { value: "crypto", label: "Crypto", count: 12 },
      { value: "stocks", label: "Stocks", count: 9 },
    ],
  },
];

function FilterHarness({ onApply }: { onApply: (v: FilterValue) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<FilterValue>({ sort: ["trending"] });
  return (
    <>
      <FilterButton count={countFilters(value, { sort: ["trending"] })} onClick={() => setOpen(true)} />
      <FilterSheet
        open={open}
        onOpenChange={setOpen}
        groups={GROUPS}
        value={value}
        resetValue={{ sort: ["trending"] }}
        onApply={(v) => {
          setValue(v);
          onApply(v);
        }}
        applyLabel={(d) => `Show ${(d.pair ?? []).length ? 9 : 21} coins`}
      />
    </>
  );
}

describe("FilterSheet", () => {
  it("edits a draft, resets it, and applies it", async () => {
    const onApply = vi.fn();
    render(<FilterHarness onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });

    const reset = within(sheet).getByRole("button", { name: "Reset" });
    expect(reset).toBeDisabled();
    const sort = within(sheet).getByRole("radiogroup", { name: "Sort by" });
    expect(within(sort).getByRole("radio", { name: "Trending" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(sheet).getByRole("button", { name: "Stocks 9 results" }));
    expect(within(sheet).getByRole("button", { name: "Stocks 9 results" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(within(sort).getByRole("radio", { name: "Trending" }), { key: "ArrowRight" });
    expect(within(sort).getByRole("radio", { name: "New" })).toHaveAttribute("aria-checked", "true");
    expect(within(sort).getByRole("radio", { name: "New" })).toHaveFocus();
    expect(reset).toBeEnabled();

    fireEvent.click(reset);
    expect(within(sort).getByRole("radio", { name: "Trending" })).toHaveAttribute("aria-checked", "true");
    expect(within(sheet).getByRole("button", { name: "Stocks 9 results" })).toHaveAttribute("aria-pressed", "false");
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(within(sheet).getByRole("button", { name: "Crypto 12 results" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Show 9 coins" }));
    expect(onApply).toHaveBeenCalledWith({ sort: ["trending"], pair: ["crypto"] });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 2000 });
    expect(screen.getByRole("button", { name: "Filters 1 applied" })).toBeInTheDocument();
  });
});

function tradeProps(overrides: Partial<MobileTradeSheetProps> = {}): MobileTradeSheetProps {
  return {
    open: true,
    onOpenChange: vi.fn(),
    coin: { name: "Harambe's Wish", symbol: "HARAMBE", price: "$0.00000412", change24h: 18.4 },
    side: "buy",
    onSideChange: vi.fn(),
    pay: { symbol: "WETH", kind: "crypto", balance: "1.8421" },
    receive: { symbol: "$HARAMBE" },
    payAmount: "",
    onPayAmountChange: vi.fn(),
    receiveAmount: "",
    slippage: 1,
    fee: "2.5%",
    causeAmount: "$28.11",
    causeName: "Save the Elephants",
    onSubmit: vi.fn(),
    ...overrides,
  };
}

describe("MobileTradeSheet", () => {
  it("shows the presets in the full ticket and fills the amount from one", async () => {
    const props = tradeProps();
    render(<MobileTradeSheet {...props} />);
    const sheet = await screen.findByRole("dialog", { name: "Buy $HARAMBE" });
    expect(within(sheet).queryByRole("group", { name: "Amount presets in WETH" })).toBeNull();
    expect(within(sheet).getByRole("button", { name: "Enter an amount" })).toBeDisabled();

    const more = within(sheet).getByRole("button", { name: /More options/ });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    const presets = await within(sheet).findByRole("group", { name: "Amount presets in WETH" });
    expect(within(sheet).getByRole("button", { name: "Fewer options" })).toHaveAttribute("aria-expanded", "true");
    expect(within(presets).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Pay 0.01 WETH",
      "Pay 0.05 WETH",
      "Pay 0.1 WETH",
      "Pay 0.5 WETH",
      "Use your whole WETH balance",
    ]);
    fireEvent.click(within(presets).getByRole("button", { name: "Pay 0.05 WETH" }));
    expect(props.onPayAmountChange).toHaveBeenLastCalledWith("0.05");
    expect(within(sheet).getByText(/of this trade's fee goes to Save the Elephants/)).toBeInTheDocument();
  });

  it("submits from the sticky button once there is an amount", async () => {
    const props = tradeProps({ payAmount: "0.05", receiveAmount: "295,820,000", defaultExpanded: true });
    render(<MobileTradeSheet {...props} />);
    const sheet = await screen.findByRole("dialog", { name: "Buy $HARAMBE" });
    fireEvent.click(await within(sheet).findByRole("button", { name: "Review buy" }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("Buy presets for more quote assets", () => {
  it("uses small BTC sizes, ETH sizes for staked ETH and dollar sizes for stablecoins", () => {
    const btc = defaultBuyPresets("WBTC", 100_000);
    expect(btc.map((p) => p.label)).toEqual(["0.0005", "0.001", "0.005", "0.01"]);
    expect(btc[0]).toMatchObject({ amount: "0.0005", detail: "≈ $50", description: "about $50" });
    expect(defaultBuyPresets("cbBTC").map((p) => p.amount)).toEqual(["0.0005", "0.001", "0.005", "0.01"]);
    expect(defaultBuyPresets("wstETH", 3050)[1]).toMatchObject({ label: "0.05", detail: "≈ $153" });
    for (const s of ["USDC", "USDT", "DAI"]) {
      expect(isStablecoin(s)).toBe(true);
      expect(defaultBuyPresets(s).map((p) => p.label)).toEqual(["$50", "$100", "$250", "$500"]);
    }
    expect(defaultBuyPresets("LINK")).toEqual([]);
  });
});

describe("TokenCarousel", () => {
  it("moves with the controls, the dots and the keyboard", () => {
    const onIndexChange = vi.fn();
    render(
      <TokenCarousel label="Trending coins" onIndexChange={onIndexChange}>
        <div>One</div>
        <div>Two</div>
        <div>Three</div>
      </TokenCarousel>,
    );
    const carousel = screen.getByRole("region", { name: "Trending coins" });
    expect(carousel).toHaveAttribute("aria-roledescription", "carousel");
    const slides = within(carousel).getAllByRole("group");
    expect(slides).toHaveLength(3);
    expect(slides[0]).toHaveAccessibleName("1 of 3");

    const prev = screen.getByRole("button", { name: "Previous slide" });
    const next = screen.getByRole("button", { name: "Next slide" });
    expect(prev).toBeDisabled();
    fireEvent.click(next);
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    expect(screen.getByRole("button", { name: "Go to slide 2 of 3" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Slide 2 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Go to slide 3 of 3" }));
    expect(next).toBeDisabled();
    const track = slides[0]!.parentElement!;
    fireEvent.keyDown(track, { key: "Home" });
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
    expect(prev).toBeDisabled();
    fireEvent.keyDown(track, { key: "ArrowRight" });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
  });
});

describe("MobileHeader", () => {
  it("opens the full-screen search from the search button", async () => {
    const onSelect = vi.fn();
    render(
      <MobileHeader
        privacy="private"
        search={{ results: [{ id: "h", title: "Harambe's Wish", subtitle: "$HARAMBE · NVDAon", group: "Coins", onSelect }], defaultValue: "har" }}
        wallet={<button type="button">Connect</button>}
      />,
    );
    expect(screen.getByRole("img", { name: /Private RPC on/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const sheet = await screen.findByRole("dialog", { name: "Search" });
    const input = within(sheet).getByRole("searchbox", { name: "Search coins, causes or paste an address" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(within(sheet).getByRole("status")).toHaveTextContent("1 result");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const result = within(sheet).getByRole("button", { name: /Harambe's Wish/ });
    expect(result).toHaveFocus();
    fireEvent.click(result);
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 2000 });
  });
});

describe("Other mobile pieces", () => {
  it("vote sheet names the chosen charity on its sticky button", async () => {
    const onVote = vi.fn();
    render(
      <MobileVoteSheet
        open
        onOpenChange={() => {}}
        title="Where should $1,284 go?"
        options={[
          { id: "1", org: "Save the Elephants", category: "wildlife", region: "Africa", source: "pinned" },
          { id: "2", org: "Rainforest Trust", category: "environment", region: "Latin America", source: "rotation" },
        ]}
        onVote={onVote}
      />,
    );
    const sheet = await screen.findByRole("dialog", { name: "Where should $1,284 go?" });
    expect(within(sheet).getByRole("button", { name: "Choose a charity to vote" })).toBeDisabled();
    fireEvent.click(within(sheet).getByRole("radio", { name: /Rainforest Trust/ }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Vote for Rainforest Trust" }));
    expect(onVote).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
  });

  it("renders a sheet in place, non-modal, when inline", () => {
    const onOpenChange = vi.fn();
    render(
      <>
        <button type="button">Outside</button>
        <MobileTradeSheet {...tradeProps({ onOpenChange })} inline />
      </>,
    );
    const sheet = screen.getByRole("dialog", { name: "Buy $HARAMBE" });
    expect(sheet).toHaveAttribute("aria-modal", "false");
    // Nothing outside is hidden from assistive tech.
    expect(screen.getByRole("button", { name: "Outside" })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: /More options/ }));
    expect(within(sheet).getByRole("group", { name: "Amount presets in WETH" })).toBeInTheDocument();
    fireEvent.keyDown(within(sheet).getByRole("button", { name: "Fewer options" }), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("pair picker switches tabs and confirms the choice", async () => {
    const onConfirm = vi.fn();
    render(
      <MobilePairPicker
        open
        onOpenChange={() => {}}
        crypto={[{ symbol: "WETH", name: "Wrapped Ether", kind: "crypto" }]}
        stocks={[{ symbol: "NVDAon", name: "NVIDIA (Ondo)", kind: "stock" }]}
        onConfirm={onConfirm}
      />,
    );
    const sheet = await screen.findByRole("dialog", { name: "Pair it with" });
    fireEvent.mouseDown(within(sheet).getByRole("tab", { name: /Stocks/ }));
    fireEvent.click(within(sheet).getByRole("radio", { name: /NVDAon/ }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Pair with NVDAon" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ symbol: "NVDAon" }));
  });

  it("pull to refresh always has a button, and the action bar its actions", async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const onNext = vi.fn();
    render(
      <>
        <PullToRefresh onRefresh={onRefresh}>
          <p>List</p>
        </PullToRefresh>
        <StickyActionBar position="static" secondary={{ label: "Back", onClick: () => {} }} primary={{ label: "Next: cause", onClick: onNext }} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(resistPull(50, 72)).toBe(50);
    expect(resistPull(172, 72)).toBe(107);
    fireEvent.click(screen.getByRole("button", { name: "Next: cause" }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
