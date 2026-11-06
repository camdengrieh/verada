import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TokenDetail } from "@/lib/indexer";

const TOKEN = "0x00000000000000000000000000000000000000A1";
const CONTROLLER = "0x00000000000000000000000000000000000000C0";
const CAUSE_A = `0x${"0a".repeat(32)}`;
const CAUSE_B = `0x${"0b".repeat(32)}`;

const catalogOrg = vi.fn(async (id: string) => ({
  org: { orgId: `0x${"a1".repeat(32)}`, causeId: id, ein: "1", name: id === CAUSE_A ? "Alpha Fund" : "Beta Trust", country: "KEN", categories: ["hunger"], regions: ["africa"] },
  entries: [{ bucket: 32, index: id === CAUSE_A ? 0 : 1, orgId: `0x${"a1".repeat(32)}`, proof: [`0x${"98".repeat(32)}`] }],
}));
const deps = { indexer: { catalogOrg } };

vi.mock("@/components/providers", () => ({
  useAppConfig: () => ({ governorAddress: "0x00000000000000000000000000000000000000d1", chainId: 1 }),
  useDeps: () => deps,
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: "0x00000000000000000000000000000000000000C0", chainId: 1, isConnected: true }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  useWriteContract: () => ({ writeContractAsync: vi.fn(), data: undefined, isPending: false, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, error: null }),
}));
vi.mock("@/components/catalog-browser", () => ({ CatalogBrowser: () => null }));

import { ShortlistEditor } from "@/components/shortlist-editor";

/** A fresh object graph each call, as every refetch of the token returns. */
const detail = (): TokenDetail =>
  ({
    address: TOKEN,
    profile: { controller: CONTROLLER },
    shortlist: [CAUSE_A, CAUSE_B],
    focus: { categoryMask: "4", regionMask: 1, categories: ["hunger"], regions: ["africa"] },
    ballotSize: { cap: 30, choice: 0, size: 30, choiceEffectiveFrom: null },
  }) as unknown as TokenDetail;

describe("ShortlistEditor draft", () => {
  it("keeps unsaved edits when a refetch returns equal but new objects", async () => {
    const { rerender } = render(<ShortlistEditor token={TOKEN} detail={detail()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Unpin Alpha Fund" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Unpin Alpha Fund" }));
    expect(screen.queryByRole("button", { name: "Unpin Alpha Fund" })).toBeNull();
    const calls = catalogOrg.mock.calls.length;

    rerender(<ShortlistEditor token={TOKEN} detail={detail()} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Unpin Alpha Fund" })).toBeNull();
    expect(screen.getByRole("button", { name: "Unpin Beta Trust" })).toBeInTheDocument();
    expect(catalogOrg.mock.calls.length).toBe(calls);
  });

  it("rebuilds when the pins on chain change", async () => {
    const { rerender } = render(<ShortlistEditor token={TOKEN} detail={detail()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Unpin Beta Trust" })).toBeInTheDocument());
    rerender(<ShortlistEditor token={TOKEN} detail={{ ...detail(), shortlist: [CAUSE_A] } as TokenDetail} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Unpin Beta Trust" })).toBeNull());
    expect(screen.getByRole("button", { name: "Unpin Alpha Fund" })).toBeInTheDocument();
  });
});
