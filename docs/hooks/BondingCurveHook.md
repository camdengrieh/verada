# BondingCurveHook (reference implementation)

> **Reference only.** `BondingCurveHook` shows how a Uniswap v4 hook can price a pool with its
> own curve instead of concentrated liquidity. It is not used in production, has not been
> audited, and is not deployed by any script. Treat it as an example to learn from and to
> fork.

- Source: `contracts/src/hooks/examples/BondingCurveHook.sol`
- Tests: `contracts/test/hooks/examples/BondingCurveHook.t.sol`
- `contract BondingCurveHook is PoolInitGateHook, PoolAdminHook, Ownable, IUnlockCallback`
  (concrete, deployable as is; constructor `(IPoolManager poolManager, address owner)`)

## Known limitations

Fix these before using the code for a real sale:

- **Front-running is closed by an init gate.** Only initializers the owner allows with
  `setPoolInitializer(account, true)` may create curve pools, and the initializer becomes the
  pool admin. Without the gate, anyone who initialized a curve's pool key first would become its
  admin, configure the curve and later withdraw both reserves.
- **A graduated curve rejects every swap, sells included.** Holders have no market on this pool
  after graduation; they depend on the admin moving the reserves to a pool where they can trade.
- **The admin takes all raised quote.** `withdrawAfterGraduation` sends both reserves to any
  address the admin picks. Buyers trust the admin with their quote. Make the admin a migrator
  contract that withdraws and seeds a locked pool in the same transaction, so no person holds the
  reserves.

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

Only an allowed initializer may call `PoolManager.initialize` for a pool with this hook
(`PoolInitGateHook`; a refused caller gets `InitializerNotAllowed(sender)` wrapped by the pool
manager), and that initializer is the pool admin (see `PoolAdminHook`). The owner manages the
allowlist. The pool's LP fee and starting price are irrelevant: the pool never trades its own
liquidity.

| Function | Rules |
| --- | --- |
| `configureCurve(PoolKey key, bool tokenIs0, uint128 virtualQuote, uint128 graduationQuote)` | once per pool (`CurveAlreadyConfigured`); `virtualQuote > 0`, `graduationQuote > 0`, curve token not native (`InvalidCurve`) |
| `seed(PoolKey key, uint256 tokenAmount)` | after configure (`CurveNotReady`), before graduation (`CurveGraduated`), only until the first buy and with a non-zero amount (`SeedingClosed`). Pulls the tokens from the admin (approve the hook first) through `poolManager.unlock`; credits what the pool manager actually received. `hookNonReentrant`. |
| `withdrawAfterGraduation(PoolKey key, address to)` | only once graduated (`CurveNotGraduated`), `to != 0` (`InvalidRecipient`). Transfers both reserves to `to` as ERC-6909 claims (redeem with `unlock` + `burn` + `take`) and zeroes them. |
| `transferPoolAdmin(PoolKey key, address newAdmin)` | from `PoolAdminHook`; zero renounces and freezes the curve (no more seeding, no withdrawal). |
| `setPoolInitializer(address account, bool allowed)` | owner only (`Ownable`); who may create curve pools. Existing pools keep their admin. |

`unlockCallback` only accepts the pool manager (`NotPoolManager`) while this hook's own `seed`
holds the lock (`UnexpectedCallback`).

Typical flow: the owner allows a launch contract, which initializes the pool, calls
`configureCurve`, approves and `seed`s the supply in the same transaction; trade until
graduation; `withdrawAfterGraduation` to a migrator.

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

Adding liquidity reverts `CurveLiquidityDisabled()` (in `beforeAddLiquidity`).

## Walkthrough

A sale of 800M tokens (18 decimals) against an 18-decimal quote such as WETH, starting at a price
set by 3 quote of virtual reserve and graduating at 10 quote raised. Every number below is
asserted by a forge test against the real `PoolManager` (the same calls as
`contracts/test/hooks/examples/BondingCurveHook.t.sol`, where the token is `currency0`).

**1. Deploy and create the pool.** Mine an address with exactly `BEFORE_INITIALIZE |
BEFORE_ADD_LIQUIDITY | BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA` and deploy
`new BondingCurveHook{salt: s}(poolManager, owner)`. The owner allows the account that will
create the pool: `curve.setPoolInitializer(launcher, true)`. The launcher initializes a pool with
`hooks = curveHook` and becomes its admin. The fee, tick spacing and starting price are
irrelevant, because the pool's own liquidity is never used.

**2. Configure and seed.**

```solidity
curve.configureCurve(key, true /* token is currency0 */, 3e18 /* virtualQuote */, 10e18 /* graduationQuote */);
IERC20(token).approve(address(curve), type(uint256).max);
curve.seed(key, 800_000_000e18);
```

`x = 3e18`, `y = 8e26`, `k = x * y`. Starting price: `x / y = 3.75e-9` quote per token
(an 800M supply valued at 3 quote).

**3. A buy of 1 quote** (exact input, `zeroForOne = false` because the quote is `currency1`):

```
tokenOut = floor(y * q / (x + q)) = floor(8e26 * 1e18 / 4e18) = 200,000,000e18
```

The buyer gets 200M tokens; `quoteBuy(poolId, 1e18)` returns the same before the swap. Now
`x = 4e18` (3 virtual + 1 real), `y = 6e26`, price `6.67e-9`.

**4. A sell of 100M tokens** (exact input, `zeroForOne = true`):

```
quoteOut = floor(x * t / (y + t)) = floor(4e18 * 1e26 / 7e26) = 571,428,571,428,571,428
```

About 0.571 quote back for half of what 1 quote bought: the price moved up and the curve rounds
in its own favour. Real quote reserve: `1e18 - 0.5714e18 = 428,571,428,571,428,572`.

**5. The graduating buy of 9.6 quote.** `quoteReserve` becomes `10,028,571,428,571,428,572`, which
is at least `graduationQuote`, so this buy is filled in full, `graduated` is set and
`Graduated(poolId, 10.0286e18)` is emitted. The buyer receives
`515,789,473,684,210,526,293,167,128` tokens (about 515.8M). Left in the curve: about 184.2M
tokens. The last price is `(3 + 10.0286) / 184.2M = 7.07e-8`, 18.9 times the start.

**6. After graduation.** Any further swap reverts `CurveGraduated()`. The admin calls
`withdrawAfterGraduation(key, to)`, and `to` receives both reserves as ERC-6909 claims on the pool
manager: 10.0286 quote and about 184.2M tokens. A typical next step, outside this contract: a
migrator (set as the admin from the start, so buyers do not have to trust a person) redeems the
claims and seeds a regular v4 pool, for example with `LaunchpadHook` and its locked liquidity
recipe.

Choosing parameters:

- Starting price = `virtualQuote / seededTokens`. Doubling `virtualQuote` doubles the starting
  price and flattens the curve.
- Tokens sold by graduation = `seeded - k / (virtualQuote + graduationQuote)`; here, in whole
  units, `800M - (3 * 800M) / 13 = 615.4M` when the last buy lands exactly on the threshold
  (the walkthrough's last buy overshoots, so it sold 615.8M).
- Price at graduation = `(virtualQuote + graduationQuote)^2 / k`, so the price multiple over the
  sale is `((virtualQuote + graduationQuote) / virtualQuote)^2`, here `(13 / 3)^2 = 18.8`.

## Permissions

`beforeInitialize` (from `PoolInitGateHook` and `PoolAdminHook`), `beforeAddLiquidity`, `beforeSwap`,
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
  BondingCurveHook)`) and `_beforeAddLiquidity` (`override(BaseHook, BondingCurveHook)`).
  `BondingCurveHook` implements `_initialPoolAdmin` (`return sender`, safe behind its init gate);
  a derived hook that adds another `PoolAdminHook` feature re-declares it with
  `override(BondingCurveHook, PoolAdminHook)`.
- The liquidity error is `CurveLiquidityDisabled()`, so its name does not clash with
  `LiquidityGateHook`'s `LiquidityNotAllowed(poolId, sender)`. The two compile together, but they
  make no sense together: the curve already blocks all liquidity.
- It implements `IUnlockCallback`; a composition with another unlock-based feature must merge the
  two callbacks in the concrete hook.

## Security notes

- Reference code: unaudited, no production use.
- Pool creation is gated (`PoolInitGateHook`), so a front-runner cannot initialize a curve's key
  and become its admin. The owner decides who may create curves.
- No token transfer inside a swap; reserves are claims and the claims invariant is tested.
- The admin controls seeding and withdrawal. Seeding closes at the first buy so the admin cannot
  dilute buyers by adding tokens mid-sale. After graduation the admin receives all quote raised and
  all unsold tokens, and the pool rejects every swap, so buyers cannot sell back on the curve;
  buyers rely on the admin (or a migrator contract set as admin) to use the reserves as promised.
  Renouncing the admin before graduation locks the reserves forever.
- Fee-on-transfer curve tokens are credited by the amount received; rebasing tokens are not
  supported (claims do not rebase).
- Native ETH is supported as the quote (tested); the curve token must be an ERC-20.
- No fee is charged by the curve; add one in a fork by adjusting `amountIn` before the curve math.
