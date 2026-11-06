// Adapted from 21st.dev @wensity/drawer (id 31360) via ui/drawer.tsx: a tall bottom sheet with a
// header block, a scrolling body and a pinned footer, holding the A-Mobile board's vote screen (one
// column of ballot options and a sticky "Vote for …" button).
"use client";

import { LockKeyhole } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@verada/ui/components/ui/button";
import { Drawer, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader } from "@verada/ui/components/ui/drawer";
import { BallotList, type BallotGroup } from "@verada/ui/components/varada/ballot-list";
import type { BallotOptionData } from "@verada/ui/components/varada/ballot-option";
import { cn } from "@verada/ui/lib/utils";
import { CONTAINED_SHEET, InlineSheet, sheetParts, type MobileSheetBaseProps } from "./sheet-shared";

export interface MobileVoteSheetProps extends MobileSheetBaseProps {
  options: readonly BallotOptionData[];
  /** Selected option id (controlled) … */
  value?: string;
  /** … or the starting selection. */
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  defaultGroup?: BallotGroup;
  /** "$HARAMBE · Epoch 12" */
  kicker?: ReactNode;
  /** "Where should $1,284 go?" */
  title: ReactNode;
  /** "Closes in 2d 14h · your weight 0.04%" */
  meta?: ReactNode;
  /** Runs with the chosen option (usually opens the VoteFlowDialog to encrypt and sign). */
  onVote: (option: BallotOptionData) => void;
  /** The button's label for a chosen option (default "Vote for <org>"). */
  voteLabel?: (option: BallotOptionData) => string;
  /** Under the button. */
  privacyNote?: ReactNode;
  /** Why the viewer can't vote ("Hold $HARAMBE at the snapshot to vote"); disables the list and button. */
  disabledReason?: string;
  /** Disables the button while the vote is being sent. */
  pending?: boolean;
}

/**
 * The weekly ballot as a phone sheet: kicker, question and countdown at the top; search, source tabs
 * and one column of options in the scrolling body; and a pinned footer with the vote button (it names
 * the chosen charity, or asks for a choice) and the privacy note.
 */
export function MobileVoteSheet({
  open,
  onOpenChange,
  container,
  modal = true,
  inline,
  options,
  value,
  defaultValue,
  onValueChange,
  defaultGroup,
  kicker,
  title,
  meta,
  onVote,
  voteLabel = (o) => `Vote for ${o.org}`,
  privacyNote = "Your choice is encrypted on this device. Only the totals are decrypted when voting ends.",
  disabledReason,
  pending,
}: MobileVoteSheetProps) {
  const id = useId();
  const [inner, setInner] = useState(defaultValue ?? "");
  const selectedId = value ?? inner;
  const selected = options.find((o) => o.id === selectedId);
  const choose = (id: string) => {
    if (value === undefined) setInner(id);
    onValueChange?.(id);
  };
  const label = disabledReason ? "Voting unavailable" : pending ? "Sending your vote…" : selected ? voteLabel(selected) : "Choose a charity to vote";

  const { Title, Description } = sheetParts(inline);
  const content = (
    <>
        <DrawerHeader className="gap-0.5 pb-3">
          {kicker ? <span className="kicker text-xs">{kicker}</span> : null}
          <Title className="text-2xl leading-tight">{title}</Title>
          {meta ? <Description className="num text-[13px] text-ink-muted">{meta}</Description> : <Description className="sr-only">Choose one charity on this week&apos;s ballot.</Description>}
        </DrawerHeader>
        <DrawerBody className="px-4">
          <BallotList
            options={options}
            value={selectedId}
            onValueChange={choose}
            defaultGroup={defaultGroup}
            disabled={!!disabledReason || pending}
            className="rounded-none border-0 bg-transparent p-0"
          />
        </DrawerBody>
        <DrawerFooter className="gap-2 bg-paper-card px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <Button
            variant="cause"
            size="lg"
            className="h-13 w-full text-base"
            disabled={!selected || !!disabledReason || pending}
            aria-describedby={disabledReason ? `${id}-reason ${id}-note` : `${id}-note`}
            onClick={() => selected && onVote(selected)}
          >
            <span className="min-w-0 truncate">{label}</span>
          </Button>
          {disabledReason ? (
            <p id={`${id}-reason`} className="m-0 text-center text-[13px] text-terracotta-strong">
              {disabledReason}
            </p>
          ) : null}
          <p id={`${id}-note`} className="m-0 flex items-start justify-center gap-1.5 text-center text-xs text-ink-soft">
            <LockKeyhole aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <span>{privacyNote}</span>
          </p>
        </DrawerFooter>
    </>
  );

  if (inline) {
    return open ? (
      <InlineSheet data-slot="mobile-vote-sheet" onClose={() => onOpenChange(false)} className="h-[88%]">
        {content}
      </InlineSheet>
    ) : null;
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} container={container} modal={modal} noBodyStyles={!!container}>
      <DrawerContent data-slot="mobile-vote-sheet" className={cn("h-[88dvh]", container && "h-[88%]", container && CONTAINED_SHEET)}>
        {content}
      </DrawerContent>
    </Drawer>
  );
}
