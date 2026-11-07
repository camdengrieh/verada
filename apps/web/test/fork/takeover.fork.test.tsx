import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Toaster } from "@varada/ui/components/ui/toaster";
import { txToast } from "@varada/ui/components/varada/tx-toast";
import { getAddress, type Hex } from "viem";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { takeoverGovernorAbi } from "@varada/sdk/abis";
import { ConnectButton } from "@/components/connect-button";
import { GovernancePanel } from "@/components/governance-panel";
import { TakeoverPanel } from "@/components/takeover-panel";
import { applyForkEnv, chain, fakeAnonHarness, forkEnabled, loadFixture, newWallet, renderApp, useChainSnapshot, warpTo, type Fixture } from "./harness";
import type { TestWallet } from "./test-wallet";

vi.mock("@anon-rpc/browser-harness", () => fakeAnonHarness());
vi.mock("@varada/ui/components/motion/confetti", async (orig) => ({ ...(await orig<object>()), fireConfetti: () => {} }));

const encryptChoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ballot", async (orig) => ({
  ...(await orig<typeof import("@/lib/ballot")>()),
  lazyEncryptor: () => async () => ({ encryptChoice }),
}));

const SLOW = { timeout: 20_000 };
/** 15 days after the fixture token launched: past the governor's 14-day minimum token age. */
const AFTER_MIN_AGE = 1_795_210_000;
const NEW_CONTROLLER = getAddress("0x00000000000000000000000000000000000c0ffe");

describe.skipIf(!forkEnabled)("takeover polls on the fork", () => {
  let f: Fixture;
  let wallet: TestWallet;
  let errored: MockInstance<typeof txToast.error>;
  let success: MockInstance<typeof txToast.success>;
  useChainSnapshot();

  beforeAll(async () => {
    f = loadFixture();
    await warpTo(AFTER_MIN_AGE);
    // The takeover governor counts its ballots on the real Zama scheme (not the epoch mock).
    const scheme = await chain.readContract({ address: f.takeoverGovernor, abi: takeoverGovernorAbi, functionName: "scheme" });
    applyForkEnv(f, { NEXT_PUBLIC_VOTING_SCHEME_ADDRESS: scheme, NEXT_PUBLIC_DEV_PLAIN_BALLOTS: "false" });
  }, 60_000);

  beforeEach(() => {
    errored = vi.spyOn(txToast, "error");
    success = vi.spyOn(txToast, "success");
    encryptChoice.mockReset();
  });
  afterEach(() => {
    wallet?.dispose();
    vi.restoreAllMocks();
  });

  async function connect(ui: React.ReactNode, chainId = 1) {
    wallet = await newWallet({ chainId });
    renderApp(
      <>
        <Toaster />
        <ConnectButton />
        {ui}
      </>,
    );
    const button = await screen.findByRole("button", { name: "Connect wallet" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByRole("button", { name: /^Wallet 0x/ });
  }

  const count = () => chain.readContract({ address: f.takeoverGovernor, abi: takeoverGovernorAbi, functionName: "proposalCount" });

  it("proposes a takeover (declined once, then on chain), then the card gates and routes the vote", async () => {
    await connect(<TakeoverPanel token={f.token} controller={f.me} />);
    const panel = await screen.findByRole("region", { name: "Takeover" }, SLOW);
    const form = await within(panel).findByRole("form", { name: "Propose takeover" }, SLOW);
    fireEvent.change(within(form).getByPlaceholderText("0x..."), { target: { value: NEW_CONTROLLER } });

    wallet.rejectNext();
    fireEvent.click(within(form).getByRole("button", { name: "Propose takeover" }));
    await waitFor(() => expect(errored).toHaveBeenCalledTimes(1), SLOW);
    expect(errored.mock.calls[0]![1]).toMatchObject({ title: "Request declined" });
    expect(await count()).toBe(0n);

    fireEvent.click(within(form).getByRole("button", { name: "Propose takeover" }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1), { timeout: 60_000 });
    expect(await count()).toBe(1n);

    // The proposal now shows as a card the holder can vote on.
    const heading = await within(panel).findByRole("heading", { name: /Proposal #1: Voting open/ }, SLOW);
    expect(heading).toBeInTheDocument();
    await within(panel).findByText(/Your weight:/, {}, SLOW);

    // For: the real adapter encrypts (mocked relayer) and hands the wallet a castBallot to the Zama scheme.
    const handle = `0x${"22".repeat(32)}` as Hex;
    encryptChoice.mockResolvedValue({ handle, inputProof: "0xabcd" });
    wallet.rejectNext();
    errored.mockClear();
    fireEvent.click(await within(panel).findByRole("button", { name: /for/i }));
    await waitFor(() => expect(errored).toHaveBeenCalledTimes(1), SLOW);
    expect(errored.mock.calls[0]![1]).toMatchObject({ title: "Request declined" });
    expect(encryptChoice).toHaveBeenCalledWith(expect.objectContaining({ userAddress: wallet.address, choice: expect.any(Number) }));

    // The wallet approves, but the real Zama scheme refuses an input proof it did not verify (the
    // relayer's proof is what it checks): the card must say the vote was not sent.
    errored.mockClear();
    fireEvent.click(await within(panel).findByRole("button", { name: /for/i }));
    // One message, in words: a fake handle trips the FHE input verifier's InvalidType() (0xb9688461).
    const alert = await within(panel).findByRole("alert", {}, SLOW);
    expect(alert).toHaveTextContent(/The contract rejected the transaction \(error 0xb9688461\)/);
    expect(wallet.calls.filter((c) => c.method === "eth_sendTransaction").length).toBeGreaterThan(0);
  }, 180_000);

  it("shows the poll card on the governance page and blocks the vote on the wrong chain", async () => {
    await connect(<GovernancePanel />, 137);
    const polls = await screen.findByRole("region", { name: "Takeover polls" }, SLOW);
    await within(polls).findByText(new RegExp(NEW_CONTROLLER.slice(0, 10), "i"), {}, { timeout: 60_000 });
    expect(within(polls).getByText(/Switch your wallet to Ethereum mainnet to vote/)).toBeInTheDocument();
    for (const b of within(polls).queryAllByRole("button", { name: /^(vote )?(for|against)/i })) expect(b).toBeDisabled();
  }, 120_000);
});
