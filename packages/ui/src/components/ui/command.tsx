"use client";
// Adapted from 21st.dev @uvain/command-menu-palette (id 33510): cmdk palette with icon, hint and
// shortcut per item, presentational list sizer for clean listbox semantics, a ⌘K hook and a dialog
// with a key-hint footer. Direction A tokens, 44px rows, Radix Dialog from the unified package.
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { Kbd } from "@varada/ui/components/ui/kbd";
import { cn } from "@varada/ui/lib/utils";

/** Opens on ⌘K (Mac) or Ctrl+K. Returns [open, setOpen]. */
export function useCommandShortcut(key = "k") {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === key && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key]);
  return [open, setOpen] as const;
}

/** Searchable list; inline in a page, or inside `CommandDialog`. */
export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn("flex size-full flex-col overflow-hidden rounded-2xl bg-popover text-popover-foreground", className)}
      {...props}
    />
  );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="flex items-center gap-2.5 border-b border-line px-4">
      <Search aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn("h-13 w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-muted disabled:cursor-not-allowed disabled:opacity-50", className)}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  // cmdk wraps groups in a role-less sizer; marking it (and separators) presentational keeps the
  // listbox → group → option chain valid for screen readers.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("[cmdk-list-sizer]")?.setAttribute("role", "presentation");
    ref.current?.querySelectorAll("[cmdk-separator]").forEach((el) => el.setAttribute("role", "none"));
  });
  return (
    <CommandPrimitive.List
      ref={ref}
      data-slot="command-list"
      className={cn("max-h-[min(380px,60dvh)] scroll-py-1.5 overflow-y-auto overscroll-contain p-1.5", className)}
      {...props}
    />
  );
}

export function CommandEmpty({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty data-slot="command-empty" className={cn("px-3 py-8 text-center text-sm text-muted-foreground", className)} {...props} />;
}

/**
 * cmdk scrolls the selected item (and its group heading) into view whenever the selection changes,
 * including the automatic first selection on mount, which scrolls the whole page to an inline
 * palette. Only allow that scroll while the palette has focus, i.e. during keyboard navigation.
 */
function guardScrollIntoView(el: HTMLElement | null) {
  if (!el) return;
  el.scrollIntoView = function guarded(this: HTMLElement, arg?: boolean | ScrollIntoViewOptions) {
    const root = this.closest("[cmdk-root]");
    if (root && root.contains(document.activeElement)) HTMLElement.prototype.scrollIntoView.call(this, arg);
  };
}

function composeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (node: T | null) => {
    for (const r of refs) {
      if (typeof r === "function") r(node);
      else if (r) (r as { current: T | null }).current = node;
    }
  };
}

export function CommandGroup({ className, ref, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      ref={composeRefs(ref, (el: HTMLDivElement | null) => guardScrollIntoView(el?.querySelector<HTMLElement>("[cmdk-group-heading]") ?? null))}
      data-slot="command-group"
      className={cn(
        "overflow-hidden py-1 text-ink [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator data-slot="command-separator" className={cn("-mx-1.5 my-1 h-px bg-line", className)} {...props} />;
}

export interface CommandItemProps extends ComponentProps<typeof CommandPrimitive.Item> {
  icon?: ReactNode;
  /** Display only, space separated: "G H", "⌘ B". */
  shortcut?: string;
  /** A second line under the label. */
  hint?: ReactNode;
  /** Right-aligned extra, e.g. a price or a badge. */
  trailing?: ReactNode;
}

export function CommandItem({ className, icon, shortcut, hint, trailing, children, ref, ...props }: CommandItemProps) {
  return (
    <CommandPrimitive.Item
      ref={composeRefs(ref, guardScrollIntoView)}
      data-slot="command-item"
      className={cn(
        "relative flex min-h-11 cursor-default select-none items-center gap-3 rounded-lg px-3 py-2 text-[15px] text-ink outline-none",
        "data-[selected=true]:bg-sand data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-ink-muted",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="grid min-w-0 flex-1">
        <span className="truncate">{children}</span>
        {hint ? <span className="truncate text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      {trailing}
      {shortcut ? <CommandShortcut keys={shortcut} /> : null}
    </CommandPrimitive.Item>
  );
}

export function CommandShortcut({ keys, className }: { keys: string; className?: string }) {
  return (
    <span data-slot="command-shortcut" className={cn("ml-auto flex gap-1", className)}>
      {keys.split(" ").map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

export interface CommandDialogProps extends ComponentProps<typeof DialogPrimitive.Root> {
  /** Accessible name of the dialog (visually hidden). */
  title?: string;
  description?: string;
  placeholder?: string;
  emptyText?: ReactNode;
  /** Footer hint row; defaults to the key legend. Pass `null` to hide it. */
  footer?: ReactNode;
  /** Props for the inner `Command` (filter, value, loop…). */
  commandProps?: ComponentProps<typeof CommandPrimitive>;
  className?: string;
}

/** ⌘K palette in a modal: focus lands in the search box, Escape closes, focus returns. */
export function CommandDialog({
  title = "Search",
  description = "Search tokens, causes and actions",
  placeholder = "Search…",
  emptyText = "No results.",
  footer,
  commandProps,
  className,
  children,
  ...props
}: CommandDialogProps) {
  return (
    <DialogPrimitive.Root data-slot="command-dialog" {...props}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/45 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed top-[12dvh] left-1/2 z-50 w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-popover shadow-float outline-none",
            "motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=open]:zoom-in-95 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:zoom-out-95",
            className,
          )}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
          <Command loop className="rounded-none" {...commandProps}>
            <CommandInput placeholder={placeholder} />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              {children}
            </CommandList>
            {footer === null ? null : (
              <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 text-xs text-muted-foreground">
                {footer ?? (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <Kbd>↑</Kbd>
                      <Kbd>↓</Kbd> to move
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Kbd>↵</Kbd> to open
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Kbd>esc</Kbd> to close
                    </span>
                  </>
                )}
              </div>
            )}
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
