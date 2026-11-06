import { inFocus, isSwarmReference, MAX_BALLOT_OPTIONS, MIN_BALLOT_OPTIONS, PINNED_MAX, swarmContenthash } from "@varada/sdk";
import { isHex, type Hex } from "viem";

/**
 * Contenthash override input: `bzz://<ref>` or a bare 64-hex Swarm reference becomes the EIP-1577
 * Swarm contenthash; any other `0x` hex is passed through as raw contenthash bytes; empty clears the
 * override (the default dApp contenthash applies again).
 */
export function parseContenthashInput(input: string): { ok: true; value: Hex } | { ok: false; error: string } {
  const v = input.trim();
  if (v === "") return { ok: true, value: "0x" };
  if (/^bzz:\/\//i.test(v) || (!v.startsWith("0x") && isSwarmReference(v))) {
    try {
      return { ok: true, value: swarmContenthash(v) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "invalid Swarm reference" };
    }
  }
  if (isHex(v) && v.length % 2 === 0) {
    if ((v.length - 2) / 2 > 512) return { ok: false, error: "Contenthash is too long" };
    return { ok: true, value: v.toLowerCase() as Hex };
  }
  return { ok: false, error: "Enter bzz://<reference>, a 64-hex Swarm reference or 0x-prefixed contenthash bytes" };
}

/** A pinned cause in the editor: its catalogue entry inside the token's focus, and a display name. */
export interface PinDraft {
  causeId: Hex;
  orgId: Hex;
  bucket: number;
  index: number;
  proof: Hex[];
  name: string;
}

/**
 * Most causes a token can pin: PINNED_MAX, or fewer when its ballot is smaller (the governor rejects
 * more pins than the ballot holds).
 */
export function maxPins(ballotSize: number | undefined): number {
  return ballotSize === undefined ? PINNED_MAX : Math.min(PINNED_MAX, ballotSize);
}

/** Adds a pin to a draft: distinct, at most `max` (`maxPins`). */
export function addPin(list: readonly PinDraft[], pin: PinDraft, max: number = PINNED_MAX): PinDraft[] | string {
  if (!isHex(pin.causeId) || pin.causeId.length !== 66) return "Cause id must be 32 bytes";
  if (list.some((p) => p.causeId.toLowerCase() === pin.causeId.toLowerCase())) return "Cause is already pinned";
  if (list.length >= max) {
    return max < PINNED_MAX
      ? `This token's ballot holds ${max} options, so at most ${max} causes can be pinned`
      : `At most ${max} causes can be pinned`;
  }
  return [...list, pin];
}

/** Ballot sizes a token's controller can pick, smallest first (0, following the platform, is offered separately). */
export const BALLOT_SIZE_CHOICES: readonly number[] = Array.from(
  { length: MAX_BALLOT_OPTIONS - MIN_BALLOT_OPTIONS + 1 },
  (_, i) => MIN_BALLOT_OPTIONS + i,
);

/** The org's first catalogue entry inside the focus (the governor needs one to accept the pin), or null. */
export function entryInFocus<E extends { bucket: number }>(entries: readonly E[], categoryMask: bigint, regionMask: number): E | null {
  return entries.find((e) => inFocus(e.bucket, categoryMask, regionMask)) ?? null;
}

/**
 * What a ballot index refers to. Once the epoch's ballot is prepared its options are fixed. Before
 * that only the pins are known: they lead the ballot and the rest is drawn from the focus pool when
 * the ballot is prepared, so voting waits for it.
 */
export function ballotOptions(opts: { prepared: boolean; epochOptions: readonly string[]; pinned: readonly string[] | null }): {
  options: string[];
  frozen: boolean;
} {
  if (opts.prepared || opts.epochOptions.length > 0) return { options: [...opts.epochOptions], frozen: true };
  return { options: [...(opts.pinned ?? [])], frozen: false };
}
