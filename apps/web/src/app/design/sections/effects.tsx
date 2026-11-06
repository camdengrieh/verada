"use client";
// Written for Varada: gallery for the paper-and-pigment motion effects adapted from 21st.dev
// (text reveals, ink, decrypting tallies, beams, orbits, live lists, tilt and spotlight cards,
// the quick-action dock, ink ripples and scroll effects).

import { AnimatedBeam, BeamNode } from "@varada/ui/components/motion/animated-beam";
import { AnimatedList, type AnimatedListItem } from "@varada/ui/components/motion/animated-list";
import { DecryptText } from "@varada/ui/components/motion/decrypt-text";
import { Dock, type DockAction } from "@varada/ui/components/motion/dock";
import { FlipWords } from "@varada/ui/components/motion/flip-words";
import { InkRippleButton } from "@varada/ui/components/motion/ink-ripple";
import { InkText } from "@varada/ui/components/motion/ink-text";
import { Orbit, OrbitRing } from "@varada/ui/components/motion/orbit";
import { ScrollProgress } from "@varada/ui/components/motion/scroll-progress";
import { ScrollReveal, ScrollWordReveal } from "@varada/ui/components/motion/scroll-reveal";
import { SpotlightCard } from "@varada/ui/components/motion/spotlight-card";
import { TextReveal } from "@varada/ui/components/motion/text-reveal";
import { TiltCard } from "@varada/ui/components/motion/tilt-card";
import { Button } from "@varada/ui/components/ui/button";
import { Divider } from "@varada/ui/components/ui/divider";
import { ArrowDownUp, Bell, Copy, HandHeart, Search, Sparkles, Vote } from "@varada/ui/components/ui/icons";
import { CAUSE_SHORT_LABELS, CauseIcon, type CauseName } from "@varada/ui/components/varada/cause-icon";
import { LogoMark } from "@varada/ui/components/varada/logo-mark";
import { Wash } from "@varada/ui/components/varada/watercolour";
import { useEffect, useRef, useState } from "react";
import { GallerySection, Specimen } from "../section";

/* ────────────────────────────────────────────────────────────── type ── */

function Headlines() {
  const [replay, setReplay] = useState(0);
  return (
    <Specimen label="Text reveal, flip words and ink" source="21st.dev @kuratlielia/text-reveal (35037), @manuarora700/flip-words (1137), @arihantcodes/ink (18211)">
      <div key={replay} className="relative isolate flex flex-col gap-4 overflow-hidden rounded-2xl border border-line bg-paper p-6">
        <Wash className="absolute inset-x-0 -top-8 -z-10 h-36 w-full opacity-50" />
        <TextReveal as="h3" text="Launch a memecoin that gives back" className="font-display text-3xl font-semibold sm:text-4xl" />
        <p className="text-xl text-ink-soft">
          Every trade funds <FlipWords words={["clean water", "wildlife rescue", "hunger relief", "medical research"]} className="font-semibold text-ink" />
        </p>
        <InkText as="p" className="font-display text-5xl font-extrabold tracking-tight sm:text-6xl" replay={replay}>
          Varada
        </InkText>
      </div>
      <div>
        <Button variant="outline" onClick={() => setReplay((r) => r + 1)}>
          Replay
        </Button>
      </div>
    </Specimen>
  );
}

const TALLY: { cause: CauseName; share: string }[] = [
  { cause: "water", share: "41.2%" },
  { cause: "wildlife", share: "33.7%" },
  { cause: "hunger", share: "25.1%" },
];

function TallyReveal() {
  const [sealed, setSealed] = useState(true);
  return (
    <Specimen label="Decrypting the tally" source="21st.dev @dqnamo/scramble-text (16620)">
      <p className="text-sm text-ink-soft">Ballots are counted while encrypted. When the epoch closes, the result decrypts in place.</p>
      <ol className="flex flex-col rounded-2xl border border-line bg-paper px-4">
        {TALLY.map((t, i) => (
          <li key={t.cause} className="flex flex-col">
            {i > 0 ? <Divider variant="dashed" /> : null}
            <div className="flex min-h-14 items-center gap-3">
              <CauseIcon cause={t.cause} size={36} decorative />
              <span className="flex-1 font-semibold text-ink">{CAUSE_SHORT_LABELS[t.cause]}</span>
              <DecryptText sealed={sealed} className="num text-lg font-semibold text-ink">
                {t.share}
              </DecryptText>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="cause" onClick={() => setSealed(false)} disabled={!sealed}>
          <Vote aria-hidden="true" /> Close epoch 12
        </Button>
        <Button variant="outline" onClick={() => setSealed(true)} disabled={sealed}>
          Seal again
        </Button>
      </div>
    </Specimen>
  );
}

/* ─────────────────────────────────────────────────────────────── flow ── */

function MoneyFlow() {
  const box = useRef<HTMLDivElement>(null);
  const coinA = useRef<HTMLDivElement>(null);
  const coinB = useRef<HTMLDivElement>(null);
  const coinC = useRef<HTMLDivElement>(null);
  const pool = useRef<HTMLDivElement>(null);
  const charity = useRef<HTMLDivElement>(null);
  return (
    <Specimen label="Animated beam: coin → cause → charity" source="21st.dev @dillionverma/animated-beam (919)">
      <div ref={box} className="relative flex items-center justify-between gap-4 overflow-hidden rounded-2xl border border-line bg-paper px-4 py-8 sm:px-10">
        <div className="flex flex-col gap-6">
          <BeamNode ref={coinA} label="$HARAMBE">
            <span className="num text-xs font-bold">HRB</span>
          </BeamNode>
          <BeamNode ref={coinB} label="$GIVEDOGE">
            <span className="num text-xs font-bold">GDG</span>
          </BeamNode>
          <BeamNode ref={coinC} label="$MUDRA">
            <span className="num text-xs font-bold">MDR</span>
          </BeamNode>
        </div>
        <BeamNode ref={pool} label="Wildlife pool" className="size-20 border-sage">
          <CauseIcon cause="wildlife" size={64} decorative />
        </BeamNode>
        <BeamNode ref={charity} label="Charity vault">
          <HandHeart aria-hidden="true" className="size-6 text-sage-ink" />
        </BeamNode>
        <AnimatedBeam containerRef={box} fromRef={coinA} toRef={pool} curvature={40} />
        <AnimatedBeam containerRef={box} fromRef={coinB} toRef={pool} delay={0.6} />
        <AnimatedBeam containerRef={box} fromRef={coinC} toRef={pool} curvature={-40} delay={1.2} />
        <AnimatedBeam containerRef={box} fromRef={pool} toRef={charity} startColor="var(--sage)" endColor="var(--ochre)" duration={2.6} width={4} />
      </div>
      <p className="text-sm text-ink-muted">Fees from each coin flow into the cause pool; at the end of the epoch the pool pays the charity.</p>
    </Specimen>
  );
}

const ORBIT_INNER: CauseName[] = ["water", "wildlife", "hunger", "education"];
const ORBIT_OUTER: CauseName[] = ["disaster", "children", "environment", "health", "refugees", "animals"];

function CauseOrbit() {
  return (
    <Specimen label="Orbit: causes around the mudra" source="21st.dev @dillionverma/orbiting-circles (1411)">
      <div className="relative isolate overflow-hidden rounded-2xl border border-line bg-paper py-4">
        <Orbit
          size={300}
          label="Causes on Varada"
          center={
            <span className="grid size-20 place-items-center rounded-full bg-paper-card shadow-float">
              <LogoMark size={52} />
            </span>
          }
        >
          <OrbitRing radius={78} duration={26}>
            {ORBIT_INNER.map((c) => (
              <CauseIcon key={c} cause={c} size={40} label={CAUSE_SHORT_LABELS[c]} className="rounded-full shadow-paper" />
            ))}
          </OrbitRing>
          <OrbitRing radius={132} duration={40} reverse offset={20}>
            {ORBIT_OUTER.map((c) => (
              <CauseIcon key={c} cause={c} size={36} label={CAUSE_SHORT_LABELS[c]} className="rounded-full shadow-paper" />
            ))}
          </OrbitRing>
        </Orbit>
      </div>
      <p className="text-sm text-ink-muted">Pauses while you point at it, and when it scrolls away.</p>
    </Specimen>
  );
}

/* ───────────────────────────────────────────────────────────── live list ── */

const GIFTS: { coin: string; cause: CauseName; amount: string }[] = [
  { coin: "$HARAMBE", cause: "wildlife", amount: "$12.40" },
  { coin: "$SPLASH", cause: "water", amount: "$3.10" },
  { coin: "$GIVEDOGE", cause: "animals", amount: "$28.75" },
  { coin: "$MUDRA", cause: "education", amount: "$6.02" },
  { coin: "$BREADLINE", cause: "hunger", amount: "$41.00" },
  { coin: "$SANDBAG", cause: "disaster", amount: "$9.66" },
];

function Gift({ coin, cause, amount, ago }: { coin: string; cause: CauseName; amount: string; ago: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-paper-card px-4 py-3 shadow-paper">
      <CauseIcon cause={cause} size={36} decorative />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-semibold text-ink">
          <span className="num">{amount}</span> to {CAUSE_SHORT_LABELS[cause]}
        </span>
        <span className="text-xs text-ink-muted">
          from <span className="num">{coin}</span> fees · {ago}
        </span>
      </div>
    </div>
  );
}

function LiveDonations() {
  const [items, setItems] = useState<AnimatedListItem[]>(() =>
    GIFTS.slice(0, 3).map((g, i) => ({ id: `seed-${i}`, content: <Gift {...g} ago={`${(i + 1) * 4}s ago`} /> })),
  );
  const [running, setRunning] = useState(true);
  const n = useRef(3);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      const g = GIFTS[n.current % GIFTS.length]!;
      const id = `gift-${n.current}`;
      n.current += 1;
      setItems((list) => [{ id, content: <Gift {...g} ago="just now" /> }, ...list].slice(0, 8));
    }, 2600);
    return () => window.clearInterval(t);
  }, [running]);
  return (
    <Specimen label="Animated list: live donations" source="21st.dev @dillionverma/animated-list (869), @unlumen/unlumen-animated-list (38150)">
      <div className="h-[22rem] overflow-hidden rounded-2xl border border-line bg-paper p-4">
        <AnimatedList label="Live donations" items={items} max={4} />
      </div>
      <div>
        <Button variant="outline" onClick={() => setRunning((r) => !r)} aria-pressed={!running}>
          {running ? "Pause feed" : "Resume feed"}
        </Button>
      </div>
    </Specimen>
  );
}

/* ──────────────────────────────────────────────────────────── surfaces ── */

function Cards() {
  return (
    <Specimen label="Tilt and spotlight cards" source="21st.dev @tom_ui/tilt-card (12244), @kevingirelli/spotlight (35180)">
      <div className="grid gap-4 sm:grid-cols-2">
        <TiltCard className="rounded-3xl border border-line bg-paper-card p-6">
          <div className="flex items-center gap-3">
            <CauseIcon cause="wildlife" size={48} decorative />
            <div className="flex flex-col">
              <span className="font-display text-xl font-semibold">$HARAMBE</span>
              <span className="text-sm text-ink-muted">Harambe Forever · Wildlife</span>
            </div>
          </div>
          <Divider variant="brush" className="my-4" />
          <div className="flex justify-between text-[15px]">
            <span className="text-ink-soft">Given so far</span>
            <span className="num font-semibold text-sage-ink">$31,204</span>
          </div>
          <p className="mt-3 text-xs text-ink-muted">Tilt: the sheet tips toward your pointer.</p>
        </TiltCard>
        <div className="grid gap-4">
          {(
            [
              ["water", "var(--sky)"],
              ["hunger", "var(--ochre)"],
            ] as const
          ).map(([cause, pigment]) => (
            <SpotlightCard key={cause} pigment={pigment} className="rounded-2xl border border-line bg-paper-card p-5">
              <div className="flex items-center gap-3">
                <CauseIcon cause={cause} size={40} decorative />
                <div className="flex flex-col">
                  <span className="font-semibold text-ink">{CAUSE_SHORT_LABELS[cause]}</span>
                  <span className="text-sm text-ink-muted">Pigment blooms where you point</span>
                </div>
              </div>
            </SpotlightCard>
          ))}
        </div>
      </div>
    </Specimen>
  );
}

const ACTIONS: DockAction[] = [
  { id: "trade", label: "Trade", icon: <ArrowDownUp aria-hidden="true" />, tone: "terracotta" },
  { id: "give", label: "Give directly", icon: <HandHeart aria-hidden="true" />, tone: "sage" },
  { id: "vote", label: "Vote", icon: <Vote aria-hidden="true" />, tone: "ochre" },
  { id: "find", label: "Find a coin", icon: <Search aria-hidden="true" />, tone: "sky" },
  { id: "alerts", label: "Price alerts", icon: <Bell aria-hidden="true" />, tone: "ink" },
  { id: "copy", label: "Copy contract", icon: <Copy aria-hidden="true" />, tone: "terracotta" },
];

function QuickActions() {
  const [last, setLast] = useState<string | null>(null);
  return (
    <Specimen label="Dock and ink ripples" source="21st.dev @rmahammad/magnetic-dock (23415), @ddoemonn/ripple (23551)">
      <Dock label="Quick actions" actions={ACTIONS.map((a) => ({ ...a, onSelect: () => setLast(a.label) }))} />
      <p className="text-center text-sm text-ink-muted" aria-live="polite">
        {last ? `Picked: ${last}` : "Sweep across it, or tab in and use the arrow keys."}
      </p>
      <Divider label="Ink ripple" />
      <div className="flex flex-wrap justify-center gap-2">
        <InkRippleButton>
          <Sparkles aria-hidden="true" /> Launch
        </InkRippleButton>
        <InkRippleButton variant="cause">
          <HandHeart aria-hidden="true" /> Donate 50 USDC
        </InkRippleButton>
        <InkRippleButton variant="outline" ink="var(--terracotta)">
          Details
        </InkRippleButton>
      </div>
    </Specimen>
  );
}

/* ─────────────────────────────────────────────────────────────── scroll ── */

function ScrollEffects() {
  const panel = useRef<HTMLDivElement>(null);
  return (
    <Specimen label="Scroll progress and word reveal" source="21st.dev @cnippet-dev/scroll-progress (18717), @motiondotdev/motion-scroll-word-reveal (24525)">
      <div className="overflow-hidden rounded-2xl border border-line bg-paper">
        <div className="border-b border-line bg-paper-card px-4 py-3">
          <ScrollProgress container={panel} variant="brush" label="Reading the manifesto" />
        </div>
        <div ref={panel} tabIndex={0} aria-label="Manifesto" className="h-72 overflow-y-auto px-6 py-8 outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/35">
          <div className="flex flex-col gap-10 pb-24">
            <span className="kicker">Scroll inside this panel</span>
            <ScrollWordReveal
              container={panel}
              className="font-display text-2xl font-semibold leading-snug"
              text="Memecoins are a game. Varada makes the game give: ninety percent of every trading fee goes to a cause, and holders choose which one, in private."
            />
            {["Launch", "Trade", "Vote"].map((step, i) => (
              <ScrollReveal key={step} delay={i * 0.05} className="rounded-2xl border border-line bg-paper-card p-5 shadow-paper">
                <span className="kicker">Step {i + 1}</span>
                <p className="mt-1 font-display text-lg font-semibold">{step}</p>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="kicker">Bar style</span>
        <ScrollProgress label="Page progress" />
        <p className="text-xs text-ink-muted">This one follows the whole page; in the app it would sit fixed at the top.</p>
      </div>
    </Specimen>
  );
}

/* ────────────────────────────────────────────────────────────── section ── */

export function EffectsSection() {
  return (
    <GallerySection
      id="effects"
      title="Effects"
      intro="Motion adapted from 21st.dev and repainted for paper and pigment: ink that soaks in, tallies that decrypt, money that flows. Under reduced motion each one shows its finished state."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Headlines />
        <TallyReveal />
      </div>
      <MoneyFlow />
      <div className="grid gap-4 lg:grid-cols-2">
        <CauseOrbit />
        <LiveDonations />
      </div>
      <Cards />
      <QuickActions />
      <ScrollEffects />
    </GallerySection>
  );
}
