// Adapted from 21st.dev @dhxwhy/bar-race-chart (id 37544): ranked rows with zero-based bars that
// slide to their new rank when the data changes (here with motion's layout animation instead of
// hand-rolled FLIP), plus its screen-reader-first table. Reworked as a top-holders table: a painted
// share bar per row, labelled tags for known contracts, a switch to leave the pool and LP locker
// out of the ranking, columns that appear as the container widens, and "Show all".
"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@varada/ui/components/ui/button";
import { Switch } from "@varada/ui/components/ui/switch";
import { cn } from "@varada/ui/lib/utils";
import { EnsAddress } from "./ens-address";
import { formatTokenAmount, formatUsd } from "./trade-feed";

export type HolderLabel = "pool" | "creator" | "locker" | "vault" | "agent" | "burn";

export interface HolderItem {
  address: `0x${string}`;
  ens?: string;
  /** A known contract or role. */
  label?: HolderLabel;
  balance: number;
  /** Percent of total supply. */
  share: number;
  usd?: number;
  /** The USD price is thin or may lag: print the value with a leading "~". */
  usdApprox?: boolean;
  /** Change in share over 24h, in percentage points. */
  change24h?: number;
}

/** Tag text, tag colours and share-bar pigment for each known holder. */
export const HOLDER_LABELS: Record<HolderLabel, { text: string; tag: string; bar: string; description: string }> = {
  pool: { text: "Pool", tag: "bg-sky/25 text-ink", bar: "bg-sky", description: "The Uniswap pool: tokens available to trade" },
  creator: { text: "Creator", tag: "bg-terracotta-tint text-terracotta-strong", bar: "bg-terracotta", description: "The wallet that launched the coin" },
  locker: { text: "LP locker", tag: "bg-sand text-ink-soft", bar: "bg-line-strong", description: "Locked liquidity; it can't be sold" },
  vault: { text: "Cause vault", tag: "bg-sage-tint text-sage-ink", bar: "bg-sage", description: "Held for causes" },
  agent: { text: "Curator agent", tag: "bg-sage-tint text-sage-ink", bar: "bg-sage", description: "A cause curator agent's vault" },
  burn: { text: "Burned", tag: "bg-sand text-ink-muted", bar: "bg-ink-muted", description: "Sent to a dead address; out of circulation" },
};

/** Labels left out by "Hide pool and locker": supply that isn't held by a person. */
export const CONTRACT_LABELS: readonly HolderLabel[] = ["pool", "locker", "burn"];

/** Holders ranked by share, optionally without the pool, locker and burn address. */
export function rankHolders(holders: readonly HolderItem[], hideContracts: boolean): HolderItem[] {
  return holders.filter((h) => !(hideContracts && h.label && CONTRACT_LABELS.includes(h.label))).sort((a, b) => b.share - a.share || a.address.localeCompare(b.address));
}

const USD_COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const usdShort = (n: number) => (n >= 100_000 ? "$" + USD_COMPACT.format(n) : formatUsd(n));

const pct = (n: number) => `${n < 0.01 && n > 0 ? "<0.01" : n < 10 ? n.toFixed(2) : n.toFixed(1)}%`;

function Change({ value }: { value?: number }) {
  if (value === undefined || Math.abs(value) < 0.005) {
    return (
      <span className="text-ink-muted">
        <span aria-hidden="true">—</span>
        <span className="sr-only">no change</span>
      </span>
    );
  }
  const up = value > 0;
  return (
    <span data-direction={up ? "up" : "down"} className={cn("num whitespace-nowrap", up ? "text-gain" : "text-loss")}>
      <span aria-hidden="true">{up ? "▲" : "▼"} </span>
      <span className="sr-only">{up ? "up" : "down"} </span>
      {Math.abs(value).toFixed(2)} pts
    </span>
  );
}

function ShareBar({ share, max, label, reduced }: { share: number; max: number; label?: HolderLabel; reduced: boolean }) {
  const width = max > 0 ? Math.max(1.5, (share / max) * 100) : 0;
  return (
    <span aria-hidden="true" className="relative block h-2 w-full overflow-hidden rounded-full bg-sand">
      <motion.span
        data-share-bar=""
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          label ? HOLDER_LABELS[label].bar : "bg-ochre",
          // A wet edge: lighter pigment pooling toward the end of the stroke.
          "after:absolute after:inset-0 after:rounded-full after:bg-[linear-gradient(90deg,transparent_40%,rgb(255_255_255/0.35)_85%,transparent)] after:content-['']",
        )}
        initial={reduced ? false : { width: 0 }}
        animate={{ width: `${width}%` }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      />
    </span>
  );
}

export interface HoldersTableProps extends Omit<ComponentProps<"section">, "children"> {
  holders: readonly HolderItem[];
  /** "$HARAMBE", for the balance column. */
  symbol?: string;
  title?: string;
  headingLevel?: 2 | 3 | 4;
  /** All holders of the coin, for the heading ("of 3,402"). */
  totalHolders?: number;
  /** Rows before "Show all" (default 10). */
  initialRows?: number;
  /** Leave the pool, LP locker and burn address out (controlled) … */
  hideContracts?: boolean;
  /** … or whether they start hidden. */
  defaultHideContracts?: boolean;
  onHideContractsChange?: (hide: boolean) => void;
  /** Link for a holder's address; defaults to Etherscan. */
  addressUrl?: (address: string) => string;
  footer?: ReactNode;
}

const count = new Intl.NumberFormat("en-US");

/**
 * Top holders: rank, holder (ENS name or address, with a tag for known contracts), a share bar,
 * balance, value and the 24h change in share. A size container: under 32rem the share and balance
 * fold into the holder cell; value and 24h appear from 36rem.
 */
export function HoldersTable({
  holders,
  symbol,
  title = "Top holders",
  headingLevel = 3,
  totalHolders,
  initialRows = 10,
  hideContracts: hideProp,
  defaultHideContracts = false,
  onHideContractsChange,
  addressUrl = (a) => `https://etherscan.io/address/${a}`,
  footer,
  className,
  ...props
}: HoldersTableProps) {
  const id = useId();
  const reduced = !!useReducedMotion();
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const [innerHide, setInnerHide] = useState(defaultHideContracts);
  const hide = hideProp ?? innerHide;
  const setHide = (v: boolean) => {
    if (hideProp === undefined) setInnerHide(v);
    onHideContractsChange?.(v);
  };
  const [all, setAll] = useState(false);
  const ranked = rankHolders(holders, hide);
  const rows = all ? ranked : ranked.slice(0, initialRows);
  const max = Math.max(0, ...ranked.map((h) => h.share));
  const hasContracts = holders.some((h) => h.label && CONTRACT_LABELS.includes(h.label));

  return (
    <section data-slot="holders-table" aria-labelledby={`${id}-title`} className={cn("@container flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-card p-4 @md:p-5", className)} {...props}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2.5">
          <Heading id={`${id}-title`} className="m-0 font-sans text-base font-semibold">
            {title}
          </Heading>
          {totalHolders !== undefined ? (
            <span className="text-xs text-ink-muted">
              of <span className="num">{count.format(totalHolders)}</span> holders
            </span>
          ) : null}
        </div>
        {hasContracts ? (
          <span className="inline-flex items-center gap-2.5">
            <Switch id={`${id}-hide`} checked={hide} onCheckedChange={setHide} tone="cause" />
            <label htmlFor={`${id}-hide`} className="text-[13px] text-ink-soft">
              Hide pool and locker
            </label>
          </span>
        ) : null}
      </div>

      {ranked.length ? (
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">
            {title}, ranked by share of supply{hide ? ", without the pool, LP locker and burn address" : ""}. Shares are of total supply.
          </caption>
          <thead>
            <tr className="border-b border-line text-left text-[11px] font-medium text-ink-muted">
              <th scope="col" className="w-8 pb-2 font-medium">
                #
              </th>
              <th scope="col" className="pb-2 font-medium">
                Holder
              </th>
              <th scope="col" className="hidden w-[26%] pb-2 font-medium @lg:table-cell">
                Share of supply
              </th>
              <th scope="col" className="hidden w-[12%] pb-2 text-right font-medium @xl:table-cell">
                Balance
              </th>
              <th scope="col" className="hidden w-[13%] pb-2 text-right font-medium @xl:table-cell">
                Value
              </th>
              <th scope="col" className="hidden w-[13%] pb-2 text-right font-medium @md:table-cell">
                24h
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h, i) => {
              const tag = h.label ? HOLDER_LABELS[h.label] : null;
              return (
                <motion.tr
                  key={h.address}
                  layout={reduced ? false : "position"}
                  transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                  data-holder={h.address}
                  data-label={h.label}
                  className="border-b border-dashed border-line align-middle last:border-b-0"
                >
                  <td className="num py-2.5 text-xs text-ink-muted">{i + 1}</td>
                  <td className="min-w-0 py-2.5 pr-3">
                    <span className="flex min-w-0 flex-col gap-1.5">
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <a href={addressUrl(h.address)} target="_blank" rel="noopener noreferrer" className="min-w-0 max-w-full rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                          <EnsAddress
                            address={h.address}
                            name={h.ens}
                            direction="reverse"
                            noCopy
                            nameOnly
                            className="pointer-events-none min-h-9 border-0 bg-transparent py-0 pl-0 [&>img]:size-6 [&>span:first-child]:size-6"
                          />
                        </a>
                        {tag ? (
                          <span title={tag.description} className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold", tag.tag)}>
                            {tag.text}
                          </span>
                        ) : null}
                      </span>
                      {/* Under 32rem the share (and under 36rem the balance) live here. */}
                      <span className="flex items-center gap-2 @lg:hidden">
                        <span className="num w-14 shrink-0 text-[13px] font-semibold text-ink">{pct(h.share)}</span>
                        <ShareBar share={h.share} max={max} label={h.label} reduced={reduced} />
                      </span>
                      <span className="num text-xs text-ink-muted @xl:hidden">
                        {formatTokenAmount(h.balance)} {symbol}
                        {h.usd !== undefined ? ` · ${h.usdApprox ? "~" : ""}${usdShort(h.usd)}` : ""}
                      </span>
                    </span>
                  </td>
                  <td className="hidden py-2.5 pr-3 @lg:table-cell">
                    <span className="flex items-center gap-2.5">
                      <span className="num w-14 shrink-0 text-[13px] font-semibold text-ink">{pct(h.share)}</span>
                      <ShareBar share={h.share} max={max} label={h.label} reduced={reduced} />
                    </span>
                  </td>
                  <td className="num hidden py-2.5 text-right @xl:table-cell">
                    {formatTokenAmount(h.balance)}
                    {symbol ? <span className="sr-only"> {symbol}</span> : null}
                  </td>
                  <td className="num hidden py-2.5 text-right text-ink-soft @xl:table-cell">{h.usd !== undefined ? `${h.usdApprox ? "~" : ""}${usdShort(h.usd)}` : "—"}</td>
                  <td className="hidden py-2.5 text-right text-[13px] @md:table-cell">
                    <Change value={h.change24h} />
                  </td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="m-0 py-6 text-center text-sm text-ink-muted">No holders yet.</p>
      )}

      {ranked.length > initialRows ? (
        <Button variant="ghost" size="sm" className="self-center" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show top " + initialRows : `Show all ${ranked.length}`}
        </Button>
      ) : null}
      {footer}
    </section>
  );
}
