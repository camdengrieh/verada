import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Toaster } from "@varada/ui/components/ui/toaster";
import { txToast } from "@varada/ui/components/varada/tx-toast";
import { erc20Abi } from "viem";
import { agentVaultAbi } from "@varada/sdk/abis";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AgentDonatePanel } from "@/components/agent-donate";
import { ConnectButton } from "@/components/connect-button";
import { applyForkEnv, chain, fakeAnonHarness, forkEnabled, loadFixture, newWallet, renderApp, setUsdc, USDC, useChainSnapshot, type Fixture } from "./harness";
import type { TestWallet } from "./test-wallet";

vi.mock("@anon-rpc/browser-harness", () => fakeAnonHarness());
// jsdom has no canvas for the success confetti.
vi.mock("@varada/ui/components/motion/confetti", async (orig) => ({ ...(await orig<object>()), fireConfetti: () => {} }));

const FUND = 500_000_000n; // 500 USDC
/** Reads on a cold fork fetch their state from the upstream node on first use. */
const SLOW = { timeout: 20_000 };

describe.skipIf(!forkEnabled)("curator agent donate flow on the fork", () => {
  let f: Fixture;
  let wallet: TestWallet;
  let pending: MockInstance<typeof txToast.pending>;
  let success: MockInstance<typeof txToast.success>;
  let errored: MockInstance<typeof txToast.error>;
  useChainSnapshot();

  beforeAll(() => {
    f = loadFixture();
    applyForkEnv(f);
  });

  beforeEach(async () => {
    pending = vi.spyOn(txToast, "pending");
    success = vi.spyOn(txToast, "success");
    errored = vi.spyOn(txToast, "error");
  });
  afterEach(() => {
    wallet?.dispose();
    vi.restoreAllMocks();
  });

  async function mount(chainId = 1) {
    wallet = await newWallet({ chainId });
    await setUsdc(wallet.address, FUND);
    renderApp(
      <>
        <Toaster />
        <ConnectButton />
        <AgentDonatePanel categoryBit={2} vault={f.vault} name="Hunger" />
      </>,
    );
    const connect = await screen.findByRole("button", { name: "Connect wallet" });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    return await screen.findByRole("region", { name: "Donate" });
  }

  it("is blocked on the wrong chain, switches, then approves and donates (rejection first)", async () => {
    const panel = await mount(137);
    expect(await within(panel).findByText(/different network than Varada/, {}, SLOW)).toBeInTheDocument();
    expect(within(panel).getByLabelText("Amount (USDC)")).toBeDisabled();

    fireEvent.click(within(panel).getByRole("button", { name: "Switch network" }));
    await waitFor(() => expect(wallet.calls.some((c) => c.method === "wallet_switchEthereumChain")).toBe(true));
    await waitFor(() => expect(within(panel).getByLabelText("Amount (USDC)")).toBeEnabled(), SLOW);
    await within(panel).findByText(/Your USDC balance: 500 USDC/, {}, SLOW);

    fireEvent.change(within(panel).getByLabelText("Amount (USDC)"), { target: { value: "25" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Approve 25 USDC" }));
    const dialog = within(await screen.findByRole("dialog", {}, SLOW));

    // The wallet declines the approval: one error toast, no pending toast, no transaction.
    wallet.rejectNext();
    fireEvent.click(dialog.getByRole("button", { name: "Approve 25 USDC" }));
    await waitFor(() => expect(errored).toHaveBeenCalledTimes(1), SLOW);
    expect(errored.mock.calls[0]![1]).toMatchObject({ title: "Request declined" });
    expect(pending).not.toHaveBeenCalled();
    expect(await dialog.findByRole("alert")).toHaveTextContent(/declined the request in your wallet/);
    // The toast really renders (the app shell mounts the same Toaster).
    expect(await screen.findByText("Request declined", {}, SLOW)).toBeInTheDocument();
    expect(await chain.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [wallet.address, f.vault] })).toBe(0n);

    // Retry: pending then confirmed in place.
    fireEvent.click(dialog.getByRole("button", { name: "Approve 25 USDC" }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1), { timeout: 20_000 });
    expect(pending).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0]![0]).toBe(pending.mock.results[0]!.value);
    expect(await screen.findByText("USDC approved", {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText("Approving USDC…")).toBeNull(); // settled in place, not stacked
    expect(await chain.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [wallet.address, f.vault] })).toBe(25_000_000n);

    // Donate (anonymous): the vault receives the USDC.
    const before = await chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [f.vault] });
    const donate = await dialog.findByRole("button", { name: "Donate 25 USDC" });
    await waitFor(() => expect(donate).toBeEnabled());
    fireEvent.click(donate);
    await waitFor(() => expect(success).toHaveBeenCalledTimes(2), { timeout: 20_000 });
    expect(await chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [f.vault] })).toBe(before + 25_000_000n);
    expect(await chain.readContract({ address: f.vault, abi: agentVaultAbi, functionName: "paused" })).toBe(false);
    expect(await dialog.findByText(/Your donation is anonymous on this site/)).toBeInTheDocument();
  }, 90_000);

  it("surfaces a wallet that moved to another chain mid-flow as a network message, not a raw error", async () => {
    const panel = await mount(1);
    await within(panel).findByText(/Your USDC balance/, {}, SLOW);
    fireEvent.change(within(panel).getByLabelText("Amount (USDC)"), { target: { value: "5" } });
    fireEvent.click(within(panel).getByRole("button", { name: /^(Approve|Donate) 5 USDC$/ }));
    const dialog = within(await screen.findByRole("dialog", {}, SLOW));

    wallet.setChain(137);
    const button = await dialog.findByRole("button", { name: /^(Approve|Donate) 5 USDC$/ });
    fireEvent.click(button);
    const alert = await dialog.findByRole("alert", {}, SLOW);
    expect(alert).toHaveTextContent(/different network/i);
    expect(alert.textContent).not.toMatch(/connector|connection's chain/);
    expect(wallet.calls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
  }, 60_000);
});
