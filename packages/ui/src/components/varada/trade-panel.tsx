// Adapted from 21st.dev @ssychui/swap-ticket (id 27122) and @ravikatiyar162/swap-card (id 7804)
"use client";

import { ChevronDown, Settings2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
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
 *
 * Under the pay input sit preset chips: amounts in the pay asset when buying (WETH sizes, or USD
 * sizes converted at `payPriceUsd`) and shares of the coin balance when selling, each showing the
 * amount it fills. A chip fills the input and stays pressed until the amount is edited.
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
  /**
   * Buy-side amount chips in the pay asset. Defaults: WETH 0.01 / 0.05 / 0.1 / 0.5; any asset with a
   * `payPriceUsd` (stablecoins assume $1) gets `buyPresetUsd` sizes converted into it; otherwise 25% /
   * 50% of the balance. A Max chip follows. `false` hides the chips.
   */
  buyPresets?: readonly TradePreset[] | false;
  /** USD per pay token, for the default USD-sized buy presets ("$50 = 0.3862 NVDAon"). */
  payPriceUsd?: number;
  /** USD sizes for the default buy presets (default 50 / 100 / 250 / 500). */
  buyPresetUsd?: readonly number[];
  /** Sell-side chips as percents of the coin balance (default 10 / 25 / 50 / 75 / 100; 100 is "Max"). `false` hides them. */
  sellPercents?: readonly number[] | false;
  /** Plain balance used to compute chip amounts ("3402.18"); defaults to `pay.balance` without commas. */
  payBalanceRaw?: string;
  /** What Max fills (default the whole balance; pass less for WETH to leave gas). */
  maxAmount?: string;
  /** Why the chips are disabled; defaults to "No <symbol> balance" when the balance is missing or zero. */
  presetsDisabledReason?: string;
  /** Called after a chip fills the pay input. */
  onPreset?: (preset: TradePresetChoice) => void;
  /** Percent chips call this too (kept for older callers; the chips now fill the input themselves). */
  onPercent?: (percent: number) => void;
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

/** A buy-side amount chip. */
export interface TradePreset {
  /** Stable id; also what `onPreset` reports. */
  key: string;
  /** Chip text ("0.05", "$100"). */
  label: string;
  /** Plain amount written into the pay input ("0.05", "0.7723"). */
  amount: string;
  /** Second line, e.g. the amount in the pay asset when the label is in USD. */
  detail?: string;
  /** Spoken name; defaults to "Pay <label> <symbol>". */
  ariaLabel?: string;
}

export interface TradePresetChoice {
  key: string;
  amount: string;
  /** Set for percent and Max chips. */
  percent?: number;
}

const STABLES = /^(USDC|USDT|DAI|USDS|PYUSD|USDON)$/i;
const ETHLIKE = /^W?ETH$/i;
export const WETH_BUY_PRESETS = ["0.01", "0.05", "0.1", "0.5"] as const;
export const DEFAULT_BUY_PRESET_USD = [50, 100, 250, 500] as const;
export const DEFAULT_SELL_PERCENTS = [10, 25, 50, 75, 100] as const;

/** "3,402.18" → 3402.18; null when it isn't a number. */
export function parseBalance(balance: string | undefined): number | null {
  if (!balance) return null;
  const n = Number(balance.replace(/[,\s_]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function trimFixed(n: number, decimals: number): string {
  const f = 10 ** decimals;
  const s = (Math.floor(n * f + 1e-9) / f).toFixed(decimals);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/**
 * A percent of a plain balance string, rounded down so it never exceeds the balance. 100 returns the
 * balance itself.
 */
export function percentOfBalance(raw: string, percent: number): string {
  const clean = raw.replace(/[,\s_]/g, "");
  if (percent >= 100) return clean;
  const n = Number(clean);
  if (!Number.isFinite(n) || n <= 0) return "0";
  const decimals = Math.min(8, Math.max(clean.split(".")[1]?.length ?? 0, 4));
  return trimFixed((n * percent) / 100, decimals);
}

/** USD converted into a token amount at `priceUsd`, rounded down with enough precision for small amounts. */
export function usdToTokenAmount(usd: number, priceUsd: number): string {
  if (!(priceUsd > 0)) return "0";
  const amount = usd / priceUsd;
  return trimFixed(amount, amount >= 100 ? 2 : amount >= 1 ? 4 : 6);
}

const compactAmount = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const sigAmount = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });
const fmtChipAmount = (s: string) => {
  const n = Number(s);
  return n >= 10_000 ? compactAmount.format(n) : sigAmount.format(n);
};

/** The default buy chips for a pay asset (see `TradePanelProps.buyPresets`). Empty when none apply. */
export function defaultBuyPresets(symbol: string, priceUsd?: number, sizesUsd: readonly number[] = DEFAULT_BUY_PRESET_USD): TradePreset[] {
  const sym = symbol.replace(/^\$/, "");
  if (ETHLIKE.test(sym)) return WETH_BUY_PRESETS.map((a) => ({ key: a, label: a, amount: a, ariaLabel: `Pay ${a} ${symbol}` }));
  const price = priceUsd ?? (STABLES.test(sym) ? 1 : undefined);
  if (!price) return [];
  return sizesUsd.map((usd) => {
    const amount = usdToTokenAmount(usd, price);
    const label = `$${usd.toLocaleString("en-US")}`;
    return {
      key: `usd-${usd}`,
      label,
      amount,
      detail: STABLES.test(sym) ? undefined : `${fmtChipAmount(amount)} ${symbol}`,
      ariaLabel: `Pay ${label} in ${symbol}, ${amount} ${symbol}`,
    };
  });
}

interface Chip {
  key: string;
  label: string;
  amount: string | null;
  percent?: number;
  detail?: string;
  ariaLabel: string;
  /** Read after the name (e.g. the resulting amount). */
  description?: string;
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
  buyPresets,
  payPriceUsd,
  buyPresetUsd,
  sellPercents,
  payBalanceRaw,
  maxAmount,
  presetsDisabledReason,
  onPreset,
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
  const reasonId = `${id}-preset-reason`;

  // Which chip filled the input; cleared by typing, switching side or the amount being emptied.
  const [picked, setPicked] = useState<{ side: TradeSide; key: string } | null>(null);
  const pressedKey = picked && picked.side === side && payAmount !== "" ? picked.key : null;

  const rawBalance = payBalanceRaw ?? pay.balance?.replace(/[,\s_]/g, "");
  const balance = parseBalance(rawBalance);
  const hasBalance = balance !== null && balance > 0;
  const chips = buildChips({ side, pay, rawBalance, hasBalance, buyPresets, payPriceUsd, buyPresetUsd, sellPercents, maxAmount });
  const chipsDisabled = !hasBalance;
  const disabledReason = chipsDisabled ? (presetsDisabledReason ?? `No ${pay.symbol} balance`) : null;

  const pick = (chip: Chip) => {
    const amount = chip.amount ?? "";
    setPicked({ side, key: chip.key });
    if (chip.amount !== null) onPayAmountChange(chip.amount);
    if (chip.percent !== undefined) onPercent?.(chip.percent);
    onPreset?.({ key: chip.key, amount, percent: chip.percent });
  };

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
              if (v === null) return;
              setPicked(null);
              onPayAmountChange(v);
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
        </div>
        {chips.length ? (
          <PresetChips
            chips={chips}
            label={side === "buy" ? `Amount presets in ${pay.symbol}` : `Sell a share of your ${pay.symbol} balance`}
            pressedKey={pressedKey}
            disabled={chipsDisabled}
            reasonId={disabledReason ? reasonId : undefined}
            idPrefix={id}
            onPick={pick}
          />
        ) : null}
        {disabledReason && chips.length ? (
          <p id={reasonId} className="m-0 text-xs text-ink-muted">
            {disabledReason}
          </p>
        ) : null}
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

function buildChips({
  side,
  pay,
  rawBalance,
  hasBalance,
  buyPresets,
  payPriceUsd,
  buyPresetUsd,
  sellPercents,
  maxAmount,
}: {
  side: TradeSide;
  pay: TradeToken;
  rawBalance: string | undefined;
  hasBalance: boolean;
  buyPresets: readonly TradePreset[] | false | undefined;
  payPriceUsd: number | undefined;
  buyPresetUsd: readonly number[] | undefined;
  sellPercents: readonly number[] | false | undefined;
  maxAmount: string | undefined;
}): Chip[] {
  const sym = pay.symbol;
  const percentChip = (p: number): Chip => {
    const amount = rawBalance && hasBalance ? (p >= 100 && maxAmount ? maxAmount : percentOfBalance(rawBalance, p)) : null;
    return {
      key: `pct-${p}`,
      label: p >= 100 ? "Max" : `${p}%`,
      amount,
      percent: p,
      detail: amount ? fmtChipAmount(amount) : undefined,
      ariaLabel: p >= 100 ? `Use your whole ${sym} balance` : `Use ${p}% of your ${sym} balance`,
      description: amount ? `${amount} ${sym}` : undefined,
    };
  };
  if (side === "sell") return sellPercents === false ? [] : (sellPercents ?? DEFAULT_SELL_PERCENTS).map(percentChip);
  if (buyPresets === false) return [];
  const presets = buyPresets ?? defaultBuyPresets(sym, payPriceUsd, buyPresetUsd);
  if (!presets.length) return [25, 50, 100].map(percentChip);
  return [
    ...presets.map<Chip>((p) => ({ key: p.key, label: p.label, amount: p.amount, detail: p.detail, ariaLabel: p.ariaLabel ?? `Pay ${p.label} ${sym}` })),
    percentChip(100),
  ];
}

const CHIP_NAV_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];

/** Toggle buttons (aria-pressed) in a group; arrow keys, Home and End move between them. */
function PresetChips({
  chips,
  label,
  pressedKey,
  disabled,
  reasonId,
  idPrefix,
  onPick,
}: {
  chips: Chip[];
  label: string;
  pressedKey: string | null;
  disabled: boolean;
  reasonId?: string;
  idPrefix: string;
  onPick: (chip: Chip) => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!CHIP_NAV_KEYS.includes(e.key)) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const i = buttons.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const n = buttons.length;
    const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    buttons[next]?.focus();
  };
  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={reasonId}
      onKeyDown={onKeyDown}
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${chips.length}, minmax(0, 1fr))` }}
    >
      {chips.map((c) => {
        const pressed = c.key === pressedKey;
        const descId = c.description ? `${idPrefix}-chip-${c.key}` : undefined;
        const describedBy = [descId, reasonId].filter(Boolean).join(" ") || undefined;
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={pressed}
            aria-label={c.ariaLabel}
            aria-describedby={describedBy}
            disabled={disabled}
            onClick={() => onPick(c)}
            className={cn(
              "group flex min-h-11 min-w-0 flex-col items-center justify-center rounded-xl border border-line-strong bg-paper-card px-1 py-1 text-ink transition-colors",
              "hover:bg-sand aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-paper aria-pressed:hover:bg-ink-soft",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-paper-card",
            )}
          >
            <span className="num text-[13px] font-semibold leading-tight">{c.label}</span>
            {c.detail ? <span className="num max-w-full truncate text-[11px] leading-tight text-ink-muted group-aria-pressed:text-paper/85">{c.detail}</span> : null}
            {descId ? (
              <span id={descId} className="sr-only">
                {c.description}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
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
