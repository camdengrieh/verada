import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeesStep } from "@/components/launch/fees-step";
import { causeNameOf, FocusStep } from "@/components/launch/focus-step";
import { IdentityStep, LabelStatusLine } from "@/components/launch/identity-step";
import { LaunchSuccess } from "@/components/launch/launch-success";
import { ModeStep } from "@/components/launch/mode-step";
import type { StepProps } from "@/components/launch/types";
import { initialWizardState, type WizardState } from "@/lib/launch-steps";
import type { LaunchInput } from "@/lib/launch";

// Radix slider measures its thumbs with ResizeObserver, which jsdom lacks.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("@/components/providers", () => ({
  useAppConfig: () => ({ ensParentName: "varada.eth", publisherUrl: undefined }),
  useDeps: () => ({}),
}));
vi.mock("@varada/ui/components/motion/confetti", () => ({ useConfetti: () => ({ fire: vi.fn(), reduced: false }) }));

function props(state: WizardState, setInput = vi.fn<(c: Partial<LaunchInput>) => void>()): StepProps {
  return { state, errors: {}, err: () => undefined, touch: vi.fn(), patch: vi.fn(), setInput };
}

const base = initialWizardState(`0x${"11".repeat(32)}`);

describe("FocusStep", () => {
  it("toggles a category and a region through setInput", () => {
    const setInput = vi.fn();
    render(<FocusStep {...props(base, setInput)} summary={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Hunger/ }));
    expect(setInput).toHaveBeenCalledWith({ categories: ["hunger"] });
    fireEvent.click(screen.getByRole("button", { name: /Africa/ }));
    expect(setInput).toHaveBeenLastCalledWith({ regions: ["africa"] });
  });

  it("lists all 21 categories and 8 regions with the live count", () => {
    render(<FocusStep {...props({ ...base, pool: 1234 })} summary={undefined} />);
    expect(document.querySelectorAll("button[aria-pressed]")).toHaveLength(21 + 8);
    expect(screen.getByText("1,234")).toBeInTheDocument();
  });

  it("explains a pool under two entries", () => {
    const p = props({ ...base, pool: 1 });
    render(<FocusStep {...p} err={(f) => (f === "focus" ? "Only 1 eligible entry: a launch needs at least 2." : undefined)} summary={undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/at least 2/);
  });

  it("maps catalogue slugs to the library's cause names", () => {
    expect(causeNameOf("hunger")).toBe("hunger");
    expect(causeNameOf("children-youth")).toBe("children");
    expect(causeNameOf("other")).toBe("other");
  });
});

describe("ModeStep epoch pool", () => {
  const modeProps = { causes: undefined, causesLoading: false, causesFailed: false, liveReady: true };

  it("says 'each epoch' and shows the length the governor reports, not a week", () => {
    render(<ModeStep {...props(base)} {...modeProps} epochLength="45 minutes" />);
    const pool = screen.getByRole("radio", { name: /Epoch pool/ });
    expect(pool).toBeInTheDocument();
    expect(screen.getByText(/Fees pool for each epoch \(currently 45 minutes\)\./)).toBeInTheDocument();
    expect(screen.queryByText(/for a week/)).toBeNull();
  });

  it("promises no length while the governor's is unknown", () => {
    render(<ModeStep {...props(base)} {...modeProps} />);
    expect(screen.getByText(/Fees pool for each epoch\. Holders then vote/)).toBeInTheDocument();
    expect(screen.queryByText(/currently/)).toBeNull();
  });
});

describe("FeesStep", () => {
  it("turns launch protection on with a surcharge and a decay, and off again", () => {
    const setInput = vi.fn();
    render(<FeesStep {...props(base, setInput)} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(setInput).toHaveBeenCalledWith({ sniperFeeStartBps: "3000", sniperDecaySeconds: "300" });
  });

  it("shows the surcharge controls once enabled and the fixed split", () => {
    const protectedState = { ...base, input: { ...base.input, sniperFeeStartBps: "3000", sniperDecaySeconds: "300" } };
    render(<FeesStep {...props(protectedState)} />);
    expect(screen.getByText("Starting surcharge")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /90% to your coin's cause, 10% to Varada/ })).toBeInTheDocument();
  });
});

describe("FeesStep donation asset", () => {
  it("offers USDC and ETH, USDC selected by default, with a hint for the pair", () => {
    render(<FeesStep {...props(base)} />);
    expect(screen.getByRole("radio", { name: /^USDC/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^ETH/ })).not.toBeChecked();
    // The default pair is WETH: ETH needs no conversion.
    expect(screen.getByText(/ETH looks better for this pair/)).toBeInTheDocument();
  });

  it("choosing ETH sets the asset and restarts the threshold in ETH", () => {
    const setInput = vi.fn();
    render(<FeesStep {...props(base, setInput)} />);
    fireEvent.click(screen.getByRole("radio", { name: /^ETH/ }));
    expect(setInput).toHaveBeenCalledWith({ donationAsset: "eth", donationThreshold: "0.01" });
  });

  it("the success screen says what donations are paid in", () => {
    render(<LaunchSuccess name="N" symbol="N" label="n-coin" token={null} live={false} donationAsset="eth" onAgain={vi.fn()} />);
    expect(screen.getByText("Donations paid in ETH")).toBeInTheDocument();
  });
});

describe("IdentityStep coin name", () => {
  const identity = (state: WizardState, errors: Record<string, string>) =>
    render(<IdentityStep {...props(state)} errors={errors} labelLoading={false} labelFailed={false} onLogo={vi.fn()} onLogoBusy={vi.fn()} />);

  it("shows the name derived from the token name, read-only, under coin.<parent>", () => {
    identity({ ...base, input: { ...base.input, name: "Harambe Relief Fund", label: "harambe-relief-fund" } }, {});
    expect(screen.getByTestId("coin-ens-name").textContent).toBe("harambe-relief-fund.coin.varada.eth");
    // No editable ENS field: the only text inputs are the token name, the ticker and the profile fields.
    expect(screen.queryByPlaceholderText("harambe")).toBeNull();
    expect(screen.getByTestId("coin-ens-name").tagName).toBe("P");
  });

  it("shows a taken name as soon as a token name is typed", () => {
    const taken = { ...base, input: { ...base.input, name: "Paws", label: "paws" }, labelStatus: { kind: "taken" as const, token: "0x0000000000000000000000000000000000000001" as const } };
    identity(taken, { label: "paws.coin.varada.eth is already taken by 0x0000…0001. Choose a different token name." });
    expect(screen.getByText(/paws\.coin\.varada\.eth is already taken/)).toBeInTheDocument();
  });

  it("keeps the error hidden while no token name is typed", () => {
    identity({ ...base, input: { ...base.input, name: "", label: "" } }, { label: "The ENS name comes from the token name" });
    expect(screen.queryByText("The ENS name comes from the token name")).toBeNull();
  });
});

describe("LabelStatusLine", () => {
  it("says available, and stays quiet for taken (the field shows that error)", () => {
    const { rerender } = render(<LabelStatusLine name="a.varada.eth" label="abc" status={{ kind: "available" }} loading={false} failed={false} />);
    expect(screen.getByText(/is available/)).toBeInTheDocument();
    rerender(<LabelStatusLine name="a.varada.eth" label="abc" status={{ kind: "taken", token: "0x0000000000000000000000000000000000000001" }} loading={false} failed={false} />);
    expect(screen.queryByText(/is available/)).toBeNull();
  });

  it("degrades to an availability-unknown note when the read failed", () => {
    render(<LabelStatusLine name="a.varada.eth" label="abc" loading={false} failed />);
    expect(screen.getByText(/Availability unknown/)).toBeInTheDocument();
  });
});

describe("LaunchSuccess", () => {
  it("links the token page and offers share links", () => {
    render(<LaunchSuccess name="Paws" symbol="PAWS" label="paws" token="0x00000000000000000000000000000000000000a1" live={false} onAgain={() => {}} />);
    expect(screen.getByRole("link", { name: "Open the token page" }).getAttribute("href")).toMatch(/token\/\?address=0x00000000000000000000000000000000000000a1$/);
    expect(screen.getByRole("link", { name: /Share on X/ }).getAttribute("href")).toContain("twitter.com/intent/tweet");
    expect(screen.getByRole("link", { name: /Share on Telegram/ }).getAttribute("href")).toContain("t.me/share/url");
    // Shown as the coin name; the page link stays on <label>.<parent>, which resolves today.
    expect(screen.getByRole("link", { name: /paws\.coin\.varada\.eth/ }).getAttribute("href")).toBe("https://paws.varada.eth.limo/");
  });

  it("copes with a receipt that has no TokenCreated log", () => {
    render(<LaunchSuccess name="Paws" symbol="PAWS" label="paws" token={null} live onAgain={() => {}} rotation="12h" />);
    expect(screen.queryByRole("link", { name: "Open the token page" })).toBeNull();
    expect(screen.getByText(/could not be read from the receipt/)).toBeInTheDocument();
  });
});
