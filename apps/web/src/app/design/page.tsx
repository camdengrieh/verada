import { DataSection } from "./sections/data";
import { EffectsSection } from "./sections/effects";
import { EnsSection } from "./sections/ens";
import { FoundationsSection } from "./sections/foundations";
import { HeroesSection } from "./sections/heroes";
import { ImpactSection } from "./sections/impact";
import { MarketsSection } from "./sections/markets";
import { MotionSection } from "./sections/motion";
import { NavigationSection } from "./sections/navigation";
import { PrimitivesSection } from "./sections/primitives";
import { VaradaSection } from "./sections/varada";

const TOC = [
  { id: "foundations", label: "Foundations" },
  { id: "heroes", label: "Heroes" },
  { id: "motion", label: "Motion & feedback" },
  { id: "effects", label: "Effects" },
  { id: "primitives", label: "Primitives & overlays" },
  { id: "navigation", label: "Tabs, tooltips & dividers" },
  { id: "data", label: "Data, motion & trading" },
  { id: "markets", label: "Ondo stocks & liquidity" },
  { id: "ens", label: "ENS names" },
  { id: "impact", label: "Raised for causes" },
  { id: "varada", label: "Varada components" },
];

/**
 * Living gallery of the @verada/ui library (Direction A). Every component and state appears here;
 * pages move onto the library one by one.
 */
export default function DesignPage() {
  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <header className="border-b border-line bg-card/80 px-4 py-8 sm:px-10">
        <div className="mx-auto flex max-w-[1360px] flex-col gap-2">
          <span className="kicker">Varada · Direction A · Paper &amp; Pigment</span>
          <h1 className="text-5xl font-extrabold tracking-tight">Design system</h1>
          <p className="max-w-3xl text-lg text-ink-soft">
            The @verada/ui component library: shadcn primitives and 21st.dev components themed for Varada, plus the
            pieces only Varada needs. Sample values only.
          </p>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1360px] flex-wrap gap-10 px-4 py-10 sm:px-10">
        <nav aria-label="Sections" className="flex-[1_1_200px] lg:sticky lg:top-6 lg:self-start">
          <ol className="flex flex-wrap gap-2 lg:flex-col">
            {TOC.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`} className="inline-flex min-h-11 items-center rounded-full px-4 text-[15px] font-medium text-ink hover:bg-sand">
                  {t.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <main className="flex min-w-0 flex-[999_1_640px] flex-col gap-16">
          <FoundationsSection />
          <HeroesSection />
          <MotionSection />
          <EffectsSection />
          <PrimitivesSection />
          <NavigationSection />
          <DataSection />
          <MarketsSection />
          <EnsSection />
          <ImpactSection />
          <VaradaSection />
        </main>
      </div>
      <footer className="border-t border-line px-4 py-6 text-sm text-muted-foreground sm:px-10">
        <div className="mx-auto max-w-[1360px]">
          Charts: TradingView Lightweight Charts™, Copyright (c) 2025 TradingView, Inc.,{" "}
          <a href="https://www.tradingview.com/" rel="noopener noreferrer" className="underline">
            tradingview.com
          </a>
          . Fonts: Fraunces, Instrument Sans and JetBrains Mono under the SIL Open Font License.
        </div>
      </footer>
    </div>
  );
}
