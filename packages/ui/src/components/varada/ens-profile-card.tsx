// Adapted from 21st.dev @daiwiikharihar/profile-card (id 6703, demo 9890): the staggered "elegant
// reveal" (rise + unblur on a fluid spring) for the profile rows. Layout, ENS records, contenthash
// badge and tokens written for Varada.
"use client";

import { BadgeCheck, ExternalLink, Hexagon, Star } from "lucide-react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { CopyButton } from "@varada/ui/components/data/copy-button";
import { buttonVariants } from "@varada/ui/components/ui/button";
import { cn } from "@varada/ui/lib/utils";
import { shortenAddress, splitEnsName, textRecordMeta, TEXT_RECORD_ORDER } from "./ens-shared";
import { HIT_AREA, WASH_FILL, WASH_PIGMENT, type WashTone } from "./shared";
import { Wash } from "./watercolour";

export interface EnsTextRecord {
  /** Record key: url, com.twitter, org.telegram, com.discord, com.github, … */
  key: string;
  value: string;
  /** Where the value links to (the app builds it: x.com/…, t.me/…). */
  href?: string;
}

export interface EnsContenthash {
  protocol: "swarm" | "ipfs";
  /** Reference / CID, shown shortened. */
  hash: string;
}

export interface EnsProfileCardProps extends Omit<ComponentProps<"article">, "children"> {
  name: string;
  /** The `description` record. */
  description?: string;
  /** Logo or avatar art (an <img>, PaintedImage, CauseIcon…), shown in a round frame. */
  avatar?: ReactNode;
  records?: EnsTextRecord[];
  contenthash?: EnsContenthash;
  /** The name's site, e.g. `ensLimoUrl(name)`. Renders the "Open site" button. */
  siteHref?: string;
  /** Owner / manager address. */
  owner?: string;
  verified?: boolean;
  primary?: boolean;
  wash?: WashTone;
  /** Extra actions after "Open site" (Edit profile…). */
  actions?: ReactNode;
}

/** Keys shown elsewhere on the card, not as rows. */
const NOT_ROWS = new Set(["description", "avatar", "varada.logo"]);

const fluid = { type: "spring", stiffness: 260, damping: 28, mass: 1 } as const;
const listVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
};
const rowVariants: Variants = {
  hidden: { y: 10, opacity: 0, filter: "blur(6px)" },
  visible: { y: 0, opacity: 1, filter: "blur(0px)", transition: fluid },
};

/** A name's public profile: logo, name, description, text records as icon rows, contenthash and site link. */
export function EnsProfileCard({
  name,
  description,
  avatar,
  records = [],
  contenthash,
  siteHref,
  owner,
  verified,
  primary,
  wash = "sage",
  actions,
  className,
  ...props
}: EnsProfileCardProps) {
  const titleId = `ens-profile-${useId().replace(/:/g, "")}`;
  const reduced = useReducedMotion();
  const { label, parent } = splitEnsName(name);
  const rows = records
    .filter((r) => !NOT_ROWS.has(r.key) && r.value)
    .sort((a, b) => {
      const ia = TEXT_RECORD_ORDER.indexOf(a.key);
      const ib = TEXT_RECORD_ORDER.indexOf(b.key);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  const reveal = reduced ? {} : { variants: listVariants, initial: "hidden", whileInView: "visible", viewport: { once: true, amount: 0.3 } };
  const row = reduced ? {} : { variants: rowVariants };

  return (
    <article
      data-slot="ens-profile-card"
      aria-labelledby={titleId}
      className={cn("@container overflow-hidden rounded-[26px] border border-line bg-card", className)}
      {...props}
    >
      <div className={cn("relative h-24", WASH_FILL[wash])}>
        <Wash
          className="absolute inset-0 size-full"
          blobs={[
            { cx: 120, cy: 90, rx: 150, ry: 70, color: WASH_PIGMENT[wash], opacity: 0.35 },
            { cx: 430, cy: 70, rx: 170, ry: 60, color: "var(--ochre)", opacity: 0.22 },
          ]}
        />
        <span className="absolute -bottom-9 left-5 grid size-[84px] place-items-center overflow-hidden rounded-full border-4 border-card bg-paper [&_img]:size-full [&_img]:object-cover">
          {avatar ?? <span className="font-display text-3xl font-bold uppercase text-ink">{label[0]}</span>}
        </span>
      </div>

      <div className="flex flex-col gap-3 px-5 pb-5 pt-11">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <h3 id={titleId} className="m-0 min-w-0 break-words font-display text-2xl font-semibold tracking-tight">
            {label}
            <wbr />
            <span className="font-normal text-ink-muted">.{parent}</span>
          </h3>
          {verified ? (
            <span className="inline-flex text-sage" title="Records verified">
              <BadgeCheck aria-hidden="true" className="size-5" />
              <span className="sr-only">Verified</span>
            </span>
          ) : null}
          {primary ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-ochre-tint px-2 py-0.5 text-xs font-semibold text-ochre-ink">
              <Star aria-hidden="true" className="size-3 fill-current" />
              Primary
            </span>
          ) : null}
          <CopyButton value={name} label={`Copy ${name}`} iconOnly variant="ghost" size="icon-sm" className={HIT_AREA} />
        </div>

        {description ? <p className="m-0 text-[15px] leading-relaxed text-ink-soft">{description}</p> : null}

        {rows.length ? (
          <motion.dl className="m-0 grid gap-1 @md:grid-cols-2" {...reveal}>
            {rows.map((r) => {
              const meta = textRecordMeta(r.key);
              const Icon = meta.icon;
              const shown = `${meta.prefix && !r.value.startsWith(meta.prefix) ? meta.prefix : ""}${r.value}`;
              return (
                <motion.div
                  key={r.key}
                  className="flex min-h-11 min-w-0 flex-col justify-center gap-0.5 rounded-xl px-2 py-1.5 hover:bg-sand/60"
                  {...row}
                >
                  <dt className="flex items-center gap-2 text-xs text-ink-muted">
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-sand text-ink-soft">
                      <Icon aria-hidden="true" className="size-3.5" />
                    </span>
                    {meta.label}
                  </dt>
                  <dd className="m-0 min-w-0 truncate pl-8 text-sm font-medium text-ink">
                      {r.href ? (
                        <a href={r.href} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
                          {shown}
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : (
                        shown
                      )}
                  </dd>
                </motion.div>
              );
            })}
          </motion.dl>
        ) : null}

        {contenthash || owner ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-line-strong pt-3 text-[13px]">
            {contenthash ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-stock-tint px-2.5 py-1 font-semibold text-stock-ink"
                title={`${contenthash.protocol === "swarm" ? "bzz" : "ipfs"}://${contenthash.hash}`}
              >
                <Hexagon aria-hidden="true" className="size-3.5" />
                {contenthash.protocol === "swarm" ? "Swarm" : "IPFS"}
                <span className="num font-normal">{shortenAddress(contenthash.hash, 6, 4)}</span>
                <span className="sr-only">contenthash</span>
              </span>
            ) : null}
            {owner ? (
              <span className="text-ink-muted">
                Owner <span className="num text-ink-soft">{shortenAddress(owner)}</span>
              </span>
            ) : null}
          </div>
        ) : null}

        {siteHref || actions ? (
          <div className="flex flex-col gap-2 @sm:flex-row @sm:flex-wrap">
            {siteHref ? (
              <a href={siteHref} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "primary" }))}>
                Open site
                <ExternalLink aria-hidden="true" />
                <span className="sr-only"> {name} (opens in a new tab)</span>
              </a>
            ) : null}
            {actions}
          </div>
        ) : null}
      </div>
    </article>
  );
}
