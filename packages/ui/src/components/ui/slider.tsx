"use client";
// Adapted from 21st.dev @jshguo/interfaces-slider (id 11891): single and range values from one
// component. Adds accessible names per thumb, a 44px thumb hit area and Direction A tokens.
import { Slider as SliderPrimitive } from "radix-ui";
import { useState, type ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

export interface SliderProps extends ComponentProps<typeof SliderPrimitive.Root> {
  /** Accessible names for each thumb, e.g. ["Minimum market cap", "Maximum market cap"]. Falls back to `aria-label`. */
  thumbLabels?: string[];
  /** Formats `aria-valuetext` for screen readers, e.g. (v) => `${v}%`. */
  formatValue?: (value: number) => string;
  tone?: "primary" | "cause";
}

export function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbLabels,
  formatValue,
  tone = "primary",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  onValueChange,
  ...props
}: SliderProps) {
  // Mirrors the value so thumbs and aria-valuetext stay current when uncontrolled.
  const [internal, setInternal] = useState<number[]>(() => defaultValue ?? [min]);
  const values = value ?? internal;
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      onValueChange={(next) => {
        if (value === undefined) setInternal(next);
        onValueChange?.(next);
      }}
      className={cn(
        "relative flex w-full touch-none select-none items-center py-3 data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col data-[orientation=vertical]:px-3 data-[orientation=vertical]:py-0",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative grow overflow-hidden rounded-full bg-line-strong data-[orientation=horizontal]:h-2 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            "absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full",
            tone === "primary" ? "bg-primary" : "bg-sage",
          )}
        />
      </SliderPrimitive.Track>
      {values.map((v, i) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={i}
          aria-label={thumbLabels?.[i] ?? ariaLabel}
          aria-labelledby={thumbLabels?.[i] ? undefined : ariaLabelledby}
          aria-valuetext={formatValue ? formatValue(v) : undefined}
          className={cn(
            "relative block size-6 shrink-0 cursor-grab rounded-full border-[2.5px] bg-paper-card shadow-md shadow-ink/25 outline-none transition-[box-shadow,transform] active:cursor-grabbing",
            "after:absolute after:-inset-2.5 after:rounded-full after:content-['']",
            "hover:ring-4 focus-visible:ring-4 disabled:pointer-events-none",
            tone === "primary" ? "border-primary ring-primary/20" : "border-sage ring-sage/25",
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}
