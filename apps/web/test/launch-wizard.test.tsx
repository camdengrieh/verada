import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeesStep } from "@/components/launch/fees-step";
import { causeNameOf, FocusStep } from "@/components/launch/focus-step";
import { LabelStatusLine } from "@/components/launch/identity-step";
import { LaunchSuccess } from "@/components/launch/launch-success";
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
    expect(screen.getByRole("link", { name: /paws\.varada\.eth/ }).getAttribute("href")).toBe("https://paws.varada.eth.limo/");
  });

  it("copes with a receipt that has no TokenCreated log", () => {
    render(<LaunchSuccess name="Paws" symbol="PAWS" label="paws" token={null} live onAgain={() => {}} rotation="12h" />);
    expect(screen.queryByRole("link", { name: "Open the token page" })).toBeNull();
    expect(screen.getByText(/could not be read from the receipt/)).toBeInTheDocument();
  });
});
