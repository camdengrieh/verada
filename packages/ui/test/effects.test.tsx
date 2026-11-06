import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnimatedBeam, BeamNode } from "@varada/ui/components/motion/animated-beam";
import { AnimatedList } from "@varada/ui/components/motion/animated-list";
import { DecryptText } from "@varada/ui/components/motion/decrypt-text";
import { Dock } from "@varada/ui/components/motion/dock";
import { FlipWords } from "@varada/ui/components/motion/flip-words";
import { InkRippleButton } from "@varada/ui/components/motion/ink-ripple";
import { InkText } from "@varada/ui/components/motion/ink-text";
import { Orbit, OrbitRing } from "@varada/ui/components/motion/orbit";
import { ScrollProgress } from "@varada/ui/components/motion/scroll-progress";
import { ScrollReveal, ScrollWordReveal } from "@varada/ui/components/motion/scroll-reveal";
import { SpotlightCard } from "@varada/ui/components/motion/spotlight-card";
import { TextReveal } from "@varada/ui/components/motion/text-reveal";
import { TiltCard } from "@varada/ui/components/motion/tilt-card";

/* A controllable prefers-reduced-motion, as in motion.test.tsx. */
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
  globalThis.IntersectionObserver ??= class {
    constructor(private cb: IntersectionObserverCallback) {}
    observe(el: Element) {
      this.cb([{ isIntersecting: true, target: el, intersectionRatio: 1 } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
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

beforeEach(() => setReduced(false));

describe("text effects keep the words readable", () => {
  it("TextReveal exposes the sentence once, and renders plain text under reduced motion", () => {
    const { container, unmount } = render(<TextReveal as="h2" text="Every trade funds a cause" />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.querySelector(".sr-only")).toHaveTextContent("Every trade funds a cause");
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    unmount();
    setReduced(true);
    render(<TextReveal as="h2" text="Every trade funds a cause" />);
    const plain = screen.getByRole("heading", { level: 2 });
    expect(plain).toHaveTextContent("Every trade funds a cause");
    expect(plain.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("FlipWords speaks the whole list and stands on the first word under reduced motion", () => {
    setReduced(true);
    const { container } = render(<FlipWords words={["clean water", "wildlife", "hunger relief"]} />);
    expect(container.querySelector(".sr-only")).toHaveTextContent("clean water, wildlife and hunger relief");
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent("clean water");
  });

  it("DecryptText shows the real value at once under reduced motion and says Sealed while sealed", async () => {
    const { rerender, container } = render(<DecryptText sealed>Clean water · 41.2%</DecryptText>);
    expect(screen.getByText("Sealed")).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).not.toHaveTextContent("Clean water");
    setReduced(true);
    rerender(<DecryptText>Clean water · 41.2%</DecryptText>);
    await waitFor(() => expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent("Clean water · 41.2%"));
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent("Clean water · 41.2%");
  });

  it("InkText and ScrollWordReveal render dry, plain text under reduced motion", () => {
    setReduced(true);
    const { container } = render(
      <>
        <InkText>Varada</InkText>
        <ScrollWordReveal text="Ninety percent of every fee goes to the cause." />
        <ScrollReveal>
          <p>Settled card</p>
        </ScrollReveal>
      </>,
    );
    const ink = container.querySelector('[data-slot="ink-text"]') as HTMLElement;
    expect(ink).toHaveTextContent("Varada");
    expect(ink.style.filter).toBe("");
    expect(ink).not.toHaveAttribute("data-wet");
    expect(screen.getByText("Ninety percent of every fee goes to the cause.")).toBeInTheDocument();
    expect(screen.getByText("Settled card")).toBeInTheDocument();
  });
});

describe("ScrollProgress", () => {
  it("is a named progressbar from 0 to 100 in both styles", () => {
    render(
      <>
        <ScrollProgress label="Reading progress" />
        <ScrollProgress label="Ballot progress" variant="brush" />
      </>,
    );
    const bar = screen.getByRole("progressbar", { name: "Reading progress" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar).toHaveAttribute("aria-valuetext", "0% read");
    expect(screen.getByRole("progressbar", { name: "Ballot progress" })).toBeInTheDocument();
  });

  it("tracks a scrollable container", () => {
    function Panel() {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div ref={ref} style={{ height: 100, overflow: "auto" }}>
          <ScrollProgress container={ref} label="Panel progress" />
          <div style={{ height: 400 }} />
        </div>
      );
    }
    render(<Panel />);
    expect(screen.getByRole("progressbar", { name: "Panel progress" })).toHaveAttribute("aria-valuenow", "0");
  });
});

describe("interactive effects", () => {
  it("Dock is a toolbar with roving focus on the arrow keys", () => {
    const actions = ["Trade", "Give", "Vote", "Share"].map((label) => ({ id: label.toLowerCase(), label, icon: <svg aria-hidden="true" /> }));
    render(<Dock label="Quick actions" actions={actions} />);
    expect(screen.getByRole("toolbar", { name: "Quick actions" })).toBeInTheDocument();
    const trade = screen.getByRole("button", { name: "Trade" });
    expect(trade).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: "Give" })).toHaveAttribute("tabindex", "-1");
    act(() => trade.focus());
    fireEvent.keyDown(trade, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Give" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Give" }), { key: "End" });
    expect(screen.getByRole("button", { name: "Share" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Share" })).toHaveAttribute("tabindex", "0");
  });

  it("InkRippleButton drops ink on press and still clicks; a flat tint under reduced motion", () => {
    let clicks = 0;
    const { container, rerender } = render(<InkRippleButton onClick={() => clicks++}>Donate</InkRippleButton>);
    const button = screen.getByRole("button", { name: "Donate" });
    fireEvent.pointerDown(button, { pointerType: "mouse", button: 0, clientX: 10, clientY: 10 });
    fireEvent.click(button);
    expect(clicks).toBe(1);
    expect(container.querySelector("filter")).not.toBeNull();
    setReduced(true);
    rerender(<InkRippleButton onClick={() => clicks++}>Donate</InkRippleButton>);
    expect(container.querySelector("filter")).toBeNull();
  });

  it("AnimatedList is a polite log that keeps at most `max` rows", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `d${i}`, content: <span>Gift {i}</span> }));
    render(<AnimatedList label="Live donations" items={items} max={4} />);
    const log = screen.getByRole("log", { name: "Live donations" });
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log.querySelectorAll("li")).toHaveLength(4);
  });

  it("Orbit names its group and holds still under reduced motion", () => {
    setReduced(true);
    const { container } = render(
      <Orbit label="Causes" center={<span>Mudra</span>}>
        <OrbitRing radius={80}>
          <span>Water</span>
          <span>Wildlife</span>
        </OrbitRing>
      </Orbit>,
    );
    expect(screen.getByRole("group", { name: "Causes" })).toBeInTheDocument();
    expect(container.querySelector('[data-slot="orbit"]')).not.toHaveAttribute("data-running");
    expect(screen.getByText("Wildlife")).toBeInTheDocument();
  });

  it("TiltCard, SpotlightCard and AnimatedBeam render their content (flat under reduced motion)", () => {
    function Flow() {
      const box = useRef<HTMLDivElement>(null);
      const a = useRef<HTMLDivElement>(null);
      const b = useRef<HTMLDivElement>(null);
      return (
        <div ref={box} className="relative">
          <BeamNode ref={a} label="$HARAMBE" />
          <BeamNode ref={b} label="Wildlife pool" />
          <AnimatedBeam containerRef={box} fromRef={a} toRef={b} />
        </div>
      );
    }
    setReduced(true);
    const { container } = render(
      <>
        <TiltCard>
          <p>Tilted</p>
        </TiltCard>
        <SpotlightCard>
          <p>Lit</p>
        </SpotlightCard>
        <Flow />
      </>,
    );
    expect(screen.getByText("Tilted")).toBeInTheDocument();
    expect(screen.getByText("Lit")).toBeInTheDocument();
    expect(screen.getByText("Wildlife pool")).toBeInTheDocument();
    expect(container.querySelector("svg linearGradient")).not.toBeNull();
  });
});
