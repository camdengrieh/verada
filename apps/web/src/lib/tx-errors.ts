/**
 * Plain-language reasons for failed wallet writes and contract reverts. Matching is on the error's
 * chain (viem wraps the cause several levels deep), its numeric `code` and the custom-error name a
 * revert carries, so nothing here depends on one wallet's wording.
 */

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  shortMessage?: unknown;
  message?: unknown;
  cause?: unknown;
  data?: { errorName?: unknown };
}

const MAX_DEPTH = 8;

/** The error and its causes, outermost first. */
function chain(e: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let cur: unknown = e;
  for (let i = 0; i < MAX_DEPTH && cur && typeof cur === "object"; i++) {
    out.push(cur as ErrorLike);
    cur = (cur as ErrorLike).cause;
  }
  return out;
}

/** Revert reasons the voting and vault contracts raise, in words a holder can act on. */
const REVERTS: Record<string, string> = {
  AlreadyVoted: "You have already voted here. Each wallet votes once.",
  ZeroWeight: "You held none of this token at the snapshot, so you have no weight to vote with.",
  PollClosed: "Voting has closed for this poll.",
  PollNotOpen: "This poll is not open yet.",
  VotingClosed: "Voting has closed for this proposal.",
  EpochNotCurrent: "This is not the current epoch any more. Reload to see the latest ballot.",
  EpochNotOpened: "This epoch's ballot has not been opened yet.",
  EpochAlreadyOpened: "This epoch's ballot is already open.",
  BallotAlreadyPrepared: "This epoch's ballot is already prepared.",
  InvalidBallot: "The ballot could not be verified. Try voting again.",
  SenderNotAllowedToUseHandle: "The encrypted choice was built for a different wallet. Vote from the wallet you connected.",
  TokenNotRegistered: "This token is not registered with Varada governance.",
  NoVotes: "Nobody voted in this epoch.",
  Paused: "This vault is paused, so donations are closed for now.",
  ZeroAmount: "Enter an amount greater than zero.",
  InsufficientGas: "The transaction did not carry enough gas. Try again.",
};

/** A custom-error name found anywhere in the error chain, or undefined. */
export function revertName(e: unknown): string | undefined {
  for (const c of chain(e)) {
    const n = c.data?.errorName;
    if (typeof n === "string" && n) return n;
  }
  // Fall back to the name inside a revert message, e.g. `reverted with the following signature ... AlreadyVoted()`.
  for (const c of chain(e)) {
    const text = [c.shortMessage, c.message].filter((x): x is string => typeof x === "string").join(" ");
    for (const name of Object.keys(REVERTS)) if (new RegExp(`\\b${name}\\b`).test(text)) return name;
  }
  return undefined;
}

/** The wallet's "user rejected the request" (EIP-1193 code 4001, ethers' ACTION_REJECTED, or viem's wording). */
export function isUserRejection(e: unknown): boolean {
  return chain(e).some((c) => {
    if (c.code === 4001 || c.code === "ACTION_REJECTED") return true;
    if (c.name === "UserRejectedRequestError") return true;
    const text = `${typeof c.shortMessage === "string" ? c.shortMessage : ""} ${typeof c.message === "string" ? c.message : ""}`;
    return /user (rejected|denied|cancell?ed)|rejected the request|request rejected/i.test(text);
  });
}

/** The wallet is on a different network than the app. */
export function isWrongChain(e: unknown): boolean {
  return chain(e).some((c) => {
    // viem's ChainMismatchError, wagmi's ConnectorChainMismatchError (what a write raises when the
    // wallet sits on another network than `chainId`) and ChainNotConfiguredError.
    if (c.name === "ChainMismatchError" || c.name === "ConnectorChainMismatchError" || c.name === "ChainNotConfiguredError" || c.name === "SwitchChainError") return true;
    const text = typeof c.message === "string" ? c.message : "";
    return /does not match the (target|connection's) chain|chain mismatch|wrong network|chain not configured/i.test(text);
  });
}

function isInsufficientFunds(e: unknown): boolean {
  return chain(e).some((c) => c.name === "InsufficientFundsError" || /insufficient funds/i.test(typeof c.message === "string" ? c.message : ""));
}

/**
 * A friendly message for an error we recognise, or null so the caller can show the raw one.
 * Never includes the user's address or anything else from the request.
 */
export function friendlyTxError(e: unknown): string | null {
  if (!e) return null;
  if (isUserRejection(e)) return "You declined the request in your wallet. Nothing was sent.";
  if (isWrongChain(e)) return "Your wallet is on a different network. Switch to Ethereum mainnet and try again.";
  if (isInsufficientFunds(e)) return "Your wallet does not have enough ETH to pay for gas.";
  const revert = revertName(e);
  if (revert && REVERTS[revert]) return REVERTS[revert]!;
  return null;
}
