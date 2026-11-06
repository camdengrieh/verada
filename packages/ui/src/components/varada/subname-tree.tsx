// Adapted from 21st.dev @arunachalam/animated-file-tree (id 12780, demo 25640): SVG branch elbows
// (vertical rail, rounded corner, horizontal stub) and the active-path stroke traced from the branch
// head to the selected node. Here the elbows draw themselves in as the diagram scrolls into view.
"use client";

import { Bot, Hash } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@varada/ui/lib/utils";
import { CAUSE_SHORT_LABELS, CauseIcon, type CauseName } from "./cause-icon";
import { AGENT_PARENT, ENS_PARENT } from "./ens-shared";
import { LogoMark } from "./logo-mark";
import { DefaultLink, type LinkComponent } from "./shared";

export interface SubnameCoin {
  label: string;
  /** Ticker or note shown after the name ("$HARAMBE"). */
  note?: string;
  /** Small coin art (an <img> or PaintedImage), shown round. */
  art?: ReactNode;
  href?: string;
}

export interface SubnameAgent {
  cause: CauseName;
  href?: string;
}

export interface SubnameTreeProps extends Omit<ComponentProps<"figure">, "children"> {
  coins: SubnameCoin[];
  agents: SubnameAgent[];
  /** Counts not listed, shown as "+ N more". */
  moreCoins?: number;
  moreAgents?: number;
  /** Full name to highlight, with its path from the branch head. */
  active?: string;
  caption?: string;
  LinkComponent?: LinkComponent;
}

interface NodeData {
  key: string;
  label: string;
  parent: string;
  note?: string;
  icon: ReactNode;
  href?: string;
}

function Elbow({
  index,
  last,
  onPath,
  isActive,
  more,
  corner = 22,
}: {
  index: number;
  last: boolean;
  onPath: boolean;
  isActive: boolean;
  more?: boolean;
  /** Where the elbow turns, in px from the top (the node's vertical centre). */
  corner?: number;
}) {
  const reduced = useReducedMotion();
  const draw = reduced
    ? {}
    : {
        initial: { pathLength: 0 },
        whileInView: { pathLength: 1 },
        viewport: { once: true, amount: 0.6 },
        transition: { duration: 0.35, delay: 0.12 + index * 0.06, ease: "easeOut" as const },
      };
  return (
    <>
      {last ? null : (
        <span
          aria-hidden="true"
          className={cn("absolute bottom-0 left-0 top-0 w-[1.5px]", onPath ? "bg-terracotta" : "bg-line-strong")}
        />
      )}
      <svg
        aria-hidden="true"
        width="24"
        height={corner + 1}
        viewBox={`0 0 24 ${corner + 1}`}
        fill="none"
        className="absolute left-[-0.25px] top-0 overflow-visible"
      >
        <motion.path
          d={`M0.75 0 V${corner - 8} Q0.75 ${corner} 8.75 ${corner} H24`}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={more ? "2 3" : undefined}
          className={isActive ? "text-terracotta" : "text-line-strong"}
          {...draw}
        />
      </svg>
    </>
  );
}

function Branch({
  head,
  lastBranch,
  nodes,
  more,
  moreLabel,
  active,
  LinkComponent,
}: {
  head: ReactNode;
  lastBranch: boolean;
  nodes: NodeData[];
  more?: number;
  moreLabel: string;
  active?: string;
  LinkComponent: LinkComponent;
}) {
  const reduced = useReducedMotion();
  const activeIndex = nodes.findIndex((n) => `${n.label}.${n.parent}` === active);
  const total = nodes.length + (more ? 1 : 0);
  return (
    <div className="relative flex min-w-0 flex-col pl-10 pt-3 @xl:pl-0 @xl:pt-5">
      {/* Narrow: the branch head hangs off the root rail like any child. Wide: a stub down from the rail. */}
      <span aria-hidden="true" className="absolute inset-y-0 left-5 w-6 @xl:hidden">
        <Elbow index={0} last={lastBranch} onPath={false} isActive={false} corner={34} />
      </span>
      <span aria-hidden="true" className="absolute left-5 top-0 hidden h-5 w-[1.5px] bg-line-strong @xl:block" />
      {head}
      <ul className="m-0 ml-5 flex list-none flex-col p-0">
        {nodes.map((n, i) => {
          const full = `${n.label}.${n.parent}`;
          const isActive = i === activeIndex;
          const inner = (
            <>
              <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-sand [&_img]:size-full [&_img]:object-cover">{n.icon}</span>
              <span className="min-w-0 truncate text-sm">
                <span className="font-semibold text-ink">{n.label}</span>
                <span className="text-ink-muted">.{n.parent}</span>
              </span>
              {n.note ? <span className="num hidden shrink-0 text-xs text-ink-muted @sm:inline">{n.note}</span> : null}
            </>
          );
          const nodeClass = cn(
            "inline-flex min-h-11 max-w-full items-center gap-2 rounded-full py-1 pl-1 pr-3 transition-colors",
            isActive ? "bg-terracotta-tint ring-1 ring-terracotta/40" : "hover:bg-sand",
          );
          return (
            <motion.li
              key={n.key}
              className="relative pb-1 pl-6"
              initial={reduced ? false : { opacity: 0, x: -6 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: 0.3, delay: reduced ? 0 : 0.18 + i * 0.06 }}
            >
              <Elbow index={i} last={i === total - 1} onPath={activeIndex > i} isActive={isActive} />
              {n.href ? (
                <LinkComponent href={n.href} className={nodeClass} aria-current={isActive ? "page" : undefined} aria-label={full}>
                  {inner}
                </LinkComponent>
              ) : (
                <span className={nodeClass} aria-current={isActive ? "true" : undefined}>
                  {inner}
                </span>
              )}
            </motion.li>
          );
        })}
        {more ? (
          <li className="relative pl-6">
            <Elbow index={nodes.length} last onPath={false} isActive={false} more />
            <span className="inline-flex min-h-11 items-center pl-2 text-sm text-ink-muted">
              + {more.toLocaleString("en-US")} more {moreLabel}
            </span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * The name space as a small tree: varada.eth at the root, coin labels under it (wildcard resolver, so
 * every coin gets `<label>.varada.eth`), and agent.varada.eth with the cause curator agents. Branches
 * sit side by side when the container is wide enough.
 */
export function SubnameTree({
  coins,
  agents,
  moreCoins,
  moreAgents,
  active,
  caption = "Every coin and curator agent has a name under varada.eth",
  LinkComponent = DefaultLink,
  className,
  ...props
}: SubnameTreeProps) {
  const captionId = `subnames-${useId().replace(/:/g, "")}`;
  const coinNodes: NodeData[] = coins.map((c) => ({
    key: `coin-${c.label}`,
    label: c.label,
    parent: ENS_PARENT,
    note: c.note,
    href: c.href,
    icon: c.art ?? <span className="text-xs font-bold uppercase text-ink">{c.label[0]}</span>,
  }));
  const agentNodes: NodeData[] = agents.map((a) => ({
    key: `agent-${a.cause}`,
    label: a.cause,
    parent: AGENT_PARENT,
    note: CAUSE_SHORT_LABELS[a.cause],
    href: a.href,
    icon: <CauseIcon cause={a.cause} size={28} decorative />,
  }));

  const headClass = "relative z-[1] inline-flex min-h-11 items-center gap-2 self-start rounded-full border border-line bg-card px-3 text-sm";
  return (
    <figure data-slot="subname-tree" aria-labelledby={captionId} className={cn("@container m-0 flex flex-col", className)} {...props}>
      <figcaption id={captionId} className="sr-only">
        {caption}
      </figcaption>
      <div className="inline-flex min-h-11 items-center gap-2.5 self-start rounded-full bg-ink py-1 pl-1 pr-4 text-paper">
        <span className="grid size-8 place-items-center rounded-full bg-paper text-ink">
          <LogoMark size={22} decorative />
        </span>
        <span className="font-display text-lg font-semibold">{ENS_PARENT}</span>
        <span className="hidden text-xs text-paper/80 @sm:inline">ENSv2 · wildcard resolver</span>
      </div>
      <div className="relative grid gap-x-6 @xl:grid-cols-2">
        {/* Root rail: down from the root, and across to the second branch on wide containers. */}
        <span aria-hidden="true" className="absolute left-5 top-0 hidden h-[1.5px] w-[calc(50%+0.75rem)] bg-line-strong @xl:block" />
        <Branch
          head={
            <span className={headClass}>
              <Hash aria-hidden="true" className="size-4 text-ochre-ink" />
              <span className="num font-semibold text-ink">
                &lt;label&gt;<span className="font-normal text-ink-muted">.{ENS_PARENT}</span>
              </span>
              <span className="text-ink-muted">coins</span>
            </span>
          }
          lastBranch={false}
          nodes={coinNodes}
          more={moreCoins}
          moreLabel="coins"
          active={active}
          LinkComponent={LinkComponent}
        />
        <Branch
          head={
            <span className={headClass}>
              <Bot aria-hidden="true" className="size-4 text-sage-ink" />
              <span className="num font-semibold text-ink">
                agent<span className="font-normal text-ink-muted">.{ENS_PARENT}</span>
              </span>
              <span className="text-ink-muted">ERC-8004 curators</span>
            </span>
          }
          lastBranch
          nodes={agentNodes}
          more={moreAgents}
          moreLabel="agents"
          active={active}
          LinkComponent={LinkComponent}
        />
      </div>
    </figure>
  );
}
