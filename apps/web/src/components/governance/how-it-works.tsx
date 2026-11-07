"use client";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@varada/ui/components/ui/accordion";
import { openPrivacyDetails } from "@/components/privacy-status";

/** Plain-language rules of the vote, in the order a holder meets them. `cycle`: the epoch cycle as the governor has it ("45 minutes: 30 minutes of trading, then 15 minutes of voting"). */
export function HowVotingWorks({ ballotSize, cycle }: { ballotSize: number | undefined; cycle?: string }) {
  return (
    <section aria-label="How voting works" className="grid grid-cols-1 gap-3">
      <div className="grid grid-cols-1 gap-1">
        <p className="kicker m-0">How it works</p>
        <h2 className="m-0 font-display text-2xl font-semibold text-ink">How an epoch vote works</h2>
      </div>
      <Accordion type="single" collapsible defaultValue="ballot" className="rounded-2xl border border-line bg-card px-4">
        <AccordionItem value="ballot">
          <AccordionTrigger>How a ballot is built</AccordionTrigger>
          <AccordionContent>
            <p className="m-0 mb-2">
              Each token&apos;s ballot holds {ballotSize !== undefined ? `up to ${ballotSize} charities` : "up to the platform's ballot size"} from the token&apos;s cause focus, or fewer if its
              controller chose a smaller ballot. Any charities the controller pinned come first, then the curator agents&apos; picks for the token&apos;s causes,
              and the rest are drawn in rotation from every matching charity in the catalogue.
            </p>
            <p className="m-0">Every pick is checked on chain against a Merkle root, so a ballot can only list charities from the catalogue.</p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="when">
          <AccordionTrigger>When you can vote</AccordionTrigger>
          <AccordionContent>
            <p className="m-0 mb-2">
              Each epoch has a trading phase and then a voting phase{cycle ? ` (epochs last ${cycle})` : ""}. Ballots are only accepted in the voting phase, which runs to the end of the
              epoch; before it opens the vote button stays off and says when voting starts.
            </p>
            <p className="m-0">The epoch length is set by the platform and can change from one epoch to the next, so the times on this page are read from the chain.</p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="weight">
          <AccordionTrigger>Who can vote, and with how much</AccordionTrigger>
          <AccordionContent>
            <p className="m-0">
              Your weight is the number of whole tokens you held at the epoch&apos;s snapshot, taken just before it started, so trading during the epoch does not change it. Buying after the snapshot does not add
              weight, and each wallet votes once per token and epoch.
            </p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="private">
          <AccordionTrigger>How your vote stays private</AccordionTrigger>
          <AccordionContent>
            <p className="m-0 mb-2">
              Your choice is encrypted in your browser with Zama&apos;s fully homomorphic encryption, so ballots are counted while still encrypted. Only the per-option
              totals are decrypted, after voting ends. Your wallet and weight are public on chain; your choice is not.
            </p>
            <p className="m-0">
              Encrypting asks Zama&apos;s relayer for a proof, which sees your IP and address, never the choice.{" "}
              <button type="button" onClick={openPrivacyDetails} className="font-semibold text-primary underline underline-offset-4">
                See everything that leaves your browser
              </button>
              .
            </p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="after">
          <AccordionTrigger>What happens when voting ends</AccordionTrigger>
          <AccordionContent>
            <p className="m-0">
              The tally is decrypted and submitted on chain, the winner is recorded, and the epoch&apos;s cause pool is paid to the winning charity in USDC through Endaoment.
              If nobody votes, the platform&apos;s fallback cause receives the pool.
            </p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  );
}
