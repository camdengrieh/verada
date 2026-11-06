// Adapted from 21st.dev @molecule-lab-rushil/swipe-row-1 (id 5160): a motion `drag="x"` row that
// reveals leading and trailing action trays past a threshold. Here each side holds one action
// (watch on the left, buy on the right), a long swipe runs it straight away, and every action also
// has a button route: an "Actions" toggle opens a strip of real buttons under the row for keyboard,
// switch and screen-reader users, and Escape closes it.
"use client";

import { Ellipsis, ShoppingBag, Star, type LucideIcon } from "lucide-react";
import { animate, motion, useMotionValue, useReducedMotion, type PanInfo } from "motion/react";
import { useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { TokenRow, type TokenRowProps } from "@varada/ui/components/varada/token-row";
import { cn } from "@varada/ui/lib/utils";

export type SwipeActionTone = "primary" | "cause" | "ink" | "ochre";

export interface SwipeAction {
  /** Button text and accessible name ("Watch", "Buy"). */
  label: string;
  icon?: LucideIcon;
  onAction: () => void;
  tone?: SwipeActionTone;
  /** For toggles such as Watch / Watching. */
  pressed?: boolean;
}

const TONE: Record<SwipeActionTone, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-terracotta-strong",
  cause: "bg-sage text-primary-foreground hover:bg-sage-ink",
  ink: "bg-ink text-paper hover:bg-ink-soft",
  ochre: "bg-ochre-tint text-ochre-ink hover:brightness-95",
};

export interface SwipeRowProps extends Omit<ComponentProps<"div">, "children"> {
  /**
   * The row. A render function receives the Actions toggle to place inside it (e.g. a TokenRow's
   * `trailing` slot); plain children get the toggle beside them.
   */
  children: ReactNode | ((actionsToggle: ReactNode) => ReactNode);
  /** Revealed by swiping right (the leading edge), e.g. Watch. */
  startAction?: SwipeAction;
  /** Revealed by swiping left (the trailing edge), e.g. Buy. */
  endAction?: SwipeAction;
  /** What the row is, for the toggle's name ("Actions for Harambe's Wish"). */
  label: string;
  /** Width of each swipe tray in px. */
  actionWidth?: number;
  /** Fraction of the row's width past which a swipe runs the action (default 0.45). */
  fullSwipe?: number;
  disabled?: boolean;
  /** Corner radius of the row, so the trays match it. */
  radiusClassName?: string;
}

type Revealed = "start" | "end" | null;

/**
 * A list row with swipe actions. Swipe a little to reveal an action, further to run it. Dragging only
 * starts on a mostly horizontal move, so vertical scrolling is untouched, and a drag never also opens
 * the row's link; a tap on a revealed row closes it. The swipe trays are a pointer shortcut only:
 * the Actions toggle (always there, 48px) opens the same actions as real buttons under the row, the
 * first takes focus, and Escape closes them. Under reduced motion the row snaps instead of springing.
 */
export function SwipeRow({
  children,
  startAction,
  endAction,
  label,
  actionWidth = 88,
  fullSwipe = 0.45,
  disabled,
  radiusClassName = "rounded-[20px]",
  className,
  ...props
}: SwipeRowProps) {
  const reduced = useReducedMotion();
  const id = useId();
  const panelId = `${id}-actions`;
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const dragged = useRef(false);
  const [revealed, setRevealed] = useState<Revealed>(null);
  const [expanded, setExpanded] = useState(false);
  const [dragging, setDragging] = useState(false);

  const reveal = (side: Revealed) => {
    setRevealed(side);
    const to = side === "start" ? actionWidth : side === "end" ? -actionWidth : 0;
    if (reduced) x.set(to);
    else animate(x, to, { type: "spring", stiffness: 520, damping: 42 });
  };

  useEffect(() => {
    if (expanded) panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [expanded]);

  const run = (action: SwipeAction | undefined) => {
    if (!action) return;
    action.onAction();
    reveal(null);
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const width = rootRef.current?.offsetWidth ?? 320;
    const dx = info.offset.x;
    const flick = Math.abs(info.velocity.x) > 900 && Math.abs(dx) > actionWidth;
    if (dx > 0 && startAction) {
      if (dx > width * fullSwipe || flick) return run(startAction);
      if (dx > actionWidth / 2) return reveal("start");
    } else if (dx < 0 && endAction) {
      if (-dx > width * fullSwipe || flick) return run(endAction);
      if (-dx > actionWidth / 2) return reveal("end");
    }
    reveal(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || (!expanded && !revealed)) return;
    e.stopPropagation();
    setExpanded(false);
    reveal(null);
    toggleRef.current?.focus();
  };

  const toggle = (
    <button
      ref={toggleRef}
      type="button"
      aria-label={`Actions for ${label}`}
      aria-expanded={expanded}
      aria-controls={panelId}
      disabled={disabled}
      onClick={() => {
        reveal(null);
        setExpanded((v) => !v);
      }}
      className="relative z-10 grid size-12 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-sand hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
    >
      <Ellipsis aria-hidden="true" className="size-5" />
    </button>
  );

  const actions = [startAction, endAction].filter((a): a is SwipeAction => !!a);

  const tray = (side: "start" | "end", action: SwipeAction) => {
    const Icon = action.icon;
    return (
      <button
        type="button"
        tabIndex={-1}
        onClick={() => run(action)}
        className={cn(
          "absolute inset-y-0 flex flex-col items-center justify-center gap-1 text-[13px] font-semibold",
          side === "start" ? "left-0 pr-2" : "right-0 pl-2",
          TONE[action.tone ?? (side === "start" ? "ochre" : "primary")],
        )}
        style={{ width: actionWidth + 16 }}
      >
        {Icon ? <Icon aria-hidden="true" className="size-5" fill={action.pressed ? "currentColor" : "none"} /> : null}
        {action.label}
      </button>
    );
  };

  const row =
    typeof children === "function" ? (
      children(toggle)
    ) : (
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">{children}</div>
        {toggle}
      </div>
    );

  return (
    <div ref={rootRef} data-slot="swipe-row" data-revealed={revealed ?? undefined} onKeyDown={onKeyDown} className={cn("flex flex-col gap-1.5", className)} {...props}>
      <div className={cn("relative isolate overflow-hidden", radiusClassName)}>
        {/* Pointer-only shortcut behind the row; the buttons below are the accessible route. */}
        <div aria-hidden="true" className={cn("absolute inset-0 -z-10", revealed || dragging ? "visible" : "invisible")}>
          {startAction ? tray("start", startAction) : null}
          {endAction ? tray("end", endAction) : null}
        </div>
        <motion.div
          className="relative touch-pan-y"
          style={{ x }}
          drag={disabled ? false : "x"}
          dragDirectionLock
          dragConstraints={{ left: endAction ? -10_000 : 0, right: startAction ? 10_000 : 0 }}
          dragElastic={0.06}
          dragMomentum={false}
          onPointerDown={() => {
            dragged.current = false;
          }}
          onDragStart={() => {
            dragged.current = true;
            setDragging(true);
          }}
          onDragEnd={(e, info) => {
            setDragging(false);
            onDragEnd(e, info);
          }}
          onClickCapture={(e: MouseEvent) => {
            // A drag ends with a click on whatever was under the pointer; swallow it.
            if (dragged.current) {
              e.preventDefault();
              e.stopPropagation();
              dragged.current = false;
              return;
            }
            // A tap on a revealed row just closes it.
            if (revealed) {
              e.preventDefault();
              e.stopPropagation();
              reveal(null);
            }
          }}
        >
          {row}
        </motion.div>
      </div>
      <div ref={panelRef} id={panelId} role="group" aria-label={`Actions for ${label}`} hidden={!expanded} className="grid auto-cols-fr grid-flow-col gap-2">
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <button
              key={a.label}
              type="button"
              aria-pressed={a.pressed}
              onClick={() => {
                a.onAction();
                setExpanded(false);
                toggleRef.current?.focus();
              }}
              className={cn(
                "inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl px-4 text-[15px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                TONE[a.tone ?? (a === startAction ? "ochre" : "primary")],
              )}
            >
              {Icon ? <Icon aria-hidden="true" className="size-[18px]" fill={a.pressed ? "currentColor" : "none"} /> : null}
              {a.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface TokenSwipeRowProps extends Omit<TokenRowProps, "trailing"> {
  /** Whether the coin is on the watchlist (the Watch action reads "Watching" and is pressed). */
  watching?: boolean;
  onWatch?: () => void;
  onBuy?: () => void;
  /** Class for the SwipeRow wrapper (`className` goes to the TokenRow). */
  swipeClassName?: string;
}

/** A TokenRow with Watch (swipe right) and Buy (swipe left), and the Actions toggle in its trailing slot. */
export function TokenSwipeRow({ watching, onWatch, onBuy, swipeClassName, token, ...rowProps }: TokenSwipeRowProps) {
  return (
    <SwipeRow
      label={token.name}
      className={swipeClassName}
      startAction={onWatch ? { label: watching ? "Watching" : "Watch", icon: Star, onAction: onWatch, pressed: !!watching, tone: "ochre" } : undefined}
      endAction={onBuy ? { label: "Buy", icon: ShoppingBag, onAction: onBuy, tone: "primary" } : undefined}
    >
      {(toggle) => <TokenRow token={token} trailing={toggle} {...rowProps} />}
    </SwipeRow>
  );
}
