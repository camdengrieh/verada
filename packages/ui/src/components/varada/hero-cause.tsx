// Layout and entrance adapted from 21st.dev @ravikatiyar162/hero-section-9 (id 5921, demo 8737), with
// the floating decorative shapes around the art turned into painted pigment dabs on pointer parallax
// (@danielpetho/parallax-floating, id 1332). Cause data and curator agent written for Varada.
"use client";

import { Bot } from "lucide-react";
import { motion } from "motion/react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { Badge } from "@varada/ui/components/ui/badge";
import { cn } from "@varada/ui/lib/utils";
import { CAUSE_LABELS, CauseIcon, type CauseName } from "./cause-icon";
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
import { usdFormatOptions } from "./impact-shared";
import { WASH_FILL, WASH_PIGMENT, type LinkComponent, type WashTone } from "./shared";
import { PaperGrain } from "./watercolour";

export interface HeroCauseCurator {
  /** `<cause>.agent.varada.eth` */
  ens: string;
  /** ERC-8004 identity token id. */
  agentId?: number | string;
  status?: "active" | "paused" | "pending";
  siteHref?: string;
}

export interface HeroCauseProps extends Omit<ComponentProps<"section">, "children"> {
  cause: CauseName;
  /** Overrides the catalogue label as the heading. */
  title?: string;
  description?: ReactNode;
  /** USD raised for this category, all time. */
  raised: number;
  /** Charities in the category's catalogue. */
  charities: number;
  /** Coins whose focus is this cause. */
  coins?: number;
  curator?: HeroCauseCurator;
  /** Extra stats after raised / charities / coins. */
  stats?: HeroStat[];
  actions?: HeroAction[];
  wash?: WashTone;
  headingLevel?: HeroHeadingLevel;
  LinkComponent?: LinkComponent;
}

const CURATOR_STATUS = { active: "Active", paused: "Paused", pending: "Not yet registered" } as const;

/** A cause category page hero: the painted icon large, category, money raised, charity count and its curator agent. */
export function HeroCause({
  cause,
  title,
  description,
  raised,
  charities,
  coins,
  curator,
  stats = [],
  actions = [],
  wash = "sage",
  headingLevel = 1,
  LinkComponent,
  className,
  ...props
}: HeroCauseProps) {
  const titleId = `hero-cause-${useId().replace(/:/g, "")}`;
  const { container, item } = useHeroEntrance();
  const allStats: HeroStat[] = [
    { label: "Raised", value: raised, format: usdFormatOptions(raised, true), live: true },
    { label: "Charities", value: charities },
    ...(coins !== undefined ? [{ label: "Coins giving", value: coins }] : []),
    ...stats,
  ];
  return (
    <section
      data-slot="hero-cause"
      aria-labelledby={titleId}
      className={cn("@container relative isolate overflow-hidden rounded-[32px] border border-line bg-paper", className)}
      {...props}
    >
      <DriftingWash
        seed={3}
        blobs={[
          { cx: 470, cy: 90, rx: 200, ry: 100, color: WASH_PIGMENT[wash], opacity: 0.28 },
          { cx: 150, cy: 170, rx: 180, ry: 50, color: "var(--sky)", opacity: 0.18 },
        ]}
      />
      <PaperGrain className="-z-10" />
      <div className="grid gap-6 p-5 @lg:p-8 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] @3xl:items-center @5xl:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] @5xl:p-12">
        <motion.div className="order-2 flex min-w-0 flex-col gap-4 @3xl:order-1" {...container}>
          <motion.div {...item}>
            <span className="kicker">Cause category</span>
          </motion.div>
          <motion.div {...item}>
            <HeroHeading id={titleId} level={headingLevel} className="text-4xl leading-[1.05] @md:text-5xl @5xl:text-6xl">
              {title ?? CAUSE_LABELS[cause]}
            </HeroHeading>
          </motion.div>
          {description ? (
            <motion.div className="max-w-xl text-[16px] leading-relaxed text-ink-soft" {...item}>
              {description}
            </motion.div>
          ) : null}
          <motion.div {...item}>
            <HeroStats stats={allStats} />
          </motion.div>
          {curator ? (
            <motion.div
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-dashed border-line-strong bg-card/70 p-3"
              {...item}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-sage-tint text-sage-ink">
                <Bot aria-hidden="true" className="size-5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-xs font-semibold text-ink-muted">
                  Curator agent{curator.agentId !== undefined ? <> · ERC-8004 #{curator.agentId}</> : null}
                </span>
                <EnsName name={curator.ens} size="sm" siteHref={curator.siteHref} />
              </span>
              {curator.status ? (
                <Badge tone={curator.status === "active" ? "cause" : curator.status === "paused" ? "rwa" : "neutral"} shape="pill">
                  {CURATOR_STATUS[curator.status]}
                </Badge>
              ) : null}
            </motion.div>
          ) : null}
          {actions.length ? (
            <motion.div {...item}>
              <HeroActions actions={actions} LinkComponent={LinkComponent} />
            </motion.div>
          ) : null}
        </motion.div>

        <Parallax className="order-1 mx-auto w-full max-w-[13rem] @3xl:order-2 @3xl:max-w-none">
          <div className={cn("relative grid aspect-square place-items-center rounded-full", WASH_FILL[wash])}>
            <span aria-hidden="true" className="absolute inset-[-6%] rounded-full border-2 border-dashed border-line-strong motion-safe:animate-[spin_60s_linear_infinite]" />
            <ParallaxLayer depth={0.7} className="grid place-items-center">
              <CauseIcon cause={cause} size={176} decorative className="h-auto max-w-[80%] @3xl:max-w-none" />
            </ParallaxLayer>
          </div>
          <ParallaxLayer depth={1.8} className="absolute left-[4%] top-[6%]">
            <span aria-hidden="true" className="block size-6 rounded-full opacity-60 blur-[1px]" style={{ background: "var(--ochre)" }} />
          </ParallaxLayer>
          <ParallaxLayer depth={-1.4} className="absolute bottom-[8%] right-[2%]">
            <span aria-hidden="true" className="block size-4 rounded-full opacity-60 blur-[1px]" style={{ background: "var(--terracotta)" }} />
          </ParallaxLayer>
        </Parallax>
      </div>
    </section>
  );
}
