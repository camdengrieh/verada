// Adapted from 21st.dev @ravikatiyar162/hero-section-9 (id 5921, demo 8737): two-column hero with a
// staggered copy entrance, actions and a social-proof stats row, plus floating accents around the art.
// The art floats on pointer parallax (21st.dev @danielpetho/parallax-floating, id 1332) over a
// drifting watercolour wash. Container queries make it fit any column, down to 360px.
"use client";

import { motion } from "motion/react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { Badge } from "@varada/ui/components/ui/badge";
import { cn } from "@varada/ui/lib/utils";
import { FeeSplitBar } from "./fee-split-bar";
import {
  DriftingWash,
  HeroActions,
  HeroHeading,
  HeroStats,
  HighlightedHeadline,
  Parallax,
  ParallaxLayer,
  useHeroEntrance,
  type HeroAction,
  type HeroHeadingLevel,
  type HeroStat,
} from "./hero-shared";
import type { LinkComponent } from "./shared";
import { PaperGrain } from "./watercolour";

export interface HeroHomeProps extends Omit<ComponentProps<"section">, "children"> {
  kicker?: string;
  headline: string;
  /** Word or phrase in the headline that gets the brush underline. */
  highlight?: string;
  lead?: ReactNode;
  /** Painted scene (PaintedImage with `priority`). */
  art: ReactNode;
  /** Small accents that float over the art (stickers, chips). */
  accents?: ReactNode[];
  actions?: HeroAction[];
  stats?: HeroStat[];
  /** Show the 90/10 split under the copy. */
  showSplit?: boolean;
  headingLevel?: HeroHeadingLevel;
  LinkComponent?: LinkComponent;
}

const ACCENT_SPOTS = ["-left-3 top-6 -rotate-6", "-right-2 top-1/3 rotate-3", "bottom-6 left-6 rotate-2", "-bottom-3 right-10 -rotate-3"];

/** The home page hero: painted scene, headline with a brush stroke, the money split, actions and live stats. */
export function HeroHome({
  kicker = "Memecoins that give",
  headline,
  highlight,
  lead,
  art,
  accents = [],
  actions = [],
  stats = [],
  showSplit = true,
  headingLevel = 1,
  LinkComponent,
  className,
  ...props
}: HeroHomeProps) {
  const titleId = `hero-home-${useId().replace(/:/g, "")}`;
  const { container, item } = useHeroEntrance();
  return (
    <section
      data-slot="hero-home"
      aria-labelledby={titleId}
      className={cn("@container relative isolate overflow-hidden rounded-[32px] border border-line bg-paper", className)}
      {...props}
    >
      <DriftingWash
        blobs={[
          { cx: 120, cy: 40, rx: 170, ry: 70, color: "var(--ochre)", opacity: 0.22 },
          { cx: 470, cy: 60, rx: 190, ry: 90, color: "var(--sky)", opacity: 0.25 },
          { cx: 330, cy: 190, rx: 220, ry: 60, color: "var(--sage)", opacity: 0.2 },
        ]}
      />
      <PaperGrain className="-z-10" />
      <div className="grid gap-8 p-5 @lg:p-8 @4xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] @4xl:items-center @4xl:gap-10 @4xl:p-12">
        <motion.div className="flex min-w-0 flex-col gap-5" {...container}>
          <motion.div {...item}>
            <Badge tone="cause" shape="pill" dot>
              {kicker}
            </Badge>
          </motion.div>
          <motion.div {...item}>
            <HeroHeading id={titleId} level={headingLevel} className="text-[2.5rem] leading-[1.02] @md:text-5xl @2xl:text-6xl @5xl:text-7xl">
              <HighlightedHeadline text={headline} highlight={highlight} />
            </HeroHeading>
          </motion.div>
          {lead ? (
            <motion.div {...item} className="max-w-xl text-[17px] leading-relaxed text-ink-soft @2xl:text-lg">
              {lead}
            </motion.div>
          ) : null}
          {showSplit ? (
            <motion.div {...item} className="max-w-md">
              <FeeSplitBar causeLabel="to charity" platformLabel="platform" />
            </motion.div>
          ) : null}
          <motion.div {...item}>
            <HeroActions actions={actions} LinkComponent={LinkComponent} />
          </motion.div>
          {stats.length ? (
            <motion.div {...item}>
              <HeroStats stats={stats} />
            </motion.div>
          ) : null}
        </motion.div>

        <Parallax className="mx-auto w-full max-w-xl">
          <ParallaxLayer depth={-0.6}>
            <div className="relative overflow-hidden rounded-[28px] border-[6px] border-paper-card bg-sand shadow-float [&_img]:block [&_img]:h-auto [&_img]:w-full">
              {art}
            </div>
          </ParallaxLayer>
          {accents.slice(0, 4).map((a, i) => (
            <ParallaxLayer key={i} depth={1 + i * 0.5} className={cn("absolute", ACCENT_SPOTS[i])}>
              {a}
            </ParallaxLayer>
          ))}
        </Parallax>
      </div>
    </section>
  );
}
