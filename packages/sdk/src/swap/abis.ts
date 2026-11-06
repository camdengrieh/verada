/**
 * Minimal ABIs for the third-party contracts the swap engine talks to. Hand-written (only the
 * functions used) so the SDK does not depend on forge artifacts for contracts it does not own.
 */

const poolKeyComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

const pathKeyComponents = [
  { name: "intermediateCurrency", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
  { name: "hookData", type: "bytes" },
] as const;

/**
 * Uniswap v4 `V4Quoter`. The quote functions are `nonpayable` on chain (they run the swap and
 * revert with the result, which the quoter decodes), but they are meant to be called with
 * `eth_call`; they are typed `view` here so `readContract` accepts them.
 */
export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: poolKeyComponents },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactOutputSingle",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: poolKeyComponents },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "exactCurrency", type: "address" },
          { name: "path", type: "tuple[]", components: pathKeyComponents },
          { name: "exactAmount", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactOutput",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "exactCurrency", type: "address" },
          { name: "path", type: "tuple[]", components: pathKeyComponents },
          { name: "exactAmount", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** Uniswap v4 `StateView`: the read-only window on the pool manager's pool state. */
export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;

/** Universal Router entry points. */
export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/** Permit2 `AllowanceTransfer`: the allowance table and the on-chain `approve`. */
export const permit2Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

/** The WETH9 wrapper (deposit / withdraw), used by the wrap-only route. */
export const wethAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] },
] as const;

/** Ondo's shared pause manager and compliance view (see `ONDO_INFRA`). */
export const ondoPauseManagerAbi = [
  { type: "function", name: "isTokenPaused", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allTokensPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

export const ondoTokenAbi = [
  { type: "function", name: "tokenPauseManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "compliance", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** Reverts when `account` is blocked or sanctioned (custom errors `UserBlocked` / `UserSanctioned`). */
export const ondoComplianceAbi = [
  { type: "function", name: "checkIsCompliant", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [] },
  { type: "error", name: "UserBlocked", inputs: [] },
  { type: "error", name: "UserSanctioned", inputs: [] },
] as const;

/** What both Varada hooks expose for the fee display (`VaradaHook` and `VaradaLiveHook`). */
export const varadaHookFeeAbi = [
  { type: "function", name: "currentFeeBps", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint24" }] },
  {
    type: "function",
    name: "feeConfig",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "baseFeeBps", type: "uint24" },
          { name: "surchargeStartBps", type: "uint24" },
          { name: "decaySeconds", type: "uint32" },
          { name: "launchTimestamp", type: "uint40" },
        ],
      },
    ],
  },
  /** Live hook only: its donation vault. A call that reverts means a weekly hook. */
  { type: "function", name: "vault", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** Quote registry reads used to learn the allowlisted quote assets and a token's quote. */
export const quoteRegistryReadAbi = [
  { type: "function", name: "quoteAssetCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "quoteAssetAt", stateMutability: "view", inputs: [{ name: "index", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "isAllowed", stateMutability: "view", inputs: [{ name: "asset", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export const factoryQuoteAbi = [
  { type: "function", name: "quoteAssetOf", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "quoteRegistry", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "liveHook", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "hook", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
