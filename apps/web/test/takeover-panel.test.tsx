import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envDefaults } from "@/lib/config";
import type { TakeoverItem } from "@/lib/indexer";

const GOVERNOR = "0x00000000000000000000000000000000000000f1";
const TOKEN = "0x00000000000000000000000000000000000000a1";
const ME = "0x00000000000000000000000000000000000000c1";

const account: { address?: string; chainId: number } = { chainId: 1 };
const switchChain = vi.fn();
const writeContractAsync = vi.fn(async () => `0x${"ab".repeat(32)}`);
const mine = { weight: 7n, voted: false };

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: account.address, chainId: account.chainId, isConnected: Boolean(account.address) }),
  useSwitchChain: () => ({ switchChain, isPending: false }),
  useWriteContract: () => ({ writeContractAsync, data: undefined, isPending: false, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, error: null }),
}));
vi.mock("@/components/providers", () => ({
  useAppConfig: () => ({ ...envDefaults(), chainId: 1, takeoverGovernorAddress: GOVERNOR }),
  useDeps: () => ({ chain: () => ({ readContract: async () => ({ votingPeriod: 259200, quorumBps: 400, proposalThresholdBps: 100, minTokenAge: 86400, lookback: 604800 }) }) }),
  usePrivateRpc: () => ({}),
}));
vi.mock("@/lib/account-reads", () => ({ createAccountClient: () => ({ readContract: async ({ functionName }: { functionName: string }) => (functionName === "weightOf" ? mine.weight : mine.voted) }) }));

let items: TakeoverItem[] = [];
vi.mock("@/lib/data", () => ({ loadTakeovers: async () => ({ data: items, source: "indexer" }) }));

const { TakeoverPanel } = await import("@/components/takeover-panel");

function proposal(over: Partial<TakeoverItem> = {}): TakeoverItem {
  return {
    proposalId: "3",
    token: TOKEN,
    proposer: "0x00000000000000000000000000000000000000d4",
    newController: "0x00000000000000000000000000000000000000e5",
    start: 1_700_000_000,
    end: 4_100_000_000,
    executionDeadline: 4_200_000_000,
    snapshot: 1_699_999_000,
    lookbackSnapshot: 1_699_000_000,
    quorumWeight: "40",
    circulatingWeight: "1000",
    forWeight: "0",
    againstWeight: "0",
    closed: false,
    tallied: false,
    executed: false,
    canceled: false,
    ballotCount: 1,
    state: "Active",
    ...over,
  };
}

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}

/** The card's For / Against buttons (disabled with a reason when voting is not possible). */
const voteButtons = () => [screen.queryByRole("button", { name: /for/i }), screen.queryByRole("button", { name: /against/i })];

describe("takeover panel voting gate", () => {
  beforeEach(() => {
    account.address = ME;
    account.chainId = 1;
    mine.weight = 7n;
    mine.voted = false;
    switchChain.mockClear();
    writeContractAsync.mockClear();
    items = [proposal()];
  });

  it("offers the vote to a connected holder on the right chain", async () => {
    wrap(<TakeoverPanel token={TOKEN} controller={null} />);
    await screen.findByText("Your weight:", { exact: false });
    const [forBtn, againstBtn] = voteButtons();
    expect(forBtn).toBeEnabled();
    expect(againstBtn).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Switch network" })).toBeNull();
  });

  it("does not offer a vote once voting ended and only the tally is pending", async () => {
    items = [proposal({ state: "Closing", end: 1_700_000_100 })];
    wrap(<TakeoverPanel token={TOKEN} controller={null} />);
    await screen.findByRole("heading", { name: /Voting ended, waiting for the tally/ });
    for (const b of voteButtons()) if (b) expect(b).toBeDisabled();
    expect(screen.getByText(/Voting has ended\. The tally is being counted\./)).toBeInTheDocument();
  });

  it("blocks the vote on the wrong chain and offers the switch", async () => {
    account.chainId = 137;
    wrap(<TakeoverPanel token={TOKEN} controller={null} />);
    const sw = await screen.findByRole("button", { name: "Switch network" });
    for (const b of voteButtons()) if (b) expect(b).toBeDisabled();
    expect(screen.getByText(/Switch your wallet to Ethereum mainnet to vote\./)).toBeInTheDocument();
    fireEvent.click(sw);
    expect(switchChain).toHaveBeenCalledWith({ chainId: 1 });
  });

  it("blocks a holder with no weight at the snapshot", async () => {
    mine.weight = 0n;
    wrap(<TakeoverPanel token={TOKEN} controller={null} />);
    await waitFor(() => expect(screen.getByText(/no weight in this vote/)).toBeInTheDocument());
    for (const b of voteButtons()) if (b) expect(b).toBeDisabled();
  });
});
