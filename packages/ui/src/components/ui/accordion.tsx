"use client";
// Adapted from 21st.dev @skyleen77/radix-accordion (id 1777): rotating chevron and a height reveal. Its
// MutationObserver + motion mask are replaced with Radix's measured-height CSS animation
// (tw-animate-css accordion keyframes), which stays in sync with Radix state and honours reduced motion.
import { ChevronDown } from "lucide-react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@varada/ui/lib/utils";

export function Accordion(props: ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

export function AccordionItem({ className, ...props }: ComponentProps<typeof AccordionPrimitive.Item>) {
  return <AccordionPrimitive.Item data-slot="accordion-item" className={cn("border-b border-line last:border-b-0", className)} {...props} />;
}

export function AccordionTrigger({ className, children, ...props }: ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group/trigger flex min-h-11 flex-1 items-center justify-between gap-4 rounded-lg py-4 text-left text-base font-semibold text-ink outline-none transition-colors hover:text-terracotta-strong focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-sand transition-colors group-data-[state=open]/trigger:bg-terracotta-tint">
          <ChevronDown
            aria-hidden="true"
            className="size-4 text-ink-muted transition-transform duration-300 ease-[cubic-bezier(0.34,1.4,0.64,1)] group-data-[state=open]/trigger:rotate-180 group-data-[state=open]/trigger:text-terracotta-strong"
          />
        </span>
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({ className, children, ...props }: ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden text-[15px] text-ink-soft motion-safe:data-[state=closed]:animate-accordion-up motion-safe:data-[state=open]:animate-accordion-down"
      {...props}
    >
      <div className={cn("pt-0 pb-4 leading-relaxed", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}
