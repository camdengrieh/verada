"use client";

import { Badge } from "@varada/ui/components/ui/badge";
import { HeroHome } from "@varada/ui/components/varada/hero-home";
import { PaintedImage } from "@varada/ui/components/varada/painted-image";
import type { HeroStat } from "@varada/ui/components/varada/hero-shared";
import { useAppConfig } from "@/components/providers";
import { ASSETS } from "@/lib/assets.generated";
import { platformTotals, type PlatformTotals } from "@/lib/platform-stats";
import type { Stats } from "@/lib/indexer";
import { formatUsd } from "@/lib/format";
import { useRel } from "./hooks";

const USD0: Intl.NumberFormatOptions = { style: "currency", currency: "USD", maximumFractionDigits: 0 };

/** Stats strip values: counting numbers when the indexer answered, a dash when it did not. */
export function heroStats(totals: PlatformTotals | null): HeroStat[] {
  return [
    { label: "Raised for causes", value: totals ? totals.raisedUsd : "–", format: USD0, live: totals !== null },
    { label: "Coins launched", value: totals ? totals.tokens : "–" },
    { label: "Donations made", value: totals ? totals.donations : "–" },
  ];
}

/** The home page hero with the platform's real totals from `/api/stats`. */
export function HomeHero({ stats }: { stats: Stats | undefined }) {
  const config = useAppConfig();
  const rel = useRel();
  const totals = platformTotals(stats);
  return (
    <HeroHome
      headline="Memecoins that give back"
      highlight="give"
      lead={
        <p className="m-0">
          Trade or launch a coin and 90% of every trading fee goes to charity, paid in USDC through Endaoment, to a cause its holders pick by private
          vote. Every coin gets its own name, like <span className="num">harambe.{config.ensParentName}</span>.
        </p>
      }
      art={<PaintedImage name="scenes/harambe-v1" asset={ASSETS["scenes/harambe-v1"]} alt="Painted scene: a gorilla in rainbow shades in a jungle" sizes="(min-width: 1024px) 40vw, 90vw" priority />}
      accents={[
        totals && totals.raisedUsd > 0 ? (
          <Badge key="raised" tone="cause" shape="pill" className="num shadow-paper">
            {formatUsd(totals.raisedUsd)} raised
          </Badge>
        ) : (
          <Badge key="split" tone="cause" shape="pill" className="shadow-paper">
            90% to charity
          </Badge>
        ),
        <Badge key="ens" tone="rwa" shape="pill" className="num shadow-paper">
          you.{config.ensParentName}
        </Badge>,
      ]}
      actions={[
        { label: "Launch a coin", href: rel("launch/"), effect: "wash" },
        { label: "Explore coins", href: "#coins", variant: "outline" },
      ]}
      stats={heroStats(totals)}
    />
  );
}
