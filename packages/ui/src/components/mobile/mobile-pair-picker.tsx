// Written for Varada (the C-Mobile launch step "Pair it with a stock, ETF or ETH": a two-column grid
// of pair tiles with a depth bar), as a vaul sheet (ui/drawer.tsx, from 21st.dev @wensity/drawer id
// 31360) with Crypto / Stocks tabs, a search field and a pinned confirm button. Tiles are a radix
// RadioGroup, as in 21st.dev @sean0205/c-radio-group-8 (id 28339) for the ballot.
"use client";

import { Check, Search } from "lucide-react";
import { RadioGroup, Tabs } from "radix-ui";
import { useId, useMemo, useState } from "react";
import { Button } from "@verada/ui/components/ui/button";
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@verada/ui/components/ui/drawer";
import { AssetKindBadge } from "@verada/ui/components/varada/asset-kind-badge";
import type { ImageSource } from "@verada/ui/components/varada/shared";
import { StockLogo, type QuoteKind } from "@verada/ui/components/varada/stock-logo";
import { cn } from "@verada/ui/lib/utils";
import { CONTAINED_SHEET, type MobileSheetBaseProps } from "./sheet-shared";

export interface PairOption {
  /** "WETH", "NVDAon" */
  symbol: string;
  /** "Wrapped Ether", "NVIDIA (Ondo)" */
  name: string;
  kind: QuoteKind;
  logo?: ImageSource;
  /** Route-to-USDC depth as a 0–100 bar, with its label ("$48M deep"). */
  depthPct?: number;
  depthLabel?: string;
  /** A short caveat ("Market closed until 9:30 ET"). */
  note?: string;
  disabled?: boolean;
}

export type PairTab = "crypto" | "stocks";

export interface MobilePairPickerProps extends MobileSheetBaseProps {
  /** WETH, WBTC, USDC… */
  crypto: readonly PairOption[];
  /** Ondo tokenized stocks and ETFs. */
  stocks: readonly PairOption[];
  /** Chosen symbol (controlled) … */
  value?: string;
  /** … or the starting choice. */
  defaultValue?: string;
  onValueChange?: (symbol: string) => void;
  /** Runs with the chosen pair and closes the sheet. */
  onConfirm: (option: PairOption) => void;
  defaultTab?: PairTab;
  title?: string;
  description?: string;
}

/**
 * Choose what a new coin pairs with, on a phone. Crypto and Stocks tabs (with counts), a search over
 * symbol and name, and a grid of pair tiles: two columns on phones, three from 448px. Each tile is a
 * radio (arrow keys move and choose) showing the logo, symbol, name, kind and route depth. The pinned
 * button confirms ("Pair with NVDAon").
 */
export function MobilePairPicker({
  open,
  onOpenChange,
  container,
  modal = true,
  crypto,
  stocks,
  value,
  defaultValue,
  onValueChange,
  onConfirm,
  defaultTab,
  title = "Pair it with",
  description = "Your coin trades against this asset. Fees convert through it to USDC before they are given.",
}: MobilePairPickerProps) {
  const id = useId();
  const [inner, setInner] = useState(defaultValue ?? "");
  const chosen = value ?? inner;
  const all = useMemo(() => [...crypto, ...stocks], [crypto, stocks]);
  const selected = all.find((o) => o.symbol === chosen);
  const [tab, setTab] = useState<PairTab>(defaultTab ?? (selected && stocks.includes(selected) ? "stocks" : "crypto"));
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filter = (list: readonly PairOption[]) => (q ? list.filter((o) => `${o.symbol} ${o.name}`.toLowerCase().includes(q)) : list);
  const lists: Record<PairTab, readonly PairOption[]> = { crypto: filter(crypto), stocks: filter(stocks) };

  const choose = (s: string) => {
    if (value === undefined) setInner(s);
    onValueChange?.(s);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} container={container} modal={modal} noBodyStyles={!!container}>
      <DrawerContent data-slot="mobile-pair-picker" className={cn("h-[88dvh]", container && "h-[88%]", container && CONTAINED_SHEET)}>
        <DrawerHeader className="pb-3">
          <DrawerTitle className="text-2xl">{title}</DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>
        <Tabs.Root value={tab} onValueChange={(t) => setTab(t as PairTab)} className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-col gap-2.5 px-4 pb-3">
            <div className="flex min-h-12 items-center gap-2 rounded-full border-[1.5px] border-line-strong bg-paper-card px-3.5 focus-within:border-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
              <Search aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
              <label htmlFor={`${id}-q`} className="sr-only">
                Search pairs
              </label>
              <input
                id={`${id}-q`}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search WETH, NVDAon, Tesla…"
                autoComplete="off"
                className="min-h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-ink-muted focus-visible:outline-none"
              />
            </div>
            <Tabs.List aria-label="Asset type" className="grid grid-cols-2 gap-1 rounded-full bg-sand p-1">
              {(["crypto", "stocks"] as const).map((t) => (
                <Tabs.Trigger
                  key={t}
                  value={t}
                  className="min-h-11 rounded-full text-[15px] font-semibold text-ink transition-colors hover:bg-line data-[state=active]:bg-ink data-[state=active]:text-paper"
                >
                  {t === "crypto" ? "Crypto" : "Stocks & ETFs"} <span className="num font-normal opacity-80">{lists[t].length}</span>
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </div>
          {(["crypto", "stocks"] as const).map((t) => (
            <Tabs.Content key={t} value={t} asChild>
              <DrawerBody className="@container px-4 data-[state=inactive]:hidden">
                {lists[t].length ? (
                  <RadioGroup.Root value={chosen} onValueChange={choose} aria-label={t === "crypto" ? "Crypto pairs" : "Stock and ETF pairs"} className="grid grid-cols-2 gap-2.5 @md:grid-cols-3">
                    {lists[t].map((o) => (
                      <PairTile key={o.symbol} option={o} />
                    ))}
                  </RadioGroup.Root>
                ) : (
                  <p role="status" className="m-0 rounded-2xl bg-paper px-4 py-6 text-center text-sm text-ink-soft">
                    No {t === "crypto" ? "crypto" : "stock"} pairs match &ldquo;{query}&rdquo;.
                  </p>
                )}
              </DrawerBody>
            </Tabs.Content>
          ))}
        </Tabs.Root>
        <DrawerFooter className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <Button
            size="lg"
            className="h-13 w-full text-base"
            disabled={!selected || selected.disabled}
            onClick={() => {
              if (!selected) return;
              onConfirm(selected);
              onOpenChange(false);
            }}
          >
            {selected ? `Pair with ${selected.symbol}` : "Choose a pair"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function PairTile({ option: o }: { option: PairOption }) {
  const depth = o.depthPct === undefined ? undefined : Math.min(100, Math.max(0, o.depthPct));
  return (
    <RadioGroup.Item
      value={o.symbol}
      disabled={o.disabled}
      aria-label={[o.symbol, o.name, o.depthLabel, o.note].filter(Boolean).join(", ")}
      className={cn(
        "group relative flex min-h-32 min-w-0 flex-col items-start gap-1 rounded-[20px] border-2 border-line bg-paper-card p-3 text-left text-ink transition-colors",
        "hover:border-line-strong data-[state=checked]:border-ink data-[state=checked]:bg-sand/60",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <span className="flex w-full items-start justify-between gap-2">
        <StockLogo symbol={o.symbol} kind={o.kind} src={o.logo?.src} srcSet={o.logo?.srcSet} size={36} decorative />
        <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-line-strong group-data-[state=checked]:border-ink group-data-[state=checked]:bg-ink">
          <RadioGroup.Indicator>
            <Check className="size-3.5 text-paper" strokeWidth={3} />
          </RadioGroup.Indicator>
        </span>
      </span>
      <strong className="mt-1 max-w-full truncate text-[15px]">{o.symbol}</strong>
      <span className="line-clamp-2 text-xs text-ink-soft">{o.name}</span>
      <AssetKindBadge kind={o.kind} className="mt-auto" aria-hidden="true" />
      {depth !== undefined ? (
        <span aria-hidden="true" className="mt-1 flex w-full flex-col gap-1">
          <span className="h-1.5 w-full overflow-hidden rounded-full bg-sand">
            <span className="block h-full rounded-full bg-sage" style={{ width: `${depth}%` }} />
          </span>
          {o.depthLabel ? <span className="num text-[11px] text-ink-muted">{o.depthLabel}</span> : null}
        </span>
      ) : null}
      {o.note ? (
        <span aria-hidden="true" className="text-[11px] font-semibold text-ochre-ink">
          {o.note}
        </span>
      ) : null}
    </RadioGroup.Item>
  );
}
