# BondingCurveHook (reference implementation)

> **Reference only.** `BondingCurveHook` shows how a Uniswap v4 hook can price a pool with its
> own curve instead of concentrated liquidity. It is not used by Verada in production, has not
> been audited, and is not deployed by any script. Treat it as an example to learn from and to
> fork.

- Source: `contracts/src/hooks/examples/BondingCurveHook.sol`
- Tests: `contracts/test/hooks/examples/BondingCurveHook.t.sol`
- `contract BondingCurveHook is PoolAdminHook, IUnlockCallback` (concrete, deployable as is;
  constructor takes the pool manager only)

## Purpose

A bonding-curve token sale on a v4 pool. One side of each pool is the **curve token**, the other
the **quote** (any ERC-20 or native ETH). Buyers pay quote and receive tokens at a price that rises
as quote comes in; sellers return tokens for quote. When the quote raised reaches a threshold the
curve **graduates**: trading closes and the pool admin withdraws both reserves (for example to seed
a regular liquidity pool).

It uses the custom curve ("NoOp") pattern: in `beforeSwap` the hook returns a `BeforeSwapDelta`
that consumes the whole specified amount, so the pool manager runs its own swap with zero amount
and the pool's liquidity is never used. Adding liquidity to a curve pool is blocked.

## Curve

A virtual constant product, per pool:

```
x = virtualQuote + quoteReserve        y = tokenReserve        k = x * y
buy  (quote in q):  tokenOut = floor(y * q / (x + q))
sell (token in t):  quoteOut = floor(x * t / (y + t))     requires quoteOut <= quoteReserve
```

- `virtualQuote` sets the starting price (`virtualQuote / tokenReserve` quote per token) and is
  never paid out.
- Output rounds down, so `k` never decreases and a buy followed by selling the tokens received
  never returns more quote than was paid (both tested, fuzzed).
- A sell whose output exceeds the real `quoteReserve` reverts `InsufficientReserve()`. Tokens held
  outside the curve (anything the admin did not seed) can be sold into it up to that reserve, so
  seed the whole supply if the sale should be closed.
- Views `quoteBuy(PoolId, quoteIn)` and `quoteSell(PoolId, tokenIn)` return the exact amounts a
  swap would produce at the current state.

## Settlement

The hook keeps both reserves as **ERC-6909 claims** on the pool manager. For an exact-input swap
it returns `(specified = +amountIn, unspecified = -amountOut)`, which credits the hook the input
and debits it the output; it nets both by `poolManager.mint(hook, input, amountIn)` and
`poolManager.burn(hook, output, amountOut)`. No ERC-20 transfer and no external code runs inside
a swap. Invariant (tested after every operation):
`poolManager.balanceOf(hook, token.toId()) == tokenReserve` and the same for the quote.

## Configuration (pool admin)

The pool admin is the caller of `PoolManager.initialize` (see `PoolAdminHook`). The pool's LP fee
and starting price are irrelevant: the pool never trades its own liquidity.

| Function | Rules |
| --- | --- |
| `configureCurve(PoolKey key, bool tokenIs0, uint128 virtualQuote, uint128 graduationQuote)` | once per pool (`CurveAlreadyConfigured`); `virtualQuote > 0`, `graduationQuote > 0`, curve token not native (`InvalidCurve`) |
| `seed(PoolKey key, uint256 tokenAmount)` | after configure (`CurveNotReady`), before graduation (`CurveGraduated`), only until the first buy and with a non-zero amount (`SeedingClosed`). Pulls the tokens from the admin (approve the hook first) through `poolManager.unlock`; credits what the pool manager actually received. `hookNonReentrant`. |
| `withdrawAfterGraduation(PoolKey key, address to)` | only once graduated (`CurveNotGraduated`), `to != 0` (`InvalidRecipient`). Transfers both reserves to `to` as ERC-6909 claims (redeem with `unlock` + `burn` + `take`) and zeroes them. |
| `transferPoolAdmin(PoolKey key, address newAdmin)` | from `PoolAdminHook`; zero renounces and freezes the curve (no more seeding, no withdrawal). |

`unlockCallback` only accepts the pool manager (`NotPoolManager`) while this hook's own `seed`
holds the lock (`UnexpectedCallback`).

Typical flow: initialize the pool, `configureCurve`, approve and `seed` the supply, trade until
graduation, `withdrawAfterGraduation` to a migrator or the admin.

## Swaps

- Exact input in both directions. `buy` means the input is the quote (`zeroForOne != tokenIs0`).
- Graduation: after a buy, if `quoteReserve >= graduationQuote`, the curve sets `graduated` and
  emits `Graduated(poolId, quoteRaised)`. The crossing buy is filled in full (no cap).
- `hookData` is not read. Price limits are not applied (the pool's own swap has zero amount); use
  a router with a minimum output for slippage protection.

Reverts a trader's swap can hit (wrapped by the pool manager in `WrappedError`):

| Error | When |
| --- | --- |
| `ExactOutputNotSupported()` | `amountSpecified > 0` |
| `CurveNotReady()` | not configured, or token reserve zero (not seeded / fully bought) |
| `CurveGraduated()` | the curve graduated |
| `InsufficientReserve()` | the output exceeds the reserve that pays it |
| `SafeCastOverflow()` | an amount above `int128` / a reserve above `uint128` |

Adding liquidity reverts `LiquidityNotAllowed()` (in `beforeAddLiquidity`).

## Permissions

`beforeInitialize` (from `PoolAdminHook`), `beforeAddLiquidity`, `beforeSwap`,
`beforeSwapReturnDelta`. The deployed address must encode exactly these (mine it with
`script/HookMiner.sol`; tests use `HookTest._deployHook`).

## Events

- `CurveConfigured(PoolId indexed poolId, bool tokenIs0, uint128 virtualQuote, uint128 graduationQuote)`
- `CurveSeeded(PoolId indexed poolId, uint256 amount)`
- `CurveSwap(PoolId indexed poolId, address indexed sender, bool buy, uint256 amountIn, uint256 amountOut)`
  (`sender` is the caller of `PoolManager.swap`, usually a router)
- `Graduated(PoolId indexed poolId, uint256 quoteRaised)`
- `CurveWithdrawn(PoolId indexed poolId, address indexed to, uint256 tokenAmount, uint256 quoteAmount)`

## Composition

The callbacks call `super` first and are `virtual`, so the curve can be inherited next to other
features (the test composes it with a stub feature that adds `afterInitialize` and a `beforeSwap`
counter). Notes:

- The curve must be the **only** feature in a concrete hook that returns a `beforeSwap` delta: it
  consumes the full specified amount, so any extra specified delta makes the pool manager revert
  `HookDeltaExceedsSwapAmount`.
- An LP fee override from another feature has no effect (the pool's own swap is zero).
- `afterSwap` features see a zero pool delta for curve swaps; a fee feature that charges the
  unspecified side must be adapted to read the curve amounts instead.
- Because `BondingCurveHook` is concrete, a derived hook must re-declare every internal function
  that two of its bases define, including `_beforeInitialize` (`override(BaseHook,
  PoolAdminHook)`) and `_beforeAddLiquidity` (`override(BaseHook, BondingCurveHook)`).
- The error name `LiquidityNotAllowed()` is also used (with arguments) by `LiquidityGateHook`;
  both cannot be inherited together (they also make no sense together: the curve blocks all
  liquidity).
- It implements `IUnlockCallback`; a composition with another unlock-based feature must merge the
  two callbacks in the concrete hook.

## Security notes

- Reference code: unaudited, no production use.
- No token transfer inside a swap; reserves are claims and the claims invariant is tested.
- The admin controls seeding and withdrawal. Seeding closes at the first buy so the admin cannot
  dilute buyers by adding tokens mid-sale. After graduation the admin receives all quote raised and
  all unsold tokens; buyers rely on the admin (or a migrator contract set as admin) to use them as
  promised. Renouncing the admin before graduation locks the reserves forever.
- Fee-on-transfer curve tokens are credited by the amount received; rebasing tokens are not
  supported (claims do not rebase).
- Native ETH is supported as the quote (tested); the curve token must be an ERC-20.
- No fee is charged by the curve; add one in a fork by adjusting `amountIn` before the curve math.
