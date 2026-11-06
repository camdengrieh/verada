import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envDefaults, type AppConfig } from "@/lib/config";
import { IndexerClient } from "@/lib/indexer";
import { tickPrice } from "@/lib/token-market";

const TOKEN = "0x00000000000000000000000000000000000000A1";
const CONTROLLER = "0x00000000000000000000000000000000000000C0";
const VIEWER = "0x00000000000000000000000000000000000000B2";
const CAUSE_A = `0x${"0a".repeat(32)}`;
const CAUSE_B = `0x${"0b".repeat(32)}`;
const LOGO = "ab".repeat(32);
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
/** The current UTC hour, so the hourly fixtures sit inside the page's 24 hour and 7 day windows. */
const HOUR = Math.floor(Date.now() / 3_600_000) * 3_600;
const TRADER = "0x00000000000000000000000000000000000000f9";

const config: AppConfig = {
  ...envDefaults(),
  indexerUrls: ["https://idx.example"],
  governorAddress: "0x00000000000000000000000000000000000000d1",
  profileRegistryAddress: "0x00000000000000000000000000000000000000d2",
  votingSchemeAddress: "0x00000000000000000000000000000000000000d3",
  takeoverGovernorAddress: "0x00000000000000000000000000000000000000d4",
  swarmGatewayUrl: "https://gw.example",
};

const fixtures: Record<string, unknown> = {
  [`/api/tokens/${TOKEN}`]: {
    address: TOKEN,
    name: "Moon Cat",
    symbol: "MCAT",
    creator: "0x00000000000000000000000000000000000000E1",
    label: "moon-cat",
    profile: {
      label: "moon-cat",
      labelhash: `0x${"11".repeat(32)}`,
      controller: CONTROLLER,
      editor: "0x0000000000000000000000000000000000000000",
      logoRef: `0x${LOGO}`,
      suppressed: false,
      registeredAt: "1700000000",
      textRecords: { url: "https://mooncat.example", "com.twitter": "mooncat", description: "A cat on the moon" },
    },
    feeTotals: { settlementAsset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", platformAmount: "1000000", causeAmount: "9000000", collections: 2, lastCollectedAt: String(HOUR) },
    shortlist: [CAUSE_A, CAUSE_B],
    focus: { categoryMask: "4", regionMask: 1, categories: ["hunger"], regions: ["africa"] },
    ballotSize: { cap: 30, choice: 0, size: 30, choiceEffectiveFrom: null },
  },
  // The pinned causes' catalogue entries (hunger x Africa is bucket 32), so the editor can re-save them.
  [`/api/catalog/orgs/${CAUSE_A}`]: {
    root: `0x${"99".repeat(32)}`,
    org: { orgId: `0x${"a1".repeat(32)}`, causeId: CAUSE_A, ein: "100000001", name: "Alpha Fund", country: "KEN", categories: ["hunger"], regions: ["africa"] },
    entries: [{ bucket: 32, index: 0, orgId: `0x${"a1".repeat(32)}`, proof: [`0x${"98".repeat(32)}`] }],
  },
  [`/api/catalog/orgs/${CAUSE_B}`]: {
    root: `0x${"99".repeat(32)}`,
    org: { orgId: `0x${"b1".repeat(32)}`, causeId: CAUSE_B, ein: "100000002", name: "Beta Trust", country: "KEN", categories: ["hunger"], regions: ["africa"] },
    entries: [{ bucket: 32, index: 1, orgId: `0x${"b1".repeat(32)}`, proof: [`0x${"97".repeat(32)}`] }],
  },
  "/api/causes": { items: [{ causeId: CAUSE_A, name: "Alpha Fund", active: true }, { causeId: CAUSE_B, name: "Beta Trust", active: true }], nextCursor: null },
  [`/api/epochs/${TOKEN}/5`]: {
    epoch: "5",
    options: [CAUSE_A, CAUSE_B],
    prepared: true,
    poolSize: "40",
    poll: { opened: true, closed: true, isFinal: true, optionCount: 2, counts: ["10", "250"], ballotCount: 3, scheme: config.votingSchemeAddress },
    voterCount: 3,
    start: 1700000000,
    end: 1700604800,
    snapshot: 1699999999,
  },
  [`/api/takeovers/${TOKEN}`]: { items: [] },
  // Agents for hunger (in the focus, categoryMask 4 = bit 2) and homelessness (not in it).
  "/api/agents": {
    items: [
      { categoryBit: 1, category: "homelessness", name: "Homelessness", label: "homeless", ensName: "homeless.agent.varada.eth", active: true, totals: null, latest: null },
      { categoryBit: 2, category: "hunger", name: "Hunger & famine", label: "hunger", ensName: "hunger.agent.varada.eth", active: false, totals: null, latest: null },
    ],
  },
};
fixtures["/api/tokens/by-label/moon-cat"] = fixtures[`/api/tokens/${TOKEN}`];

const trade = (i: number, side: "buy" | "sell", trader: string, ago: number) => ({
  id: `0x${i.toString(16).padStart(64, "0")}-1`,
  side,
  trader,
  sender: trader,
  tokenAmount: "2500000000000000000000",
  quote: WETH,
  quoteAmount: "5000000000000000",
  quoteDecimals: 18,
  price: tickPrice(-69_000, true, 18),
  feePips: 10000,
  timestamp: String(HOUR + 3_600 - ago),
  txHash: `0x${i.toString(16).padStart(64, "a")}`,
});
const MARKET = {
  quote: WETH,
  quoteDecimals: 18,
  price: tickPrice(-68_900, true, 18),
  lastTradeAt: String(HOUR + 100),
  lifetime: { trades: 3, buys: 2, sells: 1, volumeQuote: "30000000000000000" },
  window: { hours: 168, trades: 3, buys: 2, sells: 1, buyQuote: "20000000000000000", sellQuote: "10000000000000000", volumeQuote: "30000000000000000", buyShare: 66.7 },
  hourly: [
    { hour: String(HOUR - 7_200), buys: 1, sells: 1, buyQuote: "10000000000000000", sellQuote: "10000000000000000", buyToken: "1", sellToken: "1", openTick: -69_100, highTick: -68_950, lowTick: -69_100, closeTick: -69_000, closeSqrtPriceX96: "1", closePrice: tickPrice(-69_000, true, 18) },
    { hour: String(HOUR), buys: 1, sells: 0, buyQuote: "10000000000000000", sellQuote: "0", buyToken: "1", sellToken: "0", openTick: -69_000, highTick: -68_900, lowTick: -69_000, closeTick: -68_900, closeSqrtPriceX96: "1", closePrice: tickPrice(-68_900, true, 18) },
  ],
};
fixtures[`/api/tokens/${TOKEN}/market`] = MARKET;
fixtures[`/api/tokens/${TOKEN}/trades`] = {
  quote: WETH,
  quoteDecimals: 18,
  items: [trade(3, "buy", VIEWER, 60), trade(2, "sell", TRADER, 600), trade(1, "buy", TRADER, 7_200)],
  nextCursor: null,
};
fixtures[`/api/tokens/${TOKEN}/holders`] = {
  holders: 3,
  supply: "1000000000000000000000000000",
  items: [
    { rank: 1, account: "0x00000000000000000000000000000000000000f1", balance: "600000000000000000000000000", share: 60, label: "pool" },
    { rank: 2, account: "0x00000000000000000000000000000000000000e1", balance: "100000000000000000000000000", share: 10, label: "creator" },
    { rank: 3, account: TRADER, balance: "50000000000000000000000000", share: 5, label: null },
  ],
};
fixtures[`/api/tokens/${TOKEN}/holders/summary`] = {
  holders: 3,
  newHolders24h: 1,
  supply: "1000000000000000000000000000",
  poolShare: 60,
  creatorShare: 10,
  contractShare: 60,
  top10Share: 15,
  buckets: [
    { label: "1% or more", holders: 2, share: 15 },
    { label: "0.1% to 1%", holders: 0, share: 0 },
    { label: "0.01% to 0.1%", holders: 0, share: 0 },
    { label: "Under 0.01%", holders: 1, share: 0.01 },
  ],
  history: [
    { day: String(HOUR - 86_400), holders: 2 },
    { day: String(HOUR), holders: 3 },
  ],
};
fixtures["/api/activity"] = {
  items: [{ id: `donation:d1`, kind: "donation", token: TOKEN, timestamp: String(HOUR - 3_600), txHash: `0x${"d1".repeat(32)}`, data: { epoch: "4", causeId: CAUSE_B, payout: "0x00000000000000000000000000000000000000aa", amount: "4500000" } }],
  nextCursor: null,
};

const unavailable = new Set<string>();
const fetchMock = vi.fn(async (input: string) => {
  const path = new URL(input).pathname;
  if (unavailable.has(path)) return { ok: false, status: 503, json: async () => ({ error: "agents_unavailable" }) };
  return path in fixtures
    ? { ok: true, status: 200, json: async () => fixtures[path] }
    : { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
});
const indexer = new IndexerClient(config.indexerUrls, { fetchImpl: fetchMock as unknown as typeof fetch });
const chainRead = vi.fn(async ({ functionName }: { functionName: string }) => {
  if (functionName === "currentEpoch") return 5n;
  if (functionName === "quoteAssetOf") return WETH;
  if (functionName === "params") return { votingPeriod: 259200, executionWindow: 604800, cooldown: 0, minTokenAge: 604800, quorumBps: 1000, proposalThresholdBps: 100, lookback: 86400 };
  throw new Error(`unexpected public read ${functionName}`);
});
const accountRead = vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "weightOf" ? 42n : false));
const account = { address: undefined as string | undefined };
const writeContract = vi.fn(async (_args: unknown) => "0x01");

vi.mock("@/components/providers", () => ({
  useAppConfig: () => config,
  useDeps: () => ({ indexer, chain: () => ({ readContract: chainRead }) }),
  usePrivateRpc: () => ({}),
  usePrivacyPrefs: () => [{ routeIndexer: false }, vi.fn()],
}));
// jsdom has no canvas: the chart is replaced by a labelled stand-in.
vi.mock("@varada/ui/components/data/price-chart", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@varada/ui/components/data/price-chart")>();
  return {
    ...actual,
    PriceChart: (p: { label: string; toolbar?: React.ReactNode; candles?: unknown[]; points?: unknown[]; kind?: string }) => (
      <div data-testid="price-chart" data-kind={p.kind} data-candles={p.candles?.length ?? 0} data-points={p.points?.length ?? 0}>
        {p.toolbar}
        <div role="img" aria-label={p.label} />
      </div>
    ),
  };
});
vi.mock("@/lib/account-reads", () => ({ createAccountClient: (_rpc: unknown, address: string) => ({ address, readContract: accountRead }) }));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: account.address }),
  useWriteContract: () => ({ writeContractAsync: writeContract, data: undefined, isPending: false, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, error: null }),
}));

// The swap engine has its own tests: here the ticket is a stand-in that shows what the page hands it.
const ticket = vi.fn((_p: unknown) => {});
vi.mock("@/components/swap", () => ({
  ConnectedTradePanel: (p: { token: { address: string; symbol: string }; causeName?: string; causeIcon?: string; onSwapped?: () => void }) => {
    ticket(p);
    return (
      <div data-testid="ticket" data-cause={p.causeName} data-icon={p.causeIcon}>
        Ticket for {p.token.symbol} at {p.token.address}
        <button onClick={p.onSwapped}>Swapped</button>
      </div>
    );
  },
}));
vi.mock("@/hooks/use-swap-market", () => ({
  usePoolMarket: () => ({ market: { tvlUsd: 9_000_000, tvlQuote: 3750, depthUsd: 123_456, depthQuote: 50, quote: { symbol: "WETH" } }, quoteUsd: 2400, loading: false, error: null, refresh: vi.fn() }),
  useUsdPrices: () => ({ data: new Map() }),
}));
const viewport = { wide: true };
window.matchMedia = ((q: string) => ({ matches: viewport.wide && /min-width/.test(q), media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;

const cast = vi.fn(async (_args: unknown) => {});
const castState = { phase: "idle" as "idle" | "encrypting" | "signing" | "sent" | "error", error: undefined as string | undefined };
vi.mock("@/components/use-cast-ballot", () => ({
  useCastBallot: () => ({
    adapter: { id: "test", label: "Test ballot", private: true, placeholder: false, buildCall: vi.fn() },
    phase: castState.phase,
    error: castState.error,
    tx: { hash: undefined, isPending: false, error: null, receipt: undefined, receiptError: null, reset: vi.fn(), send: vi.fn() },
    cast,
  }),
}));

const { TokenDetail } = await import("@/components/token-detail");

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole("tab", { name }));
const heading = () => screen.findByRole("heading", { level: 1 });

describe("token page", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    accountRead.mockClear();
    ticket.mockClear();
    viewport.wide = true;
    window.history.replaceState(null, "", `/token/?address=${TOKEN}`);
  });

  it("renders the hero: name, ticker, logo, ENS name, links, cause focus and the pool's quote asset", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    const h1 = await heading();
    expect(h1).toHaveTextContent("Moon Cat");
    expect(h1).toHaveTextContent("$MCAT");
    expect(screen.getAllByRole("img", { name: "MCAT logo" })[0]).toHaveAttribute("src", `https://gw.example/bzz/${LOGO}/`);
    expect(screen.getAllByText("moon-cat", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /moon-cat/ })).toHaveAttribute("href", "https://moon-cat.varada.eth.limo");
    expect(screen.getByText("A cat on the moon")).toBeInTheDocument();
    const links = screen.getByRole("list", { name: "Links" });
    expect(within(links).getByRole("link", { name: /mooncat\.example/ })).toHaveAttribute("href", "https://mooncat.example");
    expect(within(links).getByRole("link", { name: /@mooncat/ })).toHaveAttribute("href", "https://x.com/mooncat");
    // Focus: hunger in Africa, fixed at launch.
    expect(screen.getAllByText(/Hunger/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Africa/).length).toBeGreaterThan(0);
    // Weekly pool, the pool's quote asset from the market.
    expect(screen.getAllByText(/Weekly pool/i).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getAllByText(/WETH/).length).toBeGreaterThan(0));
  });

  it("mounts the trade ticket in the desktop aside with the token, its cause and a refresh hook", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    await heading();
    const aside = screen.getByRole("complementary", { name: "Trade and giving" });
    const ticketEl = await within(aside).findByTestId("ticket");
    expect(ticketEl).toHaveTextContent(`Ticket for MCAT at ${TOKEN}`);
    // A single focus cause names the fee split and gives its icon.
    expect(ticketEl).toHaveAttribute("data-cause", "Hunger");
    expect(ticketEl).toHaveAttribute("data-icon", "hunger");
    expect(screen.getAllByTestId("ticket")).toHaveLength(1);
    // The hero's buy action scrolls to it, and there is no sticky bar or sheet on a wide screen.
    expect(screen.getByRole("button", { name: "Buy $MCAT" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trade $MCAT" })).toBeNull();
    // A mined swap refetches the page's data for this token.
    const before = fetchMock.mock.calls.length;
    fireEvent.click(within(ticketEl).getByRole("button", { name: "Swapped" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it("on a phone the ticket opens from the sticky action bar in a sheet, and is mounted once", async () => {
    viewport.wide = false;
    account.address = undefined;
    wrap(<TokenDetail />);
    await heading();
    expect(screen.queryByTestId("ticket")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Trade $MCAT" }));
    const sheet = await screen.findByRole("dialog", { name: /Trade \$MCAT/ });
    expect(within(sheet).getByTestId("ticket")).toHaveTextContent(`Ticket for MCAT at ${TOKEN}`);
    expect(screen.getAllByTestId("ticket")).toHaveLength(1);
  });

  it("shows the pool's liquidity next to the market metrics", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    await heading();
    expect(await screen.findByText("Liquidity")).toBeInTheDocument();
    expect(await screen.findByText(/\$123\.46K|\$123,456/)).toBeInTheDocument();
  });

  it("shows the market: price in the quote asset, 24h change, volume, holders, fees and a chart with candles", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    const metrics = await screen.findByRole("region", { name: "Trading metrics" }).catch(() => null);
    const bar = metrics ?? (await screen.findByText("Fees to causes")).closest("dl")!;
    await waitFor(() => expect(within(bar as HTMLElement).getByText(/Volume 24h/)).toBeInTheDocument());
    expect(within(bar as HTMLElement).getByText("Holders")).toBeInTheDocument();
    expect(within(bar as HTMLElement).getByText("Fees to causes")).toBeInTheDocument();
    const chart = await screen.findByTestId("price-chart");
    expect(chart).toHaveAttribute("data-kind", "candles");
    expect(Number(chart.getAttribute("data-candles"))).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("img", { name: /MCAT price in WETH, last 24 hours, up/ })).toBeInTheDocument();
    // 1H draws every trade of the last hour as a line.
    fireEvent.click(screen.getByRole("button", { name: "1H" }));
    expect(screen.getByTestId("price-chart")).toHaveAttribute("data-kind", "area");
    expect(screen.getByRole("img", { name: /last hour, per trade/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "7D" }));
    expect(screen.getByTestId("price-chart")).toHaveAttribute("data-kind", "candles");
    // Pressure and volume sit under the chart.
    expect(screen.getByRole("heading", { name: "Buy and sell pressure" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Volume by day/ })).toBeInTheDocument();
  });

  it("makes a brand-new token look intentional: no trades, no holders, nothing raised", async () => {
    account.address = undefined;
    const saved = { m: fixtures[`/api/tokens/${TOKEN}/market`], t: fixtures[`/api/tokens/${TOKEN}/trades`], h: fixtures[`/api/tokens/${TOKEN}/holders`], s: fixtures[`/api/tokens/${TOKEN}/holders/summary`], a: fixtures["/api/activity"], d: fixtures[`/api/tokens/${TOKEN}`] };
    fixtures[`/api/tokens/${TOKEN}/market`] = { quote: null, quoteDecimals: null, price: null, lastTradeAt: null, lifetime: null, window: { hours: 168, trades: 0, buys: 0, sells: 0, buyQuote: "0", sellQuote: "0", volumeQuote: "0", buyShare: null }, hourly: [] };
    fixtures[`/api/tokens/${TOKEN}/trades`] = { quote: null, quoteDecimals: null, items: [], nextCursor: null };
    fixtures[`/api/tokens/${TOKEN}/holders`] = { holders: 0, supply: "0", items: [] };
    delete fixtures[`/api/tokens/${TOKEN}/holders/summary`];
    fixtures["/api/activity"] = { items: [], nextCursor: null };
    fixtures[`/api/tokens/${TOKEN}`] = { ...(saved.d as object), feeTotals: null };
    try {
      wrap(<TokenDetail />);
      expect(await screen.findByRole("heading", { name: "No trades in MCAT yet", level: 3 })).toBeInTheDocument();
      expect(screen.getByText("No trades yet")).toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: "Swaps will be listed here" })).toBeInTheDocument();
      openTab("Holders");
      expect(await screen.findByText("No holders yet")).toBeInTheDocument();
      openTab("Impact");
      expect(await screen.findByText("MCAT has not raised anything yet")).toBeInTheDocument();
    } finally {
      fixtures[`/api/tokens/${TOKEN}/market`] = saved.m;
      fixtures[`/api/tokens/${TOKEN}/trades`] = saved.t;
      fixtures[`/api/tokens/${TOKEN}/holders`] = saved.h;
      fixtures[`/api/tokens/${TOKEN}/holders/summary`] = saved.s;
      fixtures["/api/activity"] = saved.a;
      fixtures[`/api/tokens/${TOKEN}`] = saved.d;
    }
  });

  it("offers a retry when the market data cannot be loaded", async () => {
    account.address = undefined;
    const saved = fixtures[`/api/tokens/${TOKEN}/market`];
    delete fixtures[`/api/tokens/${TOKEN}/market`];
    unavailable.add(`/api/tokens/${TOKEN}/market`);
    try {
      wrap(<TokenDetail />);
      expect(await screen.findByText("Market data is not available")).toBeInTheDocument();
      unavailable.delete(`/api/tokens/${TOKEN}/market`);
      fixtures[`/api/tokens/${TOKEN}/market`] = saved;
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.queryByText("Market data is not available")).toBeNull());
      expect(await screen.findByTestId("price-chart")).toBeInTheDocument();
    } finally {
      unavailable.delete(`/api/tokens/${TOKEN}/market`);
      fixtures[`/api/tokens/${TOKEN}/market`] = saved;
    }
  });

  it("lists trades with side, amounts and the quote asset; 'my trades' filters in the browser", async () => {
    account.address = VIEWER;
    wrap(<TokenDetail />);
    const feed = await screen.findByRole("region", { name: "Trades" });
    await waitFor(() => expect(within(feed).getAllByRole("link", { name: /View transaction|transaction/i }).length).toBeGreaterThan(0));
    expect(within(feed).getAllByText(/WETH/).length).toBeGreaterThan(0);
    const rowsBefore = within(feed).getAllByRole("listitem").length;
    expect(rowsBefore).toBe(3);
    fireEvent.click(screen.getByRole("switch", { name: "My trades" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Trades" })).getAllByRole("listitem")).toHaveLength(1));
    // The viewer's address is compared in the browser; no request carries it.
    for (const [url] of fetchMock.mock.calls) expect(String(url).toLowerCase()).not.toContain(VIEWER.slice(2).toLowerCase());
  });

  it("disables 'my trades' without a wallet", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    const toggle = await screen.findByRole("switch", { name: /My trades/ });
    expect(toggle).toBeDisabled();
  });

  it("shows holders with pool and creator tags, concentration and holder bands", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    await heading();
    openTab("Holders");
    const table = await screen.findByRole("region", { name: /Top holders/ });
    expect(within(table).getAllByText(/pool/i).length).toBeGreaterThan(0);
    expect(within(table).getAllByText(/creator/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1% or more/).length).toBeGreaterThan(0);
  });

  it("shows the impact: raised, paid by cause, charities and the payout with its transaction", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    await heading();
    openTab("Impact");
    const raised = await screen.findByRole("region", { name: /Raised for causes/ });
    expect(raised).toHaveTextContent("$9");
    expect(await screen.findByText("Paid by cause")).toBeInTheDocument();
    const timeline = await screen.findByRole("region", { name: "Recent donations" });
    expect(within(timeline).getAllByText(/Beta Trust/).length).toBeGreaterThan(0);
    expect(within(timeline).getByRole("link", { name: /transaction/i })).toHaveAttribute("href", expect.stringContaining(`0x${"d1".repeat(32)}`));
  });

  it("marks a live-donation token and shows who it gives to now", async () => {
    account.address = undefined;
    fixtures[`/api/live/${TOKEN}`] = {
      token: TOKEN,
      threshold: "5000000",
      initialCause: CAUSE_A,
      initialPeriod: "OneDay",
      quote: WETH,
      rotation: { current: "3", period: "OneDay", periodSeconds: 86400, startedAt: String(HOUR - 3600), nextRotationAt: String(HOUR + 82_800) },
      designatedCause: { causeId: CAUSE_A },
      nextCause: { causeId: CAUSE_B, fromRotation: "4", startsAt: String(HOUR + 82_800) },
      totals: { gross: "10000000", platform: "1000000", credited: "9000000", donated: "6000000", pending: "3000000" },
      causes: [{ causeId: CAUSE_A, gross: "10000000", platform: "1000000", credited: "9000000", donated: "6000000", pending: "3000000", credits: 4, donations: 2 }],
      recentDonations: [{ id: "l1", token: TOKEN, causeId: CAUSE_A, org: "0x0", amount: "6000000", orgDeployed: true, inSwap: true, timestamp: String(HOUR - 600), txHash: `0x${"e1".repeat(32)}` }],
    };
    try {
      wrap(<TokenDetail />);
      await heading();
      const giving = await screen.findByRole("heading", { name: "Giving now" });
      expect(giving).toBeInTheDocument();
      expect(screen.getAllByText(/Live donation/).length).toBeGreaterThan(0);
      expect((await screen.findAllByText("Alpha Fund")).length).toBeGreaterThan(0);
      expect(screen.queryByText(/Epoch 5 cause pool/)).toBeNull();
    } finally {
      delete fixtures[`/api/live/${TOKEN}`];
    }
  });

  it("shows the about tab: profile records, controller and the eth.limo site", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    await heading();
    openTab("About");
    const about = await screen.findByRole("tabpanel");
    await waitFor(() => expect(within(about).getAllByText("moon-cat", { exact: false }).length).toBeGreaterThan(0));
    expect(within(about).getAllByTitle(CONTROLLER).length).toBeGreaterThan(0);
    expect(within(about).getByText("A cat on the moon")).toBeInTheDocument();
    expect(within(about).getByRole("link", { name: /open site/i })).toHaveAttribute("href", "https://moon-cat.varada.eth.limo");
  });

  it("renders the governance tab: the finalized poll with results, no owner panels for an anonymous viewer", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    await heading();
    openTab("Governance");
    const epoch = await screen.findByRole("region", { name: "Current epoch" });
    await waitFor(() => expect(within(epoch).getByText("Tally decrypted", { exact: false })).toBeInTheDocument());
    await waitFor(() => expect(within(epoch).getByText("250 votes, leading")).toBeInTheDocument());
    expect(within(epoch).getByText("10 votes")).toBeInTheDocument();
    expect(within(epoch).getByText("Beta Trust")).toBeInTheDocument();
    expect(within(epoch).getByText(/Connect a wallet/)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Manage" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Edit profile" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("form", { name: "Propose takeover" })).toBeInTheDocument());
  });

  it("shows this week's pool next to the trade area", async () => {
    account.address = undefined;
    const saved = fixtures[`/api/epochs/${TOKEN}/5`];
    fixtures[`/api/epochs/${TOKEN}/5`] = { ...(saved as object), causePool: { attributed: "12000000", pending: "12000000", settledAmount: null, settledAt: null, accruals: [{ accrualEpoch: "5", causeAmount: "9000000", parts: 2 }, { accrualEpoch: "4", causeAmount: "3000000", parts: 1 }], carriedForward: [] }, pinnedCount: 1, curatedCount: 0, optionSources: ["pinned", "rotation"], prepared: true };
    try {
      wrap(<TokenDetail />);
      await heading();
      const pool = await screen.findByRole("region", { name: /Epoch 5 cause pool/ });
      expect(pool).toHaveTextContent("$12.00");
      expect(pool).toHaveTextContent("$9.00");
      expect(pool).toHaveTextContent("$3.00");
      expect(pool).toHaveTextContent("1 pinned · 0 curated · 1 rotation");
      // The CTA opens the governance tab.
      fireEvent.click(within(pool).getByRole("button"));
      expect(await screen.findByRole("region", { name: "Current epoch" })).toBeInTheDocument();
    } finally {
      fixtures[`/api/epochs/${TOKEN}/5`] = saved;
    }
  });

  it("votes through the confirm dialog: pick a charity, vote privately, confirm", async () => {
    account.address = VIEWER;
    cast.mockClear();
    const saved = fixtures[`/api/epochs/${TOKEN}/5`];
    fixtures[`/api/epochs/${TOKEN}/5`] = { ...(saved as object), poll: { opened: true, closed: false, isFinal: false, optionCount: 2, counts: null, ballotCount: 0, scheme: config.votingSchemeAddress }, pinnedCount: 1, curatedCount: 0, optionSources: ["pinned", "rotation"] };
    try {
      wrap(<TokenDetail />);
      await heading();
      openTab("Governance");
      const form = await screen.findByRole("form", { name: "Vote" });
      const options = await within(form).findAllByRole("radio");
      expect(options).toHaveLength(2);
      expect(options[0]).toHaveAccessibleName(/Alpha Fund.*Pinned/);
      expect(options[1]).toHaveAccessibleName(/Beta Trust.*Rotation/);
      // No choice yet: the form says so instead of opening the dialog.
      fireEvent.click(within(form).getByRole("button", { name: "Vote privately" }));
      expect(await within(form).findByText("Choose a cause")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(options[1]!);
      fireEvent.click(within(form).getByRole("button", { name: "Vote privately" }));
      const dialog = await screen.findByRole("dialog", { name: "Confirm your private vote" });
      expect(dialog).toHaveTextContent("Beta Trust");
      expect(dialog).toHaveTextContent("42 $MCAT");
      fireEvent.click(within(dialog).getByRole("button", { name: "Encrypt and send" }));
      expect(cast).toHaveBeenCalledWith(expect.objectContaining({ governor: config.governorAddress, token: TOKEN, scope: 5n, choice: 1 }));
    } finally {
      fixtures[`/api/epochs/${TOKEN}/5`] = saved;
    }
  });

  it("reads the viewer's weight privately and never sends their address to the indexer", async () => {
    account.address = VIEWER;
    wrap(<TokenDetail />);
    await heading();
    openTab("Governance");
    await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument());
    expect(screen.getByText(/whole tokens held at the snapshot/)).toBeInTheDocument();
    expect(accountRead).toHaveBeenCalledWith(expect.objectContaining({ functionName: "weightOf", args: [TOKEN, 5n, VIEWER] }));
    for (const [url] of fetchMock.mock.calls) expect(String(url).toLowerCase()).not.toContain(VIEWER.slice(2).toLowerCase());
    expect(screen.queryByRole("tab", { name: "Manage" })).toBeNull();
  });

  it("shows the manage tab to the controller: edit profile and pinned causes", async () => {
    account.address = CONTROLLER.toLowerCase();
    wrap(<TokenDetail />);
    await heading();
    openTab("Manage");
    const edit = await screen.findByRole("region", { name: "Edit profile" });
    expect(within(edit).getByLabelText(/Website \(url\)/)).toHaveValue("https://mooncat.example");
    expect(within(edit).getByRole("button", { name: "Set editor" })).toBeInTheDocument();
    const pinned = screen.getByRole("region", { name: "Pinned causes" });
    await waitFor(() => expect(within(pinned).getByRole("button", { name: "Unpin Alpha Fund" })).toBeInTheDocument());
    expect(within(pinned).getByRole("button", { name: "Unpin Beta Trust" })).toBeInTheDocument();
  });

  it("lets the controller choose the ballot size, with the gas hint", async () => {
    account.address = CONTROLLER.toLowerCase();
    writeContract.mockClear();
    wrap(<TokenDetail />);
    await heading();
    openTab("Manage");
    const panel = await screen.findByRole("region", { name: "Ballot size" });
    expect(panel).toHaveTextContent("The platform allows up to 30; this token's ballot now holds up to 30");
    expect(panel).toHaveTextContent("multiples of 3 are the most efficient");
    expect(panel).toHaveTextContent("each 3 fewer options save each voter about 86k gas per ballot");
    expect(panel).toHaveTextContent("30 options are counted in 10 encrypted tally words, with no space left over.");
    const select = within(panel).getByRole("combobox", { name: /Options per ballot/ });
    expect(select).toHaveValue("0");
    // Sizes above the platform cap are offered but capped.
    expect(within(select).getByRole("option", { name: "32 (capped at 30)" })).toBeInTheDocument();
    const save = within(panel).getByRole("button", { name: "Save ballot size" });
    expect(save).toBeDisabled();
    fireEvent.change(select, { target: { value: "2" } });
    expect(panel).toHaveTextContent("2 options are counted in 1 encrypted tally word, leaving room for 1 more at the same cost.");
    expect(panel).toHaveTextContent("each voter saves about 860k gas per ballot");
    fireEvent.click(save);
    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(1));
    expect(writeContract.mock.calls[0]![0]).toMatchObject({ address: config.governorAddress, functionName: "setBallotSize", args: [TOKEN, 2] });
    // The pins editor sits next to it.
    expect(screen.getByRole("region", { name: "Pinned causes" })).toHaveTextContent("Up to 8 causes");
  });

  it("hides the manage tab from other viewers", async () => {
    account.address = VIEWER;
    wrap(<TokenDetail />);
    await heading();
    expect(screen.queryByRole("tab", { name: "Manage" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Ballot size" })).toBeNull();
  });

  it("lists the curator agents for the token's causes with relative links and their state", async () => {
    account.address = undefined;
    wrap(<TokenDetail />);
    await heading();
    openTab("Governance");
    const curated = await screen.findByRole("region", { name: "Curated by" });
    const card = await within(curated).findByRole("region", { name: "hunger.agent.varada.eth" });
    // Relative: the same build is served from many hosts and under /bzz/<hash>/.
    expect(within(card).getByRole("link", { name: "Read the weekly report" })).toHaveAttribute("href", "/agent/hunger/");
    expect(within(card)).toBeDefined();
    expect(card).toHaveTextContent("Paused");
    expect(within(curated).queryByText(/homeless\.agent/)).toBeNull();
  });

  it("keeps the page working when the indexer has no agents", async () => {
    account.address = undefined;
    unavailable.add("/api/agents");
    try {
      wrap(<TokenDetail />);
      await heading();
      openTab("Governance");
      const curated = await screen.findByRole("region", { name: "Curated by" });
      await waitFor(() => expect(within(curated).getByRole("note")).toHaveTextContent(/unavailable/));
      expect(within(curated).queryByRole("link")).toBeNull();
      expect(screen.getAllByText(/Hunger/).length).toBeGreaterThan(0);
    } finally {
      unavailable.delete("/api/agents");
    }
  });
});

describe("token route by label", () => {
  it("resolves token/?label= (the plain-DNS redirect target) through the indexer fallback", async () => {
    account.address = undefined;
    window.history.replaceState(null, "", "/token/?label=moon-cat");
    wrap(<TokenDetail />);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Moon Cat"));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/tokens/by-label/moon-cat"))).toBe(true);
  });
});

describe("takeover panel", () => {
  it("shows the holding period, quorum as a share of circulating weight, and Superseded history", async () => {
    account.address = undefined;
    window.history.replaceState(null, "", `/token/?address=${TOKEN}`);
    const saved = fixtures[`/api/takeovers/${TOKEN}`];
    fixtures[`/api/takeovers/${TOKEN}`] = {
      items: [
        { proposalId: "3", token: TOKEN, proposer: CONTROLLER, newController: VIEWER, start: 1700000000, end: 1700259200, snapshot: 1699999999, lookbackSnapshot: 1699913599, quorumWeight: "100", circulatingWeight: "1000", forWeight: "0", againstWeight: "0", state: "Active" },
        { proposalId: "2", token: TOKEN, proposer: CONTROLLER, newController: VIEWER, quorumWeight: "50", state: 8 },
      ],
    };
    try {
      wrap(<TokenDetail />);
      await heading();
      openTab("Governance");
      const panel = await screen.findByRole("region", { name: "Takeover" });
      await waitFor(() => expect(within(panel).getByText(/Holding period 1 day:/)).toBeInTheDocument());
      expect(within(panel).getByText(/100 of 1000 circulating \(10\.00%\)/)).toBeInTheDocument();
      expect(within(panel).getByText(/#2 Superseded \(a newer proposal/)).toBeInTheDocument();
      expect(within(panel).getByRole("heading", { name: /Proposal #3: Voting open/ })).toBeInTheDocument();
    } finally {
      fixtures[`/api/takeovers/${TOKEN}`] = saved;
    }
  });

  it("formats shares and state labels", async () => {
    const { shareOf, takeoverStateLabel } = await import("@/components/takeover-panel");
    const { takeoverStateName } = await import("@/lib/indexer");
    expect(shareOf("1", "3")).toBe("33.33%");
    expect(shareOf("1", undefined)).toBeNull();
    expect(shareOf("1", "0")).toBeNull();
    expect(takeoverStateName(8)).toBe("Superseded");
    expect(takeoverStateName("superseded")).toBe("Superseded");
    expect(takeoverStateLabel("Superseded")).toMatch(/newer proposal/);
  });
});
