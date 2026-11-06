import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { envDefaults, type AppConfig } from "@/lib/config";

const config: AppConfig = { ...envDefaults(), governorAddress: "0x00000000000000000000000000000000000000d1" };

let cap: bigint | Error = 10n;
const chainRead = vi.fn(async ({ functionName }: { functionName: string }) => {
  if (functionName === "currentEpoch") return 5n;
  if (functionName === "ballotSizeCap") {
    if (cap instanceof Error) throw cap;
    return cap;
  }
  throw new Error(`unexpected public read ${functionName}`);
});

vi.mock("@/components/providers", () => ({
  useAppConfig: () => config,
  useDeps: () => ({ indexer: {}, chain: () => ({ readContract: chainRead }) }),
}));
vi.mock("@/components/nav", () => ({ useRel: () => (p: string) => p }));

const { GovernancePanel } = await import("@/components/governance-panel");

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <GovernancePanel />
    </QueryClientProvider>,
  );
}

describe("GovernancePanel ballot size", () => {
  beforeEach(() => {
    chainRead.mockClear();
  });

  it("states the live protocol cap, not a fixed 32", async () => {
    cap = 10n;
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
});
