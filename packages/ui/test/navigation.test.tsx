import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { AvatarTooltipGroup } from "@verada/ui/components/ui/avatar-tooltip-group";
import { InfoTip, InfoTerm } from "@verada/ui/components/ui/info-tip";
import { FeeTooltip } from "@verada/ui/components/ui/rich-tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger, type TabsVariant } from "@verada/ui/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@verada/ui/components/ui/tooltip";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

/** jsdom may not carry pointerType through PointerEvent init, so set it on the event. */
function tap(el: HTMLElement) {
  const down = createEvent.pointerDown(el);
  Object.defineProperty(down, "pointerType", { value: "touch" });
  fireEvent(el, down);
  fireEvent.click(el);
}

function Epochs({ variant, scrollable }: { variant: TabsVariant; scrollable?: boolean }) {
  return (
    <Tabs defaultValue="e12" variant={variant}>
      <TabsList aria-label="Epochs" scrollable={scrollable}>
        <TabsTrigger value="e12">Epoch 12</TabsTrigger>
        <TabsTrigger value="e11">Epoch 11</TabsTrigger>
        <TabsTrigger value="e10">Epoch 10</TabsTrigger>
      </TabsList>
      <TabsContent value="e12">Voting open</TabsContent>
      <TabsContent value="e11">Paid to Clean water</TabsContent>
      <TabsContent value="e10">Paid to Wildlife</TabsContent>
    </Tabs>
  );
}

describe("Tabs variants", () => {
  const horizontal: TabsVariant[] = ["underline", "pill", "brush", "segmented", "card"];

  it.each(horizontal)("%s: arrow keys move selection and aria-selected", async (variant) => {
    render(<Epochs variant={variant} />);
    const first = screen.getByRole("tab", { name: "Epoch 12" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tablist").closest("[data-variant]")).toHaveAttribute("data-variant", variant);
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const second = screen.getByRole("tab", { name: "Epoch 11" });
    await waitFor(() => expect(second).toHaveAttribute("aria-selected", "true"));
    expect(first).toHaveAttribute("aria-selected", "false");
    expect(second).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Paid to Clean water");
  });

  it("vertical: is a vertical tablist driven by ArrowDown and End", async () => {
    render(<Epochs variant="vertical" />);
    const list = screen.getByRole("tablist");
    expect(list).toHaveAttribute("aria-orientation", "vertical");
    const first = screen.getByRole("tab", { name: "Epoch 12" });
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Epoch 11" })).toHaveAttribute("aria-selected", "true"));
    fireEvent.keyDown(screen.getByRole("tab", { name: "Epoch 11" }), { key: "End" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Epoch 10" })).toHaveAttribute("aria-selected", "true"));
  });

  it("scrollable: keeps the tablist semantics and selects with the keyboard", async () => {
    const { container } = render(<Epochs variant="underline" scrollable />);
    expect(container.querySelector('[data-slot="tabs-scroll"]')).not.toBeNull();
    const first = screen.getByRole("tab", { name: "Epoch 12" });
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Epoch 10" })).toHaveAttribute("aria-selected", "true"));
  });
});

describe("Tooltip", () => {
  it("opens on keyboard focus and closes on Escape", async () => {
    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button">Fee</button>
        </TooltipTrigger>
        <TooltipContent>1% per trade</TooltipContent>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Fee" });
    act(() => trigger.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("1% per trade");
    expect(trigger).toHaveAttribute("aria-describedby");
    fireEvent.keyDown(document.activeElement ?? trigger, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("spring tooltips open on focus too and close on Escape", async () => {
    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button">Curator</button>
        </TooltipTrigger>
        <TooltipContent followCursor>wildlife.agent.varada.eth</TooltipContent>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Curator" });
    act(() => trigger.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("wildlife.agent.varada.eth");
    fireEvent.keyDown(trigger, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("toggles on a touch tap", async () => {
    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button">Epoch</button>
        </TooltipTrigger>
        <TooltipContent>One voting round</TooltipContent>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Epoch" });
    tap(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("One voting round");
    tap(trigger);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });
});

describe("InfoTip, FeeTooltip and AvatarTooltipGroup", () => {
  it("InfoTip names its trigger after the term and describes it with the definition", async () => {
    render(
      <p>
        Price impact <InfoTip entry="price-impact" /> and <InfoTerm entry="fhe" label="private votes" />
      </p>,
    );
    const tip = screen.getByRole("button", { name: "What is price impact?" });
    act(() => tip.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/your own trade moves the price/);
    expect(screen.getByRole("button", { name: "private votes" })).toBeInTheDocument();
  });

  it("FeeTooltip shows the 90/10 breakdown on focus", async () => {
    render(
      <FeeTooltip rate="1%" fee="$5.00" toCause="$4.50" toPlatform="$0.50" cause="Wildlife">
        <button type="button">Fee $5.00</button>
      </FeeTooltip>,
    );
    act(() => screen.getByRole("button", { name: "Fee $5.00" }).focus());
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Wildlife pool · 90%");
    expect(tip).toHaveTextContent("$4.50");
    expect(tip).toHaveTextContent("Varada · 10%");
  });

  it("AvatarTooltipGroup is a named list of focusable people with an overflow chip", async () => {
    const people = ["Asha", "Bo", "Cyd", "Dev"].map((name, i) => ({ id: String(i), name, detail: `${4 - i}.0% of supply` }));
    render(<AvatarTooltipGroup people={people} label="Top holders" max={3} />);
    expect(screen.getByRole("list", { name: "Top holders" })).toBeInTheDocument();
    const asha = screen.getByRole("button", { name: "Asha, 4.0% of supply" });
    expect(screen.getByRole("button", { name: "1 more: Dev" })).toBeInTheDocument();
    act(() => asha.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Asha");
  });
});
