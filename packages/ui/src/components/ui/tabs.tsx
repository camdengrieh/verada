"use client";
// Adapted from 21st.dev @ln-dev7/animated-navigation-tabs (id 575): an active underline and a hover
// wash that glide between tabs via motion layoutId. Rebuilt on Radix Tabs (tablist roles, arrow keys,
// panels) with a `pill` variant; indicators jump without animation under reduced motion.
// Further variants: `segmented` follows @educalvolpz/animated-tabs (id 24930, segment variant),
// `vertical` follows @0xUrvish/vertical-tabs (id 10473, a side rail with a growing indicator),
// `card` follows @originui/tabs file-tabs (id 425), and `scrollable` lists follow
// @kuratlielia/tabs (id 35021: edge fades, arrow buttons, keeping the active tab in view).
// `brush` is written for Varada: a painted stroke that slides to the new tab and redraws.
import { ChevronLeft, ChevronRight } from "lucide-react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { Tabs as TabsPrimitive } from "radix-ui";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "@varada/ui/lib/utils";

/**
 * - `underline` (default): page sections, hairline under the row.
 * - `pill`: compact panels; a paper chip slides on sand.
 * - `brush`: a painted ochre stroke under the active label that slides and redraws.
 * - `segmented`: a bordered control where an ink fill slides behind the active option.
 * - `card`: folder tabs; the active tab is the same sheet of paper as its panel.
 * - `vertical`: a side rail (arrow up/down) with a terracotta indicator.
 */
export type TabsVariant = "underline" | "pill" | "brush" | "segmented" | "card" | "vertical";

interface TabsCtx {
  value: string | undefined;
  hovered: string | null;
  setHovered: (v: string | null) => void;
  variant: TabsVariant;
  animate: boolean;
}
const TabsContext = createContext<TabsCtx | null>(null);

function useTabs(): TabsCtx {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tabs parts must be used inside <Tabs>.");
  return ctx;
}

export interface TabsProps extends ComponentProps<typeof TabsPrimitive.Root> {
  /** Visual style; see {@link TabsVariant}. `vertical` also sets `orientation="vertical"`. */
  variant?: TabsVariant;
}

const ROOT: Record<TabsVariant, string> = {
  underline: "flex flex-col gap-4",
  pill: "flex flex-col gap-4",
  brush: "flex flex-col gap-4",
  segmented: "flex flex-col gap-4",
  card: "flex flex-col",
  vertical: "flex flex-col gap-4 sm:flex-row sm:gap-6",
};

export function Tabs({ className, variant = "underline", value, defaultValue, onValueChange, orientation, ...props }: TabsProps) {
  const id = useId();
  const reduced = useReducedMotion();
  const [internal, setInternal] = useState(defaultValue);
  const [hovered, setHovered] = useState<string | null>(null);
  const current = value ?? internal;
  return (
    <TabsContext.Provider value={{ value: current, hovered, setHovered, variant, animate: !reduced }}>
      <LayoutGroup id={id}>
        <TabsPrimitive.Root
          data-slot="tabs"
          data-variant={variant}
          value={value}
          defaultValue={defaultValue}
          orientation={orientation ?? (variant === "vertical" ? "vertical" : "horizontal")}
          onValueChange={(next) => {
            if (value === undefined) setInternal(next);
            onValueChange?.(next);
          }}
          className={cn(ROOT[variant], className)}
          {...props}
        />
      </LayoutGroup>
    </TabsContext.Provider>
  );
}

const LIST: Record<TabsVariant, string> = {
  underline: "gap-1 border-b border-line",
  pill: "gap-1 rounded-full bg-sand p-1",
  brush: "gap-1",
  segmented: "gap-1 rounded-2xl border border-line-strong bg-paper-card p-1",
  card: "relative z-10 items-end gap-1 px-2 before:absolute before:inset-x-0 before:bottom-0 before:-z-10 before:h-px before:bg-line-strong",
  vertical: "flex-col items-stretch gap-0.5 border-l border-line sm:w-56 sm:shrink-0",
};

export interface TabsListProps extends ComponentProps<typeof TabsPrimitive.List> {
  /**
   * Let a long row scroll sideways (mobile, many epochs or causes): soft paper fades mark the
   * cut-off edges, arrow buttons page through, and the active tab is kept in view. Horizontal only.
   */
  scrollable?: boolean;
  /** Accessible names for the arrow buttons. */
  scrollLabels?: { previous: string; next: string };
}

export function TabsList({ className, onPointerLeave, scrollable = false, scrollLabels, ...props }: TabsListProps) {
  const { variant, setHovered } = useTabs();
  const list = (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      onPointerLeave={(e) => {
        setHovered(null);
        onPointerLeave?.(e);
      }}
      className={cn(
        "inline-flex max-w-full items-center",
        scrollable ? "w-max" : "relative w-fit overflow-x-auto",
        LIST[variant],
        className,
      )}
      {...props}
    />
  );
  if (!scrollable || variant === "vertical") return list;
  return <ScrollShell labels={scrollLabels}>{list}</ScrollShell>;
}

/** Overflow frame for a scrollable tab row: fades, arrows, active tab kept in view. */
function ScrollShell({ children, labels }: { children: ReactNode; labels?: { previous: string; next: string } }) {
  const { value, animate } = useTabs();
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ overflow: false, start: false, end: false });

  const update = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const next = { overflow: max > 1, start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 };
    setEdges((prev) => (prev.overflow === next.overflow && prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  const reveal = useCallback(
    (tab: HTMLElement | null) => {
      const el = viewport.current;
      if (!el || !tab || typeof el.scrollBy !== "function") return;
      const frame = el.getBoundingClientRect();
      const item = tab.getBoundingClientRect();
      const pad = 48; // room for the arrow button that covers each edge
      const delta = item.left < frame.left + pad ? item.left - frame.left - pad : item.right > frame.right - pad ? item.right - frame.right + pad : 0;
      if (delta) el.scrollBy({ left: delta, behavior: animate ? "smooth" : "auto" });
    },
    [animate],
  );

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [update]);

  useLayoutEffect(() => {
    reveal(viewport.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]') ?? null);
  }, [value, reveal]);

  const page = (dir: -1 | 1) => {
    const el = viewport.current;
    if (!el || typeof el.scrollBy !== "function") return;
    el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: animate ? "smooth" : "auto" });
  };

  const fade = `linear-gradient(to right, ${edges.start ? "transparent, black 3rem" : "black, black"}, ${edges.end ? "black calc(100% - 3rem), transparent" : "black, black"})`;
  const arrow =
    "absolute top-1/2 z-20 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-line bg-paper-card text-ink shadow-paper transition-opacity hover:bg-sand focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-0";

  return (
    <div data-slot="tabs-scroll" data-overflow={edges.overflow || undefined} className="relative min-w-0 max-w-full">
      {edges.overflow ? (
        <button type="button" className={cn(arrow, "left-0")} aria-label={labels?.previous ?? "Show earlier tabs"} disabled={!edges.start} onClick={() => page(-1)}>
          <ChevronLeft aria-hidden="true" className="size-4" />
        </button>
      ) : null}
      <motion.div
        ref={viewport}
        layoutScroll
        className="relative overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={edges.overflow ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
        onFocusCapture={(e) => {
          if (e.target instanceof HTMLElement && e.target.getAttribute("role") === "tab") reveal(e.target);
        }}
      >
        {children}
      </motion.div>
      {edges.overflow ? (
        <button type="button" className={cn(arrow, "right-0")} aria-label={labels?.next ?? "Show more tabs"} disabled={!edges.end} onClick={() => page(1)}>
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

const spring = { type: "spring", stiffness: 420, damping: 36, mass: 0.6 } as const;

const TRIGGER: Record<TabsVariant, string> = {
  underline: "rounded-t-lg",
  pill: "rounded-full",
  brush: "rounded-lg pb-1",
  segmented: "flex-1 rounded-xl data-[state=active]:text-paper",
  card: "rounded-t-xl border-x border-t border-line bg-sand/70 data-[state=active]:border-line-strong data-[state=active]:bg-transparent",
  vertical: "w-full justify-start rounded-r-lg text-left",
};

/** The painted stroke used by `brush`; it redraws whenever it lands on a new tab. */
function BrushStroke({ redraw, animate }: { redraw: string | undefined; animate: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 120 12" preserveAspectRatio="none" className="h-2.5 w-full overflow-visible">
      <motion.path
        key={redraw}
        d="M3 7 C 30 3, 70 10, 117 5"
        stroke="var(--ochre)"
        strokeWidth="5"
        strokeLinecap="round"
        fill="none"
        opacity={0.75}
        initial={animate ? { pathLength: 0 } : false}
        animate={{ pathLength: 1 }}
        transition={animate ? { duration: 0.45, ease: [0.3, 0.7, 0.2, 1], delay: 0.08 } : { duration: 0 }}
      />
    </svg>
  );
}

function ActiveIndicator({ variant, value, transition, animate }: { variant: TabsVariant; value: string; transition: object; animate: boolean }) {
  const common = { layoutId: "active", "aria-hidden": true, transition } as const;
  switch (variant) {
    case "underline":
      return <motion.span {...common} className="absolute inset-x-2 -bottom-px h-[3px] rounded-full bg-primary" />;
    case "pill":
      return <motion.span {...common} className="absolute inset-0 rounded-full bg-paper-card shadow-sm shadow-ink/20" />;
    case "brush":
      return (
        <motion.span {...common} className="absolute inset-x-2 bottom-0.5 block">
          <BrushStroke redraw={value} animate={animate} />
        </motion.span>
      );
    case "segmented":
      return <motion.span {...common} className="absolute inset-0 rounded-xl bg-ink shadow-paper" />;
    case "card":
      return <motion.span {...common} className="absolute -inset-x-px -top-px -bottom-px rounded-t-xl border-x border-t border-line-strong bg-paper-card" />;
    case "vertical":
      return <motion.span {...common} className="absolute -left-px inset-y-1.5 w-[3px] rounded-full bg-primary" />;
  }
}

export function TabsTrigger({ className, children, value, onPointerEnter, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  const ctx = useTabs();
  const active = ctx.value === value;
  const transition = ctx.animate ? spring : { duration: 0 };
  const showHover = (ctx.variant === "underline" || ctx.variant === "brush" || ctx.variant === "vertical") && ctx.hovered === value;
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      value={value}
      onPointerEnter={(e) => {
        ctx.setHovered(value);
        onPointerEnter?.(e);
      }}
      className={cn(
        "relative inline-flex h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap px-4 text-[15px] font-semibold text-ink-muted outline-none transition-colors",
        "hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-ink [&_svg]:size-4",
        TRIGGER[ctx.variant],
        className,
      )}
      {...props}
    >
      {showHover ? (
        <motion.span
          layoutId="hover"
          aria-hidden="true"
          className={cn("absolute rounded-lg bg-sand/70", ctx.variant === "vertical" ? "inset-0 rounded-l-none" : "inset-x-0 inset-y-1")}
          transition={transition}
        />
      ) : null}
      {active ? <ActiveIndicator variant={ctx.variant} value={value} transition={transition} animate={ctx.animate} /> : null}
      <span className="relative z-10 inline-flex items-center gap-1.5">{children}</span>
    </TabsPrimitive.Trigger>
  );
}

const CONTENT: Partial<Record<TabsVariant, string>> = {
  card: "relative -mt-px rounded-b-2xl rounded-tr-2xl border border-line-strong bg-paper-card p-5",
  vertical: "min-w-0 flex-1",
};

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  const { variant } = useTabs();
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        "rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 motion-safe:data-[state=active]:animate-in motion-safe:data-[state=active]:fade-in-0",
        CONTENT[variant],
        className,
      )}
      {...props}
    />
  );
}
