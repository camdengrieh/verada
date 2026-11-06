// Written for Varada (ink cause-pool card from the A-Token board)
import { useId, type ComponentProps } from "react";
import { buttonVariants } from "@verada/ui/components/ui/button";
import { cn } from "@verada/ui/lib/utils";
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

/** This epoch's weekly pool on the dark ink card, with the ballot mix and the vote call to action. */
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
    <section aria-labelledby={titleId} className={cn("flex flex-col gap-3 rounded-[26px] bg-ink p-5 text-paper", className)} {...props}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={titleId} className="m-0 font-display text-[22px] font-semibold">
          Epoch {epoch} cause pool
        </h2>
        <span className="num text-[13px] text-paper/80">{countdown}</span>
      </div>
      <span className="num text-[34px] font-semibold leading-tight">{amount}</span>
      <dl className="m-0 flex flex-col gap-1.5 text-sm text-paper/80">
        <div className="flex justify-between gap-3">
          <dt>Attributed this epoch</dt>
          <dd className="num m-0">{attributed}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Carried forward</dt>
          <dd className="num m-0">{carriedForward}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Ballot</dt>
          <dd className="m-0 text-right">{ballotMixLabel(ballot)}</dd>
        </div>
      </dl>
      {curator ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          Curated by <span className="rounded-full bg-sage px-2.5 py-0.5 font-semibold text-paper">{curator}</span>
        </div>
      ) : null}
      {voteHref ? (
        <LinkComponent href={voteHref} className={cta}>
          {voteLabel}
        </LinkComponent>
      ) : onVote ? (
        <button type="button" onClick={onVote} className={cta}>
          {voteLabel}
        </button>
      ) : null}
    </section>
  );
}
