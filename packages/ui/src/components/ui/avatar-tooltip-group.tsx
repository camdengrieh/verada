"use client";
// Adapted from 21st.dev @manuarora700/animated-tooltip (id 791): overlapping avatars whose name
// card springs in and sways with the pointer, and @arihantcodes/avatar-stack (id 27756): the
// stack fans apart on hover and ends in a "+N" chip. Rebuilt on ui/avatar and ui/tooltip, so each
// avatar is a focusable button (name on hover, focus and tap) and images come from the app.
import { motion } from "motion/react";
import { useState } from "react";
import { usePrefersReducedMotion } from "@verada/ui/components/motion/marquee";
import { Avatar, AvatarFallback, AvatarImage } from "@verada/ui/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@verada/ui/components/ui/tooltip";
import { cn } from "@verada/ui/lib/utils";

export interface AvatarPerson {
  id: string;
  name: string;
  /** Second line in the name card, e.g. "Top holder · 4.2%" or "wildlife.agent.varada.eth". */
  detail?: string;
  /** Site-relative image (already resolved by the app). Initials show while it loads or if absent. */
  src?: string;
  /** Override the initials. */
  initials?: string;
}

export interface AvatarTooltipGroupProps {
  people: AvatarPerson[];
  /** Accessible name for the group, e.g. "Top holders of $HARAMBE". */
  label: string;
  /** Avatars shown before the "+N" chip. */
  max?: number;
  size?: "md" | "lg";
  /** Called when an avatar is activated (click, Enter, Space). */
  onSelect?: (person: AvatarPerson) => void;
  className?: string;
}

/** Fallback washes cycle through the pigments, each with an ink that passes 4.5:1 on it. */
const TINTS = ["bg-ochre-tint text-ochre-ink", "bg-sage-tint text-sage-ink", "bg-terracotta-tint text-terracotta-strong", "bg-stock-tint text-stock-ink", "bg-etf-tint text-etf-ink"];

function initialsOf(p: AvatarPerson) {
  if (p.initials) return p.initials;
  const words = p.name.replace(/^[@$]/, "").split(/[\s.\-_]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

function NameCard({ person }: { person: AvatarPerson }) {
  return (
    <span className="flex flex-col items-center gap-0.5 whitespace-nowrap">
      <span className="font-semibold">{person.name}</span>
      {person.detail ? <span className="text-xs text-paper/80">{person.detail}</span> : null}
      <span aria-hidden="true" className="absolute inset-x-6 -bottom-px h-0.5 rounded-full bg-linear-to-r from-transparent via-ochre to-transparent" />
    </span>
  );
}

/**
 * Stacked avatars for holders, curators or donors. Hovering (or focusing) one lifts it out of the
 * stack and its name card springs in, leaning with the pointer. The "+N" chip lists everyone else.
 */
export function AvatarTooltipGroup({ people, label, max = 5, size = "md", onSelect, className }: AvatarTooltipGroupProps) {
  const reduced = usePrefersReducedMotion();
  const [active, setActive] = useState<string | null>(null);
  const shown = people.slice(0, max);
  const rest = people.slice(max);
  const box = size === "lg" ? "size-14" : "size-11";
  const overlap = size === "lg" ? "-ml-4" : "-ml-3";

  return (
    <ul aria-label={label} className={cn("flex items-center", className)} onPointerLeave={() => setActive(null)}>
      {shown.map((person, i) => {
        const lifted = active === person.id;
        return (
          <motion.li
            key={person.id}
            className={cn("relative", i > 0 && overlap)}
            style={{ zIndex: lifted ? 30 : shown.length - i }}
            animate={reduced ? undefined : { y: lifted ? -4 : 0, scale: lifted ? 1.08 : 1, x: active && !lifted ? (shown.findIndex((p) => p.id === active) < i ? 4 : -4) : 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 22 }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={person.detail ? `${person.name}, ${person.detail}` : person.name}
                  onPointerEnter={() => setActive(person.id)}
                  onFocus={() => setActive(person.id)}
                  onBlur={() => setActive((a) => (a === person.id ? null : a))}
                  onClick={() => onSelect?.(person)}
                  className="block rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <Avatar size={size} className={cn(box, "ring-[3px]")}>
                    {person.src ? <AvatarImage src={person.src} alt="" /> : null}
                    <AvatarFallback className={TINTS[i % TINTS.length]}>{initialsOf(person)}</AvatarFallback>
                  </Avatar>
                </button>
              </TooltipTrigger>
              <TooltipContent followCursor sideOffset={10} className="relative px-4 py-2 text-center">
                <NameCard person={person} />
              </TooltipContent>
            </Tooltip>
          </motion.li>
        );
      })}
      {rest.length > 0 ? (
        <li className={cn("relative", overlap)} style={{ zIndex: 0 }}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${rest.length} more: ${rest.map((p) => p.name).join(", ")}`}
                className={cn(
                  box,
                  "grid place-items-center rounded-full bg-ink text-sm font-semibold text-paper ring-[3px] ring-paper-card outline-none focus-visible:ring-ring/50",
                )}
              >
                <span aria-hidden="true">+{rest.length}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent tone="paper" animation="spring" className="max-w-60">
              <span className="flex flex-col gap-1 text-left">
                {rest.slice(0, 8).map((p) => (
                  <span key={p.id} className="flex justify-between gap-3">
                    <span className="font-medium text-ink">{p.name}</span>
                    {p.detail ? <span className="num text-xs text-ink-muted">{p.detail}</span> : null}
                  </span>
                ))}
                {rest.length > 8 ? <span className="text-xs text-ink-muted">and {rest.length - 8} more</span> : null}
              </span>
            </TooltipContent>
          </Tooltip>
        </li>
      ) : null}
    </ul>
  );
}
