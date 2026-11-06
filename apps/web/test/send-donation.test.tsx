import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ContractFunctionRevertedError, encodeErrorResult, zeroAddress, type Abi } from "viem";
import { ballotCommitment } from "@verada/sdk";
import { donationDistributorAbi, feeVaultAbi } from "@verada/sdk/abis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envDefaults, type AppConfig } from "@/lib/config";
import { IndexerClient } from "@/lib/indexer";
import { blockedText, candidateWeeks, donationAddresses, waitText } from "@/lib/donation-push";

const TOKEN = "0x00000000000000000000000000000000000000A1";
const GOVERNOR = "0x00000000000000000000000000000000000000d1";
const VAULT = "0x00000000000000000000000000000000000000d2";
const SCHEME = "0x00000000000000000000000000000000000000d3";
const DISTRIBUTOR = "0x00000000000000000000000000000000000000d4";
const CAUSE = `0x${"cc".repeat(32)}`;
const ZERO32 = `0x${"00".repeat(32)}`;
const ORGS = [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`];
const WEEK = 604_800n;
const DAY = 86_400n;
/** `epochStart(e)` of the fake governor. */
const startOf = (e: bigint) => 2_900n * WEEK + e * WEEK;

const full: AppConfig = {
  ...envDefaults(),
  indexerUrls: ["https://idx.example"],
  governorAddress: GOVERNOR,
  vaultAddress: VAULT,
  votingSchemeAddress: SCHEME,
  donationDistributorAddress: DISTRIBUTOR,
};
let config: AppConfig = full;

const fixtures: Record<string, unknown> = {};
const fetchMock = vi.fn(async (input: string) => {
  const path = new URL(input).pathname;
  return path in fixtures
    ? { ok: true, status: 200, json: async () => fixtures[path] }
    : { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
});
const indexer = new IndexerClient(full.indexerUrls, { fetchImpl: fetchMock as unknown as typeof fetch });

/** On-chain state of week 4 (the current epoch is 5). */
const chain = {
  current: 5n,
  now: startOf(5n) + DAY,
  registered: true,
  opened: false,
  closed: false,
  finalized: false,
  voters: 0n,
  tallyFinal: false,
  defaultCause: CAUSE,
  pool: 1_500_000n,
  settled: false,
  pending: 0n,
  distributed: false,
  feesPending: false,
  orgInactive: false,
};
const initial = { ...chain };

const revert = (abi: Abi, errorName: string, args: readonly unknown[]) =>
  new ContractFunctionRevertedError({ abi, data: encodeErrorResult({ abi, errorName, args } as never), functionName: "x" });

const readContract = vi.fn(async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
  switch (functionName) {
    case "currentEpoch":
      return chain.current;
    case "isRegistered":
      return address === VAULT ? true : chain.registered;
    case "isOpened":
      return chain.opened;
    case "isClosed":
      return chain.closed;
    case "closeFailed":
      return false;
    case "isFinalized":
      return chain.finalized;
    case "voterCount":
      return chain.voters;
    case "epochScheme":
      return chain.opened ? SCHEME : zeroAddress;
    case "epochStart":
      return startOf(args![0] as bigint);
    case "TALLY_GRACE":
      return 14n * DAY;
    case "defaultCause":
      return chain.defaultCause;
    case "winningCause":
      return chain.finalized ? CAUSE : ZERO32;
    case "ballotCommitment":
      return chain.opened ? [ballotCommitment(ORGS as `0x${string}`[]), 2] : [ZERO32, 0];
    case "tallyOf":
      return [chain.tallyFinal, chain.tallyFinal ? [3n, 1n] : []];
    case "settled":
      return chain.settled;
    case "causePoolOf":
      return chain.pool;
    case "SETTLE_GRACE":
      return 7n * DAY;
    case "pending":
      return chain.pending;
    case "distributed":
      return chain.distributed;
    default:
      throw new Error(`unexpected read ${functionName}`);
  }
});
const simulateContract = vi.fn(async ({ functionName }: { functionName: string }) => {
  if (functionName === "settle") {
    if (chain.feesPending) throw revert(feeVaultAbi as Abi, "FeesPending", [TOKEN, 4n]);
    if (chain.pool === 0n) throw revert(feeVaultAbi as Abi, "NothingToSettle", [TOKEN, 4n]);
  }
  if (functionName === "distribute" && chain.orgInactive) throw revert(donationDistributorAbi as Abi, "OrgNotActive", [DISTRIBUTOR]);
  return { result: undefined };
});

const writeContractAsync = vi.fn(async (_req: unknown) => "0xabc");
const wallet: { hash?: string; receipt?: { status: string; blockNumber: bigint; transactionHash: string } } = {};

vi.mock("@/components/providers", () => ({
  useAppConfig: () => config,
  useDeps: () => ({ indexer, chain: () => ({ readContract, simulateContract, getBlock: async () => ({ number: 100n, timestamp: chain.now }) }) }),
  usePrivateRpc: () => ({}),
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined }),
  useWriteContract: () => ({ writeContractAsync, data: wallet.hash, isPending: false, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: wallet.receipt, error: null }),
}));

const { SendDonation } = await import("@/components/send-donation");

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={qc}>
      <SendDonation token={TOKEN} />
    </QueryClientProvider>
  );
  const r = render(ui());
  return { ...r, rerender: () => r.rerender(ui()) };
}

const card = () => screen.findByRole("region", { name: "Send this week's donation" });

/** The step's transaction is mined: apply it on the fake chain and report its receipt. */
function mine(n: number, apply: () => void, rerender: () => void) {
  apply();
  wallet.hash = `0x${String(n).repeat(64)}`;
  wallet.receipt = { status: "success", blockNumber: BigInt(100 + n), transactionHash: wallet.hash };
  rerender();
}

beforeEach(() => {
  Object.assign(chain, initial);
  config = full;
  writeContractAsync.mockClear();
  delete wallet.hash;
  delete wallet.receipt;
  for (const k of Object.keys(fixtures)) delete fixtures[k];
  fixtures[`/api/epochs/${TOKEN}`] = {
    items: [
      { epoch: "5", donatedAt: null, causeAttributed: "10" },
      { epoch: "4", donatedAt: null, causeAttributed: "1500000", settledAmount: null },
      { epoch: "3", donatedAt: "1700000000", causeAttributed: "900" },
      { epoch: "2", donatedAt: null, causeAttributed: "0" },
    ],
    nextCursor: null,
  };
  fixtures["/api/causes"] = { items: [{ name: "Hunger Relief", causeId: CAUSE, orgId: null, address: null, isDeployed: true }], nextCursor: null };
});

describe("send this week's donation", () => {
  it("walks an unvoted week through finalize, settle and distribute, re-planning after each receipt", async () => {
    const { rerender } = renderCard();
    const c = await card();
    expect(c).toHaveTextContent(/The week of .* has ended, but its donation has not gone out yet \(1\.5 USDC for the cause so far\)/);
    expect(within(c).getByRole("list", { name: "Steps left" })).toHaveTextContent(
      /Finalize the winner.*Move the week's fees to the donation contract.*Send the donation to the winning charity/,
    );
    expect(c).toHaveTextContent(/Anyone can do these steps.*only go to the week's winning charity.*you pay the gas/);

    fireEvent.click(within(c).getByRole("button", { name: "Finalize the winner" }));
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    expect(writeContractAsync.mock.calls[0]![0]).toMatchObject({ address: GOVERNOR, functionName: "finalizeEpoch", args: [TOKEN, 4n, []], chainId: config.chainId });
    mine(1, () => (chain.finalized = true), rerender);

    const settle = await screen.findByRole("button", { name: "Move the week's fees to the donation contract" });
    expect(screen.getByRole("list", { name: "Steps left" })).toHaveTextContent(/Send the donation to Hunger Relief/);
    fireEvent.click(settle);
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(2));
    expect(writeContractAsync.mock.calls[1]![0]).toMatchObject({ address: VAULT, functionName: "settle", args: [TOKEN, 4n] });
    mine(2, () => Object.assign(chain, { settled: true, pending: chain.pool, pool: 0n }), rerender);

    const distribute = await screen.findByRole("button", { name: "Send the donation to Hunger Relief" });
    fireEvent.click(distribute);
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(3));
    expect(writeContractAsync.mock.calls[2]![0]).toMatchObject({ address: DISTRIBUTOR, functionName: "distribute", args: [TOKEN, 4n] });
    mine(3, () => Object.assign(chain, { distributed: true, pending: 0n }), rerender);

    expect(await screen.findByText(/The donation was sent/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("closes a voted week first, then waits for the keeper to decrypt the tally", async () => {
    Object.assign(chain, { opened: true, voters: 2n });
    const { rerender } = renderCard();
    const c = await card();
    expect(within(c).getByRole("list", { name: "Steps left" })).toHaveTextContent(/Close the vote.*Decrypt the tally.*Finalize the winner/);
    fireEvent.click(within(c).getByRole("button", { name: "Close the vote" }));
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    expect(writeContractAsync.mock.calls[0]![0]).toMatchObject({ address: GOVERNOR, functionName: "closeEpoch", args: [TOKEN, 4n] });
    mine(1, () => (chain.closed = true), rerender);
    expect(await screen.findByText(/Waiting for the tally to be decrypted/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("finalizes a decrypted tally with the indexer's org ids", async () => {
    Object.assign(chain, { opened: true, voters: 2n, closed: true, tallyFinal: true });
    fixtures[`/api/epochs/${TOKEN}/4`] = { epoch: "4", options: [], optionOrgIds: ORGS };
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Finalize the winner" }));
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    expect(writeContractAsync.mock.calls[0]![0]).toMatchObject({ functionName: "finalizeEpoch", args: [TOKEN, 4n, ORGS] });
  });

  it("explains when the week's fees are still pending, with the time", async () => {
    Object.assign(chain, { finalized: true, feesPending: true });
    renderCard();
    const c = await card();
    const graceEnd = new Date(Number(startOf(5n) + 7n * DAY) * 1000).toISOString().replace(".000Z", "Z");
    expect(within(c).getByRole("status")).toHaveTextContent(`still on their way to the vault`);
    expect(within(c).getByRole("status")).toHaveTextContent(`or from ${graceEnd} at the latest`);
    expect(within(c).queryByRole("button")).toBeNull();
  });

  it("explains an inactive charity plainly", async () => {
    Object.assign(chain, { finalized: true, settled: true, pool: 0n, pending: 1_000_000n, orgInactive: true });
    renderCard();
    const c = await card();
    expect(await within(c).findByRole("alert")).toHaveTextContent(/Endaoment no longer lists Hunger Relief as active/);
    expect(within(c).queryByRole("button")).toBeNull();
  });

  it("is hidden when no ended week is waiting", async () => {
    Object.assign(chain, { finalized: true, settled: true, distributed: true });
    renderCard();
    await waitFor(() => expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "distributed" })));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: "Send this week's donation" })).toBeNull();
  });

  it("is hidden for a token the governor does not know (live tokens)", async () => {
    chain.registered = false;
    renderCard();
    await waitFor(() => expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "isRegistered" })));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("is hidden without the distributor address", () => {
    config = { ...full, donationDistributorAddress: undefined };
    expect(donationAddresses(config)).toBeNull();
    const { container } = renderCard();
    expect(container).toBeEmptyDOMElement();
  });
});

describe("donation-push helpers", () => {
  it("lists ended, undonated weeks with fees, oldest first, and falls back to last week", async () => {
    const deps = { indexer, chain: () => ({}) } as never;
    expect(await candidateWeeks(deps, TOKEN, 5n)).toEqual([4n]);
    fixtures[`/api/epochs/${TOKEN}`] = { items: [{ epoch: "4", causeAttributed: "1" }, { epoch: "1", causeAttributed: "0", settledAmount: "5" }] };
    expect(await candidateWeeks(deps, TOKEN, 5n)).toEqual([1n, 4n]);
    delete fixtures[`/api/epochs/${TOKEN}`];
    expect(await candidateWeeks(deps, TOKEN, 5n)).toEqual([4n]);
  });

  it("words every wait and block", () => {
    const fmt = (s: number) => `t${s}`;
    expect(waitText({ type: "wait", stage: "tally", reason: "tally-other-scheme", until: 9n }, fmt)).toMatch(/From t9 the week can be finalized/);
    expect(waitText({ type: "wait", stage: "close", reason: "epoch-not-ended", until: 9n }, fmt)).toMatch(/ends at t9/);
    expect(waitText({ type: "done", reason: "donated" }, fmt)).toBeNull();
    expect(blockedText({ type: "blocked", stage: "finalize", reason: "no-default-cause" }, "X")).toMatch(/has not set a default charity/);
    expect(blockedText({ type: "blocked", stage: "distribute", reason: "org-address-mismatch" }, "X")).toMatch(/address on record for X/);
    expect(blockedText({ type: "blocked", stage: "settle", reason: "settle-reverts", error: "Boom" }, "X")).toMatch(/\(Boom\)/);
  });
});
