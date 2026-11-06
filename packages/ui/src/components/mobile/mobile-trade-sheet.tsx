// Adapted from 21st.dev @coss.com/drawer (id 11443, the snap-points demo) on our vaul drawer
// (ui/drawer.tsx, itself from 21st.dev @wensity/drawer id 31360): a sheet that stops part-way and
// drags up to full height. The compact stop is the A-Mobile board's trade sheet (side, pay, receive,
// cause share, confirm); the full stop adds the presets, slippage and quote details. The ticket
// pieces come from varada/trade-panel, so both behave the same.
"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from "@verada/ui/components/ui/drawer";
import { Divider } from "@verada/ui/components/ui/divider";
import { PriceChange } from "@verada/ui/components/varada/price-change";
import { WASH_FILL, type ImageSource, type WashTone } from "@verada/ui/components/varada/shared";
import {
  sanitizeAmount,
  tradeAction,
  TradeActionButton,
  TradeCauseNote,
  TradeDetails,
  TradePresetChips,
  TradeSideToggle,
  TradeSlippageControl,
  TradeTokenChip,
  useTradePresets,
  type TradePanelProps,
} from "@verada/ui/components/varada/trade-panel";
import { cn } from "@verada/ui/lib/utils";
import { CONTAINED_SHEET, type MobileSheetBaseProps } from "./sheet-shared";

type TicketProps = Pick<
  TradePanelProps,
  | "side"
  | "onSideChange"
  | "pay"
  | "receive"
  | "payAmount"
  | "onPayAmountChange"
  | "receiveAmount"
  | "payFiat"
  | "buyPresets"
  | "payPriceUsd"
  | "buyPresetUsd"
  | "sellPercents"
  | "payBalanceRaw"
  | "maxAmount"
  | "presetsDisabledReason"
  | "onPreset"
  | "onPercent"
  | "onPickPayToken"
  | "slippage"
  | "onSlippageChange"
  | "slippagePresets"
  | "priceImpact"
  | "minReceived"
  | "fee"
  | "sniperFee"
  | "causeAmount"
  | "causeName"
  | "causeIcon"
  | "platformAmount"
  | "blocker"
  | "pending"
  | "onSubmit"
  | "notice"
>;

export interface MobileTradeSheetProps extends MobileSheetBaseProps, TicketProps {
  /** The coin being traded, for the sheet's header. */
  coin: { name: string; symbol: string; art?: ImageSource; wash?: WashTone; price?: string; change24h?: number };
  /** The full ticket (controlled) … */
  expanded?: boolean;
  /** … or whether it opens full. */
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Height of the compact stop ("420px", or a fraction of the screen). Measured from the content by default. */
  compactSnap?: number | string;
}

const FALLBACK_SNAP = "440px";

/**
 * The phone trade ticket as a bottom sheet with two stops. Compact: side, amount, what you get, the
 * cause share and the confirm button, sized to its content. Drag it up, or press "More options", for
 * the full ticket: presets, slippage, price impact, minimum received and fees, with the confirm
 * button pinned to the bottom. The confirm button's label names whatever blocks the trade, exactly
 * as in TradePanel.
 */
export function MobileTradeSheet({
  open,
  onOpenChange,
  container,
  modal = true,
  coin,
  expanded: expandedProp,
  defaultExpanded = false,
  onExpandedChange,
  compactSnap,
  ...t
}: MobileTradeSheetProps) {
  const id = useId();
  const payId = `${id}-pay`;
  const balanceId = `${id}-balance`;
  const [innerExpanded, setInnerExpanded] = useState(defaultExpanded);
  const expanded = expandedProp ?? innerExpanded;
  const setExpanded = (e: boolean) => {
    if (expandedProp === undefined) setInnerExpanded(e);
    onExpandedChange?.(e);
  };

  // Size the compact stop to the compact content (header, quote, footer) plus the grab handle.
  const measureRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<string | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useLayoutEffect(() => {
    if (compactSnap !== undefined || !open) return;
    const el = measureRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (expandedRef.current) return;
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 200) setMeasured((m) => (m === `${h + 26}px` ? m : `${h + 26}px`));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, compactSnap]);
  const compact = compactSnap ?? measured ?? FALLBACK_SNAP;
  const snapPoints = [compact, 1];

  const presets = useTradePresets(t);
  const action = tradeAction(t);
  const verb = t.side === "buy" ? "Buy" : "Sell";

  // Switching side resets the "pressed" chip inside useTradePresets; nothing else to do here.
  useEffect(() => {
    if (!open) setInnerExpanded(defaultExpanded);
  }, [open, defaultExpanded]);

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      container={container}
      modal={modal}
      noBodyStyles={!!container}
      snapPoints={snapPoints}
      activeSnapPoint={expanded ? 1 : compact}
      setActiveSnapPoint={(p) => setExpanded(p === 1)}
      fadeFromIndex={1}
    >
      <DrawerContent data-slot="mobile-trade-sheet" data-expanded={expanded ? "true" : undefined} className={cn(container && CONTAINED_SHEET)}>
        <div ref={measureRef} className={cn("flex min-h-0 flex-col", expanded ? "flex-1" : "flex-none")}>
          <DrawerHeader className="flex-row items-center gap-3 pb-3">
            {coin.art ? (
              <img src={coin.art.src} srcSet={coin.art.srcSet} sizes="44px" alt="" width={44} height={44} className={cn("size-11 shrink-0 rounded-[14px] object-contain", WASH_FILL[coin.wash ?? "sage"])} />
            ) : null}
            <div className="flex min-w-0 flex-col">
              <DrawerTitle className="truncate text-lg">
                {verb} ${coin.symbol.replace(/^\$/, "")}
              </DrawerTitle>
              <DrawerDescription className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <span className="truncate">{coin.name}</span>
                {coin.price ? <span className="num text-ink">{coin.price}</span> : null}
                {coin.change24h !== undefined ? <PriceChange value={coin.change24h} className="text-[13px]" /> : null}
              </DrawerDescription>
            </div>
          </DrawerHeader>

          <DrawerBody className={cn("@container flex flex-col gap-3", expanded ? "flex-1" : "flex-none overflow-hidden")}>
            <div className="flex items-center gap-2">
              <TradeSideToggle side={t.side} onSideChange={t.onSideChange} className="flex-1" />
              {expanded ? <TradeSlippageControl value={t.slippage} onChange={t.onSlippageChange} presets={t.slippagePresets} /> : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={payId} className="text-[13px] text-ink-muted">
                You pay
              </label>
              <div className="flex items-center gap-2 rounded-[14px] border-[1.5px] border-line-strong bg-paper-card py-2 pl-3 pr-2.5 focus-within:border-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
                <input
                  id={payId}
                  value={t.payAmount}
                  onChange={(e) => {
                    const v = sanitizeAmount(e.target.value);
                    if (v === null) return;
                    presets.clear();
                    t.onPayAmountChange(v);
                  }}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  aria-describedby={t.pay.balance || t.payFiat ? balanceId : undefined}
                  className="num min-h-11 min-w-0 flex-1 bg-transparent text-2xl text-ink outline-none placeholder:text-ink-muted focus-visible:outline-none"
                />
                <TradeTokenChip token={t.pay} onClick={t.onPickPayToken} />
              </div>
              {t.pay.balance || t.payFiat ? (
                <span id={balanceId} className="text-[13px] text-ink-muted">
                  {t.pay.balance ? (
                    <>
                      Balance <span className="num">{t.pay.balance}</span> {t.pay.symbol}
                    </>
                  ) : null}
                  {t.payFiat ? <span className="num"> · {t.payFiat}</span> : null}
                </span>
              ) : null}
              {expanded ? <TradePresetChips presets={presets} idPrefix={id} /> : null}
            </div>

            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-ink-muted">You receive</span>
              <strong className="num truncate text-base">
                {t.receiveAmount || "0"} <span className="font-sans">{t.receive.symbol}</span>
              </strong>
            </div>

            {expanded ? (
              <>
                <Divider variant="dashed" />
                <TradeDetails receive={t.receive} priceImpact={t.priceImpact} minReceived={t.minReceived} fee={t.fee} sniperFee={t.sniperFee} />
              </>
            ) : null}
            <TradeCauseNote causeAmount={t.causeAmount} causeName={t.causeName} causeIcon={t.causeIcon} platformAmount={expanded ? t.platformAmount : undefined} compact />
            {t.notice}
          </DrawerBody>

          <DrawerFooter className={cn("flex-row items-center gap-2 px-5 py-3", !expanded && "mt-0")}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? "Fewer options" : "More options: presets, slippage and fees"}
              className="grid size-13 shrink-0 place-items-center rounded-full border-[1.5px] border-ink text-ink transition-colors hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {expanded ? <ChevronDown aria-hidden="true" className="size-5" /> : <ChevronUp aria-hidden="true" className="size-5" />}
            </button>
            <TradeActionButton state={action} onSubmit={t.onSubmit} className="flex-1" />
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
