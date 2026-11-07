import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Countdown, countdownParts, countdownSentence, formatCountdown } from "@varada/ui/components/data/countdown";
import { DataTable, dataTableColumns } from "@varada/ui/components/data/data-table";
import { FileDropzone, validateFile } from "@varada/ui/components/data/file-dropzone";
import { Sparkline } from "@varada/ui/components/data/sparkline";
import { Stepper } from "@varada/ui/components/data/stepper";
import { Delta } from "@varada/ui/components/data/stat-card";
import { EmptyState } from "@varada/ui/components/data/empty-state";

type Coin = { id: string; name: string; price: number };
const coins: Coin[] = [
  { id: "a", name: "Harambe", price: 0.42 },
  { id: "b", name: "Bonk Cause", price: 1.5 },
  { id: "c", name: "Cat Fund", price: 0.08 },
];
const col = dataTableColumns<Coin>();
const columns = col.columns([
  col.accessor("name", { header: "Coin" }),
  col.accessor("price", { header: "Price", meta: { numeric: true, priority: 2 } }),
]);

const firstColumnText = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0]!.textContent);

describe("DataTable", () => {
  it("toggles aria-sort and reorders rows when a header is clicked", () => {
    render(<DataTable caption="Coins" columns={columns} data={coins} getRowId={(c) => c.id} />);
    const header = screen.getByRole("columnheader", { name: /Coin/ });
    expect(header).toHaveAttribute("aria-sort", "none");
    expect(firstColumnText()).toEqual(["Harambe", "Bonk Cause", "Cat Fund"]);

    fireEvent.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(firstColumnText()).toEqual(["Bonk Cause", "Cat Fund", "Harambe"]);

    fireEvent.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(firstColumnText()).toEqual(["Harambe", "Cat Fund", "Bonk Cause"]);
    expect(screen.getByRole("status")).toHaveTextContent("Sorted by Coin, descending");
  });

  it("hides low-priority columns below their breakpoint and shows loading and empty states", () => {
    const { rerender } = render(<DataTable caption="Coins" columns={columns} data={coins} getRowId={(c) => c.id} />);
    expect(screen.getByRole("columnheader", { name: /Price/ }).className).toContain("hidden sm:table-cell");
    rerender(<DataTable caption="Coins" columns={columns} data={coins} getRowId={(c) => c.id} loading />);
    expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    rerender(<DataTable caption="Coins" columns={columns} data={[]} getRowId={(c) => c.id} empty="No coins yet" />);
    expect(screen.getByText("No coins yet")).toBeInTheDocument();
  });

  it("selects rows through the checkbox column", () => {
    render(<DataTable caption="Coins" columns={columns} data={coins} getRowId={(c) => c.id} selectable />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row b" }));
    expect(screen.getByRole("checkbox", { name: "Select row b" })).toBeChecked();
    expect(screen.getByText("selected")).toBeInTheDocument();
  });
});

const steps = [
  { id: "identity", label: "Identity", content: <p>Name and ticker</p> },
  { id: "giving", label: "Giving mode", content: <p>Pick a mode</p> },
  { id: "pair", label: "Pair", content: <p>WETH or a stock</p> },
];

describe("Stepper", () => {
  it("marks the current step and moves focus to the new heading", () => {
    render(<Stepper steps={steps} label="Launch steps" />);
    const rail = screen.getByRole("list", { name: "Launch steps" });
    expect(within(rail).getByRole("button", { name: /Step 1 of 3: Identity/ })).toHaveAttribute("aria-current", "step");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const current = within(rail).getByRole("button", { name: /Step 2 of 3: Giving mode/ });
    expect(current).toHaveAttribute("aria-current", "step");
    expect(within(rail).getByRole("button", { name: /Identity, completed/ })).not.toHaveAttribute("aria-current");
    expect(document.activeElement).toHaveTextContent("Giving mode");
    expect(document.activeElement?.tagName).toBe("H3");
  });

  it("jumps back from the rail and calls onComplete on the last step", () => {
    const onComplete = vi.fn();
    render(<Stepper steps={steps} defaultIndex={2} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onComplete).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Step 1 of 3: Identity/ }));
    expect(screen.getByRole("button", { name: /Step 1 of 3: Identity/ })).toHaveAttribute("aria-current", "step");
    expect(document.activeElement).toHaveTextContent("Identity");
  });
});

describe("Countdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats d h m s", () => {
    const parts = countdownParts((2 * 86400 + 4 * 3600 + 9 * 60 + 7) * 1000);
    expect(parts).toMatchObject({ days: 2, hours: 4, minutes: 9, seconds: 7 });
    expect(formatCountdown(parts)).toBe("2d 04h 09m 07s");
    expect(countdownSentence(parts)).toBe("2 days, 4 hours, 9 minutes remaining");
    expect(countdownParts(-5).total).toBe(0);
  });

  it("ticks down and calls onDone once at zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
    const onDone = vi.fn();
    render(<Countdown to={Date.now() + 3000} onDone={onDone} variant="inline" label="Epoch 12 closes in" />);
    expect(screen.getByText("00h 00m 03s")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("00h 00m 02s")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onDone).toHaveBeenCalledOnce();
    expect(screen.getByText("Closed")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onDone).toHaveBeenCalledOnce();
  });
});

describe("Sparkline", () => {
  it("renders a path, labelled when given a label", () => {
    const { container } = render(<Sparkline data={[1, 3, 2, 5, 4]} label="7 day price, up 12%" animate={false} />);
    const svg = screen.getByRole("img", { name: "7 day price, up 12%" });
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[paths.length - 1]!.getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+C/);
    expect(svg.getAttribute("class")).toContain("text-gain");
  });

  it("is decorative without a label and uses the loss tone for a falling series", () => {
    const { container } = render(<Sparkline data={[5, 4, 2]} animate={false} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg.getAttribute("class")).toContain("text-loss");
  });
});

describe("Delta", () => {
  it("pairs the glyph with a spoken direction", () => {
    render(<Delta value={-3.5} />);
    expect(screen.getByText("▼", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("down", { exact: false })).toBeInTheDocument();
  });
});

describe("FileDropzone", () => {
  const big = new File([new Uint8Array(3 * 1024 * 1024)], "logo.png", { type: "image/png" });
  const gif = new File(["gif"], "logo.gif", { type: "image/gif" });
  const ok = new File(["png"], "logo.webp", { type: "image/webp" });

  it("validates type and size", () => {
    expect(validateFile(big, "image/png,image/jpeg,image/webp", 2 * 1024 * 1024)).toBe("That file is 3 MB. The limit is 2 MB.");
    expect(validateFile(gif, "image/png,image/jpeg,image/webp", 2 * 1024 * 1024)).toBe(
      "PNG, JPEG or WebP only. That file is a GIF.",
    );
    expect(validateFile(ok, "image/png,image/jpeg,image/webp", 2 * 1024 * 1024)).toBeNull();
  });

  it("rejects an oversized file and an unsupported type with an alert", () => {
    const onChange = vi.fn();
    render(<FileDropzone label="Coin logo" onChange={onChange} />);
    const input = screen.getByLabelText("Coin logo");
    fireEvent.change(input, { target: { files: [big] } });
    expect(screen.getByRole("alert")).toHaveTextContent("The limit is 2 MB");
    expect(input).toHaveAttribute("aria-invalid", "true");

    fireEvent.drop(input.parentElement!, { dataTransfer: { files: [gif] } });
    expect(screen.getByRole("alert")).toHaveTextContent("PNG, JPEG or WebP only");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { files: [ok] } });
    expect(onChange).toHaveBeenCalledWith(ok);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("logo.webp")).toBeInTheDocument();
  });
});

describe("EmptyState heading level", () => {
  it("renders the level it is given, down to h1 for a page that has nothing else to say", () => {
    const { rerender } = render(<EmptyState title="Nothing here" headingLevel={1} />);
    expect(screen.getByRole("heading", { level: 1, name: "Nothing here" })).toBeInTheDocument();
    rerender(<EmptyState title="Nothing here" />);
    expect(screen.getByRole("heading", { level: 3 })).toBeInTheDocument();
  });
});
