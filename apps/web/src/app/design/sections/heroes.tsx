"use client";

import type { ReactNode } from "react";
import { Badge } from "@varada/ui/components/ui/badge";
import { ensLimoUrl } from "@varada/ui/components/varada/ens-shared";
import { HeroCause } from "@varada/ui/components/varada/hero-cause";
import { HeroHome } from "@varada/ui/components/varada/hero-home";
import { HeroLaunch } from "@varada/ui/components/varada/hero-launch";
import { HeroToken } from "@varada/ui/components/varada/hero-token";
import { PaintedImage } from "@varada/ui/components/varada/painted-image";
import { ASSETS } from "@/lib/assets.generated";
import { GallerySection, Specimen } from "../section";

type Cutout = "cutouts/gorilla-mog" | "cutouts/party-hat" | "cutouts/statue-v1" | "cutouts/tiger-wif-hat";
const cutout = (key: Cutout, alt = "", sizes = "220px") => <PaintedImage name={key} asset={ASSETS[key]} alt={alt} sizes={sizes} />;

const USD0: Intl.NumberFormatOptions = { style: "currency", currency: "USD", maximumFractionDigits: 0 };

function Home({ narrow }: { narrow?: boolean }) {
  return (
    <HeroHome
      headingLevel={3}
      headline="Memecoins that give back"
      highlight="give"
      lead={
        <p className="m-0">
          Launch or trade a coin and 90% of every trading fee goes to charity, paid in USDC through Endaoment. Every coin gets its own name,
          like harambe.varada.eth.
        </p>
      }
      art={
        <PaintedImage
          name="scenes/harambe-v1"
          asset={ASSETS["scenes/harambe-v1"]}
          alt="Painted scene: a gorilla in rainbow shades in a jungle"
          sizes={narrow ? "360px" : "(min-width: 1024px) 40vw, 90vw"}
        />
      }
      accents={[
        <Badge key="a" tone="cause" shape="pill" className="shadow-paper">
          $48,210 raised
        </Badge>,
        <Badge key="b" tone="rwa" shape="pill" className="num shadow-paper">
          harambe.varada.eth
        </Badge>,
      ]}
      actions={[
        { label: "Launch a coin", href: "#heroes", effect: "wash" },
        { label: "Explore coins", href: "#heroes", variant: "outline" },
      ]}
      stats={[
        { label: "Raised for causes", value: 48210, format: USD0, live: true },
        { label: "Charities paid", value: 63 },
        { label: "Coins giving", value: 1284 },
      ]}
    />
  );
}

function Token() {
  return (
    <HeroToken
      headingLevel={3}
      name="Harambe"
      symbol="HARAMBE"
      ens="harambe.varada.eth"
      siteHref={ensLimoUrl("harambe.varada.eth")}
      art={cutout("cutouts/gorilla-mog", "Painted gorilla, arms crossed")}
      price="$0.000412"
      change24h={18.42}
      cause="wildlife"
      causeRegions={["Africa"]}
      giving={{ mode: "live", cadence: "24h" }}
      wash="sage"
      tagline="The gorilla that gives. Each trade donates straight away; the charity rotates every 24 hours."
      actions={[
        { label: "Buy $HARAMBE", onClick: () => {} },
        { label: "Sell", variant: "soft", onClick: () => {} },
        { label: "Share", variant: "ghost", onClick: () => {} },
      ]}
      stats={[
        { label: "Market cap", value: "$412K" },
        { label: "Raised", value: 21480, format: USD0, live: true },
        { label: "Holders", value: 2318 },
      ]}
    />
  );
}

function Cause() {
  return (
    <HeroCause
      headingLevel={3}
      cause="wildlife"
      description="Rangers, vets and habitat for endangered species. Holders choose the charity each week from a ballot the curator agent puts together."
      raised={21480}
      charities={6}
      coins={14}
      curator={{ ens: "wildlife.agent.varada.eth", agentId: 7, status: "active", siteHref: ensLimoUrl("wildlife.agent.varada.eth") }}
      actions={[
        { label: "Vote this epoch", variant: "cause", href: "#heroes" },
        { label: "See charities", variant: "outline", href: "#heroes" },
      ]}
    />
  );
}

function Launch({ narrow }: { narrow?: boolean }) {
  const sizes = narrow ? "160px" : "220px";
  return (
    <HeroLaunch
      headingLevel={3}
      stickers={[
        cutout("cutouts/tiger-wif-hat", "", sizes),
        cutout("cutouts/party-hat", "", sizes),
        cutout("cutouts/statue-v1", "", sizes),
        cutout("cutouts/gorilla-mog", "", sizes),
      ]}
      actions={[{ label: "Start your launch", href: "#heroes", effect: "brush" }]}
    />
  );
}

function NarrowAndWide({ label, source, narrow, wide }: { label: string; source?: string; narrow: ReactNode; wide: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <Specimen label={`${label}, wide`} source={source}>
        {wide}
      </Specimen>
      <Specimen label={`${label}, 360px`} className="max-w-[402px]">
        <div className="w-full max-w-[360px]">{narrow}</div>
      </Specimen>
    </div>
  );
}

export function HeroesSection() {
  return (
    <GallerySection
      id="heroes"
      title="Heroes"
      intro="Page openers for home, a coin, a cause and launching. They size themselves with container queries, so the same hero works in a full-width band or a 360px column. Move the pointer over the art for the parallax."
    >
      <NarrowAndWide label="Home" source="21st.dev hero-section-9 + parallax-floating" wide={<Home />} narrow={<Home narrow />} />
      <NarrowAndWide label="Coin" wide={<Token />} narrow={<Token />} />
      <NarrowAndWide label="Cause" wide={<Cause />} narrow={<Cause />} />
      <NarrowAndWide label="Launch" source="21st.dev parallax-floating" wide={<Launch />} narrow={<Launch narrow />} />
    </GallerySection>
  );
}
