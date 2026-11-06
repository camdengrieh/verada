"use client";
// Adapted from 21st.dev @ln-dev7/animated-navigation-tabs (id 575): an active underline and a hover
// wash that glide between tabs via motion layoutId. Rebuilt on Radix Tabs (tablist roles, arrow keys,
// panels) with a `pill` variant; indicators jump without animation under reduced motion.
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { createContext, useContext, useId, useState, type ComponentProps } from "react";
import { cn } from "@verada/ui/lib/utils";

interface TabsCtx {
  value: string | undefined;
  hovered: string | null;
  setHovered: (v: string | null) => void;
  variant: "underline" | "pill";
  animate: boolean;
}
const TabsContext = createContext<TabsCtx | null>(null);

function useTabs(): TabsCtx {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tabs parts must be used inside <Tabs>.");
  return ctx;
}

export interface TabsProps extends ComponentProps<typeof TabsPrimitive.Root> {
  /** `underline` (default) for page sections; `pill` for compact panels. */
  variant?: "underline" | "pill";
}

export function Tabs({ className, variant = "underline", value, defaultValue, onValueChange, ...props }: TabsProps) {
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
          value={value}
          defaultValue={defaultValue}
          onValueChange={(next) => {
            if (value === undefined) setInternal(next);
            onValueChange?.(next);
          }}
          className={cn("flex flex-col gap-4", className)}
          {...props}
        />
      </LayoutGroup>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, onPointerLeave, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  const { variant, setHovered } = useTabs();
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      onPointerLeave={(e) => {
        setHovered(null);
        onPointerLeave?.(e);
      }}
      className={cn(
        "inline-flex w-fit max-w-full items-center overflow-x-auto",
        variant === "underline" ? "gap-1 border-b border-line" : "gap-1 rounded-full bg-sand p-1",
        className,
      )}
      {...props}
    />
  );
}

const spring = { type: "spring", stiffness: 420, damping: 36, mass: 0.6 } as const;

export function TabsTrigger({ className, children, value, onPointerEnter, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  const ctx = useTabs();
  const active = ctx.value === value;
  const transition = ctx.animate ? spring : { duration: 0 };
  const underline = ctx.variant === "underline";
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
        underline ? "rounded-t-lg" : "rounded-full",
        className,
      )}
      {...props}
    >
      {underline && ctx.hovered === value ? (
        <motion.span layoutId="hover" aria-hidden="true" className="absolute inset-x-0 inset-y-1 rounded-lg bg-sand/70" transition={transition} />
      ) : null}
      {active ? (
        <motion.span
          layoutId="active"
          aria-hidden="true"
          className={underline ? "absolute inset-x-2 -bottom-px h-[3px] rounded-full bg-primary" : "absolute inset-0 rounded-full bg-paper-card shadow-sm shadow-ink/20"}
          transition={transition}
        />
      ) : null}
      <span className="relative z-10 inline-flex items-center gap-1.5">{children}</span>
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 motion-safe:data-[state=active]:animate-in motion-safe:data-[state=active]:fade-in-0", className)}
      {...props}
    />
  );
}
