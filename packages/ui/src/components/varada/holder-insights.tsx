// Adapted from 21st.dev @sean0205/c-chart-3 (id 30675, diagonal-stripe bar chart card): a card with
// a headline number and trend, and patterned bars. Reworked as a distribution read-out: holder
// count with a sparkline, the concentration written as sentences, a verdict whose thresholds are in
// its tooltip (the same ones HolderDistribution warns at), and paired bars per holding size: share
// of holders against share of supply.
"use client";

import { CircleCheck, CircleDot, TriangleAlert } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useId, type ComponentProps } from "react";
import { Sparkline } from "@verada/ui/components/data/sparkline";
import { InfoTip } from "@verada/ui/components/ui/info-tip";
import { cn } from "@verada/ui/lib/utils";
import { CONCENTRATION } from "./holder-distribution";

export interface HolderBucket {
  /** "Under $100", "$1K–10K" */
  label: string;
  holders: number;
  /** Percent of supply held by this bucket. */
  share: number;
}

export type HolderVerdict = "spread" | "fair" | "concentrated";

/** Concentrated at the HolderDistribution warning levels; "fair" at half of them. */
export function holderVerdict(top10Share: number, creatorShare: number): HolderVerdict {
  if (top10Share >= CONCENTRATION.top10 || creatorShare >= CONCENTRATION.creator) return "concentrated";
  if (top10Share >= CONCENTRATION.top10 / 2 || creatorShare >= CONCENTRATION.creator / 2) return "fair";
  return "spread";
}

const VERDICT: Record<HolderVerdict, { text: string; icon: typeof CircleCheck; className: string }> = {
  spread: { text: "Spread out", icon: CircleCheck, className: "bg-sage-tint text-sage-ink" },
  fair: { text: "Fairly spread", icon: CircleDot, className: "bg-sand text-ink" },
  concentrated: { text: "Concentrated", icon: TriangleAlert, className: "bg-ochre-tint text-ochre-ink" },
};

export interface HolderInsightsProps extends Omit<ComponentProps<"section">, "children"> {
  holders: number;
  newHolders24h?: number;
  /** Top 10 wallets, excluding the pool and LP locker, percent of supply. */
  top10Share: number;
  creatorShare: number;
  poolShare: number;
  /** By holding size, smallest first. */
  buckets: readonly HolderBucket[];
  /** Holder count over time, oldest first. */
  history?: number[];
  title?: string;
  headingLevel?: 2 | 3 | 4;
}

const count = new Intl.NumberFormat("en-US");
const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "Most holders (62%) hold under $100; wallets holding over $10K have the most supply (41%)." */
export function bucketTakeaway(buckets: readonly HolderBucket[]): string | null {
  const total = buckets.reduce((s, b) => s + b.holders, 0);
  if (!total || buckets.length < 2) return null;
  const byHolders = buckets.reduce((a, b) => (b.holders > a.holders ? b : a));
  const bySupply = buckets.reduce((a, b) => (b.share > a.share ? b : a));
  const holdersPct = pct((byHolders.holders / total) * 100);
  if (byHolders === bySupply) return `Wallets holding ${lower(byHolders.label)} are both the most holders (${holdersPct}) and the most supply (${pct(bySupply.share)}).`;
  return `Most holders (${holdersPct}) hold ${lower(byHolders.label)}; wallets holding ${lower(bySupply.label)} have the most supply (${pct(bySupply.share)}).`;
}

function PairedBar({ value, tone, reduced, delay }: { value: number; tone: "holders" | "supply"; reduced: boolean; delay: number }) {
  return (
    <span aria-hidden="true" className="relative block h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-sand">
      <motion.span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          tone === "holders" ? "bg-sage" : "bg-ochre bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.28)_0_3px,transparent_3px_7px)]",
        )}
        initial={reduced ? false : { width: 0 }}
        animate={{ width: `${Math.max(value > 0 ? 2 : 0, Math.min(100, value))}%` }}
        transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
      />
    </span>
  );
}

/**
 * How the supply is spread, in words first: the verdict, the top-10, creator and pool shares as
 * sentences, then holders against supply for each holding size. A size container: the two bars of
 * a bucket sit side by side from 28rem.
 */
export function HolderInsights({
  holders,
  newHolders24h,
  top10Share,
  creatorShare,
  poolShare,
  buckets,
  history,
  title = "Holder insights",
  headingLevel = 3,
  className,
  ...props
}: HolderInsightsProps) {
  const id = useId();
  const reduced = !!useReducedMotion();
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const verdict = holderVerdict(top10Share, creatorShare);
  const v = VERDICT[verdict];
  const Icon = v.icon;
  const bucketHolders = buckets.reduce((s, b) => s + b.holders, 0) || 1;
  const takeaway = bucketTakeaway(buckets);

  return (
    <section data-slot="holder-insights" data-verdict={verdict} aria-labelledby={`${id}-title`} className={cn("@container flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-card p-4 @md:p-5", className)} {...props}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Heading id={`${id}-title`} className="m-0 font-sans text-base font-semibold">
          {title}
        </Heading>
        <span className="inline-flex items-center gap-1">
          <span data-slot="verdict" className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold", v.className)}>
            <Icon aria-hidden="true" className="size-3.5" />
            {v.text}
          </span>
          <InfoTip term="Concentration">
            Concentrated when the top 10 wallets hold {CONCENTRATION.top10}% or more of supply, or the creator holds {CONCENTRATION.creator}% or more. Fairly spread from half of
            those ({CONCENTRATION.top10 / 2}% and {CONCENTRATION.creator / 2}%). The pool and LP locker don&apos;t count as holders.
          </InfoTip>
        </span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex flex-col">
          <span className="num font-display text-3xl font-semibold leading-none text-ink">{count.format(holders)}</span>
          <span className="mt-1 text-[13px] text-ink-muted">
            holders
            {newHolders24h !== undefined ? (
              <>
                {" · "}
                <span className={cn("num font-semibold", newHolders24h >= 0 ? "text-gain" : "text-loss")}>
                  {newHolders24h >= 0 ? "+" : "−"}
                  {count.format(Math.abs(newHolders24h))}
                </span>{" "}
                in 24h
              </>
            ) : null}
          </span>
        </div>
        {history && history.length > 1 ? (
          <Sparkline
            data={history}
            width={160}
            height={44}
            area
            tone="cause"
            label={`Holders over time, ${count.format(history[0]!)} to ${count.format(history[history.length - 1]!)}`}
            className="h-11 w-40 max-w-full"
          />
        ) : null}
      </div>

      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm text-ink-soft">
        <li>
          Top 10 wallets hold <strong className="num text-ink">{pct(top10Share)}</strong> (excluding the pool).
        </li>
        <li>
          The creator holds <strong className="num text-ink">{pct(creatorShare)}</strong>.
        </li>
        <li>
          <strong className="num text-ink">{pct(poolShare)}</strong> sits in the pool, available to trade.
        </li>
      </ul>

      {buckets.length ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-ink">By holding size</span>
            <span aria-hidden="true" className="flex gap-3 text-[11px] text-ink-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-[3px] bg-sage" /> Holders
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-[3px] bg-ochre bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.28)_0_3px,transparent_3px_7px)]" /> Supply
              </span>
            </span>
          </div>
          <table className="w-full border-collapse text-[13px]">
            <caption className="sr-only">Holders and supply by holding size</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Holding size</th>
                <th scope="col">Share of holders</th>
                <th scope="col">Share of supply</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b, i) => {
                const holdersPct = (b.holders / bucketHolders) * 100;
                return (
                  <tr key={b.label} data-bucket={b.label} className="flex flex-col gap-1 py-1.5 @md:grid @md:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] @md:items-center @md:gap-3">
                    <th scope="row" className="text-left font-medium text-ink">
                      {b.label}
                    </th>
                    <td className="flex items-center gap-2">
                      <PairedBar value={holdersPct} tone="holders" reduced={reduced} delay={i * 0.06} />
                      <span className="num w-24 shrink-0 text-right text-ink-soft">
                        {pct(holdersPct)} <span className="text-ink-muted">({count.format(b.holders)})</span>
                      </span>
                    </td>
                    <td className="flex items-center gap-2">
                      <PairedBar value={b.share} tone="supply" reduced={reduced} delay={i * 0.06 + 0.03} />
                      <span className="num w-12 shrink-0 text-right text-ink-soft">{pct(b.share)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {takeaway ? <p className="m-0 text-[13px] text-ink-muted">{takeaway}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
