import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const confettiMock = vi.hoisted(() => {
  const fn = vi.fn((..._args: unknown[]) => null) as ReturnType<typeof vi.fn> & {
    shapeFromPath: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  };
  fn.shapeFromPath = vi.fn(() => ({ type: "path", path: "", matrix: [] }));
  fn.reset = vi.fn();
  return fn;
});
vi.mock("canvas-confetti", () => ({ default: confettiMock }));

import { ConfettiButton, fireConfetti, readTokenColors } from "@varada/ui/components/motion/confetti";
import { LoadingScreen, PageLoader } from "@varada/ui/components/motion/loading-screen";
import { Button } from "@varada/ui/components/ui/button";
import { Drawer, DrawerContent, DrawerScaleWrapper, DrawerTitle, DrawerTrigger } from "@varada/ui/components/ui/drawer";
import { Toaster } from "@varada/ui/components/ui/toaster";
import { txToast } from "@varada/ui/components/varada/tx-toast";

/* A controllable prefers-reduced-motion. */
let reduced = false;
const listeners = new Set<() => void>();
function setReduced(value: boolean) {
  reduced = value;
  listeners.forEach((l) => l());
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("prefers-reduced-motion") ? reduced : false;
    },
    media: query,
    onchange: null,
    addListener: (l: () => void) => listeners.add(l),
    removeListener: (l: () => void) => listeners.delete(l),
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  confettiMock.mockClear();
  setReduced(false);
});

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("confetti", () => {
  it("bursts with the token palette when motion is allowed", () => {
    document.documentElement.style.setProperty("--sage", "#3f6b4e");
    document.documentElement.style.setProperty("--ochre", "#c98a2b");
    expect(readTokenColors(["--sage", "--ochre", "--missing"])).toEqual(["#3f6b4e", "#c98a2b"]);

    const handle = fireConfetti({ preset: "vote", origin: { x: 0.5, y: 0.5, unit: "fraction" } });
    expect(handle.fired).toBe(true);
    expect(confettiMock).toHaveBeenCalled();
    const first = confettiMock.mock.calls[0]?.[0] as { colors?: string[]; disableForReducedMotion?: boolean; origin?: { x: number } };
    expect(first.colors).toContain("#3f6b4e");
    expect(first.disableForReducedMotion).toBe(true);
    expect(first.origin?.x).toBe(0.5);
    handle.cancel();
  });

  it("draws nothing under reduced motion and reports it instead", () => {
    setReduced(true);
    const onReducedMotion = vi.fn();
    const handle = fireConfetti({ preset: "launch", onReducedMotion });
    expect(handle.fired).toBe(false);
    expect(onReducedMotion).toHaveBeenCalledOnce();
    expect(confettiMock).not.toHaveBeenCalled();
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("ConfettiButton shows a static celebration under reduced motion and still runs onClick", () => {
    setReduced(true);
    const onClick = vi.fn();
    render(
      <ConfettiButton preset="donation" onClick={onClick}>
        Donate
      </ConfettiButton>,
    );
    const button = screen.getByRole("button", { name: "Donate" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(confettiMock).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("data-celebrated", "true");
    expect(button.querySelector("[data-slot='confetti-static']")).not.toBeNull();
  });

  it("ConfettiButton bursts from itself when motion is allowed", () => {
    render(<ConfettiButton preset="vote">Vote</ConfettiButton>);
    fireEvent.click(screen.getByRole("button", { name: "Vote" }));
    expect(confettiMock).toHaveBeenCalled();
  });
});

describe("LoadingScreen", () => {
  const steps = [
    { id: "config", label: "Loading configuration", status: "done" as const },
    { id: "nym", label: "Connecting privately through Nym…", status: "active" as const },
    { id: "chain", label: "Reading the chain", status: "pending" as const },
  ];

  it("is a busy status region that announces the active step", () => {
    render(<LoadingScreen ready={false} steps={steps} minVisibleMs={0} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading Varada: Connecting privately through Nym…");
  });

  it("leaves when ready flips and calls onExited", async () => {
    setReduced(true);
    const onExited = vi.fn();
    const { rerender } = render(<LoadingScreen ready={false} minVisibleMs={0} onExited={onExited} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    rerender(<LoadingScreen ready minVisibleMs={0} onExited={onExited} />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), { timeout: 2000 });
    await waitFor(() => expect(onExited).toHaveBeenCalled());
  });

  it("stays up for minVisibleMs so a fast load doesn't flash", () => {
    vi.useFakeTimers();
    try {
      render(<LoadingScreen ready minVisibleMs={500} />);
      expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("PageLoader is a labelled status", () => {
    render(<PageLoader label="Loading ballots" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading ballots");
  });
});

describe("Button effects", () => {
  it("keep the role and name and add only hidden decoration", () => {
    render(
      <>
        <Button effect="wash">Launch</Button>
        <Button effect="brush" variant="cause">
          Vote
        </Button>
        <Button effect="shine" asChild variant="outline">
          <a href="#x">Docs</a>
        </Button>
      </>,
    );
    const launch = screen.getByRole("button", { name: "Launch" });
    expect(launch).toHaveAttribute("type", "button");
    expect(launch).toHaveAttribute("data-effect", "wash");
    expect(launch.className).toContain("bg-primary");
    expect(launch.querySelector("[data-slot='button-effect']")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "Vote" }).querySelector("[data-slot='button-effect']")).not.toBeNull();
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link.className).toContain("border-ink");
    expect(link.querySelector("[data-slot='button-effect']")).not.toBeNull();
  });

  it("leave the plain button untouched when no effect is set", () => {
    render(<Button>Buy</Button>);
    const b = screen.getByRole("button", { name: "Buy" });
    expect(b).not.toHaveAttribute("data-effect");
    expect(b.className).not.toContain("group/btn");
  });

  it("switch off under reduced motion", () => {
    setReduced(true);
    render(
      <>
        <Button effect="wash">Launch</Button>
        <Button effect="magnetic">Swap</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Launch" }).querySelector("[data-slot='button-effect']")).toBeNull();
    const swap = screen.getByRole("button", { name: "Swap" });
    fireEvent.pointerMove(swap, { pointerType: "mouse", clientX: 40, clientY: 10 });
    expect(swap.style.transform).toBe("");
  });
});

describe("txToast", () => {
  it("moves one toast from pending to success with the donation and explorer link", async () => {
    render(<Toaster />);
    let id: string | number = "";
    act(() => {
      id = txToast.pending({ kind: "swap", description: "0.5 ETH for $HARAMBE" });
    });
    expect(await screen.findByText("Confirming your swap…")).toBeInTheDocument();

    act(() => {
      txToast.success(id, {
        kind: "swap",
        explorerHref: "https://etherscan.io/tx/0xabc",
        donation: { amount: "0.0045 ETH", cause: "Wildlife rescue" },
        confetti: "launch",
      });
    });
    expect(await screen.findByText("Swap confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Confirming your swap…")).toBeNull();
    expect(screen.getByText("0.0045 ETH")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View on Etherscan/ })).toHaveAttribute("href", "https://etherscan.io/tx/0xabc");
    await waitFor(() => expect(confettiMock).toHaveBeenCalled());
  });

  it("shows errors as alerts with a retry", async () => {
    render(<Toaster />);
    const onRetry = vi.fn();
    act(() => {
      txToast.error(undefined, { kind: "vote", description: "The ballot closed.", onRetry });
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Vote not cast");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("follows a promise", async () => {
    render(<Toaster />);
    let settle: (v: string) => void = () => {};
    const p = new Promise<string>((r) => (settle = r));
    act(() => {
      void txToast.promise(p, { kind: "launch", success: (ticker) => ({ description: `${ticker} is live` }) });
    });
    expect(await screen.findByText("Launching your token…")).toBeInTheDocument();
    await act(async () => {
      settle("$HARAMBE");
      await p;
    });
    expect(await screen.findByText("Token launched")).toBeInTheDocument();
    expect(screen.getByText("$HARAMBE is live")).toBeInTheDocument();
  });
});

describe("Drawer", () => {
  it("still opens and closes", async () => {
    render(
      <Drawer>
        <DrawerTrigger>Open</DrawerTrigger>
        <DrawerContent>
          <DrawerTitle>Buy $HARAMBE</DrawerTitle>
        </DrawerContent>
      </Drawer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("dialog", { name: "Buy $HARAMBE" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 2000 });
  });

  it("scales the wrapper behind it, but not under reduced motion", async () => {
    const view = (
      <DrawerScaleWrapper data-testid="page">
        <Drawer shouldScaleBackground>
          <DrawerTrigger>Open</DrawerTrigger>
          <DrawerContent variant="paper">
            <DrawerTitle>Paper</DrawerTitle>
          </DrawerContent>
        </Drawer>
      </DrawerScaleWrapper>
    );
    const { unmount } = render(view);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Paper" });
    expect(dialog).toHaveAttribute("data-variant", "paper");
    await waitFor(() => expect(screen.getByTestId("page").style.transform).toContain("scale("));
    unmount();

    setReduced(true);
    render(view);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog", { name: "Paper" });
    expect(screen.getByTestId("page").style.transform).toBe("");
  });

  it("sizes the sheet to full height when snap points are set", async () => {
    render(
      <Drawer snapPoints={[0.4, 1]}>
        <DrawerTrigger>Open</DrawerTrigger>
        <DrawerContent>
          <DrawerTitle>Snaps</DrawerTitle>
        </DrawerContent>
      </Drawer>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Snaps" });
    expect(dialog.className).toContain("data-[vaul-snap-points=true]:h-[96dvh]");
    await waitFor(() => expect(dialog).toHaveAttribute("data-vaul-snap-points", "true"));
  });
});
