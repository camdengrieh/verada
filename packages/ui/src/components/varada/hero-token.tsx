// Layout and entrance adapted from 21st.dev @ravikatiyar162/hero-section-9 (id 5921, demo 8737);
// coin art on pointer parallax from @danielpetho/parallax-floating (id 1332). Token data, ENS name,
// giving mode and quick actions written for Varada.
"use client";

import { motion } from "motion/react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@verada/ui/lib/utils";
import { CauseChip } from "./cause-chip";
import type { CauseName } from "./cause-icon";
import { EnsName } from "./ens-name";
import {
  DriftingWash,
  HeroActions,
  HeroHeading,
  HeroStats,
  Parallax,
  ParallaxLayer,
  useHeroEntrance,
  type HeroAction,
  type HeroHeadingLevel,
  type HeroStat,
} from "./hero-shared";
import { ModeBadge, type GivingMode } from "./mode-badge";
import { PriceChange } from "./price-change";
import { WASH_FILL, WASH_PIGMENT, type LinkComponent, type WashTone } from "./shared";
import { PaperGrain } from "./watercolour";

export interface HeroTokenProps extends Omit<ComponentProps<"section">, "children"> {
  name: string;
  /** Ticker without the dollar sign. */
  symbol: string;
  /** `<label>.varada.eth` */
  ens: string;
  /** The name's site (eth.limo), for the link next to the name. */
  siteHref?: string;
  /** Coin art, cut out (PaintedImage). */
  art: ReactNode;
  /** Formatted price ("$0.000412"). */
  price: string;
  /** 24h change in percent. */
  change24h: number;
  cause: CauseName;
  causeRegions?: readonly string[];
  giving: GivingMode;
  /** Short line under the name. */
  tagline?: ReactNode;
  stats?: HeroStat[];
  /** Quick actions: Buy, Sell, Share… The first is primary. */
  actions?: HeroAction[];
  wash?: WashTone;
  headingLevel?: HeroHeadingLevel;
  LinkComponent?: LinkComponent;
}

/** A coin page hero: art on its wash, name and ticker, ENS name, price and change, cause, mode and actions. */
export function HeroToken({
  name,
  symbol,
  ens,
  siteHref,
  art,
  price,
  change24h,
  cause,
  causeRegions,
  giving,
  tagline,
  stats = [],
  actions = [],
  wash = "sage",
  headingLevel = 1,
  LinkComponent,
  className,
  ...props
}: HeroTokenProps) {
  const titleId = `hero-token-${useId().replace(/:/g, "")}`;
  const { container, item } = useHeroEntrance();
  return (
    <section
      data-slot="hero-token"
      aria-labelledby={titleId}
      className={cn("@container relative isolate overflow-hidden rounded-[32px] border border-line bg-card", className)}
      {...props}
    >
      <DriftingWash
        className="opacity-80"
        blobs={[
          { cx: 110, cy: 110, rx: 170, ry: 90, color: WASH_PIGMENT[wash], opacity: 0.25 },
          { cx: 500, cy: 40, rx: 150, ry: 60, color: "var(--ochre)", opacity: 0.16 },
        ]}
      />
      <PaperGrain className="-z-10" />
      <div className="grid gap-6 p-5 @lg:p-7 @3xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] @3xl:items-center @3xl:gap-8 @5xl:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] @5xl:p-10">
        <Parallax className="mx-auto w-full max-w-[15rem] @5xl:max-w-[19rem]">
          <div className={cn("relative aspect-square overflow-hidden rounded-[28px]", WASH_FILL[wash])}>
            <ParallaxLayer depth={0.8} className="absolute inset-[6%] grid place-items-center [&_img]:max-h-full [&_img]:w-auto [&_img]:object-contain">
              {art}
            </ParallaxLayer>
          </div>
          <ParallaxLayer depth={1.6} className="absolute -bottom-3 -right-2 rotate-3">
            <span className="num inline-flex rounded-full border-2 border-card bg-ink px-3 py-1 text-sm font-bold text-paper shadow-paper">${symbol}</span>
          </ParallaxLayer>
        </Parallax>

        <motion.div className="flex min-w-0 flex-col gap-4" {...container}>
          <motion.div className="flex flex-wrap items-center gap-2" {...item}>
            <ModeBadge giving={giving} long />
            <CauseChip cause={cause} regions={causeRegions} />
          </motion.div>
          <motion.div className="flex flex-col gap-1.5" {...item}>
            <HeroHeading id={titleId} level={headingLevel} className="text-4xl leading-none @md:text-5xl @5xl:text-6xl">
              {name} <span className="num align-middle text-[0.45em] font-semibold text-ink-muted">${symbol}</span>
            </HeroHeading>
            <EnsName name={ens} siteHref={siteHref} />
          </motion.div>
          {tagline ? (
            <motion.p className="m-0 max-w-xl text-[16px] leading-relaxed text-ink-soft" {...item}>
              {tagline}
            </motion.p>
          ) : null}
          <motion.div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" {...item}>
            <span className="num text-3xl font-semibold text-ink @md:text-4xl">
              <span className="sr-only">Price </span>
              {price}
            </span>
            <PriceChange value={change24h} showPeriod className="text-base" />
          </motion.div>
          {actions.length ? (
            <motion.div {...item}>
              <HeroActions actions={actions} LinkComponent={LinkComponent} />
            </motion.div>
          ) : null}
          {stats.length ? (
            <motion.div {...item}>
              <HeroStats stats={stats} tone="card" />
            </motion.div>
          ) : null}
        </motion.div>
      </div>
    </section>
  );
}
