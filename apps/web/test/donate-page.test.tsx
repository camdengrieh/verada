import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
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

const registryVault: Record<number, string> = { ...VAULTS };
const chainRead = vi.fn(async ({ functionName, args, address }: { functionName: string; args?: unknown[]; address: string }): Promise<unknown> => {
  if (functionName === "agentOf" && address === REGISTRY) return { vault: registryVault[args![0] as number], active: true };
  if (functionName === "paused") return false;
  throw new Error(`unexpected read ${functionName}`);
});
const accountRead = vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "balanceOf" ? 100_000_000n : 0n));

let txCount = 0;
const writeContractAsync = vi.fn<(req: unknown) => Promise<string>>(async () => `0x${(++txCount).toString(16).padStart(64, "0")}`);
const account = { address: undefined as string | undefined };
const receipts = new Map<string, { status: "success"; transactionHash: string }>();

vi.mock("@/components/providers", () => ({
  useAppConfig: () => config,
  useDeps: () => ({ indexer: { get: indexerGet, catalogPool: async () => 42 }, chain: () => ({ readContract: chainRead }) }),
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
  window.history.replaceState(null, "", "/donate/");
});

describe("Just donate", () => {
  it("ranks causes for the picked places and routes the gift to the hottest one", async () => {
    wrap(<JustDonate />);
    await waitFor(() => expect(screen.getAllByText("Wells asia").length).toBeGreaterThan(0));
    // Everywhere: water's Asia weight (9000) beats hunger's Africa (8800).
    expect(trendNames()[0]).toMatch(/Clean water/);
    expect(within(screen.getByRole("list", { name: "Where your gift goes" })).getByText(/Clean water/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Africa" }));
    await waitFor(() => expect(trendNames()[0]).toMatch(/Hunger/));
    expect(screen.getByRole("heading", { name: "Most urgent causes in Africa" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Where your gift goes" })).getByText(/Hunger/)).toBeInTheDocument();
    expect(screen.getByText("Food Aid africa")).toBeInTheDocument();
    expect(screen.queryByText("Wells asia")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "42 in the catalogue" })).toHaveAttribute("href", "./causes/?category=hunger&region=africa#catalogue");
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
    await waitFor(() => expect(screen.getByText("Split evenly across 2 causes")).toBeInTheDocument());

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
});
