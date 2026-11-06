"use client";

import { Badge } from "@varada/ui/components/ui/badge";
import { Button } from "@varada/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@varada/ui/components/ui/card";
import { PaintedImage } from "@varada/ui/components/varada/painted-image";
import { BrushUnderline, PaperGrain, Wash } from "@varada/ui/components/varada/watercolour";
import { ASSETS } from "@/lib/assets.generated";
import { GallerySection, Specimen } from "../section";

const COLORS: { name: string; token: string; use: string }[] = [
  { name: "Paper", token: "--paper", use: "Page ground" },
  { name: "Card", token: "--paper-card", use: "Surfaces" },
  { name: "Sand", token: "--sand", use: "Soft fills, secondary" },
  { name: "Line", token: "--line", use: "Borders" },
  { name: "Ink", token: "--ink", use: "Text" },
  { name: "Ink muted", token: "--ink-muted", use: "Secondary text" },
  { name: "Terracotta", token: "--terracotta", use: "Primary actions, losses ▼" },
  { name: "Sage", token: "--sage", use: "Causes, voting" },
  { name: "Gain", token: "--gain", use: "Gains ▲" },
  { name: "Ochre", token: "--ochre", use: "Platform share, washes" },
  { name: "Sky", token: "--sky", use: "Washes, charts" },
  { name: "Stock", token: "--stock-ink", use: "Stock badges" },
  { name: "ETF", token: "--etf-ink", use: "ETF badges" },
];

export function FoundationsSection() {
  return (
    <GallerySection
      id="foundations"
      title="Foundations"
      intro="Direction A, Paper & Pigment: cotton-paper ground, terracotta actions, sage for giving, painted art. Tokens use shadcn names, so 21st.dev components take the theme without edits."
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
        {COLORS.map((c) => (
          <div key={c.token} className="overflow-hidden rounded-xl border border-line bg-card">
            <div className="h-16 border-b border-line" style={{ background: `var(${c.token})` }} />
            <div className="flex flex-col gap-0.5 p-3">
              <strong className="text-sm">{c.name}</strong>
              <span className="num text-xs text-muted-foreground">var({c.token})</span>
              <span className="text-xs text-ink-soft">{c.use}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Type">
          <div className="font-display text-6xl font-extrabold leading-none tracking-tight">Display</div>
          <div className="font-display text-4xl font-semibold tracking-tight">Heading · Fraunces</div>
          <div className="font-display text-2xl font-semibold">Title · token names</div>
          <p className="text-base leading-relaxed">Body · Instrument Sans. Plain sentences that say what happens to the money.</p>
          <span className="kicker">Kicker · caps label</span>
          <span className="num text-xl">$412,880.12 · ▲ 18.42% · 0x7f3a…c21e</span>
        </Specimen>
        <Specimen label="Watercolour, drawn in code">
          <div className="relative h-40 overflow-hidden rounded-xl bg-card">
            <Wash className="absolute inset-0 size-full" />
            <PaperGrain />
            <p className="absolute bottom-3 left-4 text-sm">Wash + PaperGrain: SVG filters, no image files</p>
          </div>
          <h3 className="relative inline-block self-start font-display text-3xl font-semibold">
            Fund the cause
            <BrushUnderline className="absolute -bottom-2 left-0 h-4 w-full" />
          </h3>
        </Specimen>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Specimen label="Buttons" source="shadcn base, Direction A variants">
          <div className="flex flex-wrap gap-2">
            <Button>Buy $HARAMBE</Button>
            <Button variant="cause">Cast private vote</Button>
            <Button variant="outline">Launch a coin</Button>
            <Button variant="soft">Cancel</Button>
            <Button variant="ink">Connect wallet</Button>
            <Button variant="ghost">Details</Button>
            <Button variant="link">How giving works</Button>
            <Button size="sm" variant="outline">50%</Button>
            <Button disabled>Disabled</Button>
          </div>
        </Specimen>
        <Specimen label="Badges">
          <div className="flex flex-wrap gap-2">
            <Badge tone="stock">STOCK</Badge>
            <Badge tone="etf">ETF</Badge>
            <Badge tone="rwa">RWA</Badge>
            <Badge>Fee 2.5%</Badge>
            <Badge tone="cause">Weekly pool</Badge>
            <Badge tone="live" dot>Live · 24h</Badge>
            <Badge tone="ink">Pinned</Badge>
            <Badge tone="outline" shape="pill">Rotation</Badge>
          </div>
        </Specimen>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Paper card</CardTitle></CardHeader>
          <CardDescription>The default surface for panels and token cards.</CardDescription>
          <CardFooter><Button size="sm">Action</Button></CardFooter>
        </Card>
        <Card tone="ink">
          <CardHeader><CardTitle>Ink card</CardTitle></CardHeader>
          <CardContent><span className="num text-3xl">$1,284.60</span><span className="text-sm opacity-80">Epoch 12 cause pool</span></CardContent>
        </Card>
        <Card tone="sand">
          <CardHeader><CardTitle>Sand card</CardTitle></CardHeader>
          <CardDescription className="text-ink-soft">Quiet callouts and grouped settings.</CardDescription>
        </Card>
      </div>

      <Specimen label="Painted art from the asset pipeline" source="PaintedImage · AVIF + WebP + blur placeholder">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <PaintedImage name="scenes/harambe-v1" asset={ASSETS["scenes/harambe-v1"]} alt="Painted scene: a gorilla in rainbow shades in a jungle" sizes="(min-width: 1024px) 25vw, 50vw" className="rounded-xl" />
          <PaintedImage name="scenes/gigachad-v2" asset={ASSETS["scenes/gigachad-v2"]} alt="Painted scene: people and animals sharing a hillside" sizes="(min-width: 1024px) 25vw, 50vw" className="rounded-xl" />
          <PaintedImage name="cutouts/tiger-wif-hat" asset={ASSETS["cutouts/tiger-wif-hat"]} alt="Tiger in a knitted hat at a laptop" sizes="25vw" className="rounded-xl bg-sand" />
          <PaintedImage name="cutouts/statue-v1" asset={ASSETS["cutouts/statue-v1"]} alt="Carved statue in a giving gesture" sizes="25vw" className="rounded-xl bg-sand" />
        </div>
      </Specimen>
    </GallerySection>
  );
}
