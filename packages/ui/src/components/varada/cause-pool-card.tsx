// Written for Varada (ink cause-pool card from the A-Token board)
import { useId, type ComponentProps } from "react";
import { buttonVariants } from "@varada/ui/components/ui/button";
import { Divider } from "@varada/ui/components/ui/divider";
import { cn } from "@varada/ui/lib/utils";
import { DefaultLink, type LinkComponent } from "./shared";

export interface BallotMix {
  pinned: number;
  curated: number;
  rotation: number;
}

export function ballotMixLabel(mix: BallotMix): string {
  return `${mix.pinned} pinned · ${mix.curated} curated · ${mix.rotation} rotation`;
}

export interface CausePoolCardProps extends Omit<ComponentProps<"section">, "children"> {
  epoch: number;
  /** "closes in 2d 14h" — the app owns the clock. */
  countdown: string;
  /** All formatted. */
  amount: string;
  attributed: string;
  carriedForward: string;
  ballot: BallotMix;
  /** Curator agent, `<cause>.agent.varada.eth`. */
  curator?: string;
  /** Vote CTA: a link (vote page) or a button. */
  voteHref?: string;
  onVote?: () => void;
  voteLabel?: string;
  LinkComponent?: LinkComponent;
}

/**
 * This epoch's weekly pool on the dark ink card, with the ballot mix and the vote call to action.
 * A size container: under 288px the rows stack label over value; from 576px the amount and the vote
 * button sit on the left and the breakdown on the right.
 */
export function CausePoolCard({
  epoch,
  countdown,
  amount,
  attributed,
  carriedForward,
  ballot,
  curator,
  voteHref,
  onVote,
  voteLabel = "Vote privately",
  LinkComponent = DefaultLink,
  className,
  ...props
}: CausePoolCardProps) {
  const titleId = `pool-${useId().replace(/:/g, "")}`;
  const cta = cn(buttonVariants({ variant: "soft", size: "lg" }), "w-full bg-paper text-ink hover:bg-sand");
  return (
    <section aria-labelledby={titleId} data-slot="cause-pool-card" className={cn("@container rounded-[26px] bg-ink p-5 text-paper", className)} {...props}>
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @xl:gap-x-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id={titleId} className="m-0 font-display text-xl font-semibold @2xs:text-[22px]">
            Epoch {epoch} cause pool
          </h2>
          <span className="num text-[13px] text-paper/80">{countdown}</span>
        </div>
        <span className="num text-[28px] font-semibold leading-tight @2xs:text-[34px]">{amount}</span>
        <div className="flex flex-col gap-3 @xl:col-start-2 @xl:row-span-3 @xl:row-start-1 @xl:justify-center @xl:border-l @xl:border-paper/20 @xl:pl-8">
          <Divider variant="dashed" tone="color-mix(in oklab, var(--paper) 30%, transparent)" className="@xl:hidden" />
          <dl className="m-0 flex flex-col gap-2 text-sm text-paper/80 @2xs:gap-1.5">
            {(
              [
                ["Attributed this epoch", attributed, true],
                ["Carried forward", carriedForward, true],
                ["Ballot", ballotMixLabel(ballot), false],
              ] as const
            ).map(([term, value, mono]) => (
              <div key={term} className="flex flex-col @2xs:flex-row @2xs:justify-between @2xs:gap-3">
                <dt>{term}</dt>
                <dd className={cn("m-0 @2xs:text-right", mono ? "num" : "text-paper")}>{value}</dd>
              </div>
            ))}
          </dl>
          {curator ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
              Curated by <span className="max-w-full truncate rounded-full bg-sage px-2.5 py-0.5 font-semibold text-paper">{curator}</span>
            </div>
          ) : null}
        </div>
        {voteHref ? (
          <LinkComponent href={voteHref} className={cn(cta, "@xl:self-end")}>
            {voteLabel}
          </LinkComponent>
        ) : onVote ? (
          <button type="button" onClick={onVote} className={cn(cta, "@xl:self-end")}>
            {voteLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}
