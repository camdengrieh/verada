import { useQuery } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { txToast } from "@varada/ui/components/varada/tx-toast";
import type { Server } from "node:http";
import type { Hex } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { epochGovernorAbi } from "@varada/sdk/abis";
import { BallotSizeEditor } from "@/components/ballot-size-editor";
import { ConnectButton } from "@/components/connect-button";
import { GovernancePanel } from "@/components/governance-panel";
import { useAppConfig, useDeps } from "@/components/providers";
import { ShortlistEditor } from "@/components/shortlist-editor";
import { loadTokenDetail } from "@/lib/data";
import {
  applyForkEnv,
  causeIdOf,
  chain,
  fakeAnonHarness,
  forkEnabled,
  loadFixture,
  newWallet,
  ORG_IDS,
  ORG_NAMES,
  renderApp,
  startFixtureIndexer,
  useChainSnapshot,
  type Fixture,
} from "./harness";
import type { TestWallet } from "./test-wallet";

vi.mock("@anon-rpc/browser-harness", () => fakeAnonHarness());
// jsdom has no canvas for the success confetti.
vi.mock("@varada/ui/components/motion/confetti", async (orig) => ({ ...(await orig<object>()), fireConfetti: () => {} }));

// The Zama relayer is the one part that cannot run on a fork: the encryptor is replaced, everything
// around it (adapter selection, ballot encoding, wallet, scheme call) is the real code.
const encryptChoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ballot", async (orig) => ({
  ...(await orig<typeof import("@/lib/ballot")>()),
  lazyEncryptor: () => async () => ({ encryptChoice }),
}));

const SLOW = { timeout: 20_000 };
/** The fixture node sits in epoch 1: the catalogue was published after epoch 0 began, so epoch 0 has no pool. */
const EPOCH = 1n;

/** The token's editors, fed with the detail the app itself loads (from the chain, the indexer being down). */
function Editors({ token }: { token: Fixture["token"] }) {
  const config = useAppConfig();
  const deps = useDeps();
  const detail = useQuery({ queryKey: ["fixture-detail", token], queryFn: () => loadTokenDetail(config, deps, token), retry: false });
  if (!detail.data?.data) return <p>{detail.error ? `detail failed: ${String(detail.error)}` : "loading detail"}</p>;
  return (
    <>
      <ShortlistEditor token={token} detail={detail.data.data} />
      <BallotSizeEditor token={token} detail={detail.data.data} />
    </>
  );
}

describe.skipIf(!forkEnabled)("governance flows on the fork", () => {
  let f: Fixture;
  let wallet: TestWallet;
  let indexer: { server: Server; url: string };
  let pending: MockInstance<typeof txToast.pending>;
  let success: MockInstance<typeof txToast.success>;
  let errored: MockInstance<typeof txToast.error>;
  useChainSnapshot();

  beforeAll(async () => {
    f = loadFixture();
    indexer = await startFixtureIndexer(f);
    applyForkEnv(f, { NEXT_PUBLIC_INDEXER_URLS: indexer.url, NEXT_PUBLIC_DEV_PLAIN_BALLOTS: "true" });
  }, 60_000);
  afterAll(() => new Promise<void>((resolve) => indexer.server.close(() => resolve())));

  beforeEach(() => {
    pending = vi.spyOn(txToast, "pending");
    success = vi.spyOn(txToast, "success");
    errored = vi.spyOn(txToast, "error");
    encryptChoice.mockReset();
  });
  afterEach(() => {
    wallet?.dispose();
    vi.restoreAllMocks();
  });

  async function connect(ui: React.ReactNode) {
    wallet = await newWallet();
    renderApp(
      <>
        <ConnectButton />
        {ui}
      </>,
    );
    const button = await screen.findByRole("button", { name: "Connect wallet" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByRole("button", { name: /^Wallet 0x/ });
  }

  it("edits pins: a declined save sends nothing, a confirmed save lands on chain", async () => {
    await connect(<Editors token={f.token} />);
    const pins = await screen.findByRole("region", { name: "Pinned causes" }, SLOW);
    await within(pins).findByText(/No causes pinned/, {}, SLOW);

    // The catalogue (served by the fixture indexer) offers both orgs; pin the first.
    const pinButtons = await within(pins).findAllByRole("button", { name: /^Pin\b/ }, SLOW);
    expect(pinButtons).toHaveLength(2);
    fireEvent.click(pinButtons[0]!);
    await within(pins).findByText(ORG_NAMES[0]!, { selector: "span" }, SLOW);

    wallet.rejectNext();
    fireEvent.click(within(pins).getByRole("button", { name: "Save pinned causes" }));
    await waitFor(() => expect(errored).toHaveBeenCalledTimes(1), SLOW);
    expect(errored.mock.calls[0]![1]).toMatchObject({ title: "Request declined" });
    expect(pending).not.toHaveBeenCalled();
    expect(await chain.readContract({ address: f.epochGovernor, abi: epochGovernorAbi, functionName: "shortlistOf", args: [f.token] })).toEqual([]);

    fireEvent.click(within(pins).getByRole("button", { name: "Save pinned causes" }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1), { timeout: 30_000 });
    expect(await chain.readContract({ address: f.epochGovernor, abi: epochGovernorAbi, functionName: "shortlistOf", args: [f.token] })).toEqual([causeIdOf(ORG_IDS[0])]);
  }, 90_000);

  it("changes the ballot size on chain", async () => {
    await connect(<Editors token={f.token} />);
    const size = await screen.findByRole("region", { name: "Ballot size" }, SLOW);
    fireEvent.change(await within(size).findByLabelText("Options per ballot", {}, SLOW), { target: { value: "6" } });
    fireEvent.click(within(size).getByRole("button", { name: "Save ballot size" }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1), { timeout: 30_000 });
    expect(await chain.readContract({ address: f.epochGovernor, abi: epochGovernorAbi, functionName: "ballotSizeChoiceOf", args: [f.token] })).toBe(6);
  }, 90_000);

  /** Opens the ballot panel on a wallet that is connected, with the vote dialog for `orgName` showing. */
  async function openVoteDialog(orgName: string) {
    await connect(<GovernancePanel />);
    const ballot = await screen.findByRole("region", { name: /ballot$/i }, SLOW);
    const list = await within(ballot).findByRole("radiogroup", {}, SLOW);
    fireEvent.click(await within(list).findByRole("radio", { name: new RegExp(orgName) }, SLOW));
    const vote = within(ballot).getByRole("button", { name: `Vote for ${orgName}` });
    await waitFor(() => expect(vote).toBeEnabled(), SLOW);
    fireEvent.click(vote);
    return { ballot, dialog: within(await screen.findByRole("dialog", {}, SLOW)) };
  }

  const hasVoted = () => chain.readContract({ address: f.epochGovernor, abi: epochGovernorAbi, functionName: "hasVoted", args: [f.token, EPOCH, wallet.address] });
  const sentCalls = () => wallet.calls.filter((c) => c.method === "eth_sendTransaction");

  it("lists the ballot from the chain and opens it for any wallet", async () => {
    await connect(<GovernancePanel />);
    const ballot = await screen.findByRole("region", { name: /ballot$/i }, SLOW);
    await within(ballot).findByText(/ballot is not prepared yet/i, {}, SLOW);
    // The pin (set in the first test) leads the unprepared ballot, named from the catalogue.
    await within(ballot).findByText(ORG_NAMES[0]!, {}, SLOW);

    // Anyone can open the epoch's ballot; the plan is the keeper's own, over the fixture catalogue.
    fireEvent.click(await within(ballot).findByRole("button", { name: "Open this week's ballot" }, SLOW));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1), { timeout: 60_000 });
    expect(await chain.readContract({ address: f.epochGovernor, abi: epochGovernorAbi, functionName: "isPrepared", args: [f.token, EPOCH] })).toBe(true);
    const list = await within(ballot).findByRole("radiogroup", {}, SLOW);
    expect(await within(list).findAllByRole("radio", {}, SLOW)).toHaveLength(2);
  }, 120_000);

  it("encrypted ballot: encrypt failure stops before the wallet; a declined signature sends nothing (mocked relayer)", async () => {
    process.env.NEXT_PUBLIC_DEV_PLAIN_BALLOTS = "false";
    const { dialog } = await openVoteDialog(ORG_NAMES[1]!);

    // 1. The relayer is unreachable: the dialog reports the encrypt step and the wallet is never asked.
    encryptChoice.mockRejectedValueOnce(new Error("relayer unreachable"));
    fireEvent.click(dialog.getByRole("button", { name: /^Confirm|^Encrypt/i }));
    expect(await dialog.findByText(/relayer unreachable/, {}, SLOW)).toBeInTheDocument();
    expect(sentCalls()).toHaveLength(0);

    // 2. Encryption "succeeds": the real adapter hands the wallet castBallot(governor, token, epoch, encodeFheBallot(handle, proof)).
    const handle = `0x${"11".repeat(32)}` as Hex;
    const inputProof = "0xabcd" as Hex;
    encryptChoice.mockResolvedValue({ handle, inputProof });
    wallet.rejectNext();
    errored.mockClear();
    fireEvent.click(await dialog.findByRole("button", { name: /Try again|Retry/i }, SLOW));
    await waitFor(() => expect(errored).toHaveBeenCalledTimes(1), SLOW);
    expect(errored.mock.calls[0]![1]).toMatchObject({ title: "Request declined" });
    expect(encryptChoice).toHaveBeenLastCalledWith(expect.objectContaining({ userAddress: wallet.address, choice: expect.any(Number) }));
    const scheme = await chain.readContract({ address: f.epochGovernor, abi: epochGovernorAbi, functionName: "epochScheme", args: [f.token, EPOCH] });
    expect(encryptChoice.mock.calls.at(-1)![0].contractAddress.toLowerCase()).toBe(scheme.toLowerCase());
    expect(await hasVoted()).toBe(false);
  }, 120_000);

  it("plaintext development ballot: declined once, then confirmed on chain; the vote is then closed to this wallet", async () => {
    process.env.NEXT_PUBLIC_DEV_PLAIN_BALLOTS = "true";
    const { ballot, dialog } = await openVoteDialog(ORG_NAMES[1]!);

    wallet.rejectNext();
    errored.mockClear();
    fireEvent.click(dialog.getByRole("button", { name: /^Confirm|^Encrypt/i }));
    await waitFor(() => expect(errored).toHaveBeenCalledTimes(1), SLOW);
    expect(errored.mock.calls[0]![1]).toMatchObject({ title: "Request declined" });
    expect(await hasVoted()).toBe(false);

    success.mockClear();
    fireEvent.click(await dialog.findByRole("button", { name: /Try again|Retry/i }));
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1), { timeout: 60_000 });
    expect(await hasVoted()).toBe(true);
    expect(encryptChoice).not.toHaveBeenCalled(); // development scheme: no encryptor involved
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close" }));

    // Voted wallets are told so instead of being offered a second ballot.
    await waitFor(() => expect(within(ballot).getByText(/You have voted in this epoch/)).toBeInTheDocument(), SLOW);
  }, 120_000);
});
