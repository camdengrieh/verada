// Written for Varada (curator agent card from the A-Vote board)
import { BadgeCheck, CircleAlert } from "lucide-react";
import { useId, type ComponentProps } from "react";
import { Badge } from "@verada/ui/components/ui/badge";
import { Divider } from "@verada/ui/components/ui/divider";
import { cn } from "@verada/ui/lib/utils";
import { CAUSE_LABELS, CauseIcon, type CauseName } from "./cause-icon";
import { DefaultLink, WASH_FILL, type LinkComponent, type WashTone } from "./shared";

export type CuratorStatus = "active" | "paused" | "pending";

export interface CuratorAgentCardProps extends Omit<ComponentProps<"section">, "children"> {
  /** `<cause>.agent.varada.eth` */
  ens: string;
  cause: CauseName;
  status: CuratorStatus;
  /** ERC-8004 identity token id. */
  agentId?: number | string;
  /** How many options the agent picked for this ballot. */
  picks?: number;
  /** One-paragraph rationale from this week's report. */
  rationale?: string;
  topPicks?: readonly { org: string; score: string }[];
  /** Picks checked on-chain against the report's Merkle root. */
  verified?: boolean;
  reportHref?: string;
  wash?: WashTone;
  LinkComponent?: LinkComponent;
}

const STATUS: Record<CuratorStatus, { label: string; tone: "cause" | "rwa" | "neutral" }> = {
  active: { label: "Active", tone: "cause" },
  paused: { label: "Paused", tone: "rwa" },
  pending: { label: "Not yet registered", tone: "neutral" },
};

/**
 * An AI curator agent: identity, what it picked this week and why, and whether the picks verify.
 * A size container: the wash band and avatar shrink under 288px; from 672px the wash becomes a
 * column on the left with the avatar centred in it.
 */
export function CuratorAgentCard({
  ens,
  cause,
  status,
  agentId,
  picks,
  rationale,
  topPicks,
  verified,
  reportHref,
  wash = "sage",
  LinkComponent = DefaultLink,
  className,
  ...props
}: CuratorAgentCardProps) {
  const titleId = `agent-${useId().replace(/:/g, "")}`;
  const s = STATUS[status];
  const meta = ["Curator agent", agentId !== undefined ? `ERC-8004 #${agentId}` : null, picks !== undefined ? `picked ${picks} options on this ballot` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <section aria-labelledby={titleId} data-slot="curator-agent-card" className={cn("@container overflow-hidden rounded-[26px] border border-line bg-card", className)} {...props}>
      <div className="flex flex-col @2xl:flex-row">
        <div className={cn("relative h-24 shrink-0 @2xs:h-[120px] @2xl:h-auto @2xl:min-h-44 @2xl:w-48", WASH_FILL[wash])}>
          <span className="absolute -bottom-7 left-[18px] grid size-[72px] place-items-center rounded-full border-4 border-card bg-card @2xs:size-[84px] @2xl:inset-x-0 @2xl:top-1/2 @2xl:bottom-auto @2xl:mx-auto @2xl:-translate-y-1/2">
            <CauseIcon cause={cause} size={76} label={`${CAUSE_LABELS[cause]} curator`} className="size-16 @2xs:size-[76px]" />
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 px-4 pb-5 pt-9 @2xs:px-5 @2xl:pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id={titleId} className="m-0 font-display text-lg font-semibold break-all @2xs:text-xl">
              {ens}
            </h3>
            <Badge tone={s.tone} shape="pill">
              {s.label}
            </Badge>
          </div>
          <span className="text-[13px] text-ink-muted">{meta}</span>
          {rationale ? (
            <blockquote className="m-0 text-sm leading-relaxed text-ink-soft">
              <p className="m-0">&ldquo;{rationale}&rdquo;</p>
            </blockquote>
          ) : null}
          {rationale && topPicks?.length ? <Divider variant="dashed" label="Top picks" /> : null}
          {topPicks?.length ? (
            <ol className="m-0 flex flex-col gap-1 pl-5 text-sm">
              {topPicks.map((p) => (
                <li key={p.org}>
                  {p.org} · <span className="num">{p.score}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {verified === undefined ? null : verified ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gain">
              <BadgeCheck aria-hidden="true" className="size-4" />
              Picks verified on-chain against the report root
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-loss">
              <CircleAlert aria-hidden="true" className="size-4" />
              Picks not yet verified against the report root
            </span>
          )}
          {reportHref ? (
            <LinkComponent href={reportHref} className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-primary underline-offset-4 hover:underline">
              Read the weekly report
            </LinkComponent>
          ) : null}
        </div>
      </div>
    </section>
  );
}
