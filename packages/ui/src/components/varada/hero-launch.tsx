// Sticker cluster on pointer parallax adapted from 21st.dev @danielpetho/parallax-floating (id 1332,
// demo 656): images scattered at set spots, each drifting by its own depth, fading in one by one.
// Copy entrance from @ravikatiyar162/hero-section-9 (id 5921). Three-step preview written for Varada.
"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { Divider } from "@verada/ui/components/ui/divider";
import { cn } from "@verada/ui/lib/utils";
import {
  DriftingWash,
  HeroActions,
  HeroHeading,
  HighlightedHeadline,
  Parallax,
  ParallaxLayer,
  useHeroEntrance,
  type HeroAction,
  type HeroHeadingLevel,
} from "./hero-shared";
import type { LinkComponent } from "./shared";
import { PaperGrain } from "./watercolour";

export interface LaunchStep {
  title: string;
  body: ReactNode;
}

export const DEFAULT_LAUNCH_STEPS: LaunchStep[] = [
  { title: "Name it", body: "Pick a ticker and claim <label>.varada.eth. Your coin's site goes live on Swarm with it." },
  { title: "Choose how it gives", body: "A cause focus, then a weekly pool holders vote on, or live donations that rotate charities." },
  { title: "Launch", body: "Liquidity seeds on Uniswap. From the first trade, 90% of every fee goes to charity." },
];

export interface HeroLaunchProps extends Omit<ComponentProps<"section">, "children"> {
  kicker?: string;
  headline?: string;
  highlight?: string;
  lead?: ReactNode;
  /** Cut-out sticker art (PaintedImage), up to four. */
  stickers: ReactNode[];
  steps?: LaunchStep[];
  actions?: HeroAction[];
  headingLevel?: HeroHeadingLevel;
  LinkComponent?: LinkComponent;
}

// Spots for up to four stickers: position, size, tilt and parallax depth.
const SPOTS = [
  { className: "left-[4%] top-[6%] w-[44%] -rotate-6", depth: 0.6 },
  { className: "right-[2%] top-[2%] w-[38%] rotate-6", depth: 1.4 },
  { className: "bottom-[4%] left-[14%] w-[36%] rotate-3", depth: 1.9 },
  { className: "bottom-[8%] right-[6%] w-[40%] -rotate-3", depth: 1 },
];

/** Invitation to launch: sticker art scattered on the paper, a painted headline, and the three steps ahead. */
export function HeroLaunch({
  kicker = "Launch",
  headline = "Launch a coin that gives",
  highlight = "gives",
  lead = "It takes a few minutes and one transaction. No code, no presale: a fair launch with the giving built in.",
  stickers,
  steps = DEFAULT_LAUNCH_STEPS,
  actions = [],
  headingLevel = 1,
  LinkComponent,
  className,
  ...props
}: HeroLaunchProps) {
  const titleId = `hero-launch-${useId().replace(/:/g, "")}`;
  const stepsId = `${titleId}-steps`;
  const reduced = useReducedMotion();
  const { container, item } = useHeroEntrance();
  return (
    <section
      data-slot="hero-launch"
      aria-labelledby={titleId}
      className={cn("@container relative isolate overflow-hidden rounded-[32px] border border-line bg-paper", className)}
      {...props}
    >
      <DriftingWash
        seed={12}
        blobs={[
          { cx: 460, cy: 70, rx: 200, ry: 90, color: "var(--terracotta)", opacity: 0.16 },
          { cx: 150, cy: 150, rx: 190, ry: 70, color: "var(--ochre)", opacity: 0.2 },
        ]}
      />
      <PaperGrain className="-z-10" />
      <div className="grid gap-8 p-5 @lg:p-8 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] @4xl:items-center @4xl:p-12">
        <motion.div className="flex min-w-0 flex-col gap-5" {...container}>
          <motion.span className="kicker" {...item}>
            {kicker}
          </motion.span>
          <motion.div {...item}>
            <HeroHeading id={titleId} level={headingLevel} className="text-[2.5rem] leading-[1.02] @md:text-5xl @2xl:text-6xl">
              <HighlightedHeadline text={headline} highlight={highlight} color="var(--terracotta)" />
            </HeroHeading>
          </motion.div>
          {lead ? (
            <motion.div className="max-w-xl text-[17px] leading-relaxed text-ink-soft" {...item}>
              {lead}
            </motion.div>
          ) : null}
          <motion.div {...item}>
            <HeroActions actions={actions} LinkComponent={LinkComponent} />
          </motion.div>
          <motion.div className="flex flex-col gap-3" {...item}>
            <Divider variant="brush" label={<span id={stepsId}>Three steps</span>} />
            <ol aria-labelledby={stepsId} className="m-0 grid list-none gap-3 p-0 @2xl:grid-cols-3">
              {steps.map((s, i) => (
                <li key={s.title} className="flex gap-3 rounded-2xl border border-line bg-card/80 p-3 @2xl:flex-col">
                  <span aria-hidden="true" className="num grid size-8 shrink-0 place-items-center rounded-full bg-ink text-sm font-bold text-paper">
                    {i + 1}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[15px] font-semibold text-ink">
                      <span className="sr-only">Step {i + 1}: </span>
                      {s.title}
                    </span>
                    <span className="text-sm leading-relaxed text-ink-soft">{s.body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </motion.div>
        </motion.div>

        <Parallax className="relative mx-auto aspect-square w-full max-w-md">
          {stickers.slice(0, 4).map((s, i) => {
            const spot = SPOTS[i]!;
            return (
              <ParallaxLayer key={i} depth={spot.depth} className={cn("absolute", spot.className)}>
                <motion.div
                  className="overflow-hidden rounded-[22px] border-[5px] border-paper-card bg-sand shadow-float [&_img]:block [&_img]:h-auto [&_img]:w-full"
                  initial={reduced ? false : { opacity: 0, scale: 0.85, y: 12 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ type: "spring", stiffness: 220, damping: 18, delay: reduced ? 0 : 0.25 + i * 0.15 }}
                  whileHover={reduced ? undefined : { scale: 1.04, rotate: i % 2 ? -2 : 2 }}
                >
                  {s}
                </motion.div>
              </ParallaxLayer>
            );
          })}
        </Parallax>
      </div>
    </section>
  );
}
