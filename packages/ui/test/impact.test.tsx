import { act, render, renderHook, screen, within } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const confettiMock = vi.hoisted(() => {
  const fn = vi.fn((..._args: unknown[]) => null) as ReturnType<typeof vi.fn> & {
    shapeFromPath: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  };
  fn.shapeFromPath = vi.fn(() => ({ type: "path", path: "", matrix: [] }));
  fn.reset = vi.fn();
  return fn;
});
vi.mock("canvas-confetti", () => ({ default: confettiMock }));

import { CauseLeaderboard, causeEntry, movementText } from "@varada/ui/components/varada/cause-leaderboard";
import { DonationGoal, goalProgress, milestoneStates } from "@varada/ui/components/varada/donation-goal";
import { DonationTimeline, relativeTime, type Donation } from "@varada/ui/components/varada/donation-timeline";
import { ImpactBreakdown, breakdownShares } from "@varada/ui/components/varada/impact-breakdown";
import { formatUsd, useThrottledAnnouncement } from "@varada/ui/components/varada/impact-shared";
import { PoolMeter, epochElapsed } from "@varada/ui/components/varada/pool-meter";
import { RaisedCounter } from "@varada/ui/components/varada/raised-counter";
import { HeroCause } from "@varada/ui/components/varada/hero-cause";
import { HeroHome } from "@varada/ui/components/varada/hero-home";
import { HeroLaunch } from "@varada/ui/components/varada/hero-launch";
import { HeroToken } from "@varada/ui/components/varada/hero-token";

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
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
});

afterEach(() => {
  vi.useRealTimers();
  confettiMock.mockClear();
});

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

describe("formatUsd", () => {
  it("shows cents under $1,000 and whole dollars above", () => {
    expect(formatUsd(48210)).toBe("$48,210");
    expect(formatUsd(12.4)).toBe("$12.40");
    expect(formatUsd(999.999)).toBe("$1,000.00");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("goes compact on request from $10K", () => {
    expect(formatUsd(48210, { compact: true })).toBe("$48.2K");
    expect(formatUsd(1_250_000, { compact: true })).toBe("$1.3M");
    expect(formatUsd(9_500, { compact: true })).toBe("$9,500");
    expect(formatUsd(30_000, { compact: true })).toBe("$30K");
  });
});

describe("useThrottledAnnouncement", () => {
  it("skips the first value, then speaks at most once per interval", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ text }) => useThrottledAnnouncement(text, 1000), { initialProps: { text: "a" } });
    expect(result.current).toBe("");
    rerender({ text: "b" });
    rerender({ text: "c" });
    act(() => vi.advanceTimersByTime(999));
    expect(result.current).toBe("");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("c");
  });
});

describe("RaisedCounter", () => {
  it("is a labelled region with the formatted total and goal share", () => {
    render(<RaisedCounter value={48210} goal={60000} caption="90% of every fee, paid in USDC via Endaoment" />);
    const region = screen.getByRole("region", { name: "Raised for causes" });
    expect(within(region).getByRole("heading", { level: 2, name: "Raised for causes" })).toBeInTheDocument();
    expect(region).toHaveTextContent("$48,210");
    expect(region).toHaveTextContent("80% of the $60,000 goal");
    expect(within(region).getByRole("status")).toBeEmptyDOMElement();
  });

  it("floats the increment when the total rises", () => {
    const { rerender, container } = render(<RaisedCounter value={48210} latestTo="WWF" />);
    rerender(<RaisedCounter value={48222.4} latestTo="WWF" />);
    expect(container).toHaveTextContent("+$12.40 to WWF");
  });
});

describe("DonationGoal", () => {
  it("does the goal maths", () => {
    expect(goalProgress(48210, 60000)).toMatchObject({ pct: 80, remaining: 11790, reached: false, over: 0 });
    expect(goalProgress(59990, 60000).pct).toBe(99);
    expect(goalProgress(61000, 60000)).toMatchObject({ ratio: 1, pct: 100, reached: true, over: 1000 });
    expect(goalProgress(10, 0)).toMatchObject({ ratio: 0, reached: false });
    const { list, next } = milestoneStates(
      [
        { at: 50000, label: "Two rangers" },
        { at: 10000, label: "One ranger" },
      ],
      48210,
    );
    expect(list.map((m) => m.reached)).toEqual([true, false]);
    expect(next?.label).toBe("Two rangers");
  });

  it("exposes a progressbar and ticks milestones", () => {
    render(
      <DonationGoal
        raised={48210}
        goal={60000}
        label="Epoch 12 · Wildlife"
        milestones={[
          { at: 10000, label: "Anti-poaching patrol" },
          { at: 50000, label: "Gorilla vet clinic" },
        ]}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Epoch 12 · Wildlife" });
    expect(bar).toHaveAttribute("aria-valuetext", "$48,210 of $60,000, 80%");
    expect(screen.getByText("$11,790")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("reached");
    expect(items[1]).toHaveTextContent("next");
  });

  it("celebrates once when the goal is crossed", () => {
    const { rerender } = render(<DonationGoal raised={59000} goal={60000} label="Goal" variant="bar" />);
    expect(confettiMock).not.toHaveBeenCalled();
    rerender(<DonationGoal raised={60500} goal={60000} label="Goal" variant="bar" />);
    expect(confettiMock).toHaveBeenCalled();
    expect(screen.getByText(/Goal reached/)).toBeInTheDocument();
  });
});

describe("ImpactBreakdown", () => {
  it("rounds shares to sum to 100", () => {
    const shares = breakdownShares([
      { cause: "water", amount: 1 },
      { cause: "wildlife", amount: 1 },
      { cause: "hunger", amount: 1 },
    ]);
    expect(shares.reduce((s, x) => s + x.share, 0)).toBe(100);
    expect(breakdownShares([{ cause: "water", amount: 0 }])).toEqual([]);
  });

  it("lists causes biggest first in both layouts", () => {
    const items = [
      { cause: "water" as const, amount: 9120 },
      { cause: "wildlife" as const, amount: 21480, charities: 6 },
    ];
    const { rerender } = render(<ImpactBreakdown items={items} />);
    let rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Wildlife");
    expect(rows[0]).toHaveTextContent("$21,480");
    expect(rows[0]).toHaveTextContent("70%");
    rerender(<ImpactBreakdown items={items} variant="grid" />);
    rows = screen.getAllByRole("listitem");
    expect(rows[1]).toHaveTextContent("Clean water");
    expect(screen.getByText("$30,600")).toBeInTheDocument();
  });
});

describe("DonationTimeline", () => {
  const donations: Donation[] = [
    { id: "a", org: "WWF", amount: 1240.5, cause: "wildlife", at: NOW - 5 * 60_000, coin: "$HARAMBE", via: "live", txHref: "https://etherscan.io/tx/0xabc" },
    { id: "b", org: "charity: water", amount: 880, cause: "water", at: NOW - 3 * 3_600_000, via: "pool" },
  ];

  it("words relative times", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("Just now");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(relativeTime(new Date(NOW - 3 * 3_600_000), NOW)).toBe("3h ago");
    expect(relativeTime(new Date(NOW - 50 * 3_600_000).toISOString(), NOW)).toBe("2d ago");
  });

  it("renders newest first with the tx link and announces new rows", () => {
    const { rerender } = render(<DonationTimeline donations={donations} now={NOW} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("$1,241 to WWF");
    expect(items[0]).toHaveTextContent("from $HARAMBE · live donation");
    expect(items[1]).toHaveTextContent("weekly pool");
    expect(within(items[0]!).getByRole("link", { name: /View transaction for \$1,241 to WWF/ })).toHaveAttribute("href", "https://etherscan.io/tx/0xabc");
    expect(within(items[0]!).getByText("5m ago").tagName).toBe("TIME");
    rerender(<DonationTimeline donations={[{ id: "c", org: "GiveDirectly", amount: 42, cause: "poverty", at: NOW }, ...donations]} now={NOW} />);
    expect(screen.getByRole("status")).toHaveTextContent("New donation: $42.00 to GiveDirectly");
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("GiveDirectly");
  });
});

describe("CauseLeaderboard", () => {
  it("ranks by raised with movement in words", () => {
    expect(movementText(2)).toBe("Up 2 places");
    expect(movementText(-1)).toBe("Down 1 place");
    expect(movementText(0)).toBe("No change");
    expect(movementText(undefined)).toBe("New this period");
    render(<CauseLeaderboard entries={[causeEntry("water", 9120, -1), causeEntry("wildlife", 21480, 2), causeEntry("hunger", 4000)]} period="Epoch 12" />);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Rank 1.");
    expect(rows[0]).toHaveTextContent("Wildlife");
    expect(rows[0]).toHaveTextContent("Up 2 places");
    expect(rows[1]).toHaveTextContent("Down 1 place");
    expect(rows[2]).toHaveTextContent("New this period");
  });
});

describe("PoolMeter", () => {
  it("works out the elapsed share and shows the pool", () => {
    const start = NOW - 3.5 * 86_400_000;
    const end = NOW + 3.5 * 86_400_000;
    expect(epochElapsed(start, end, NOW)).toBeCloseTo(0.5);
    expect(epochElapsed(start, end, end + 1)).toBe(1);
    render(<PoolMeter epoch={12} amount={18420} target={30000} startsAt={start} endsAt={end} now={NOW} onVote={() => {}} />);
    expect(screen.getByRole("heading", { name: "Epoch 12 cause pool" })).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("61% of $30K")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vote privately" })).toBeInTheDocument();
  });
});

describe("Heroes", () => {
  const art = <img src="assets/scenes/harambe-v1-960.webp" alt="Painted gorilla in a jungle" />;

  it("HeroHome is a region named by its h1, with the brush word, actions and stats", () => {
    const onLaunch = vi.fn();
    render(
      <HeroHome
        headline="Memecoins that give back"
        highlight="give"
        lead="90% of every trading fee goes to charity."
        art={art}
        actions={[{ label: "Launch a coin", onClick: onLaunch }, { label: "Explore coins", href: "/explore" }]}
        stats={[
          { label: "Raised for causes", value: 48210, format: { style: "currency", currency: "USD", maximumFractionDigits: 0 }, live: true },
          { label: "Coins", value: "1,284" },
        ]}
      />,
    );
    const region = screen.getByRole("region", { name: "Memecoins that give back" });
    expect(within(region).getByRole("heading", { level: 1 })).toHaveTextContent("Memecoins that give back");
    expect(within(region).getByRole("img", { name: "Painted gorilla in a jungle" })).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "Explore coins" })).toHaveAttribute("href", "/explore");
    act(() => within(region).getByRole("button", { name: "Launch a coin" }).click());
    expect(onLaunch).toHaveBeenCalled();
    expect(within(region).getByText("Raised for causes")).toHaveTextContent("(live)");
    expect(within(region).getAllByText("$48,210").length).toBeGreaterThan(0);
  });

  it("HeroToken shows name, ENS, price with direction, mode and cause", () => {
    render(
      <HeroToken
        name="Harambe"
        symbol="HARAMBE"
        ens="harambe.varada.eth"
        art={art}
        price="$0.000412"
        change24h={18.4}
        cause="wildlife"
        giving={{ mode: "live", cadence: "24h" }}
        headingLevel={2}
        actions={[{ label: "Buy" }, { label: "Sell", variant: "soft" }]}
      />,
    );
    const region = screen.getByRole("region", { name: /Harambe/ });
    expect(within(region).getByRole("heading", { level: 2 })).toHaveTextContent("Harambe $HARAMBE");
    expect(within(region).getByText("Up 18.4% in 24h")).toBeInTheDocument();
    expect(within(region).getByText("Live donation · 24h")).toBeInTheDocument();
    expect(within(region).getByText("Wildlife")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Copy harambe.varada.eth" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Sell" })).toBeInTheDocument();
  });

  it("HeroCause names the category and its curator agent", () => {
    render(<HeroCause cause="wildlife" raised={21480} charities={6} coins={14} curator={{ ens: "wildlife.agent.varada.eth", agentId: 7, status: "active" }} />);
    const region = screen.getByRole("region", { name: "Wildlife & endangered species" });
    expect(within(region).getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(within(region).getByText("Charities")).toBeInTheDocument();
    expect(within(region).getByText(/ERC-8004 #7/)).toBeInTheDocument();
    expect(within(region).getByText("Active")).toBeInTheDocument();
  });

  it("HeroLaunch lists the three steps under a labelled list", () => {
    render(<HeroLaunch stickers={[art]} actions={[{ label: "Start launch", href: "/launch" }]} />);
    const region = screen.getByRole("region", { name: "Launch a coin that gives" });
    const steps = within(region).getByRole("list", { name: "Three steps" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
    expect(within(steps).getAllByRole("listitem")[0]).toHaveTextContent("Step 1: Name it");
    expect(within(region).getByRole("link", { name: "Start launch" })).toHaveAttribute("href", "/launch");
  });
});
