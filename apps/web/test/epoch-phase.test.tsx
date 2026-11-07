import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpochPhaseStrip } from "@/components/epoch-phase";

vi.mock("@/components/providers", () => ({ useAppConfig: () => ({}), useDeps: () => ({}), usePrivateRpc: () => ({}) }));
vi.mock("wagmi", () => ({ useAccount: () => ({}) }));

// A 45 minute epoch: 30 minutes of trading, then 15 of voting.
const T = { start: 1_000_000, end: 1_002_700, votingOpensAt: 1_001_800 };
const at = (s: number) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(s * 1000) });
afterEach(() => vi.useRealTimers());

describe("EpochPhaseStrip", () => {
  it("shows trading with a countdown to when voting opens", () => {
    at(T.start + 60);
    render(<EpochPhaseStrip timing={T} epoch={9n} />);
    const strip = screen.getByRole("group", { name: "Epoch 9 phase" });
    expect(within(strip).getByText("Trading")).toBeInTheDocument();
    expect(within(strip).getByText("Ballots are not accepted yet.")).toBeInTheDocument();
    expect(within(strip).getByRole("group", { name: "Voting opens in" })).toBeInTheDocument();
    expect(strip).toHaveTextContent("Epochs last 45 minutes: 30 minutes of trading, then 15 minutes of voting.");
    expect(strip).toHaveTextContent("Trading 1970-01-12T13:46:40Z to 1970-01-12T14:16:40Z.");
  });

  it("shows voting with a countdown to the end of the epoch", () => {
    at(T.votingOpensAt + 1);
    render(<EpochPhaseStrip timing={T} />);
    const strip = screen.getByRole("group", { name: "Epoch phase" });
    expect(within(strip).getByText("Voting")).toBeInTheDocument();
    expect(within(strip).getByRole("group", { name: "Voting closes in" })).toBeInTheDocument();
  });

  it("shows the tally phase once the epoch ended, without a countdown", () => {
    at(T.end);
    render(<EpochPhaseStrip timing={T} />);
    const strip = screen.getByRole("group", { name: "Epoch phase" });
    expect(within(strip).getByText("Tally")).toBeInTheDocument();
    expect(within(strip).queryByRole("group", { name: /Voting (opens|closes) in/ })).toBeNull();
  });

  it("says ballots are accepted throughout when there is no trading phase", () => {
    at(T.start + 5);
    render(<EpochPhaseStrip timing={{ ...T, votingOpensAt: T.start }} />);
    expect(screen.getByText("Ballots are accepted for the whole epoch.")).toBeInTheDocument();
    expect(screen.queryByText(/of trading/)).toBeNull();
  });
});
