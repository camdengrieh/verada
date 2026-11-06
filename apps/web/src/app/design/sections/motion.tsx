"use client";
// Written for Varada: gallery for motion and feedback (confetti, loading screen, button hovers,
// drawers, transaction toasts, marquees and the launch wizard).

import { Stepper, type StepperStep } from "@verada/ui/components/data/stepper";
import { ConfettiButton, fireConfetti, useConfetti } from "@verada/ui/components/motion/confetti";
import { LoadingScreen, PageLoader, type LoadingStep } from "@verada/ui/components/motion/loading-screen";
import { Marquee } from "@verada/ui/components/motion/marquee";
import { Badge } from "@verada/ui/components/ui/badge";
import { Button, type ButtonEffect } from "@verada/ui/components/ui/button";
import {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerScaleWrapper,
  DrawerTitle,
  DrawerTrigger,
} from "@verada/ui/components/ui/drawer";
import { ArrowDownUp, Coins, HandHeart, Sparkles, Vote } from "@verada/ui/components/ui/icons";
import { Toaster } from "@verada/ui/components/ui/toaster";
import { CauseChip } from "@verada/ui/components/varada/cause-chip";
import { CauseIcon } from "@verada/ui/components/varada/cause-icon";
import { LogoMark } from "@verada/ui/components/varada/logo-mark";
import { TxToastCard, txToast } from "@verada/ui/components/varada/tx-toast";
import { Wash } from "@verada/ui/components/varada/watercolour";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GallerySection, Specimen } from "../section";

/** Demo toasts go to their own Toaster (top centre) so they land where you're looking. */
const TOASTER = "motion";
const SAMPLE_TX = "https://etherscan.io/tx/0x7f3ac21e9b0d4c1f8e2a6b5d3c9e1f0a7b4d2c8e6f1a3b5c7d9e0f2a4b6c8d0e";

/** setTimeout that clears itself on unmount. */
function useTimers() {
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const list = timers.current;
    return () => list.forEach((t) => window.clearTimeout(t));
  }, []);
  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  const clear = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);
  return { later, clear };
}

/* ─────────────────────────────────────────── launch celebration (wizard) ── */

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line bg-paper px-4 py-3">
      <span className="kicker">{label}</span>
      <span className="text-[15px] font-semibold text-ink">{value}</span>
    </div>
  );
}

const LAUNCH_STEPS: StepperStep[] = [
  {
    id: "token",
    label: "Name and ticker",
    description: "What the coin is called",
    content: (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" value="Harambe Forever" />
        <Field label="Ticker" value={<span className="num">$HARAMBE</span>} />
      </div>
    ),
  },
  {
    id: "cause",
    label: "Pick a cause",
    description: "Where 90% of fees go",
    content: (
      <div className="flex flex-wrap items-center gap-2">
        <CauseChip cause="wildlife" />
        <span className="text-sm text-ink-soft">90% of trading fees fund wildlife rescue.</span>
      </div>
    ),
  },
  {
    id: "liquidity",
    label: "Pick a pair",
    description: "Pair and giving mode",
    content: (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Pair with" value={<span className="num">NVDAon</span>} />
        <Field label="Giving" value={<span>Weekly pool</span>} />
      </div>
    ),
  },
  {
    id: "launch",
    label: "Launch",
    description: "Sign and go live",
    content: <p className="text-[15px] text-ink-soft">Review done. Finish signs the launch transaction.</p>,
  },
];

function LaunchCelebration() {
  const [index, setIndex] = useState(0);
  const [complete, setComplete] = useState(false);
  const [running, setRunning] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const { reduced } = useConfetti();
  const { later, clear } = useTimers();

  const finish = useCallback(() => {
    setRunning(true);
    const id = txToast.pending({ kind: "launch", toasterId: TOASTER, description: "Deploying $HARAMBE and opening its pool" });
    later(() => {
      setComplete(true);
      setRunning(false);
      fireConfetti({ preset: "launch", origin: cardRef.current ?? undefined });
      txToast.success(id, {
        kind: "launch",
        toasterId: TOASTER,
        title: "$HARAMBE is live",
        description: "Your coin is trading. Every trade now funds the cause.",
        icon: <CauseIcon cause="wildlife" size={40} decorative />,
        explorerHref: SAMPLE_TX,
        donation: { amount: "$31.20 USDC", cause: "Wildlife rescue" },
      });
    }, 1600);
  }, [later]);

  const run = () => {
    clear();
    setComplete(false);
    setIndex(0);
    setRunning(true);
    [1, 2, 3].forEach((step, i) => later(() => setIndex(step), 700 * (i + 1)));
    later(finish, 700 * 4);
  };

  const reset = () => {
    clear();
    setRunning(false);
    setComplete(false);
    setIndex(0);
  };

  return (
    <Specimen label="Launch celebration: wizard → confetti → toast" source="Stepper + motion/confetti + varada/tx-toast">
      <div ref={cardRef} className="relative isolate overflow-hidden rounded-2xl border border-line bg-paper p-5 sm:p-6">
        <Wash className="absolute inset-x-0 -top-10 -z-10 h-40 w-full opacity-60" />
        <Stepper
          steps={LAUNCH_STEPS}
          index={index}
          onIndexChange={(i) => setIndex(i)}
          onComplete={finish}
          complete={complete}
          label="Launch progress"
          finishLabel={running ? "Launching…" : "Finish and launch"}
          canAdvance={!running}
          completeContent={
            <div className="flex flex-col gap-3">
              <p className="text-[15px] text-ink-soft">
                <span className="num font-semibold text-ink">$HARAMBE</span> is live. 90% of its trading fees go to wildlife rescue.
              </p>
              {reduced ? (
                <p className="inline-flex items-center gap-2 text-sm text-ink-muted">
                  <Sparkles aria-hidden="true" className="size-4 text-ochre-ink" /> Reduced motion is on, so the confetti stays in the jar.
                </p>
              ) : null}
            </div>
          }
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button effect="wash" onClick={run} disabled={running}>
          <Sparkles aria-hidden="true" /> Run a fake launch
        </Button>
        <Button variant="outline" onClick={reset}>
          Reset
        </Button>
      </div>
    </Specimen>
  );
}

/* ──────────────────────────────────────────────────────────── confetti ── */

function ConfettiTriggers() {
  return (
    <Specimen label="Confetti presets" source="21st.dev @dillionverma/confetti (843) on canvas-confetti">
      <p className="text-sm text-ink-soft">
        Colours come from the theme tokens at runtime. Nothing draws under reduced motion; the button shows a static sparkle instead.
      </p>
      <div className="flex flex-wrap gap-2">
        <ConfettiButton preset="launch">
          <Sparkles aria-hidden="true" /> Launch
        </ConfettiButton>
        <ConfettiButton preset="vote" variant="cause">
          <Vote aria-hidden="true" /> Cast vote
        </ConfettiButton>
        <ConfettiButton preset="donation" variant="outline">
          <HandHeart aria-hidden="true" /> Donate 50 USDC
        </ConfettiButton>
      </div>
      <ul className="grid gap-1 text-sm text-ink-muted">
        <li>
          <strong className="text-ink">launch</strong>: painted-palette burst, side cannons and falling petals
        </li>
        <li>
          <strong className="text-ink">vote</strong>: a few sage and ochre petals that float
        </li>
        <li>
          <strong className="text-ink">donation</strong>: gold coins and hearts
        </li>
      </ul>
    </Specimen>
  );
}

/* ──────────────────────────────────────────────────────── button hovers ── */

const EFFECTS: { effect: ButtonEffect; label: string; note: string }[] = [
  { effect: "wash", label: "Wash", note: "pigment soaks in from the pointer" },
  { effect: "brush", label: "Brush", note: "a stroke paints under the label" },
  { effect: "shine", label: "Shine", note: "a paper sheen crosses once" },
  { effect: "magnetic", label: "Magnetic", note: "leans toward the pointer" },
];

function ButtonEffects() {
  return (
    <Specimen label="Button hover effects" source="Button effect prop · 21st.dev 26022, 4764, 38278, 26725">
      <p className="text-sm text-ink-soft">Hover with a mouse or tab to them (focus triggers the same effect). Off under reduced motion.</p>
      <div className="flex flex-col gap-3">
        {EFFECTS.map(({ effect, label, note }) => (
          <div key={effect} className="flex flex-wrap items-center gap-2">
            <span className="w-full text-sm text-ink-muted sm:w-48">
              <code className="num text-ink">effect=&quot;{effect}&quot;</code> {note}
            </span>
            <Button effect={effect}>{label}</Button>
            <Button effect={effect} variant="cause">
              Vote
            </Button>
            <Button effect={effect} variant="outline">
              Details
            </Button>
          </div>
        ))}
      </div>
    </Specimen>
  );
}

/* ──────────────────────────────────────────────────────── loading screen ── */

const STEP_LABELS = ["Loading configuration", "Connecting privately through Nym…", "Reading the chain"];

function stepsAt(done: number): LoadingStep[] {
  return STEP_LABELS.map((label, i) => ({ id: `s${i}`, label, status: i < done ? "done" : i === done ? "active" : "pending" }));
}

/** Walks through the three start-up steps, then flips ready. */
function useFakeBoot(totalMs: number) {
  const [done, setDone] = useState(0);
  const [ready, setReady] = useState(false);
  const [run, setRun] = useState(0);
  const { later, clear } = useTimers();

  const start = useCallback(() => {
    clear();
    setDone(0);
    setReady(false);
    setRun((r) => r + 1);
    const step = totalMs / 4;
    later(() => setDone(1), step);
    later(() => setDone(2), step * 2);
    later(() => setDone(3), step * 3);
    later(() => setReady(true), totalMs);
  }, [clear, later, totalMs]);

  const finish = useCallback(() => {
    clear();
    setDone(3);
    setReady(true);
  }, [clear]);

  return { steps: stepsAt(done), ready, run, start, finish };
}

function LoadingDemo() {
  const framed = useFakeBoot(3600);
  const full = useFakeBoot(3000);
  const [fullOn, setFullOn] = useState(false);
  const startFramed = framed.start;
  const finishFull = full.finish;

  useEffect(() => {
    startFramed();
  }, [startFramed]);

  useEffect(() => {
    if (!fullOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finishFull();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullOn, finishFull]);

  return (
    <Specimen label="Loading screen" source="21st.dev @kedhareswer/animator-title-preloader (38994) + @gaxocif204/preloader (13967)">
      <p className="text-sm text-ink-soft">
        Shown while the app waits for its config and the Nym private-RPC worker: the mark is sketched, then inked, over a blooming wash.
        When <code className="num">ready</code> flips it lifts away.
      </p>
      <div className="relative isolate h-[24rem] overflow-hidden rounded-2xl border border-line bg-card">
        <div className="grid h-full place-items-center p-6 text-center">
          <div className="flex flex-col items-center gap-2">
            <LogoMark size={40} decorative />
            <p className="font-display text-xl font-semibold">App ready</p>
            <p className="text-sm text-ink-muted">Press Replay to watch it again.</p>
          </div>
        </div>
        <LoadingScreen key={framed.run} fullScreen={false} ready={framed.ready} steps={framed.steps} minVisibleMs={0} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={framed.start}>
          Replay
        </Button>
        <Button
          effect="shine"
          onClick={() => {
            setFullOn(true);
            full.start();
          }}
        >
          Show full screen (3 s)
        </Button>
      </div>
      <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className="kicker">PageLoader · md</span>
          <PageLoader label="Loading ballots" />
        </div>
        <div className="flex flex-col gap-2">
          <span className="kicker">PageLoader · sm</span>
          <PageLoader size="sm" label="Fetching prices" />
        </div>
      </div>
      {fullOn ? (
        <LoadingScreen key={full.run} ready={full.ready} steps={full.steps} minVisibleMs={0} onExited={() => setFullOn(false)}>
          <p className="text-xs text-ink-muted">Demo: press Escape to skip</p>
        </LoadingScreen>
      ) : null}
    </Specimen>
  );
}

/* ─────────────────────────────────────────────────────────────── drawers ── */

function TradeLines() {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {["0.42 ETH → $HARAMBE", "1.1 ETH → $PEPEWISH", "0.08 ETH → $GIVEDOGE", "2.0 ETH → $HARAMBE", "0.3 ETH → $MUDRA", "0.9 ETH → $GIVEDOGE", "0.05 ETH → $PEPEWISH", "1.6 ETH → $HARAMBE"].map(
        (t) => (
          <li key={t} className="flex items-center justify-between py-3 text-[15px]">
            <span className="num">{t}</span>
            <span className="text-sm text-gain">▲ filled</span>
          </li>
        ),
      )}
    </ul>
  );
}

function DrawerDemos() {
  return (
    <Specimen label="Drawer variants" source="ui/drawer on vaul · 21st.dev @wensity/drawer (31360), @coss.com/drawer (11442)">
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-3">
          <span className="kicker">Scaled background</span>
          <DrawerScaleWrapper className="min-h-0 rounded-2xl border border-line bg-paper p-4">
            <div className="flex flex-col gap-2">
              <span className="font-display text-lg font-semibold">$HARAMBE</span>
              <span className="num text-sm text-ink-soft">0.000042 ETH · ▲ 12.4%</span>
              <Drawer shouldScaleBackground>
                <DrawerTrigger asChild>
                  <Button>
                    <ArrowDownUp aria-hidden="true" /> Trade
                  </Button>
                </DrawerTrigger>
                <DrawerContent>
                  <DrawerHeader>
                    <DrawerTitle>Trade $HARAMBE</DrawerTitle>
                    <DrawerDescription>The page behind steps back while this is open.</DrawerDescription>
                  </DrawerHeader>
                  <DrawerBody>
                    <p className="text-[15px] text-ink-soft">Swap form goes here.</p>
                  </DrawerBody>
                  <DrawerFooter>
                    <DrawerClose asChild>
                      <Button effect="wash">Review swap</Button>
                    </DrawerClose>
                  </DrawerFooter>
                </DrawerContent>
              </Drawer>
            </div>
          </DrawerScaleWrapper>
          <p className="text-xs text-ink-muted">
            Here the framed card is the <code className="num">DrawerScaleWrapper</code>; in the app it wraps the whole page.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <span className="kicker">Snap points</span>
          <Drawer snapPoints={[0.45, 1]}>
            <DrawerTrigger asChild>
              <Button variant="outline">Recent trades</Button>
            </DrawerTrigger>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>Recent trades</DrawerTitle>
                <DrawerDescription>Opens part-way; drag the handle up for the full list.</DrawerDescription>
              </DrawerHeader>
              <DrawerBody>
                <TradeLines />
              </DrawerBody>
            </DrawerContent>
          </Drawer>
          <p className="text-xs text-ink-muted">
            <code className="num">snapPoints={"{[0.45, 1]}"}</code>: stops at 45% of the screen, then full height.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <span className="kicker">Paper</span>
          <Drawer>
            <DrawerTrigger asChild>
              <Button variant="cause">
                <HandHeart aria-hidden="true" /> Give directly
              </Button>
            </DrawerTrigger>
            <DrawerContent variant="paper">
              <DrawerHeader>
                <DrawerTitle>Give to Wildlife rescue</DrawerTitle>
                <DrawerDescription>A torn cotton-paper edge and a wash behind the header.</DrawerDescription>
              </DrawerHeader>
              <DrawerBody>
                <p className="text-[15px] text-ink-soft">100% of a direct gift goes to the cause&apos;s vault.</p>
              </DrawerBody>
              <DrawerFooter>
                <DrawerClose asChild>
                  <ConfettiButton preset="donation" variant="cause">
                    Donate 50 USDC
                  </ConfettiButton>
                </DrawerClose>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>
          <p className="text-xs text-ink-muted">
            <code className="num">variant=&quot;paper&quot;</code>; every sheet now springs in and its sections settle after it.
          </p>
        </div>
      </div>
    </Specimen>
  );
}

/* ──────────────────────────────────────────────────────────────── toasts ── */

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function ToastShowcase() {
  const { later } = useTimers();

  const swap = () => {
    const id = txToast.pending({ kind: "swap", toasterId: TOASTER, description: "0.5 ETH for $HARAMBE" });
    later(
      () =>
        txToast.success(id, {
          kind: "swap",
          toasterId: TOASTER,
          description: "You got 11,904,761 $HARAMBE.",
          explorerHref: SAMPLE_TX,
          donation: { amount: "$11.70 USDC", cause: "Wildlife rescue", icon: <CauseIcon cause="wildlife" size={20} decorative /> },
        }),
      1800,
    );
  };
  const vote = () => {
    const id = txToast.pending({ kind: "vote", toasterId: TOASTER, description: "Epoch 12 · encrypted ballot" });
    later(() => txToast.success(id, { kind: "vote", toasterId: TOASTER, description: "Your choice stays private until the tally.", confetti: "vote" }), 1500);
  };
  const failed = () => {
    txToast.error(undefined, {
      kind: "swap",
      toasterId: TOASTER,
      description: "Price moved more than your 0.5% slippage.",
      onRetry: swap,
    });
  };
  const promised = () => {
    void txToast.promise(wait(2200).then(() => "$MUDRA"), {
      kind: "launch",
      toasterId: TOASTER,
      pending: { description: "Deploying and opening the pool" },
      success: (ticker) => ({
        title: `${ticker} is live`,
        icon: <CauseIcon cause="water" size={40} decorative />,
        donation: { amount: "$26.00 USDC", cause: "Clean water" },
        explorerHref: SAMPLE_TX,
        confetti: "launch",
      }),
    });
  };

  return (
    <Specimen label="Transaction toasts" source="varada/tx-toast · 21st.dev @shadcnspace/sonner-05 (19146), @cnippet-dev/promise-toast (24420)">
      <p className="text-sm text-ink-soft">
        One toast per transaction, updated in place from pending to success or error. These demos post to a Toaster at the top of the
        screen.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button effect="wash" onClick={swap}>
          <ArrowDownUp aria-hidden="true" /> Swap: pending → success
        </Button>
        <Button effect="wash" variant="cause" onClick={vote}>
          <Vote aria-hidden="true" /> Vote with petals
        </Button>
        <Button variant="outline" onClick={failed}>
          Failed swap
        </Button>
        <Button variant="soft" onClick={promised}>
          <Coins aria-hidden="true" /> Promise helper
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <TxToastCard state="pending" kind="swap" description="0.5 ETH for $HARAMBE" />
        <TxToastCard
          state="success"
          kind="launch"
          title="$HARAMBE is live"
          icon={<CauseIcon cause="wildlife" size={40} decorative />}
          donation={{ amount: "$31.20 USDC", cause: "Wildlife rescue" }}
          link={
            <a href={SAMPLE_TX} rel="noopener noreferrer" target="_blank" className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline">
              View on Etherscan<span className="sr-only"> (opens in a new tab)</span>
            </a>
          }
        />
        <TxToastCard state="error" kind="vote" description="The ballot closed before your vote landed." onRetry={() => {}} />
      </div>
    </Specimen>
  );
}

/* ────────────────────────────────────────────────────────────── marquees ── */

const TICKS = [
  { t: "$HARAMBE", v: "▲ 12.4%", up: true },
  { t: "$PEPEWISH", v: "▼ 3.1%", up: false },
  { t: "$GIVEDOGE", v: "▲ 41.0%", up: true },
  { t: "$MUDRA", v: "▲ 6.8%", up: true },
  { t: "$WAGMI4KIDS", v: "▼ 0.9%", up: false },
];

const GIFTS = ["$109 USDC to Wildlife rescue", "$806 USDC to Clean water", "$21 USDC to Hunger relief", "$3,120 USDC to Disaster relief", "$182 USDC to Education"];

function MarqueeShowcase() {
  return (
    <Specimen label="Marquees" source="motion/marquee · 21st.dev @kevingirelli/marquee (35200)">
      <p className="text-sm text-ink-soft">Pauses on hover and on focus within; stands still as a scroll row under reduced motion.</p>
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-paper py-3">
        <Marquee label="Price ticker" duration={28} gap="0.75rem">
          {TICKS.map((x) => (
            <span key={x.t} className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3.5 py-1.5 text-sm">
              <span className="num font-semibold">{x.t}</span>
              <span className={x.up ? "text-gain" : "text-loss"}>
                {x.v}
                <span className="sr-only">{x.up ? " up" : " down"}</span>
              </span>
            </span>
          ))}
        </Marquee>
        <Marquee label="Donations" direction="right" duration={36} gap="0.75rem">
          {GIFTS.map((g) => (
            <Badge key={g} tone="cause" className="gap-1.5 px-3 py-1.5 text-sm">
              <HandHeart aria-hidden="true" className="size-4" /> {g}
            </Badge>
          ))}
        </Marquee>
      </div>
    </Specimen>
  );
}

/* ────────────────────────────────────────────────────────────── section ── */

export function MotionSection() {
  return (
    <GallerySection
      id="motion"
      title="Motion and feedback"
      intro="Confetti, the start-up loading screen, signature button hovers, drawers, transaction toasts and marquees. Everything here respects prefers-reduced-motion."
    >
      <Toaster id={TOASTER} position="top-center" />
      <LaunchCelebration />
      <div className="grid gap-4 lg:grid-cols-2">
        <ConfettiTriggers />
        <ButtonEffects />
      </div>
      <LoadingDemo />
      <DrawerDemos />
      <ToastShowcase />
      <MarqueeShowcase />
    </GallerySection>
  );
}
