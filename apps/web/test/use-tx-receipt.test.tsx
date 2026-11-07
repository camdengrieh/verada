import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HASH = `0x${"ab".repeat(32)}` as const;
const txToast = vi.hoisted(() => ({ pending: vi.fn(() => "t1"), success: vi.fn(), error: vi.fn() }));
vi.mock("@varada/ui/components/varada/tx-toast", () => ({ txToast }));
vi.mock("@/components/providers", () => ({ useAppConfig: () => ({ chainId: 1 }) }));

const client = vi.hoisted(() => ({
  waitForTransactionReceipt: vi.fn(),
  getTransaction: vi.fn(),
  call: vi.fn(),
}));
vi.mock("wagmi", () => ({
  useWriteContract: () => ({ writeContractAsync: vi.fn(), data: HASH, isPending: false, error: null, reset: vi.fn() }),
  usePublicClient: () => client,
}));

const { useTx, TxStatus } = await import("@/components/use-tx");

function Probe({ label }: { label?: string }) {
  const tx = useTx({ kind: "launch" });
  return <TxStatus tx={tx} label={label} />;
}

const reverted = { status: "reverted", blockNumber: 7n, logs: [] };

describe("useTx reads the receipt through the public client", () => {
  beforeEach(() => {
    Object.values(txToast).forEach((f) => f.mockClear());
    Object.values(client).forEach((f) => f.mockReset());
    client.getTransaction.mockResolvedValue({ from: "0x00000000000000000000000000000000000000aa", to: "0x00000000000000000000000000000000000000bb", input: "0x1234", value: 0n, gas: 100000n });
  });

  it("reaches the reverted status and raises the reverted toast", async () => {
    client.waitForTransactionReceipt.mockResolvedValue(reverted);
    client.call.mockResolvedValue({ data: undefined });
    render(<Probe label="Launch" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(`Launch reverted (${HASH})`));
    expect(screen.queryByText(/Could not read the receipt/)).toBeNull();
    await waitFor(() => expect(txToast.error).toHaveBeenCalledWith("t1", expect.objectContaining({ title: "Transaction reverted", description: expect.stringContaining("Nothing was spent beyond gas") })));
    expect(txToast.success).not.toHaveBeenCalled();
  });

  it("replays the call at the mined block and shows the decoded reason", async () => {
    client.waitForTransactionReceipt.mockResolvedValue(reverted);
    client.call.mockRejectedValue(Object.assign(new Error("reverted"), { shortMessage: "The contract function reverted with reason: Paused" }));
    render(<Probe label="Launch" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This vault is paused"));
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 7n, data: "0x1234" }));
    expect(txToast.error).toHaveBeenCalledWith("t1", expect.objectContaining({ description: expect.stringContaining("This vault is paused") }));
  });

  it("still reports a read failure as one, and a success as confirmed", async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new Error("timeout"));
    const { unmount } = render(<Probe />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not read the receipt: timeout"));
    unmount();
    client.waitForTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 9n, logs: [] });
    render(<Probe />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("confirmed in block 9"));
    await waitFor(() => expect(txToast.success).toHaveBeenCalled());
  });
});
