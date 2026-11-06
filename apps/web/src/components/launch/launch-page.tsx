"use client";

import { HeroLaunch } from "@varada/ui/components/varada/hero-launch";
import { PaintedImage } from "@varada/ui/components/varada/painted-image";
import { ASSETS } from "@/lib/assets.generated";
import { LaunchWizard } from "./launch-wizard";

const cutout = (key: "cutouts/gorilla-mog" | "cutouts/party-hat" | "cutouts/statue-v1" | "cutouts/tiger-wif-hat") => (
  <PaintedImage name={key} asset={ASSETS[key]} alt="" sizes="220px" />
);

/** /launch: the painted invitation (wide screens) above the stepped launch wizard. */
export function LaunchPage() {
  return (
    <div className="flex flex-col gap-8">
      <div className="hidden lg:block">
        <HeroLaunch
          stickers={[cutout("cutouts/tiger-wif-hat"), cutout("cutouts/party-hat"), cutout("cutouts/statue-v1"), cutout("cutouts/gorilla-mog")]}
          actions={[{ label: "Start your launch", href: "#wizard", effect: "brush" }]}
        />
      </div>
      <header className="flex flex-col gap-1 lg:hidden">
        <h1 className="m-0 font-display text-3xl font-semibold leading-tight">Launch a coin that gives</h1>
        <p className="m-0 text-[15px] text-ink-soft">A few minutes and one transaction. From the first trade, 90% of every fee goes to charity.</p>
      </header>
      <section id="wizard" aria-label="Launch wizard" className="scroll-mt-24">
        <LaunchWizard />
      </section>
    </div>
  );
}
