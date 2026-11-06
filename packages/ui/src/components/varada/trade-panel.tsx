// Adapted from 21st.dev @ssychui/swap-ticket (id 27122) and @ravikatiyar162/swap-card (id 7804)
"use client";

import { ChevronDown, Settings2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Popover, RadioGroup } from "radix-ui";
import { Button } from "@verada/ui/components/ui/button";
import { cn } from "@verada/ui/lib/utils";
import { CauseIcon, type CauseName } from "./cause-icon";
import { HIT_AREA, type ImageSource } from "./shared";
import { StockLogo, type QuoteKind } from "./stock-logo";

/**
 * Buy/sell ticket for a Varada coin. Presentational: the app computes the quote and passes amounts,
 * impact and fees back in. Following the Swap Ticket, the primary button's label IS the validation
 * state: it names whatever blocks the trade ("Connect wallet", "Enter an amount", "Insufficient
 * NVDAon balance") and only reads "Review buy" when the trade can go ahead.
 */

export type TradeSide = "buy" | "sell";

export interface TradeToken {
  symbol: string;
  kind?: QuoteKind;
  logo?: ImageSource;
  /** Balance as it should print ("3,402.18"). */
  balance?: string;
}

export interface TradeBlocker {
  /** Button label naming the blocker. */
  label: string;
  /** When given, the button stays enabled and runs this (e.g. connect the wallet). */
  onAction?: () => void;
}

export interface SniperFeeState {
  active: boolean;
  /** "12% · ends in 4m" while active. */
  detail?: string;
}

export interface TradePanelProps extends Omit<ComponentProps<"section">, "children" | "onSubmit"> {
  side: TradeSide;
  onSideChange: (side: TradeSide) => void;
  /** The token being paid and the one received, for the current side. */
  pay: TradeToken;
  receive: TradeToken;
  payAmount: string;
  onPayAmountChange: (value: string) => void;
  /** Estimated output, formatted. */
  receiveAmount: string;
  /** Fiat value of the pay amount ("$1,249.50"). */
  payFiat?: string;
  /** Percent chips under the pay input; 100 is "Max". */
  onPercent?: (percent: 25 | 50 | 100) => void;
  onPickPayToken?: () => void;
  /** Slippage tolerance in percent. */
  slippage: number;
  onSlippageChange?: (percent: number) => void;
  slippagePresets?: readonly number[];
  /** Price impact in percent; coloured and labelled by severity. */
  priceImpact?: number;
  minReceived?: string;
  /** Trading fee, formatted ("2.5%"). */
  fee: string;
  sniperFee?: SniperFeeState;
  /** The cause share of this trade's fee ("$28.11") and where it goes. */
  causeAmount?: string;
  causeName: string;
  causeIcon?: CauseName;
  platformAmount?: string;
  /** Something that stops the trade. Without one, an empty amount still blocks. */
  blocker?: TradeBlocker | null;
  /** Shows "Confirm in your wallet" and disables the button. */
  pending?: boolean;
  onSubmit: () => void;
  /** Slot above the action (e.g. a market-closed note). */
  notice?: ReactNode;
}

export type ImpactSeverity = "low" | "medium" | "high";

/** Under 1% is fine, under 3% worth a look, 3% or more a warning. */
export function impactSeverity(percent: number): ImpactSeverity {
  if (percent >= 3) return "high";
  if (percent >= 1) return "medium";
  return "low";
}

const IMPACT_TONE: Record<ImpactSeverity, string> = {
  low: "text-gain",
  medium: "text-ochre-ink",
  high: "text-loss font-semibold",
};

/** The pay amount input accepts digits with one decimal point (pasted commas are dropped). */
export function sanitizeAmount(value: string): string | null {
  const v = value.replace(/,/g, "");
  return /^\d*\.?\d*$/.test(v) ? v : null;
}

export function TradePanel({
  side,
  onSideChange,
  pay,
  receive,
  payAmount,
  onPayAmountChange,
  receiveAmount,
  payFiat,
  onPercent,
  onPickPayToken,
  slippage,
  onSlippageChange,
  slippagePresets = [0.5, 1, 2, 3],
  priceImpact,
  minReceived,
  fee,
  sniperFee,
  causeAmount,
  causeName,
  causeIcon,
  platformAmount,
  blocker,
  pending,
  onSubmit,
  notice,
  className,
  ...props
}: TradePanelProps) {
  const reduced = useReducedMotion();
  const id = useId();
  const payId = `${id}-pay`;
  const receiveId = `${id}-receive`;
  const balanceId = `${id}-balance`;

  const empty = !(parseFloat(payAmount) > 0);
  const effective: TradeBlocker | null = blocker ?? (empty ? { label: "Enter an amount" } : null);
  const label = pending ? "Confirm in your wallet" : effective ? effective.label : side === "buy" ? "Review buy" : "Review sell";
  const actionable = !pending && (!effective || !!effective.onAction);
  const severity = priceImpact === undefined ? undefined : impactSeverity(priceImpact);

  return (
    <section
      aria-label={side === "buy" ? `Buy ${receive.symbol}` : `Sell ${pay.symbol}`}
      className={cn("flex flex-col gap-3.5 rounded-[26px] border border-line bg-card p-5 shadow-paper", className)}
      {...props}
    >
      <div className="flex items-center gap-2">
        <RadioGroup.Root
          value={side}
          onValueChange={(v) => onSideChange(v as TradeSide)}
          aria-label="Trade side"
          orientation="horizontal"
          className="flex flex-1 rounded-full bg-sand p-1"
        >
          {(["buy", "sell"] as const).map((s) => (
            <RadioGroup.Item
              key={s}
              value={s}
              className={cn(
                "min-h-11 flex-1 rounded-full text-[15px] font-semibold text-ink transition-colors",
                "data-[state=checked]:text-primary-foreground",
                s === "buy" ? "data-[state=checked]:bg-sage" : "data-[state=checked]:bg-primary",
                "data-[state=unchecked]:hover:bg-line",
              )}
            >
              {s === "buy" ? "Buy" : "Sell"}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
        <SlippageControl value={slippage} onChange={onSlippageChange} presets={slippagePresets} />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={payId} className="text-[13px] text-ink-muted">
          You pay
        </label>
        <div className="flex items-center gap-2.5 rounded-[14px] border-[1.5px] border-line-strong bg-paper-card py-2.5 pl-3.5 pr-3 focus-within:border-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
          <input
            id={payId}
            value={payAmount}
            onChange={(e) => {
              const v = sanitizeAmount(e.target.value);
              if (v !== null) onPayAmountChange(v);
            }}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            aria-describedby={pay.balance ? balanceId : undefined}
            className="num min-w-0 flex-1 bg-transparent text-[26px] text-ink outline-none placeholder:text-ink-muted focus-visible:outline-none"
          />
          <TokenChip token={pay} onClick={onPickPayToken} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-muted">
          <span id={balanceId}>
            {pay.balance ? (
              <>
                Balance <span className="num">{pay.balance}</span> {pay.symbol}
              </>
            ) : null}
            {payFiat ? <span className="num"> · {payFiat}</span> : null}
          </span>
          {onPercent ? (
            <span className="flex gap-1.5" role="group" aria-label="Amount presets">
              {([25, 50, 100] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPercent(p)}
                  aria-label={p === 100 ? `Use your whole ${pay.symbol} balance` : `Use ${p}% of your ${pay.symbol} balance`}
                  className={cn(HIT_AREA, "min-h-9 rounded-full border border-line px-3 text-xs font-medium text-ink transition-colors hover:bg-sand")}
                >
                  {p === 100 ? "Max" : `${p}%`}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={receiveId} className="text-[13px] text-ink-muted">
          You receive (estimated)
        </label>
        <div className="flex items-center gap-2.5 rounded-[14px] bg-paper py-2.5 pl-3.5 pr-3">
          <input
            id={receiveId}
            value={receiveAmount}
            readOnly
            tabIndex={-1}
            placeholder="0"
            className="num min-w-0 flex-1 bg-transparent text-[26px] text-ink outline-none placeholder:text-ink-muted"
          />
          <span className="inline-flex items-center gap-1.5 font-semibold">
            {receive.kind ? <StockLogo symbol={receive.symbol} kind={receive.kind} src={receive.logo?.src} srcSet={receive.logo?.srcSet} size={24} decorative /> : null}
            {receive.symbol}
          </span>
        </div>
      </div>

      <dl className="m-0 flex flex-col gap-2 text-sm">
        {priceImpact !== undefined && severity ? (
          <Row term="Price impact">
            <span className={cn("num", IMPACT_TONE[severity])}>
              {severity === "high" ? "High · " : null}
              {priceImpact.toFixed(2)}%
            </span>
            {severity !== "low" ? <span className="sr-only">{severity === "high" ? ", high: you may get a much worse price" : ", moderate"}</span> : null}
          </Row>
        ) : null}
        {minReceived ? (
          <Row term="Minimum received">
            <span className="num">
              {minReceived} {receive.symbol}
            </span>
          </Row>
        ) : null}
        <Row term="Trading fee">
          <span className="num">{fee}</span>
          {sniperFee ? (
            <span className={cn(sniperFee.active ? "font-semibold text-loss" : "text-ink-muted")}>
              {" · "}
              {sniperFee.active ? `sniper fee ${sniperFee.detail ?? "active"}` : "sniper fee ended"}
            </span>
          ) : null}
        </Row>
      </dl>

      {causeAmount ? (
        <div className="flex items-center gap-2.5 rounded-[14px] bg-sage-tint p-3 text-sm text-sage-ink">
          {causeIcon ? <CauseIcon cause={causeIcon} size={40} decorative /> : null}
          <p className="m-0">
            <strong className="num">{causeAmount}</strong> of this trade&apos;s fee goes to {causeName}
            {platformAmount ? (
              <>
                , <strong className="num">{platformAmount}</strong> to Varada
              </>
            ) : null}
            .
          </p>
        </div>
      ) : null}

      {notice}

      <Button
        size="lg"
        disabled={!actionable}
        onClick={() => {
          if (effective?.onAction) effective.onAction();
          else if (!effective) onSubmit();
        }}
        className="h-13 w-full text-[17px]"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={label}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: reduced ? 0 : 0.14, ease: [0.16, 1, 0.3, 1] }}
            className="block"
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </Button>
    </section>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{term}</dt>
      <dd className="m-0 text-right">{children}</dd>
    </div>
  );
}

function TokenChip({ token, onClick }: { token: TradeToken; onClick?: () => void }) {
  const content = (
    <>
      <StockLogo symbol={token.symbol} kind={token.kind ?? "stock"} src={token.logo?.src} srcSet={token.logo?.srcSet} size={24} decorative />
      {token.symbol}
    </>
  );
  if (!onClick) return <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-paper py-1.5 pl-1.5 pr-2.5 text-sm font-semibold">{content}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Pay with ${token.symbol}, change token`}
      className={cn(HIT_AREA, "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full bg-paper py-1.5 pl-1.5 pr-2.5 text-sm font-semibold text-ink hover:bg-sand")}
    >
      {content}
      <ChevronDown aria-hidden="true" className="size-3.5 text-ink-muted" />
    </button>
  );
}

function SlippageControl({ value, onChange, presets }: { value: number; onChange?: (v: number) => void; presets: readonly number[] }) {
  const [custom, setCustom] = useState("");
  const inputId = useId();
  const fmt = (v: number) => `${v}%`;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Slippage settings, currently ${fmt(value)}`}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line-strong bg-paper-card px-3 text-[13px] font-semibold text-ink hover:bg-sand"
        >
          <span className="num">{fmt(value)}</span>
          <Settings2 aria-hidden="true" className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 flex w-72 flex-col gap-3 rounded-2xl border border-line bg-popover p-4 text-popover-foreground shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="flex flex-col gap-0.5">
            <span className="font-display text-lg font-semibold">Slippage tolerance</span>
            <span className="text-[13px] text-ink-muted">The trade reverts if the price moves more than this.</span>
          </div>
          <RadioGroup.Root
            value={presets.includes(value) ? String(value) : ""}
            onValueChange={(v) => {
              setCustom("");
              onChange?.(Number(v));
            }}
            aria-label="Slippage presets"
            orientation="horizontal"
            className="grid grid-cols-4 gap-1.5"
          >
            {presets.map((p) => (
              <RadioGroup.Item
                key={p}
                value={String(p)}
                className="num min-h-11 rounded-full border border-line text-sm font-semibold text-ink hover:bg-sand data-[state=checked]:border-ink data-[state=checked]:bg-ink data-[state=checked]:text-paper"
              >
                {fmt(p)}
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
          <div className="flex items-center gap-2">
            <label htmlFor={inputId} className="text-[13px] text-ink-soft">
              Custom
            </label>
            <div className="flex flex-1 items-center rounded-[10px] border-[1.5px] border-line-strong bg-paper-card px-3 focus-within:border-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
              <input
                id={inputId}
                value={custom}
                inputMode="decimal"
                placeholder={presets.includes(value) ? "0.8" : String(value)}
                onChange={(e) => {
                  const v = sanitizeAmount(e.target.value);
                  if (v === null) return;
                  setCustom(v);
                  const n = parseFloat(v);
                  if (n > 0 && n <= 50) onChange?.(n);
                }}
                className="num min-h-11 min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:outline-none"
              />
              <span aria-hidden="true" className="text-sm text-ink-muted">
                %
              </span>
            </div>
          </div>
          {value >= 5 ? (
            <p role="note" className="m-0 rounded-[10px] bg-terracotta-tint px-3 py-2 text-[13px] text-terracotta-strong">
              High slippage: the trade can fill at a much worse price.
            </p>
          ) : null}
          <Popover.Arrow className="fill-popover" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
