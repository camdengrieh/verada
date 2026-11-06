"use client";
// Adapted from 21st.dev @ddoemonn/segmented-control (id 23552): a sliding thumb that springs to the
// chosen segment. Rebuilt on Radix ToggleGroup (roving focus, arrow keys) with a motion layoutId thumb;
// the thumb jumps without animation under reduced motion. Single mode never deselects.
import { cva, type VariantProps } from "class-variance-authority";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { createContext, useContext, useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "@verada/ui/lib/utils";

const groupVariants = cva("inline-flex w-fit items-center gap-1 rounded-full bg-sand p-1", {
  variants: { size: { sm: "", md: "" }, block: { true: "flex w-full", false: "" } },
  defaultVariants: { size: "md", block: false },
});

const itemVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-4 font-semibold text-ink-muted outline-none transition-colors hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:text-ink [&_svg]:size-4",
  {
    variants: { size: { sm: "h-8 px-3 text-sm", md: "h-11 text-[15px]" }, block: { true: "flex-1", false: "" } },
    defaultVariants: { size: "md", block: false },
  },
);

interface Ctx {
  values: string[];
  thumbId: string;
  animate: boolean;
  size: "sm" | "md";
  block: boolean;
  multiple: boolean;
}
const ToggleGroupContext = createContext<Ctx | null>(null);

type Common = {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  /** Name the group: "Chart range", "Order side"… */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Stretch to the container with equal-width segments. */
  block?: boolean;
  loop?: boolean;
} & Omit<VariantProps<typeof groupVariants>, "block">;

export type ToggleGroupProps =
  | (Common & { type?: "single"; value?: string; defaultValue?: string; onValueChange?: (value: string) => void })
  | (Common & { type: "multiple"; value?: string[]; defaultValue?: string[]; onValueChange?: (value: string[]) => void });

const toArray = (v: string | string[] | undefined): string[] => (v === undefined || v === "" ? [] : Array.isArray(v) ? v : [v]);

/**
 * Segmented control (`type="single"`, the default) or a set of toggle chips (`type="multiple"`).
 * Single mode shows a paper thumb sliding between segments and never ends up empty; multiple mode
 * marks each pressed chip in place.
 */
export function ToggleGroup(props: ToggleGroupProps) {
  const { className, size = "md", block = false, children, disabled, loop = true } = props;
  const multiple = props.type === "multiple";
  const thumbId = useId();
  const reduced = useReducedMotion();
  const [internal, setInternal] = useState<string[]>(() => toArray(props.defaultValue));
  const controlled = props.value !== undefined;
  const values = controlled ? toArray(props.value) : internal;

  const ctx: Ctx = { values, thumbId, animate: !reduced, size: size ?? "md", block, multiple };
  const common = {
    "data-slot": "toggle-group",
    "aria-label": props["aria-label"],
    "aria-labelledby": props["aria-labelledby"],
    disabled,
    loop,
    className: cn(groupVariants({ size, block }), className),
  };

  return (
    <ToggleGroupContext.Provider value={ctx}>
      <LayoutGroup id={thumbId}>
        {multiple ? (
          <ToggleGroupPrimitive.Root
            {...common}
            type="multiple"
            value={values}
            onValueChange={(next: string[]) => {
              if (!controlled) setInternal(next);
              (props.onValueChange as ((v: string[]) => void) | undefined)?.(next);
            }}
          >
            {children}
          </ToggleGroupPrimitive.Root>
        ) : (
          <ToggleGroupPrimitive.Root
            {...common}
            type="single"
            value={values[0] ?? ""}
            onValueChange={(next: string) => {
              if (!next) return; // a segmented control always keeps one choice
              if (!controlled) setInternal([next]);
              (props.onValueChange as ((v: string) => void) | undefined)?.(next);
            }}
          >
            {children}
          </ToggleGroupPrimitive.Root>
        )}
      </LayoutGroup>
    </ToggleGroupContext.Provider>
  );
}

export function ToggleGroupItem({
  className,
  children,
  value,
  ...props
}: Omit<ComponentProps<typeof ToggleGroupPrimitive.Item>, "value"> & { value: string }) {
  const ctx = useContext(ToggleGroupContext);
  if (!ctx) throw new Error("ToggleGroupItem must be used inside <ToggleGroup>.");
  const on = ctx.values.includes(value);
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      value={value}
      className={cn(itemVariants({ size: ctx.size, block: ctx.block }), className)}
      {...props}
    >
      {on && ctx.multiple ? (
        <span aria-hidden="true" className="absolute inset-0 rounded-full bg-paper-card shadow-sm shadow-ink/20" />
      ) : on ? (
        <motion.span
          layoutId="thumb"
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-paper-card shadow-sm shadow-ink/20"
          transition={ctx.animate ? { type: "spring", stiffness: 520, damping: 38, mass: 0.5 } : { duration: 0 }}
        />
      ) : null}
      <span className="relative z-10 inline-flex items-center gap-1.5">{children}</span>
    </ToggleGroupPrimitive.Item>
  );
}
