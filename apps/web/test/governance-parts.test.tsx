import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envDefaults } from "@/lib/config";
import { cardStatus, endsInText, percentOf } from "@/components/governance/takeover-polls";
import { canVoteHere, filterBoard, type BoardEntry } from "@/components/governance/token-board";

const txToast = vi.hoisted(() => ({ pending: vi.fn(() => "t1"), success: vi.fn(), error: vi.fn() }));
vi.mock("@varada/ui/components/varada/tx-toast", () => ({ txToast }));

const readyStatus = vi.hoisted(() => ({ state: "ready" }));
const wallet: { hash?: string; receipt?: { status: string }; error?: unknown } = {};
// Receipts are read through viem (wagmi's action throws on a reverted receipt); use-receipt.test.tsx covers the real hook.
vi.mock("@/hooks/use-receipt", () => ({ useReceipt: () => ({ revertReason: undefined, refetch: () => {}, data: wallet.receipt, error: null }) }));
vi.mock("wagmi", () => ({
  useAccount: () => ({}),
  useWriteContract: () => ({ writeContractAsync: vi.fn(), data: wallet.hash, isPending: false, error: wallet.error ?? null, reset: vi.fn() }),
}));
vi.mock("@/components/providers", () => ({
  useAppConfig: () => envDefaults(),
  useConfig: () => envDefaults(),
  usePrivateRpc: () => ({ subscribe: () => () => {}, getStatus: () => readyStatus, directPublicAllowed: false, network: { label: "Nym", anonymizes: true }, start: async () => {}, retry: async () => {}, allowDirectForPublic() {} }),
  usePrivacyPrefs: () => prefsState,
}));
const prefsState: [{ routeIndexer: boolean; introSeen: boolean }, (p: { routeIndexer: boolean; introSeen: boolean }) => void] = [{ routeIndexer: false, introSeen: false }, vi.fn()];

const { useTx } = await import("@/components/use-tx");
const { PrivacyMenu } = await import("@/components/privacy-status");

describe("takeover helpers", () => {
  it("maps governor states to the card's status", () => {
    expect(cardStatus("Active")).toBe("active");
    expect(cardStatus("Closing")).toBe("active");
    expect(cardStatus("Succeeded")).toBe("passed");
    expect(cardStatus("Executed")).toBe("executed");
    for (const s of ["Defeated", "Canceled", "Expired", "Superseded"]) expect(cardStatus(s)).toBe("failed");
  });
  it("computes shares and the countdown text", () => {
    expect(percentOf("40", "800")).toBe(5);
    expect(percentOf("1", "3")).toBe(33.3);
    expect(percentOf("1", "0")).toBeNull();
    expect(percentOf("1", undefined)).toBeNull();
    expect(endsInText(1000 + 2 * 86400 + 3 * 3600, 1000)).toBe("Ends in 2d 3h");
    expect(endsInText(1000 + 90 * 60, 1000)).toBe("Ends in 1h 30m");
    expect(endsInText(900, 1000)).toBe("Voting ended");
    expect(endsInText(undefined, 1000)).toBeUndefined();
  });
});

describe("token board filtering", () => {
  const now = 1000;
  const entry = (name: string, open: boolean, weight?: bigint, voted = false): BoardEntry => ({
    row: {
      token: { address: `0x${name}`, name, symbol: name.toUpperCase() },
      detail: open ? ({ prepared: true, poll: { opened: true, closed: false, isFinal: false }, end: now + 100 } as never) : null,
      failed: false,
    },
    standing: weight === undefined ? undefined : { weight, voted },
  });
  const entries = [entry("aaa", false), entry("bbb", true, 5n), entry("ccc", true, 5n, true), entry("ddd", true)];

  it("puts the tokens the viewer can still vote in first", () => {
    expect(canVoteHere(entries[1]!, now)).toBe(true);
    expect(canVoteHere(entries[2]!, now)).toBe(false);
    expect(filterBoard(entries, "all", "", now)[0]!.row.token.name).toBe("bbb");
  });
  it("filters by open ballots, holdings and a search", () => {
    expect(filterBoard(entries, "open", "", now).map((e) => e.row.token.name).sort()).toEqual(["bbb", "ccc", "ddd"]);
    expect(filterBoard(entries, "mine", "", now).map((e) => e.row.token.name).sort()).toEqual(["bbb", "ccc"]);
    expect(filterBoard(entries, "all", "CC", now).map((e) => e.row.token.name)).toEqual(["ccc"]);
  });
});

describe("useTx toasts", () => {
  beforeEach(() => {
    delete wallet.hash;
    delete wallet.receipt;
    delete wallet.error;
    Object.values(txToast).forEach((f) => f.mockClear());
  });

  it("raises a pending toast with the hash, then settles it in place", () => {
    wallet.hash = `0x${"ab".repeat(32)}`;
    const { rerender } = renderHook(() => useTx({ kind: "vote", description: "Epoch 5" }));
    expect(txToast.pending).toHaveBeenCalledWith(expect.objectContaining({ kind: "vote", description: "Epoch 5", explorerHref: expect.stringContaining("etherscan.io/tx/") }));
    wallet.receipt = { status: "success" };
    rerender();
    expect(txToast.success).toHaveBeenCalledWith("t1", expect.objectContaining({ kind: "vote" }));
  });

  it("marks a reverted receipt as an error toast", () => {
    wallet.hash = `0x${"cd".repeat(32)}`;
    wallet.receipt = { status: "reverted" };
    renderHook(() => useTx({ kind: "donation" }));
    expect(txToast.error).toHaveBeenCalledWith("t1", expect.objectContaining({ title: "Transaction reverted" }));
  });

  it("shows a declined request as one short error toast, and stays quiet when toasts are off", () => {
    wallet.error = Object.assign(new Error("User rejected the request."), { code: 4001 });
    renderHook(() => useTx({ kind: "vote" }));
    expect(txToast.error).toHaveBeenCalledTimes(1);
    expect(txToast.error).toHaveBeenCalledWith(undefined, expect.objectContaining({ title: "Request declined" }));
    txToast.error.mockClear();
    renderHook(() => useTx({ toast: false }));
    expect(txToast.error).not.toHaveBeenCalled();
  });
});

describe("privacy menu", () => {
  beforeEach(() => {
    prefsState[0] = { routeIndexer: false, introSeen: false };
    (prefsState[1] as ReturnType<typeof vi.fn>).mockClear();
  });

  it("explains privacy on the first visit and remembers the dismissal", async () => {
    render(<PrivacyMenu />);
    const dialog = await screen.findByRole("dialog", { name: "Private by default" });
    expect(within(dialog).getByText(/Reads go through Nym/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(prefsState[1]).toHaveBeenCalledWith({ routeIndexer: false, introSeen: true }));
  });

  it("opens the full details, listing what goes direct", async () => {
    prefsState[0] = { routeIndexer: false, introSeen: true };
    render(<PrivacyMenu />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => void window.dispatchEvent(new Event("varada:privacy-details")));
    const dialog = await screen.findByRole("dialog", { name: "How Varada protects what you look at" });
    const list = within(dialog).getByRole("list", { name: "Where each request goes" });
    expect(within(list).getAllByRole("listitem").length).toBeGreaterThanOrEqual(6);
    expect(list).toHaveTextContent("Zama's relayer sees your IP");
    expect(within(list).getAllByText("Through Nym").length).toBe(2);
  });
});
