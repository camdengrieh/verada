/** A launch failure explained for the creator, and whether a new salt would help. */
export interface LaunchErrorHelp {
  text: string;
  /** Another salt gives a different token address, which sidesteps a pool or token that already exists. */
  rerollSalt?: boolean;
}

// Uniswap v4 `PoolAlreadyInitialized()`.
const POOL_ALREADY_INITIALIZED = "0x7983c051";

const KNOWN: { match: RegExp; help: LaunchErrorHelp }[] = [
  { match: /user rejected|user denied|rejected the request/i, help: { text: "You declined the transaction in your wallet. Nothing was sent." } },
  {
    match: new RegExp(`PoolAlreadyInitialized|${POOL_ALREADY_INITIALIZED}`, "i"),
    help: { text: "A pool already exists for this token address. Pick a new salt and sign again: the salt only changes the token's address.", rerollSalt: true },
  },
  { match: /TokenAlreadyDeployed/i, help: { text: "A token with this exact name, symbol, metadata and salt already exists. Pick a new salt and sign again.", rerollSalt: true } },
  { match: /LabelTaken/i, help: { text: "That ENS label was taken while you were filling this in. Go back to Identity and choose another." } },
  { match: /LabelReserved/i, help: { text: "That ENS label is reserved. Go back to Identity and choose another." } },
  { match: /QuoteAssetNotAllowed/i, help: { text: "The quote registry no longer allows that pair. Go back to Pair and choose another asset." } },
  { match: /PoolTooSmall/i, help: { text: "The chosen causes and regions hold fewer than two organizations in the latest catalogue. Widen the focus." } },
  { match: /InactiveCause/i, help: { text: "The first charity is not active in the cause registry. Go back to Giving and choose another." } },
  { match: /LiveModeNotConfigured/i, help: { text: "Live donation is not enabled on this factory yet. Choose the epoch pool." } },
  { match: /LiquidityTooLarge|InvalidStartTick/i, help: { text: "The starting market cap is outside what the pool can hold. Go back to Pair and change it." } },
  { match: /InvalidFee|InvalidSniperFee/i, help: { text: "The factory rejected the fee settings. Go back to Fees and check them." } },
  { match: /insufficient funds/i, help: { text: "Your wallet does not hold enough ETH for the gas." } },
];

export function launchErrorHelp(message: string): LaunchErrorHelp {
  const hit = KNOWN.find((k) => k.match.test(message));
  return hit?.help ?? { text: message || "The launch failed." };
}
