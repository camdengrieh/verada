import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { Button } from "@verada/ui/components/ui/button";
import { Checkbox } from "@verada/ui/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@verada/ui/components/ui/dialog";
import { Field, FieldControl, FieldError, FieldHint, FieldLabel } from "@verada/ui/components/ui/field";
import { Input } from "@verada/ui/components/ui/input";
import { Label } from "@verada/ui/components/ui/label";
import { Slider } from "@verada/ui/components/ui/slider";
import { Switch } from "@verada/ui/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@verada/ui/components/ui/tabs";
import { Toaster, toast } from "@verada/ui/components/ui/toaster";

// jsdom lacks these browser APIs; Radix (sizing) and motion/sonner (media queries) read them.
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
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

describe("Field", () => {
  it("labels the control and describes it with the hint and, when invalid, the error", () => {
    render(
      <Field invalid>
        <FieldLabel>Amount</FieldLabel>
        <FieldControl>
          <Input inputMode="decimal" />
        </FieldControl>
        <FieldHint>Max 2.5 ETH per trade.</FieldHint>
        <FieldError>Enter more than 0.</FieldError>
      </Field>,
    );
    const input = screen.getByLabelText("Amount");
    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0]!)).toHaveTextContent("Max 2.5 ETH per trade.");
    expect(document.getElementById(ids[1]!)).toHaveTextContent("Enter more than 0.");
    expect(input).toHaveAccessibleDescription("Max 2.5 ETH per trade. Enter more than 0.");
  });

  it("hides the error and drops aria-invalid while valid", () => {
    render(
      <Field>
        <FieldLabel>Symbol</FieldLabel>
        <FieldControl>
          <Input />
        </FieldControl>
        <FieldHint>2 to 10 letters.</FieldHint>
        <FieldError>Taken.</FieldError>
      </Field>,
    );
    const input = screen.getByLabelText("Symbol");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).toHaveAccessibleDescription("2 to 10 letters.");
    expect(screen.queryByText("Taken.")).toBeNull();
  });
});

describe("Dialog", () => {
  it("opens from its trigger, closes on Escape and returns focus", async () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Connect wallet</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Connect a wallet</DialogTitle>
          <DialogDescription>Choose how you sign.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole("button", { name: "Connect wallet" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Connect a wallet" });
    expect(dialog).toHaveAccessibleDescription("Choose how you sign.");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("Tabs", () => {
  it("moves selection with the arrow keys", async () => {
    render(
      <Tabs defaultValue="trades">
        <TabsList aria-label="Token activity">
          <TabsTrigger value="trades">Trades</TabsTrigger>
          <TabsTrigger value="holders">Holders</TabsTrigger>
          <TabsTrigger value="votes">Votes</TabsTrigger>
        </TabsList>
        <TabsContent value="trades">Recent trades</TabsContent>
        <TabsContent value="holders">Top holders</TabsContent>
        <TabsContent value="votes">Cause votes</TabsContent>
      </Tabs>,
    );
    const trades = screen.getByRole("tab", { name: "Trades" });
    expect(trades).toHaveAttribute("aria-selected", "true");
    act(() => trades.focus());
    fireEvent.keyDown(trades, { key: "ArrowRight" });
    const holders = screen.getByRole("tab", { name: "Holders" });
    await waitFor(() => expect(holders).toHaveAttribute("aria-selected", "true"));
    expect(holders).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Top holders");
    fireEvent.keyDown(holders, { key: "End" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Votes" })).toHaveAttribute("aria-selected", "true"));
  });
});

describe("form controls", () => {
  it("exposes slider, checkbox and switch roles with names and state", () => {
    render(
      <>
        <Slider aria-label="Slippage tolerance" defaultValue={[1]} min={0} max={5} step={0.1} formatValue={(v) => `${v}%`} />
        <Checkbox id="ack" />
        <Label htmlFor="ack">I understand 90% of fees go to causes</Label>
        <Switch id="private" defaultChecked />
        <Label htmlFor="private">Private vote</Label>
      </>,
    );
    const slider = screen.getByRole("slider", { name: "Slippage tolerance" });
    expect(slider).toHaveAttribute("aria-valuenow", "1");
    expect(slider).toHaveAttribute("aria-valuetext", "1%");

    const checkbox = screen.getByRole("checkbox", { name: /90% of fees/ });
    expect(checkbox).toHaveAttribute("aria-checked", "false");
    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute("aria-checked", "true");

    const sw = screen.getByRole("switch", { name: "Private vote" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
  });
});

describe("Toaster", () => {
  it("renders a toast", async () => {
    render(<Toaster />);
    act(() => {
      toast.success("Vote cast privately", { description: "Epoch 12 · Wildlife rescue" });
    });
    expect(await screen.findByText("Vote cast privately")).toBeInTheDocument();
    expect(screen.getByText("Epoch 12 · Wildlife rescue")).toBeInTheDocument();
  });
});
