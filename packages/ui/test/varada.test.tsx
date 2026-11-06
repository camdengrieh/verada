import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BallotList } from "@varada/ui/components/varada/ballot-list";
import type { BallotOptionData } from "@varada/ui/components/varada/ballot-option";
import { FeeSplitBar } from "@varada/ui/components/varada/fee-split-bar";
import { PriceChange } from "@varada/ui/components/varada/price-change";
import { SiteHeader } from "@varada/ui/components/varada/site-header";
import { StockLogo, stockLogoLetters } from "@varada/ui/components/varada/stock-logo";
import { TradePanel, impactSeverity, type TradePanelProps } from "@varada/ui/components/varada/trade-panel";
import { VoteFlowDialog, type VoteFlowState } from "@varada/ui/components/varada/vote-flow-dialog";

beforeAll(() => {
  // Radix radios measure themselves; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  MotionGlobalConfig.skipAnimations = true;
});

describe("PriceChange", () => {
  it("shows a dash and says there were no trades when there is nothing to compare", () => {
    const { container } = render(<PriceChange value={null} />);
    expect(container.querySelector("[data-direction=none]")).not.toBeNull();
    expect(container.textContent).toContain("–");
    expect(container.textContent).toContain("No trades in 24h");
  });
  it("shows the up glyph and says the direction in words", () => {
    const { container } = render(<PriceChange value={18.42} />);
    const visible = container.querySelector("[aria-hidden='true']");
    expect(visible).toHaveTextContent("▲ 18.4%");
    expect(screen.getByText("Up 18.4% in 24h")).toHaveClass("sr-only");
    expect(container.firstChild).toHaveClass("text-gain");
  });

  it("handles losses and flat values", () => {
    const { container, rerender } = render(<PriceChange value={-4.2} period="7d" />);
    expect(container.querySelector("[aria-hidden='true']")).toHaveTextContent("▼ 4.2%");
    expect(screen.getByText("Down 4.2% in 7d")).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("text-loss");
    rerender(<PriceChange value={0.01} />);
    expect(screen.getByText("Unchanged in 24h")).toBeInTheDocument();
  });
});

describe("StockLogo", () => {
  it("shows a lettered badge without a src", () => {
    render(<StockLogo symbol="NVDAon" />);
    const badge = screen.getByRole("img", { name: "NVDAon logo" });
    expect(badge.tagName).toBe("SPAN");
    expect(badge).toHaveTextContent("NV");
    expect(stockLogoLetters("SPYon")).toBe("SP");
    expect(stockLogoLetters("WETH")).toBe("WE");
  });

  it("uses the image, and falls back to letters when it fails to load", () => {
    render(<StockLogo symbol="TSLAon" src="https://gw.example/tsla-64.webp" />);
    const img = screen.getByRole("img", { name: "TSLAon logo" });
    expect(img.tagName).toBe("IMG");
    fireEvent.error(img);
    expect(screen.getByRole("img", { name: "TSLAon logo" })).toHaveTextContent("TS");
  });
});

const BALLOT: BallotOptionData[] = [
  { id: "1", org: "Save the Elephants", category: "wildlife", region: "Africa", source: "pinned" },
  { id: "2", org: "Wildlife SOS", category: "wildlife", region: "Asia", source: "pinned" },
  { id: "3", org: "TRAFFIC International", category: "wildlife", region: "Global", source: "curated" },
  { id: "4", org: "Rainforest Trust", category: "environment", region: "Latin America & Caribbean", source: "rotation" },
  { id: "5", org: "Innocence Project", category: "justice", region: "North America", source: "rotation" },
];

describe("BallotList", () => {
  it("filters by source tab and by search", () => {
    render(<BallotList options={BALLOT} />);
    expect(screen.getAllByRole("radio")).toHaveLength(5);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Pinned 2" }));
    expect(screen.getAllByRole("radio")).toHaveLength(2);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "All 5" }));
    fireEvent.change(screen.getByLabelText("Search the ballot"), { target: { value: "rainforest" } });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(1);
    expect(radios[0]).toHaveAccessibleName(/Rainforest Trust/);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Pinned 2" }));
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText(/No charities match/)).toBeInTheDocument();
  });

  it("moves and selects with the arrow keys", async () => {
    const onValueChange = vi.fn();
    render(<BallotList options={BALLOT} defaultValue="1" onValueChange={onValueChange} />);
    const group = screen.getByRole("radiogroup", { name: "Choose a charity" });
    const [first, second] = within(group).getAllByRole("radio");
    expect(first).toHaveAttribute("aria-checked", "true");

    act(() => first!.focus());
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    await waitFor(() => expect(second).toHaveFocus());
    await waitFor(() => expect(second).toHaveAttribute("aria-checked", "true"));
    expect(onValueChange).toHaveBeenLastCalledWith("2");
    expect(first).toHaveAttribute("aria-checked", "false");
  });
});

function VoteHarness({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<VoteFlowState>("confirm");
  return (
    <>
      <VoteFlowDialog
        open
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
        state={state}
        choice={{ org: "Save the Elephants", category: "wildlife" }}
        weight="38.9M $HARAMBE"
        onConfirm={() => setState("encrypting")}
      />
      {/* Stand-ins for the app's wallet callbacks. */}
      <button type="button" data-testid="advance" onClick={() => setState((s) => (s === "encrypting" ? "wallet" : "sent"))} />
    </>
  );
}

describe("VoteFlowDialog", () => {
  it("advances confirm → encrypting → wallet → sent and closes", async () => {
    const onClose = vi.fn();
    render(<VoteHarness onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Confirm your private vote" })).toBeInTheDocument();
    expect(screen.getByText("Save the Elephants")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Encrypt and send" }));
    expect(await screen.findByRole("heading", { name: "Encrypting your ballot" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Encrypting your choice, step 1 of 3");

    fireEvent.click(screen.getByTestId("advance"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Waiting for your wallet signature, step 2 of 3"));
    const steps = within(screen.getByRole("list", { name: "Vote progress" })).getAllByRole("listitem");
    expect(steps[0]).toHaveTextContent("(done)");
    expect(steps[1]).toHaveAttribute("aria-current", "step");

    fireEvent.click(screen.getByTestId("advance"));
    expect(await screen.findByRole("heading", { name: "Vote sent" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("FeeSplitBar", () => {
  it("labels the split and shows amounts", () => {
    render(<FeeSplitBar causeAmount="$28.11" platformAmount="$3.12" />);
    expect(screen.getByRole("img", { name: "Fee split: 90% to the cause ($28.11), 10% platform ($3.12)" })).toBeInTheDocument();
    expect(screen.getByText("$28.11")).toBeInTheDocument();
    expect(screen.getByText("$3.12")).toBeInTheDocument();
  });

  it("works without amounts and with another share", () => {
    render(<FeeSplitBar causeShare={80} compact />);
    expect(screen.getByRole("img", { name: "Fee split: 80% to the cause, 20% platform" })).toBeInTheDocument();
    expect(screen.queryByText("80%")).toBeNull();
  });
});

function trade(overrides: Partial<TradePanelProps> = {}) {
  const props: TradePanelProps = {
    side: "buy",
    onSideChange: vi.fn(),
    pay: { symbol: "NVDAon", kind: "stock", balance: "3,402.18" },
    receive: { symbol: "$HARAMBE" },
    payAmount: "9.65",
    onPayAmountChange: vi.fn(),
    receiveAmount: "295,820,000",
    onPercent: vi.fn(),
    slippage: 1,
    fee: "2.5%",
    priceImpact: 0.42,
    causeAmount: "$28.11",
    causeName: "Save the Elephants",
    onSubmit: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<TradePanel {...props} />) };
}

describe("TradePanel", () => {
  it("calls back with the percent chips", () => {
    const { props } = trade();
    fireEvent.click(screen.getByRole("button", { name: "Use 25% of your NVDAon balance" }));
    fireEvent.click(screen.getByRole("button", { name: "Use 50% of your NVDAon balance" }));
    fireEvent.click(screen.getByRole("button", { name: "Use your whole NVDAon balance" }));
    expect(props.onPercent).toHaveBeenNthCalledWith(1, 25);
    expect(props.onPercent).toHaveBeenNthCalledWith(2, 50);
    expect(props.onPercent).toHaveBeenNthCalledWith(3, 100);
  });

  it("names the blocker on the action button", () => {
    const { props, rerender } = trade({ payAmount: "" });
    expect(screen.getByRole("button", { name: "Enter an amount" })).toBeDisabled();

    rerender(<TradePanel {...props} blocker={{ label: "Insufficient NVDAon balance" }} />);
    return screen.findByRole("button", { name: "Insufficient NVDAon balance" }).then((b) => {
      expect(b).toBeDisabled();
    });
  });

  it("runs the blocker's action when it has one, otherwise submits", async () => {
    const onAction = vi.fn();
    const { props, rerender } = trade({ blocker: { label: "Connect wallet", onAction } });
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();

    rerender(<TradePanel {...props} blocker={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review buy" }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps only valid amounts and grades price impact", () => {
    const { props } = trade();
    const input = screen.getByLabelText("You pay");
    fireEvent.change(input, { target: { value: "1,250.5" } });
    expect(props.onPayAmountChange).toHaveBeenLastCalledWith("1250.5");
    fireEvent.change(input, { target: { value: "12abc" } });
    expect(props.onPayAmountChange).toHaveBeenCalledTimes(1);
    expect(impactSeverity(0.4)).toBe("low");
    expect(impactSeverity(1.6)).toBe("medium");
    expect(impactSeverity(4.8)).toBe("high");
  });
});

describe("SiteHeader", () => {
  const links = [
    { href: "/", label: "Discover" },
    { href: "/launch/", label: "Launch" },
    { href: "/vote/", label: "Governance" },
  ];

  it("marks the active link and opens the menu sheet", async () => {
    render(<SiteHeader links={links} activeHref="/launch/" search={{}} wallet={<button type="button">Connect wallet</button>} />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Launch" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Discover" })).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("link", { name: "Launch" })).toHaveAttribute("aria-current", "page");
    expect(within(sheet).getByLabelText("Search coins, causes or paste an address")).toBeInTheDocument();

    fireEvent.click(within(sheet).getByRole("button", { name: "Close menu" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("uses the app's link component", () => {
    const Rel = ({ href, children, ...p }: { href: string; children: React.ReactNode; className?: string }) => (
      <a href={`../${href.replace(/^\//, "")}`} {...p}>
        {children}
      </a>
    );
    render(<SiteHeader links={links} LinkComponent={Rel} />);
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Governance" })).toHaveAttribute("href", "../vote/");
  });
});
