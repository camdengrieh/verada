import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", Observer);
vi.stubGlobal("ResizeObserver", Observer);

const REGISTRY = "0x00000000000000000000000000000000000000aa";
const VAULTS: Record<number, string> = { 2: "0x0000000000000000000000000000000000000002", 9: "0x0000000000000000000000000000000000000009" };
const config = { chainId: 1, curatorRegistryAddress: REGISTRY, ensParentName: "varada.eth" };

const agentRow = (label: string, categoryBit: number) => ({
  label,
  categoryBit,
  ensName: `${label}.agent.varada.eth`,
  agentId: "1",
  vault: VAULTS[categoryBit],
  active: true,
  latest: { epoch: "7", reportRef: "0x01", catalogVersion: 1 },
});
const reportRow = (label: string, categoryBit: number, regions: Record<string, number>, pick: string) => ({
  epoch: "7",
  agent: agentRow(label, categoryBit),
  regions: Object.entries(regions).map(([region, weight]) => ({
    region,
    weight,
    verified: true,
    summary: `${label} need in ${region}`,
    picks: [{ rank: 0, orgId: `0x${label}${region}`, name: `${pick} ${region}`, score: 90, reasons: "Why it matters" }],
  })),
});

const indexerGet = vi.fn(async (path: string): Promise<unknown> => {
  if (path === "/api/agents") return { items: [agentRow("hunger", 2), agentRow("water", 9)] };
  if (path === "/api/agents/hunger/reports/7") return reportRow("hunger", 2, { africa: 8800, asia: 3000 }, "Food Aid");
  if (path === "/api/agents/water/reports/7") return reportRow("water", 9, { africa: 6000, asia: 9000 }, "Wells");
  throw new Error(`unexpected ${path}`);
});

const ORG_ID = `0x${"0b".repeat(32)}`;
const ORG_RAW = "0x00000000000000000000000000000000000000cc";
const ORG_ADDRESS = getAddress(ORG_RAW);
const FACTORY = "0x10fD9348136dCea154F752fe0B6dB45Fc298A589";
const catalogOrg = { orgId: ORG_ID, causeId: `0x${"ca".repeat(32)}`, ein: "271661997", name: "Give Well Fund", country: "USA", state: "NY", nteeCode: null, categories: ["poverty"], regions: ["africa"], label: "give-well-fund", ethOrgId: null };
const orgState = { deployed: false, active: true };

const registryVault: Record<number, string> = { ...VAULTS };
const chainRead = vi.fn(async ({ functionName, args, address }: { functionName: string; args?: unknown[]; address: string }): Promise<unknown> => {
  if (functionName === "agentOf" && address === REGISTRY) return { vault: registryVault[args![0] as number], active: true };
  if (functionName === "paused") return false;
  if (functionName === "computeOrgAddress" && address === FACTORY && args![0] === ORG_ID) return ORG_RAW;
  if (functionName === "isActiveEntity") return orgState.active;
  if (functionName === "orgId") return ORG_ID;
  throw new Error(`unexpected read ${functionName}`);
});
const getCode = vi.fn(async () => (orgState.deployed ? "0x6080" : undefined));
const catalogSearch = vi.fn<(q: unknown) => Promise<{ items: (typeof catalogOrg)[]; total: number }>>(async () => ({ items: [catalogOrg], total: 1 }));
const accountRead = vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "balanceOf" ? 100_000_000n : 0n));

let txCount = 0;
const writeContractAsync = vi.fn<(req: unknown) => Promise<string>>(async () => `0x${(++txCount).toString(16).padStart(64, "0")}`);
const account = { address: undefined as string | undefined };
const receipts = new Map<string, { status: "success"; transactionHash: string }>();

vi.mock("@/components/providers", () => ({
  useAppConfig: () => config,
  useDeps: () => ({
    indexer: { get: indexerGet, catalogPool: async () => 42, catalogSearch, catalogCauses: async () => new Map(), catalogOrg: async () => ({ org: catalogOrg, entries: [] }) },
    chain: () => ({ readContract: chainRead, getCode }),
  }),
  usePrivateRpc: () => ({}),
}));
vi.mock("@/components/nav", () => ({ useRel: () => (p: string) => `./${p}` }));
vi.mock("@/lib/account-reads", () => ({ createAccountClient: () => ({ readContract: accountRead }) }));
vi.mock("wagmi", async () => {
  const { useCallback, useState } = await import("react");
  return {
    useAccount: () => ({ address: account.address, isConnected: Boolean(account.address), chainId: 1 }),
    useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
    useWriteContract: () => {
      const [hash, setHash] = useState<string>();
      const send = useCallback(async (req: unknown) => {
        const h = await writeContractAsync(req);
        setHash(h);
        return h;
      }, []);
      return { writeContractAsync: send, data: hash, isPending: false, error: null, reset: () => setHash(undefined) };
    },
    // Every sent transaction confirms at once.
    useWaitForTransactionReceipt: ({ hash }: { hash?: string }) => {
      if (hash && !receipts.has(hash)) receipts.set(hash, { status: "success", transactionHash: hash });
      return { data: hash ? receipts.get(hash) : undefined, error: null, refetch: vi.fn() };
    },
  };
});

const { JustDonate } = await import("@/components/donate/just-donate");

function wrap(node: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
}

const trendNames = () => within(screen.getByRole("heading", { name: /Most urgent causes/ }).closest("section")!).getAllByRole("listitem").map((li) => li.textContent);

beforeEach(() => {
  account.address = undefined;
  writeContractAsync.mockClear();
  receipts.clear();
  Object.assign(registryVault, VAULTS);
  Object.assign(orgState, { deployed: false, active: true });
  catalogSearch.mockClear();
  window.history.replaceState(null, "", "/donate/");
});

describe("Just donate", () => {
  it("ranks causes for the picked places and routes the gift to the hottest one", async () => {
    wrap(<JustDonate />);
    await waitFor(() => expect(screen.getAllByText("Wells asia").length).toBeGreaterThan(0));
    // Everywhere: water's Asia weight (9000) beats hunger's Africa (8800).
    expect(trendNames()[0]).toMatch(/Clean water/);
    expect(screen.getByRole("list", { name: "Where your gift goes" })).toHaveTextContent(/Clean water/);

    fireEvent.click(screen.getByRole("button", { name: "Africa" }));
    await waitFor(() => expect(trendNames()[0]).toMatch(/Hunger/));
    expect(screen.getByRole("heading", { name: "Most urgent causes in Africa" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Where your gift goes" })).toHaveTextContent(/Hunger/);
    expect(screen.getByText("Food Aid africa")).toBeInTheDocument();
    expect(screen.queryByText("Wells asia")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "42 charities in the catalogue" })).toHaveAttribute("href", "./causes/?category=hunger&region=africa#catalogue");
    await waitFor(() => expect(window.location.search).toBe("?amount=25&region=africa"));
    expect(screen.getByRole("note")).toHaveTextContent("Connect a wallet to donate.");
  });

  it("splits a gift across two causes: approve and donate for each, to the vaults the registry confirms", async () => {
    account.address = "0x00000000000000000000000000000000000000d1";
    window.history.replaceState(null, "", "/donate/?amount=10&region=africa");
    wrap(<JustDonate />);
    await waitFor(() => expect(trendNames()[0]).toMatch(/Hunger/));
    const water = screen.getAllByRole("listitem").find((li) => /Clean water/.test(li.textContent ?? "") && within(li).queryByRole("button", { name: /Add to gift/ }))!;
    fireEvent.click(within(water).getByRole("button", { name: /Add to gift/ }));
    await waitFor(() => expect(screen.getByText(/Split evenly across 2 causes/)).toBeInTheDocument());

    const donate = screen.getByRole("button", { name: "Donate 10 USDC" });
    await waitFor(() => expect(donate).toBeEnabled());
    fireEvent.click(donate);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: /Donate 10 USDC to 2 causes/ })).toBeInTheDocument();

    const labels = ["Approve 5 USDC", "Donate 5 USDC", "Approve 5 USDC", "Donate 5 USDC"];
    for (const [i, label] of labels.entries()) {
      // The outgoing panel may still be on screen while it slides out: take the newest.
      const button = (await within(dialog).findAllByRole("button", { name: label })).at(-1)!;
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
      await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(i + 1));
    }
    await waitFor(() => expect(within(dialog).getByText(/Thank you. Your gift is with the Hunger & famine and Clean water & sanitation curators/)).toBeInTheDocument());

    const calls = writeContractAsync.mock.calls.map(([r]) => r as { functionName: string; address: string; args: unknown[] });
    expect(calls.map((c) => c.functionName)).toEqual(["approve", "donate", "approve", "donate"]);
    expect(calls[0]!.args).toEqual([VAULTS[2], 5_000_000n]);
    expect(calls[1]).toMatchObject({ address: VAULTS[2], args: [5_000_000n, false] });
    expect(calls[2]!.args).toEqual([VAULTS[9], 5_000_000n]);
    expect(calls[3]).toMatchObject({ address: VAULTS[9], args: [5_000_000n, false] });
  });

  it("blocks a gift when the indexer's vault is not the registry's", async () => {
    account.address = "0x00000000000000000000000000000000000000d1";
    registryVault[9] = "0x00000000000000000000000000000000000000ee";
    wrap(<JustDonate />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/is not the one registered on chain/));
    expect(screen.getByRole("button", { name: "Donate 25 USDC" })).toBeDisabled();
    expect(writeContractAsync).not.toHaveBeenCalled();
  });
  it("gives straight to a searched charity: its ENS name and deposit address, then approve and deploy-and-donate", async () => {
    account.address = "0x00000000000000000000000000000000000000d1";
    wrap(<JustDonate />);
    fireEvent.change(await screen.findByLabelText("Name, ENS name or EIN"), { target: { value: "27-1661997" } });
    await waitFor(() => expect(catalogSearch).toHaveBeenLastCalledWith(expect.objectContaining({ q: "27-1661997" })));
    const results = await screen.findByRole("list", { name: "Search results" });
    expect(within(results).getByText("give-well-fund.org.varada.eth")).toBeInTheDocument();
    fireEvent.click(within(results).getByRole("button", { name: /Donate directly to Give Well Fund/ }));

    const deposit = await screen.findByRole("group", { name: "Give Well Fund deposit address" });
    expect(within(deposit).getByText("give-well-fund")).toBeInTheDocument();
    expect(within(deposit).getByRole("button", { name: "Copy the name give-well-fund.org.varada.eth" })).toBeInTheDocument();
    expect(within(deposit).getAllByRole("button").length).toBeGreaterThanOrEqual(2); // address copy + name copy
    expect(within(deposit).getByRole("link", { name: /on Etherscan/ })).toHaveAttribute("href", `https://etherscan.io/address/${ORG_ADDRESS}`);
    expect(screen.getByText(/Not opened yet/)).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(`?amount=25&org=${ORG_ID}`));

    const donate = screen.getAllByRole("button", { name: "Donate 25 USDC" }).at(-1)!;
    await waitFor(() => expect(donate).toBeEnabled());
    fireEvent.click(donate);
    const dialog = await screen.findByRole("dialog");
    for (const [i, label] of ["Approve 25 USDC", "Donate 25 USDC"].entries()) {
      const button = (await within(dialog).findAllByRole("button", { name: label })).at(-1)!;
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
      await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(i + 1));
    }
    await waitFor(() => expect(within(dialog).getByText("Thank you. 25 USDC is with Give Well Fund.")).toBeInTheDocument());
    const calls = writeContractAsync.mock.calls.map(([r]) => r as { functionName: string; address: string; args: unknown[] });
    expect(calls.map((c) => c.functionName)).toEqual(["approve", "deployOrgAndDonate"]);
    expect(calls[0]!.args).toEqual([FACTORY, 25_000_000n]);
    expect(calls[1]).toMatchObject({ address: FACTORY, args: [ORG_ID, 25_000_000n] });
  });

  it("donates to a deployed charity's own contract, and blocks one Endaoment lists as inactive", async () => {
    account.address = "0x00000000000000000000000000000000000000d1";
    orgState.deployed = true;
    window.history.replaceState(null, "", `/donate/?amount=5&org=${ORG_ID}`);
    const { unmount } = wrap(<JustDonate />);
    await screen.findByRole("group", { name: "Give Well Fund deposit address" });
    expect(screen.getByText(/Endaoment account on Ethereum/)).toBeInTheDocument();
    const donate = screen.getAllByRole("button", { name: "Donate 5 USDC" }).at(-1)!;
    await waitFor(() => expect(donate).toBeEnabled());
    fireEvent.click(donate);
    const dialog = await screen.findByRole("dialog");
    for (const [i, label] of ["Approve 5 USDC", "Donate 5 USDC"].entries()) {
      const button = (await within(dialog).findAllByRole("button", { name: label })).at(-1)!;
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
      await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(i + 1));
    }
    const calls = writeContractAsync.mock.calls.map(([r]) => r as { functionName: string; address: string; args: unknown[] });
    expect(calls[0]!.args).toEqual([ORG_ADDRESS, 5_000_000n]);
    expect(calls[1]).toMatchObject({ functionName: "donate", address: ORG_ADDRESS, args: [5_000_000n] });
    unmount();

    writeContractAsync.mockClear();
    orgState.active = false;
    wrap(<JustDonate />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Endaoment does not list this charity as active"));
    expect(writeContractAsync).not.toHaveBeenCalled();
  });

  it("shows each curator vault's ENS name with its address", async () => {
    wrap(<JustDonate />);
    const vault = await screen.findByRole("group", { name: /curator vault/ });
    expect(within(vault).getByRole("button", { name: /Copy the name .*\.agent\.varada\.eth/ })).toBeInTheDocument();
  });
});
