import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ETH, ONDO_TOKENS, SwapError, WETH, USDC, type TradeQuote } from "@varada/sdk";

const TOKEN = "0x1111111111111111111111111111111111111111";
const HOOK = "0x2222222222222222222222222222222222222222";
const market = (quote = WETH) => ({ address: TOKEN, symbol: "TKN", hook: HOOK, quote, decimals: 18, mode: "weekly" }) as const;

const h = vi.hoisted(() => ({
  connected: true,
  connect: vi.fn(),
  quote: { status: "idle", quote: null, error: null, stale: false, updatedAt: null, refresh: vi.fn() } as Record<string, unknown>,
  swap: { phase: "idle", steps: [], hash: null, receipt: null, error: null, busy: false, execute: vi.fn(), reset: vi.fn() } as Record<string, unknown>,
  balances: new Map<string, bigint>(),
  quoteParams: [] as unknown[],
  resolved: null as unknown,
}));

vi.mock("wagmi", () => ({ useAccount: () => ({ isConnected: h.connected, address: h.connected ? "0x00000000000000000000000000000000000000aa" : undefined }), useConnect: () => ({ connectors: [{ id: "x" }], connect: h.connect }) }));
vi.mock("@/components/providers", () => ({ useAppConfig: () => ({}), useDeps: () => ({ indexer: {} }) }));
vi.mock("@/hooks/use-swap-clients", () => ({ useSwapClients: () => ({ chain: {}, account: "0x00000000000000000000000000000000000000aa" }) }));
vi.mock("@/hooks/use-swap-quote", () => ({ useSwapQuote: (p: unknown) => (h.quoteParams.push(p), h.quote) }));
vi.mock("@/hooks/use-swap", () => ({ useSwap: () => h.swap }));
vi.mock("@/hooks/use-swap-balances", () => ({ useBalances: () => ({ balances: h.balances, balanceOf: (a: { address: string }) => h.balances.get(a.address.toLowerCase()), loading: false, error: null, refresh: vi.fn() }) }));
vi.mock("@/hooks/use-swap-market", () => ({
  usePoolMarket: () => ({ market: { priceUsd: 5, tvlUsd: 120_000, tvlQuote: 48 }, quoteUsd: 2500, loading: false, error: null, refresh: vi.fn() }),
  useUsdPrices: () => ({ data: new Map([[ETH.address, 2500], [WETH.address.toLowerCase(), 2500], [USDC.address.toLowerCase(), 1]]) }),
}));
vi.mock("@/lib/swap/tokens", async (orig) => ({ ...(await orig<typeof import("@/lib/swap/tokens")>()), resolveMarketToken: async () => { if (h.resolved instanceof Error) throw h.resolved; return h.resolved; } }));
vi.mock("@/lib/swap/trade", async (orig) => ({ ...(await orig<typeof import("@/lib/swap/trade")>()), requestTradeQuote: async () => null, quoteImpactLadder: async () => [] }));
vi.mock("@/lib/swap/depth", () => ({ loadQuoteRouteDepth: async () => ({ sizeUsd: 10_000, impactPct: 0.04 }) }));

import { ConnectedTradePanel } from "@/components/swap/connected-trade-panel";

const wrapper = (children: ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;

function readyQuote(over: Partial<TradeQuote> = {}): TradeQuote {
  return {
    request: { side: "buy" },
    amountIn: 10n ** 18n,
    amountOut: 400n * 10n ** 18n,
    amountOutMin: 396n * 10n ** 18n,
    amountInMax: 10n ** 18n,
    feeFraction: 0.03,
    fee: { feeBps: 300, baseFeeBps: 100, sniperBps: 200, sniperActive: true, sniperEndsAt: Math.floor(Date.now() / 1000) + 600, causeShareBps: 9000, platformShareBps: 1000 },
    best: { priceImpactPct: 0.42 },
    alternatives: [{}, {}],
    routeLabel: "ETH > WETH > TKN",
    blockers: [],
    compliance: { blockers: [], warnings: [], checked: [] },
    quotedAt: Date.now(),
    ...over,
  } as unknown as TradeQuote;
}

beforeEach(() => {
  h.connected = true;
  h.connect.mockReset();
  h.swap = { phase: "idle", steps: [], hash: null, receipt: null, error: null, busy: false, execute: vi.fn(), reset: vi.fn() };
  h.quote = { status: "idle", quote: null, error: null, stale: false, updatedAt: null, refresh: vi.fn() };
  h.balances = new Map([[ETH.address, 5n * 10n ** 18n]]);
  h.quoteParams = [];
  h.resolved = market();
});

const renderPanel = (props = {}) => render(wrapper(<ConnectedTradePanel token={{ address: TOKEN, symbol: "TKN" }} causeName="Wildlife rescue" {...props} />));

describe("ConnectedTradePanel", () => {
  it("shows a loading note, then the ticket once the token resolves", async () => {
    renderPanel();
    expect(screen.getByLabelText("Trade")).toHaveAttribute("aria-busy", "true");
    await screen.findByRole("region", { name: /Buy TKN/ });
  });

  it("explains when the token cannot be traded", async () => {
    h.resolved = new Error("This token is not configured on any Varada hook");
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("Trading is not available for this token yet: This token is not configured on any Varada hook");
  });

  it("asks to connect the wallet when disconnected and connects on click", async () => {
    h.connected = false;
    renderPanel();
    const btn = await screen.findByRole("button", { name: "Connect wallet" });
    fireEvent.click(btn);
    expect(h.connect).toHaveBeenCalledWith({ connector: { id: "x" } });
  });

  it("says Enter an amount before anything is typed", async () => {
    renderPanel();
    expect(await screen.findByRole("button", { name: "Enter an amount" })).toBeDisabled();
  });

  it("flags an amount above the balance", async () => {
    renderPanel();
    const input = await screen.findByLabelText("You pay");
    fireEvent.change(input, { target: { value: "9" } });
    expect(await screen.findByRole("button", { name: "Insufficient ETH balance" })).toBeDisabled();
  });

  it("passes what the user typed to the quote hook and shows the quote: fee, split, sniper, minimum, route", async () => {
    h.quote = { status: "ready", quote: readyQuote(), error: null, stale: false, updatedAt: Date.now(), refresh: vi.fn() };
    renderPanel();
    const input = await screen.findByLabelText("You pay");
    fireEvent.change(input, { target: { value: "1" } });
    await screen.findByRole("button", { name: "Review buy" });
    const last = h.quoteParams.at(-1) as { side: string; asset: { symbol: string }; amountText: string; slippagePct: number };
    expect(last).toMatchObject({ side: "buy", amountText: "1", slippagePct: 1 });
    expect(last.asset.symbol).toBe("ETH");
    expect(screen.getByText(/Route: ETH > WETH > TKN \(best of 2\)/)).toBeInTheDocument();
    expect(screen.getAllByText(/3\.00%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/396/).length).toBeGreaterThan(0); // min received
    expect(screen.getAllByText(/2\.00%/).length).toBeGreaterThan(0); // sniper
    // 90 / 10 of a 3% fee on $2,500: $67.50 and $7.50
    expect(screen.getAllByText("$67.50").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$7.50").length).toBeGreaterThan(0);
  });

  it("submits the quote with the cause name", async () => {
    const quote = readyQuote();
    h.quote = { status: "ready", quote, error: null, stale: false, updatedAt: Date.now(), refresh: vi.fn() };
    renderPanel();
    fireEvent.change(await screen.findByLabelText("You pay"), { target: { value: "1" } });
    fireEvent.click(await screen.findByRole("button", { name: "Review buy" }));
    expect(h.swap.execute).toHaveBeenCalledWith(quote, expect.objectContaining({ causeName: "Wildlife rescue" }));
  });

  it("turns quote errors and blockers into the button label", async () => {
    h.quote = { status: "error", quote: null, error: new SwapError("no-route"), stale: false, updatedAt: null, refresh: vi.fn() };
    renderPanel();
    fireEvent.change(await screen.findByLabelText("You pay"), { target: { value: "1" } });
    expect(await screen.findByRole("button", { name: "No route" })).toBeDisabled();
  });

  it("shows the Ondo pause as a blocker with its message", async () => {
    const amzn = { address: ONDO_TOKENS.AMZNon.address, symbol: "AMZNon", decimals: 18 };
    h.resolved = market(amzn);
    h.quote = {
      status: "ready",
      quote: readyQuote({ blockers: ["paused"], compliance: { blockers: [{ reason: "paused", message: "AMZNon is paused by Ondo" }], warnings: [], checked: [] } }),
      error: null,
      stale: false,
      updatedAt: Date.now(),
      refresh: vi.fn(),
    };
    renderPanel();
    fireEvent.change(await screen.findByLabelText("You pay"), { target: { value: "1" } });
    expect(await screen.findByRole("button", { name: "Trading paused" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("AMZNon is paused by Ondo");
  });

  it("shows the swap steps and disables the button while the wallet is busy", async () => {
    h.quote = { status: "ready", quote: readyQuote(), error: null, stale: false, updatedAt: Date.now(), refresh: vi.fn() };
    h.swap = { ...h.swap, phase: "awaiting-wallet", busy: true, steps: [{ id: "approve", label: "Approve WETH", status: "done" }, { id: "swap", label: "Swap", status: "active" }] };
    renderPanel();
    fireEvent.change(await screen.findByLabelText("You pay"), { target: { value: "1" } });
    expect(await screen.findByRole("button", { name: "Confirm in your wallet" })).toBeDisabled();
    expect(screen.getByRole("list", { name: "Swap progress" })).toHaveTextContent("Done: Approve WETH");
    expect(screen.getByRole("list", { name: "Swap progress" })).toHaveTextContent("Now: Swap");
  });

  it("switching to sell changes the pay asset to the token and clears the amount", async () => {
    renderPanel();
    const input = (await screen.findByLabelText("You pay")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("radio", { name: /Sell/ }));
    await waitFor(() => expect((screen.getByLabelText("You pay") as HTMLInputElement).value).toBe(""));
    expect((h.quoteParams.at(-1) as { side: string }).side).toBe("sell");
  });

  it("renders the liquidity panel for the quote asset", async () => {
    renderPanel();
    expect(await screen.findByRole("region", { name: "Pair and liquidity" })).toHaveTextContent("$120,000");
    expect(screen.getByRole("region", { name: "Pair and liquidity" })).toHaveTextContent("Locked forever");
    await waitFor(() => expect(screen.getByRole("region", { name: "Pair and liquidity" })).toHaveTextContent("0.04%"));
  });

  it("can hide the details", async () => {
    renderPanel({ hideDetails: true });
    await screen.findByLabelText("You pay");
    expect(screen.queryByRole("region", { name: "Pair and liquidity" })).toBeNull();
  });
});
