# FeeConversionHook

`contracts/src/hooks/conversion/FeeConversionHook.sol`, an
`abstract contract FeeConversionHook is BaseHook, IUnlockCallback`.

## Purpose

Fees often arrive in whatever currency a pool happens to trade, but whoever collects them wants a
single currency. This feature converts fee claims (ERC-6909) that the hook holds into one
immutable `conversionTarget` currency **inside the swap that earned them**. It swaps through a
route of hookless pools and checks each hop with a price guard that the concrete hook supplies.

If the conversion cannot run or fails for any reason, the claims are **held** under a bucket
(any `bytes32`, usually the pool id). Anyone can retry them later, outside a swap, in full or in
chunks. A conversion failure never reverts the trader's swap. The only revert this feature adds
to a swap is `InsufficientGas` (see "Gas").

The feature takes no fee itself. A fee feature feeds it, normally `SwapFeeHook` with
`recipient = address(this)` and `asClaims = true`, whose `_onSwapFeeTaken` calls
`_convertOrHold` right after the pool manager minted the claims.

Deployable example: `contracts/src/hooks/examples/ConvertingSwapFeeExample.sol`
(`SwapFeeHook + FeeConversionHook + Ownable`).

## Configuration

| Item | How |
| --- | --- |
| Target currency | constructor `FeeConversionHook(Currency conversionTarget)` (immutable; native ETH is `address(0)`) |
| Route per fee currency | `_setConversionRoute(Currency from, PoolKey[] calldata route)` (internal; the concrete hook adds access control) |
| Clear a route | `_clearConversionRoute(Currency from)` (fees in `from` are then held) |
| Price guard | `_hopMinOutput(...)`, which you must implement |
| Recipient | `_conversionRecipient(bytes32 bucket)`, which you must implement |

A route has 1 to `MAX_ROUTE_HOPS` (3) hops. Every hop must be hookless (`address(hooks) == 0`),
and the hops must be contiguous from `from` to `conversionTarget`. A route for the target itself
is rejected. Otherwise the setter reverts `InvalidRoute()`. A fee that is already in the target
needs no route: it is paid out directly.

The example exposes these to its `Ownable` owner: `setConversionRoute`, `clearConversionRoute`,
`setHopGuard(hop, referenceTick, inSwapDeviationTicks, inSwapSlippageBps, retryDeviationTicks,
retrySlippageBps)` (slippage at most 2000 bps) and `setPayout`.

Views: `conversionRoute(Currency)`, `heldFees(bucket, currency)`, `totalHeld(currency)`,
`conversionGasRequired()`, `conversionTarget()`.

## Flow

### In-swap: `_convertOrHold(bucket, currency, amount)`

Precondition: the hook just received `amount` of `currency` as its own claims (not yet counted
in `totalHeld`), and the pool manager is unlocked.

1. `amount == 0`: return, nothing to do.
2. `gasleft() < _conversionGasRequired()`: revert `InsufficientGas(required, left)`.
3. A currency is synced on the pool manager (a router is between `sync` and `settle`): hold the
   fee with reason `SYNCED_CURRENCY_PENDING`. Moving pool manager balances at this point would
   break the router's settlement.
4. Otherwise `try this.convertInline{gas: _conversionGasBudget()}(...)` with a bare `catch`. On
   failure the claims are held, and `FeeHeld.reason` carries the first 4 bytes of the revert
   data.
5. Whenever a fee is held (step 3 or 4), `_onFeeHeld(bucket, currency, amount, reason)` runs
   after `FeeHeld` (no-op by default). It runs inside the swap within
   `_conversionFallbackReserve()`, so keep it cheap: an event in your own schema, a transient
   note.

`convertInline` is self-only (`NotSelf()`) and runs `_convert(inSwap = true)`:

- `_executeConversion(bucket, currency, amount, inSwap)` turns the claims into `out` of the
  target. The default burns the hook's own claims and swaps exact-input hop by hop along the
  stored route. For each hop, `minOut = _hopMinOutput(...)`. A hop that does not consume all of
  its input reverts `PartialFill()`. A short output reverts `SlippageExceeded(out, minOut)`.
  Override it to delegate to an external converter (it burns the claims as the hook's ERC-6909
  operator and pays the target itself); pair that with a `_settleConverted` that does not take
  again.
- A zero `out` reverts `SlippageExceeded(0, 1)`.
- `_settleConverted(bucket, out)`. By default this calls `poolManager.take(conversionTarget,
  _conversionRecipient(bucket), out)`, and a zero recipient reverts `ZeroConversionRecipient()`.
- `_onFeeConverted(bucket, currency, amountIn, out, inSwap)` (no-op by default), then
  `FeeConverted`.

All of these steps run inside the try frame, so any failure rolls them all back to "held".

### Retry: `retryHeld(bucket, currency, amount)`

Anyone can call it. It is `hookNonReentrant` and accepts chunks.

- Reverts `PoolManagerBusy()` if the pool manager is unlocked, `NothingToRetry()` for a zero
  amount, and `AmountExceedsHeld(amount, held)` if the amount is more than the bucket holds.
- Lowers `heldFees` and `totalHeld` first, then calls `poolManager.unlock`. `unlockCallback`
  requires `msg.sender == poolManager` (`NotPoolManager`) and `_hookLockState() == LOCK_CALL`
  (`UnexpectedUnlock`), then runs `_convert(inSwap = false)`.
- If the conversion fails, the whole retry reverts and the held amounts are unchanged.
- The body is `_retryHeld(bucket, currency, amount)` (internal). A concrete hook that wants its
  own retry entry point (a different key, different errors) holds the lock in `LOCK_CALL` itself
  and calls `_retryHeld`. For example, a hook that keys held fees by `(token, recipient)` can
  expose `retryHeld(token, recipient, amount)`, derive the bucket as
  `keccak256(abi.encode(token, recipient))` and pass it on.
- Emits `HeldFeeRetried(bucket, currency, caller, amountIn, amountOut)`.

## Price guard

`_hopMinOutput(PoolKey memory hop, bool zeroForOne, uint256 amountIn, uint160 sqrtPriceX96,
int24 spotTick, bool inSwap)` has no default implementation. The concrete hook decides what
counts as a trustworthy price: a TWAP (for example from a `TwapOracleHook` pool), an external
feed, or a reference tick set by an admin. `inSwap` is true inside the trader's swap and false on
a retry. Inside the swap, the trader picks the moment and may have moved route pools earlier in
the same transaction, so use the tightest bounds there.

The helper `_minOutFromReference(amountIn, zeroForOne, sqrtSpot, spotTick, referenceTick,
maxDeviationTicks, maxSlippageBps, hopFeePips)` implements a reference-tick guard. It also has an
overload that takes a `ReferenceGuard` struct, which uses fewer stack slots for callers compiled
without via_ir.

- It reverts `PriceDeviation(spotTick, referenceTick)` when `|spot - reference| >
  maxDeviationTicks`.
- `expected = max(quote at spot, quote at reference)`. A spot pushed below the reference, while
  still inside the band, therefore does not lower the minimum.
- `minOut = expected * (10_000 - maxSlippageBps - ceil(hopFeePips / 100)) / 10_000`. The result
  is 0 when the tolerance reaches 100%.
- Quotes ignore price impact: `amount * P` or `amount / P` with `P = (sqrtPrice / 2^96)^2`,
  computed with two `mulDiv` calls.

`_hopSwapFeePips(hop, zeroForOne)` returns a hop's total swap fee: its LP fee combined with the
pool manager's protocol fee for that direction.

## Gas

| Internal pure virtual | Default |
| --- | --- |
| `_conversionPreTryGas()` | 40,000 |
| `_conversionGasBudget()` | 650,000 (three hops, payout and a callback) |
| `_conversionFallbackReserve()` | 70,000 (hold path: two slots, event) |
| `_conversionGasRequired()` | pre-try + budget * 64 / 63 + reserve = **770,317** |

The requirement does not depend on state, so `eth_estimateGas` finds it. A swap whose fee is
converted needs that much gas left at `afterSwap`. With less, it reverts `InsufficientGas`
instead of silently skipping the conversion. The `64 / 63` factor makes sure the full budget is
forwarded despite the 63/64 rule. Override the budget to match your routes and callbacks.

## Permissions

`beforeSwap` and `afterSwap`, which the shared swap lock needs. `_usesSwapLock()` returns
`true`. The feature does not override either swap callback. When composed with `SwapFeeHook`,
the merged set adds `beforeInitialize`, `afterSwap` and `afterSwapReturnDelta`.

## Composition

- A concrete hook combines a fee feature with this one. For example, from the example:

  ```solidity
  contract ConvertingSwapFeeExample is SwapFeeHook, FeeConversionHook, Ownable {
      function _onSwapFeeTaken(address s, PoolKey calldata key, Currency c, uint256 amount,
          address recipient, bool asClaims) internal override {
          super._onSwapFeeTaken(s, key, c, amount, recipient, asClaims);
          if (recipient == address(this) && asClaims) {
              _convertOrHold(PoolId.unwrap(key.toId()), c, amount);
          }
      }
  }
  ```

- Rule 6 re-declarations with `SwapFeeHook`: `_hookPermissions` `override(SwapFeeHook,
  FeeConversionHook)`, `_usesSwapLock` `override(BaseHook, FeeConversionHook)`,
  `_beforeInitialize` `override(BaseHook, PoolAdminHook)` and `_afterSwap` `override(BaseHook,
  SwapFeeHook)`, each with body `return super._x(...)`.
- Buckets are opaque. The example uses the pool id. A protocol can use any key: a recipient,
  an epoch, a `(pool, recipient)` pair.
- Customize the payout through `_settleConverted` (for example, mint claims to a vault instead of
  taking tokens) and `_onFeeConverted` (for example, credit a ledger). Both run inside the try
  frame, so if either reverts, the fee is held.
- Replace the converter with `_executeConversion` (an aggregator or a protocol router instead of
  the stored route), react to holds with `_onFeeHeld`, and expose your own retry with
  `_retryHeld`. A hook can use all three together: an external converter, a held-fee event in its
  own schema, and a retry keyed by its own identifiers.
- `unlockCallback` is `virtual`. A concrete hook that also inherits another feature implementing
  `IUnlockCallback` must override it and dispatch on its own data.
- The feature does not read `hookData`.

## Invariants

For a hook whose only ERC-6909 claims are fees:

- `poolManager.balanceOf(hook, id(c)) == totalHeld[c] == sum of heldFees[*][c]` after every
  swap and every retry.
- A fee is either converted in its swap or held in full. A retry lowers the held amounts by
  exactly the claims it burns.
- The burn, the hops and the payout net to zero across the hook's pool manager deltas, and the
  feature never calls `sync`.

## Security notes

- Reverts this feature adds to a trader's swap: `InsufficientGas` only. Everything else is
  caught and held.
- The swap lock means code reached during a conversion (the recipient, `_onFeeConverted`
  callees, a native ETH payout) cannot swap on any pool of this hook (`HookReentered(1)`, which
  is caught, so the fee is held). It also cannot call `retryHeld` (`HookReentered`). A retry
  cannot be nested (`HookReentered(2)`) or run inside someone else's unlock (`PoolManagerBusy`).
- Route pools must be hookless, so no third-party hook code runs during the conversion.
- The guard is your responsibility. A weak guard lets a trader push a route pool before their
  swap and buy the fee cheaply in the same transaction. Bound the in-swap deviation tightly
  against a reference the trader cannot move within one transaction. Holding is always safe.
- With a native target, the recipient receives ETH inside the swap, and its code runs within the
  gas budget. With an ERC-20 target, the payout is a token transfer.
- Held claims sit in the pool manager under the hook. Only `retryHeld` moves them, and only into
  the target, paid to the recipient. There is no admin withdrawal.
- `retryHeld` is permissionless, so anyone can choose its timing, but the retry bounds still
  apply.

## Tests

`contracts/test/hooks/conversion/FeeConversionHook.t.sol` uses the real `PoolManager`, routers
from `Deployers`, hook addresses placed with `HookTest._deployHook`, and real hookless route
pools. Its test concrete composes a counter stub, a stand-in fee feature (the `SwapFeeHook`
spec) and this feature. It covers:

- permissions, and the bare feature deployed on its own
- in-swap conversion with 1 and 2 hops, and with the fee already in the target
- held paths: pushed route pool (`PriceDeviation`), synced currency, no route or cleared route,
  slippage, partial fill, missing guard, zero recipient, reverting callback, nested swap
- `InsufficientGas` (decoded from the pool manager's `WrappedError`)
- retry: full, chunked, a failure that keeps the hold, zero amount, more than held, inside an
  unlock, inside a swap, nested
- entry point guards and route validation
- a native ETH target
- fuzz: swap size and route push against the trader's swap succeeding, converted xor held, and
  the claims invariant; `_minOutFromReference` against a reference formula; quote identity at
  tick 0

`contracts/test/hooks/examples/ConvertingSwapFeeExample.t.sol` runs the example with the real
`SwapFeeHook`. It covers conversion, hold and retry, a different recipient and token settlement
(no conversion), owner gating, guard validation and payout changes.

`contracts/test/hooks/conversion/FeeConversionExtensions.t.sol` covers the extension points on
their own: `_executeConversion` (default route, target currency, revert and zero output held, an
external converter override, `inSwap == false` on retry), `_onFeeHeld` (held amounts already
updated, the synced-currency and no-route reasons, not called on success) and a custom retry
entry point over `_retryHeld` (chunks, failure keeps the hold, the lock is required, validation,
re-entry from a conversion blocked).

```
cd contracts
FOUNDRY_PROFILE=hooks forge test --match-contract 'FeeConversionHookTest|FeeConversionExtensionsTest|ConvertingSwapFeeExampleTest'
```
