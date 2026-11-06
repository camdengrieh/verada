"use client";
// Adapted from 21st.dev @rmahammad/magnetic-dock (id 23415, from Motiq): a dock whose icons swell
// under one shared gaussian field around the pointer, so neighbours yield too, with a label chip
// over the dominant icon and keyboard focus bending the field like a hover. Varada version: built
// on motion springs (no hand-rolled rAF loop), a paper shelf with pigment-washed tiles, a toolbar
// role with arrow-key roving focus, 44px tiles at rest, and a plain CSS lift under reduced motion.
import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from "motion/react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { cn } from "@verada/ui/lib/utils";

export interface DockAction {
  id: string;
  /** Accessible name and the label chip. */
  label: string;
  icon: ReactNode;
  /** Tile wash. */
  tone?: "terracotta" | "sage" | "ochre" | "sky" | "ink";
  onSelect?: () => void;
  disabled?: boolean;
}

export interface DockProps {
  actions: DockAction[];
  /** Accessible name for the toolbar, e.g. "Quick actions". */
  label: string;
  /** Scale of the tile right under the pointer. */
  magnification?: number;
  /** Spread of the field in px; bigger reaches more neighbours. */
  reach?: number;
  className?: string;
}

const TONE: Record<NonNullable<DockAction["tone"]>, string> = {
  terracotta: "bg-terracotta-tint text-terracotta-strong",
  sage: "bg-sage-tint text-sage-ink",
  ochre: "bg-ochre-tint text-ochre-ink",
  sky: "bg-stock-tint text-stock-ink",
  ink: "bg-ink text-paper",
};

const BASE = 44;

function Tile({
  action,
  index,
  pointer,
  magnification,
  reach,
  focused,
  reduced,
  tabIndex,
  register,
  onFocusTile,
  onKey,
}: {
  action: DockAction;
  index: number;
  pointer: MotionValue<number>;
  magnification: number;
  reach: number;
  focused: boolean;
  reduced: boolean;
  tabIndex: number;
  register: (i: number, el: HTMLButtonElement | null) => void;
  onFocusTile: (i: number) => void;
  onKey: (e: KeyboardEvent<HTMLButtonElement>, i: number) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [hot, setHot] = useState(false);
  const distance = useTransform(pointer, (x) => {
    // Measure the tile's slot (the li), whose offsetParent is the shelf.
    const el = ref.current?.parentElement;
    if (!el || !Number.isFinite(x)) return Infinity;
    return x - (el.offsetLeft + el.offsetWidth / 2);
  });
  const influence = useTransform(distance, (d) => (Number.isFinite(d) ? Math.exp(-(d * d) / (2 * reach * reach)) : 0));
  const size = useSpring(
    useTransform(influence, (k) => BASE * (1 + (magnification - 1) * k)),
    { stiffness: 380, damping: 24, mass: 0.4 },
  );
  const lift = useTransform(size, (s) => -(s - BASE) * 0.45);

  return (
    <motion.li className="relative flex items-end" style={reduced ? undefined : { width: size, height: size, y: lift }}>
      <button
        ref={(el) => {
          ref.current = el;
          register(index, el);
        }}
        type="button"
        aria-label={action.label}
        disabled={action.disabled}
        tabIndex={tabIndex}
        onClick={action.onSelect}
        onPointerEnter={() => setHot(true)}
        onPointerLeave={() => setHot(false)}
        onFocus={() => onFocusTile(index)}
        onKeyDown={(e) => onKey(e, index)}
        className={cn(
          "grid size-full min-h-11 min-w-11 place-items-center rounded-2xl border border-line shadow-paper outline-none transition-colors",
          "focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 [&_svg]:size-[45%] [&_svg]:min-w-5 [&_svg]:min-h-5",
          TONE[action.tone ?? "ink"],
          reduced && "size-11 transition-transform hover:-translate-y-1.5 focus-visible:-translate-y-1.5",
        )}
      >
        {action.icon}
      </button>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1 text-xs font-semibold text-paper shadow-paper transition-[opacity,translate] duration-150",
          hot || focused ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
        )}
      >
        {action.label}
      </span>
    </motion.li>
  );
}

/** A shelf of quick actions (trade, give, vote, share) that swells under the pointer. */
export function Dock({ actions, label, magnification = 1.55, reach = 60, className }: DockProps) {
  const reduced = usePrefersReducedMotion();
  const pointer = useMotionValue(Number.POSITIVE_INFINITY);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const [current, setCurrent] = useState(0);
  const [focusWithin, setFocusWithin] = useState(false);
  const list = useRef<HTMLUListElement>(null);

  const centreOf = (i: number) => {
    const el = tiles.current[i]?.parentElement;
    return el ? el.offsetLeft + el.offsetWidth / 2 : Number.POSITIVE_INFINITY;
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = actions.length;
    const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    tiles.current[to]?.focus();
  };

  return (
    <div role="toolbar" aria-label={label} aria-orientation="horizontal" data-slot="dock" className={cn("flex justify-center pt-12", className)}>
      <ul
        ref={list}
        className="relative flex h-[68px] items-end gap-2.5 rounded-[1.6rem] border border-line-strong bg-paper-card px-3 pb-3 shadow-float"
        onPointerMove={(e) => {
          if (reduced || e.pointerType === "touch") return;
          const r = e.currentTarget.getBoundingClientRect();
          pointer.set(e.clientX - r.left - e.currentTarget.clientLeft);
        }}
        onPointerLeave={() => pointer.set(focusWithin ? centreOf(current) : Number.POSITIVE_INFINITY)}
        onFocus={() => setFocusWithin(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setFocusWithin(false);
            pointer.set(Number.POSITIVE_INFINITY);
          }
        }}
      >
        {actions.map((a, i) => (
          <Tile
            key={a.id}
            action={a}
            index={i}
            pointer={pointer}
            magnification={magnification}
            reach={reach}
            focused={focusWithin && current === i}
            reduced={reduced}
            tabIndex={i === current ? 0 : -1}
            register={(idx, el) => {
              tiles.current[idx] = el;
            }}
            onFocusTile={(idx) => {
              setCurrent(idx);
              if (!reduced) pointer.set(centreOf(idx));
            }}
            onKey={onKey}
          />
        ))}
      </ul>
    </div>
  );
}
