import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { decodeFheBallot } from "@varada/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envDefaults, type AppConfig } from "@/lib/config";

const GOVERNOR = "0x00000000000000000000000000000000000000d1";
const SCHEME = "0x00000000000000000000000000000000000000d3";
const T1 = "0x00000000000000000000000000000000000000a1";
const T2 = "0x00000000000000000000000000000000000000a2";
const VOTER = "0x00000000000000000000000000000000000000b2";
const cause = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
const NOW = Math.floor(Date.now() / 1000);

const baseConfig: AppConfig = { ...envDefaults(), indexerUrls: ["https://idx.example"], governorAddress: GOVERNOR, votingSchemeAddress: SCHEME };
let config: AppConfig = baseConfig;

let cap: bigint | Error = 10n;
/** The platform clock's schedule: epoch 5 runs from an hour ago to tomorrow; voting opens at its start unless a test sets `opensAt`. */
const clockSchedule = { opensAt: NOW - 3600 };
const chainRead = vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
  if (functionName === "currentEpoch") return 5n;
  if (functionName === "epochStart") return BigInt(args?.[0] === 6n ? NOW + 86_400 : NOW - 3600);
  if (functionName === "votingOpensAt") return BigInt(clockSchedule.opensAt);
  if (functionName === "epochScheduleFor") return [BigInt(90_000), BigInt(NOW + 86_400 - clockSchedule.opensAt), 90_000n];
  if (functionName === "ballotSizeCap") {
    if (cap instanceof Error) throw cap;
    return cap;
  }
  throw new Error(`unexpected public read ${functionName}`);
});

/** What the indexer says about each token's current epoch (404: no entry). */
const epochs: Record<string, unknown> = {};
const tokens = [
  { address: T1, name: "Harambe", symbol: "HAR" },
  { address: T2, name: "Pepe", symbol: "PEPE" },
];
const orgs: Record<string, { name: string; categories: string[]; regions: string[] }> = {
  [cause(1)]: { name: "Alpha Shelter", categories: ["homelessness"], regions: ["africa"] },
  [cause(2)]: { name: "Beta Pantry", categories: ["hunger"], regions: ["asia"] },
  [cause(3)]: { name: "Gamma Wells", categories: ["clean-water"], regions: ["global"] },
};
let history: { epoch: unknown[]; donation: unknown[] } = { epoch: [], donation: [] };

const indexer = {
  tokens: vi.fn(async () => ({ items: tokens, nextCursor: null })),
  tokenDetail: vi.fn(async (address: string) => ({ ...tokens.find((t) => t.address === address)!, profile: null, shortlist: null, focus: null, ballotSize: null })),
  epochDetail: vi.fn(async (token: string) => epochs[token] ?? null),
  causes: vi.fn(async () => ({ items: [], nextCursor: null })),
  catalogCauses: vi.fn(async (ids: string[]) => new Map(ids.filter((i) => orgs[i]).map((i) => [i, { causeId: i, orgId: i, ein: null, country: null, state: null, nteeCode: null, ...orgs[i]! }]))),
  activity: vi.fn(async ({ kind }: { kind: "epoch" | "donation" }) => ({ items: history[kind], nextCursor: null })),
  takeovers: vi.fn(async () => []),
  get: vi.fn(async (path: string) => {
    if (path === "/api/agents") return { items: [] };
    throw new Error(`unexpected indexer get ${path}`);
  }),
};

const account = { address: undefined as string | undefined, chainId: 1 as number | undefined };
const switchChain = vi.fn();
const accountRead = vi.fn(async ({ functionName }: { functionName: string }): Promise<unknown> => (functionName === "weightOf" ? 10n : false));
const writeContractAsync = vi.fn(async (_req: unknown) => `0x${"ab".repeat(32)}`);
const wallet: { hash?: string; receipt?: { status: string; blockNumber: bigint } } = {};

const rpcStatus = { state: "ready" } as const;
const rpc = { subscribe: () => () => {}, getStatus: () => rpcStatus, directPublicAllowed: false, network: { label: "Nym", anonymizes: true } };

vi.mock("@/components/providers", () => ({
  useAppConfig: () => config,
  useDeps: () => ({ indexer, chain: () => ({ readContract: chainRead }) }),
  usePrivateRpc: () => rpc,
  usePrivacyPrefs: () => [{ routeIndexer: false, introSeen: true }, () => {}],
}));
vi.mock("@/lib/account-reads", () => ({ createAccountClient: () => ({ readContract: accountRead }) }));
vi.mock("@/components/connect-button", () => ({ ConnectButton: () => <button type="button">Connect wallet</button> }));
// Receipts are read through viem (wagmi's action throws on a reverted receipt); use-receipt.test.tsx covers the real hook.
vi.mock("@/hooks/use-receipt", () => ({ useReceipt: () => ({ revertReason: undefined, refetch: () => {}, data: wallet.receipt, error: null }) }));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: account.address, isConnected: Boolean(account.address), chainId: account.chainId }),
  useSwitchChain: () => ({ switchChain, isPending: false }),
  useWriteContract: () => ({ writeContractAsync, data: wallet.hash, isPending: false, error: null, reset: vi.fn() }),
}));
// Encryption is the Zama SDK's job (tested in ballot.test.ts); here it returns a fixed handle and proof.
vi.mock("@/lib/ballot", async (orig) => ({
  ...(await orig<typeof import("@/lib/ballot")>()),
  lazyEncryptor: () => async () => ({ encryptChoice: async () => ({ handle: `0x${"11".repeat(32)}`, inputProof: "0xdeadbeef" }) }),
}));

const { GovernancePanel } = await import("@/components/governance-panel");

function openEpoch(over: Record<string, unknown> = {}) {
  return {
    epoch: "5",
    options: [cause(1), cause(2), cause(3)],
    optionSources: ["pinned", "curated", "rotation"],
    prepared: true,
    start: NOW - 3600,
    end: NOW + 86_400,
    snapshot: NOW - 3601,
    poolSize: "140",
    poll: { opened: true, closed: false, isFinal: false, optionCount: 3, counts: null, ballotCount: 2, scheme: SCHEME },
    ...over,
  };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <GovernancePanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  config = baseConfig;
  cap = 10n;
  account.address = undefined;
  account.chainId = 1;
  wallet.hash = undefined;
  wallet.receipt = undefined;
  for (const k of Object.keys(epochs)) delete epochs[k];
  history = { epoch: [], donation: [] };
  chainRead.mockClear();
  clockSchedule.opensAt = NOW - 3600;
  accountRead.mockReset().mockImplementation(async ({ functionName }) => (functionName === "weightOf" ? 10n : false));
  writeContractAsync.mockClear();
  switchChain.mockClear();
  for (const fn of Object.values(indexer)) fn.mockClear();
});

describe("GovernancePanel header", () => {
  it("states the live protocol cap, not a fixed 32", async () => {
    renderPanel();
    expect(await screen.findByText(/up to 10 charities \(the platform's current ballot size; at most 32\)/)).toBeInTheDocument();
    expect(screen.queryByText(/up to 32 charities/)).not.toBeInTheDocument();
  });

  it("falls back to wording without a number when the cap cannot be read", async () => {
    cap = new Error("rpc down");
    renderPanel();
    expect(await screen.findByText(/Current epoch:\s*5/)).toBeInTheDocument();
    expect(screen.getByText(/up to the platform's ballot size \(at most 32 charities\)/)).toBeInTheDocument();
  });

  it("shows the epoch clock in its voting phase with a countdown to the end of the epoch", async () => {
    renderPanel();
    const clock = await screen.findByRole("group", { name: /Voting closes in/ });
    expect(clock).toBeInTheDocument();
    const region = await screen.findByRole("region", { name: "Epoch clock" });
    expect(region).toHaveTextContent("Current epoch: 5");
    expect(region).toHaveTextContent("Voting");
    expect(region).toHaveTextContent("Ballots are accepted for the whole epoch.");
  });

  it("shows the trading phase of a 45 minute cycle with a countdown to when voting opens", async () => {
    // Epoch 5 started 10 minutes ago, lasts 45 minutes: voting opens in 20 minutes.
    clockSchedule.opensAt = NOW + 1200;
    renderPanel();
    const strip = await screen.findByRole("group", { name: "Epoch 5 phase" });
    expect(within(strip).getByText("Trading")).toBeInTheDocument();
    expect(within(strip).getByText("Ballots are not accepted yet.")).toBeInTheDocument();
    expect(within(strip).getByRole("group", { name: "Voting opens in" })).toBeInTheDocument();
    expect(strip).toHaveTextContent("of trading, then");
  });

  it("says so when no governor is configured", async () => {
    config = { ...baseConfig, governorAddress: undefined };
    renderPanel();
    expect(await screen.findByText("Governance is not set up on this site")).toBeInTheDocument();
    expect(indexer.tokens).not.toHaveBeenCalled();
  });
});

describe("token board and ballot", () => {
  beforeEach(() => {
    epochs[T1] = openEpoch();
    epochs[T2] = null;
  });

  it("lists tokens with their ballot status and opens the first open ballot", async () => {
    renderPanel();
    const list = await screen.findByRole("list", { name: "Tokens" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    await waitFor(() => expect(rows[0]).toHaveTextContent("Voting"));
    expect(rows[0]).toHaveTextContent("2 ballots cast");
    expect(rows[1]).toHaveTextContent("Not opened");
    // The open token's ballot is selected without a click.
    const ballot = await screen.findByRole("region", { name: "Harambe (HAR) ballot" });
    expect(within(ballot).getByText("Options: 1 pinned, 1 curated, 1 rotation.", { exact: false })).toBeInTheDocument();
  });

  it("groups the options by source with real names, categories and regions", async () => {
    renderPanel();
    await screen.findByRole("region", { name: "Harambe (HAR) ballot" });
    const tabs = await screen.findByRole("tablist", { name: "Ballot source" });
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: "Pinned 1" })).toBeInTheDocument());
    expect(within(tabs).getByRole("tab", { name: "All 3" })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: "Curated 1" })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: "Rotation 1" })).toBeInTheDocument();
    const option = await screen.findByRole("radio", { name: /Alpha Shelter, Homelessness, Africa, Pinned/ });
    expect(option).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Beta Pantry, Hunger, Asia, Curated/ })).toBeInTheDocument();
    fireEvent.mouseDown(within(tabs).getByRole("tab", { name: "Rotation 1" }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.queryByRole("radio", { name: /Alpha Shelter/ })).toBeNull());
    expect(screen.getByRole("radio", { name: /Gamma Wells/ })).toBeInTheDocument();
  });

  it("asks a visitor without a wallet to connect, and does not read any account data", async () => {
    renderPanel();
    await screen.findByRole("radio", { name: /Alpha Shelter/ });
    expect(screen.getAllByText("Connect a wallet to vote.").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
    expect(accountRead).not.toHaveBeenCalled();
  });

  it("offers a network switch when the wallet is on another chain", async () => {
    account.address = VOTER;
    account.chainId = 10;
    renderPanel();
    await screen.findByRole("radio", { name: /Alpha Shelter/ });
    const button = await screen.findByRole("button", { name: "Switch to Ethereum" });
    fireEvent.click(button);
    expect(switchChain).toHaveBeenCalledWith({ chainId: config.chainId });
  });

  it("reads the viewer's weight privately and says when they already voted", async () => {
    account.address = VOTER;
    accountRead.mockImplementation(async ({ functionName }) => (functionName === "weightOf" ? 25n : true));
    renderPanel();
    await screen.findByRole("radio", { name: /Alpha Shelter/ });
    expect(await screen.findByText("You have voted in this epoch. Each wallet votes once.")).toBeInTheDocument();
    expect(accountRead).toHaveBeenCalledWith(expect.objectContaining({ functionName: "weightOf", args: [T1, 5n, VOTER] }));
    // The indexer never receives the address.
    for (const call of [...indexer.epochDetail.mock.calls, ...indexer.tokenDetail.mock.calls, ...indexer.activity.mock.calls]) {
      expect(JSON.stringify(call, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase()).not.toContain(VOTER.toLowerCase());
    }
  });

  it("tells a holder with no weight why they cannot vote", async () => {
    account.address = VOTER;
    accountRead.mockImplementation(async ({ functionName }) => (functionName === "weightOf" ? 0n : false));
    renderPanel();
    await screen.findByRole("radio", { name: /Alpha Shelter/ });
    expect(await screen.findByText(/You held no \$HAR at the snapshot/)).toBeInTheDocument();
  });

  it("encrypts the choice, sends castBallot from the voter, and shows the vote as sent", async () => {
    account.address = VOTER;
    renderPanel();
    fireEvent.click(await screen.findByRole("radio", { name: /Beta Pantry/ }));
    const vote = await screen.findByRole("button", { name: "Vote for Beta Pantry" });
    await waitFor(() => expect(vote).toBeEnabled());
    fireEvent.click(vote);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Confirm your private vote")).toBeInTheDocument();
    expect(within(dialog).getByText("Beta Pantry")).toBeInTheDocument();
    expect(within(dialog).getByText("10 $HAR")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Encrypt and send/ }));

    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    const req = writeContractAsync.mock.calls[0]![0] as { address: string; functionName: string; args: [string, string, bigint, `0x${string}`] };
    expect(req).toMatchObject({ address: SCHEME, functionName: "castBallot", chainId: config.chainId });
    expect(req.args.slice(0, 3)).toEqual([GOVERNOR, T1, 5n]);
    expect(decodeFheBallot(req.args[3])).toEqual({ handle: `0x${"11".repeat(32)}`, inputProof: "0xdeadbeef" });
    expect(await within(dialog).findByText("Waiting for the chain to confirm…")).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Vote sent" })).toBeInTheDocument();
  });

  it("shows a wallet rejection in the dialog and lets the voter try again", async () => {
    account.address = VOTER;
    writeContractAsync.mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    renderPanel();
    fireEvent.click(await screen.findByRole("radio", { name: /Alpha Shelter/ }));
    const vote = await screen.findByRole("button", { name: "Vote for Alpha Shelter" });
    await waitFor(() => expect(vote).toBeEnabled());
    fireEvent.click(vote);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Encrypt and send/ }));
    expect(await within(dialog).findByText("Vote not sent")).toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("You declined the request in your wallet");
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(2));
  });

  it("shows the decrypted tally with the winner once voting is final", async () => {
    epochs[T1] = openEpoch({
      poll: { opened: true, closed: true, isFinal: true, optionCount: 3, counts: ["5", "70", "25"], ballotCount: 9, scheme: SCHEME },
      winningCause: cause(2),
    });
    renderPanel();
    const results = await screen.findByRole("region", { name: "Results" });
    expect(within(results).getByText("Winner")).toBeInTheDocument();
    await waitFor(() => expect(within(results).getAllByRole("listitem")[0]).toHaveTextContent("Beta Pantry"));
    const rows = within(results).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("70 · 70%");
    expect(rows[1]).toHaveTextContent("Gamma Wells");
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("keeps the vote button off with a clear reason until voting opens (VotingNotOpen), and shows Trading", async () => {
    const opens = NOW + 1200;
    clockSchedule.opensAt = opens;
    epochs[T1] = openEpoch({ votingOpensAt: opens });
    account.address = VOTER;
    renderPanel();
    const list = await screen.findByRole("list", { name: "Tokens" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Trading"));
    expect(await screen.findByText(/Voting is not open yet\. Ballots are accepted from/)).toBeInTheDocument();
    const vote = await screen.findByRole("button", { name: /Vote for|Choose a charity to vote/ });
    expect(vote).toBeDisabled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writeContractAsync).not.toHaveBeenCalled();
  });

  it("explains that voting is closed while the tally is counted", async () => {
    epochs[T1] = openEpoch({ end: NOW - 10 });
    account.address = VOTER;
    renderPanel();
    expect(await screen.findByText("Voting has closed. The tally is being counted.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Vote for/ })).toBeNull();
  });

  it("filters the board and opens a token by address", async () => {
    renderPanel();
    await screen.findByRole("list", { name: "Tokens" });
    fireEvent.change(screen.getByLabelText("Search tokens by name, symbol or address"), { target: { value: "pepe" } });
    const rows = within(screen.getByRole("list", { name: "Tokens" })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Pepe");
    fireEvent.click(within(rows[0]!).getByRole("button"));
    expect(await screen.findByRole("region", { name: "Pepe (PEPE) ballot" })).toBeInTheDocument();
    expect(await screen.findByText(/This epoch's ballot is not prepared yet/)).toBeInTheDocument();
  });
});

describe("history", () => {
  it("lists past winners and the payouts they received from the public feeds", async () => {
    epochs[T1] = null;
    epochs[T2] = null;
    history = {
      epoch: [
        {
          id: `epoch:${T1}:4`,
          kind: "epoch",
          token: T1,
          timestamp: NOW - 86_400,
          data: { epoch: "4", winningCauseId: cause(1), voteCount: 7, donatedAmount: "2500000000", donatedAt: String(NOW - 80_000) },
        },
      ],
      donation: [
        {
          id: "donation:d1",
          kind: "donation",
          token: T1,
          timestamp: NOW - 80_000,
          txHash: `0x${"cd".repeat(32)}`,
          data: { epoch: "4", causeId: cause(1), payout: "0x00000000000000000000000000000000000000e1", amount: "2500000000" },
        },
      ],
    };
    renderPanel();
    const section = await screen.findByRole("region", { name: "Past epochs" });
    const table = await within(section).findByRole("table");
    await waitFor(() => expect(table).toHaveTextContent("Alpha Shelter"));
    expect(table).toHaveTextContent("Harambe (HAR)");
    expect(table).toHaveTextContent("$2,500");
    await waitFor(() => expect(within(section).getByText("Donations to winners")).toBeInTheDocument());
    expect(within(section).getByText("Causes by value received")).toBeInTheDocument();
    expect(indexer.activity).toHaveBeenCalledWith(expect.objectContaining({ kind: "epoch" }));
    expect(indexer.activity).toHaveBeenCalledWith(expect.objectContaining({ kind: "donation" }));
  });

  it("says so when nothing has finished", async () => {
    epochs[T1] = null;
    epochs[T2] = null;
    renderPanel();
    expect(await screen.findByText("No epoch has finished yet")).toBeInTheDocument();
  });
});
