# Case study: how Verada composes the generic hooks

Verada is a charity token launchpad on Ethereum. A factory launches a token, pairs it with an
allowed quote asset in a Uniswap v4 pool, places the launch liquidity in a locker that can never
remove it, and routes trading fees to nonprofits chosen by holders. It has two hooks, one per
launch mode:

| Hook | Mode | Composition |
| --- | --- | --- |
| `contracts/src/VeradaHook.sol` | weekly: fees accumulate and holders vote on a cause each week | `IVeradaHook, PoolInitGateHook, TwapOracleHook, DecayingFeeHook, SwapFeeHook` |
| `contracts/src/VeradaLiveHook.sol` | live: each swap's fee is converted to USDC in the same swap and credited to the active cause | `PoolInitGateHook, FeeConversionHook` |

Both started as bespoke contracts that implemented `IHooks` directly and bundled every
behaviour. They are now thin compositions of the generic features plus Verada glue: the glue
only overrides the features' `internal virtual` extension points; no feature was forked. Each
keeps its previous external interface (`IVeradaHook`, `IVeradaLiveHook`), events, errors and
address flags, so the contracts that call them did not change. The generic features add their
own entry points and views on top (for example `twapTick(poolId, window)`, `decayingFee`,
`swapFee`, `heldFees`).

This page shows each mapping, what stayed protocol glue and why, and what the exercise added to
the generic library. Read it as a worked example of adopting the library in an existing protocol.

## What stays Verada

Nothing below is a hook, and none of it moved into the library:

- `VeradaFactory`: deploys the token, configures the hook for it (`configureToken`), initializes
  the pool, and places the launch position with `VeradaLpLocker`.
- `VeradaLpLocker`: holds the launch position with no removal path and forwards LP fees.
- `FeeConsolidator` and `QuoteRegistry`: allowed quote assets, conversion routes, reference
  ticks and price guards.
- `FeeVault`, `LiveDonationVault`, `RotationGovernor`, the cause registry and the voting
  contracts.

## VeradaHook (weekly mode)

### Behaviour to reproduce

- Only the factory creates pools; one pool per token; dynamic-fee key; the token must have been
  configured by the factory (`configureToken(token, FeeConfig)`), exactly one side configured.
- LP fee: the token's base fee (`baseFeeBps` in `[MIN_FEE_BPS, MAX_FEE_BPS]` = 1% to 5%), paid
  to the locked position.
- Anti-sniper surcharge: `sniperFeeStartBps` (at most 80%) decaying linearly to zero over
  `sniperDecaySeconds` (at most a day), taken in `afterSwap` on the unspecified currency, sent as
  tokens to the fee consolidator and reported to it with `consolidate(token, currency, amount)`.
  The consolidator's own swaps are exempt.
- A TWAP (24 checkpoints at least 5 minutes apart) that the consolidator reads as
  `twapTick(token, window)`.
- The pool is registered with the consolidator at initialization.

### Mapping

| Behaviour | Feature | Glue in `VeradaHook` |
| --- | --- | --- |
| factory-only pools | `PoolInitGateHook` | constructor: `_setPoolInitializer(factory, true)` |
| one pool per token, dynamic fee, exactly one configured side | `PoolInitGateHook` key rule | `_validatePoolKey` reverts `InvalidPool` |
| base LP fee | `DecayingFeeHook` with a flat schedule (`startFee == endFee == baseFeeBps * 100` pips, `duration = 0`) | written in `_beforeInitialize` from the token's `FeeConfig` |
| decaying surcharge on the unspecified side | `SwapFeeHook`, tokens to `recipient = feeConsolidator` | `_swapFeeBps`: 0 for the consolidator, else `LinearDecay.value(sniperFeeStartBps, 0, sniperDecaySeconds, launchTimestamp, now)`; `_onSwapFeeTaken`: `consolidate(...)` and `SniperFeeTaken` |
| TWAP | `TwapOracleHook(OBS_INTERVAL, OBS_CAPACITY)` = `(5 minutes, 24)` | `twapTick(address token, uint32 window)` maps the token to its pool id and calls the generic `twapTick(poolId, window)` |
| frozen per-token config | `PoolAdminHook` | `_initialPoolAdmin` returns `address(0)`: no pool has an admin, so `setDecayingFee`, `setSwapFee` and `transferPoolAdmin` always revert `NotPoolAdmin` |
| register the pool with the consolidator | none | `_beforeInitialize`, after `super` |

Two design points worth copying:

- **Config derived from the protocol, then frozen.** The factory's `configureToken` is the only
  configuration call. `_beforeInitialize` turns the stored `FeeConfig` into the features' per pool
  structs (`decayingFee[id]`, `swapFee[id]`) and no admin is ever recorded, so the terms are fixed
  from the first block. Generic hooks with per pool admins become fixed-terms hooks with one
  override.
- **The rate comes from an override, the plumbing from the feature.** `swapFee[id]` stores only
  the recipient and settlement (`feeBps = 0`); `_swapFeeBps` supplies the decaying rate.
  `SwapFeeHook` handles the four swap shapes, rounding, the return delta and settlement.

One deliberate deviation from the composition rules: `TwapOracleHook` asks for
`afterInitialize` to seed its first checkpoint. To keep the deployed address flags of the
original hook (`beforeInitialize | beforeSwap | afterSwap | afterSwapReturnDelta`),
`VeradaHook._hookPermissions` clears that flag and seeds the oracle in `_beforeInitialize`
instead (the seed does not depend on the tick). A new protocol has no deployed flag set to keep
and should simply take the extra flag.

One observable difference from the bespoke hook: `twapTick` now rounds the average toward
negative infinity (the v3 oracle convention, from `TwapOracleHook`), where the bespoke hook
truncated toward zero. Negative non-integer averages are one tick lower; nothing else changes.

### Linearization

`VeradaHook is IVeradaHook, PoolInitGateHook, TwapOracleHook, DecayingFeeHook, SwapFeeHook`, so in
each callback the features run in this order: the initializer gate and key rule, the pool admin
record (zero), the dynamic-fee check, then the Verada initialization glue; in `beforeSwap` the
oracle accrues before the LP fee override is merged; in `afterSwap` the surcharge is taken.
The override lists are the same as in [ComposeYourOwn.md](ComposeYourOwn.md) plus
`PoolInitGateHook` in `_beforeInitialize` and `_hookPermissions`.

## VeradaLiveHook (live mode)

### Behaviour to reproduce

- Only the factory creates pools; one pool per token; dynamic fee; the quote must be allowed by
  the `QuoteRegistry`, routable to USDC and not USDC itself; the token must already be
  registered with the `LiveDonationVault`.
- LP fee forced to 0 (the locked position earns nothing).
- A fee of `baseFeeBps + launch surcharge(now)` (at most 85%) on the **gross quote flow** of every
  swap, always in the quote: taken in `beforeSwap` when the quote is the specified currency
  (exact-in buy, exact-out sell, with a full-fill check), in `afterSwap` otherwise.
- The fee is converted to USDC inside the swap by the fee consolidator along the quote's route,
  under the consolidator's in-swap price guards, paid to the vault and credited to the cause
  active at that moment (`RotationGovernor.activeCause(token)`). On any failure the fee is held
  per `(token, causeId)` and anyone can `retryHeld(token, causeId, amount)` later.
- A fixed gas floor (`LIVE_GAS_REQUIRED`) at `afterSwap`, so wallets estimate enough gas and the
  donation is never skipped silently.
- Nested swaps on any live pool revert `SwapReentered`; donations revert `DonateNotAllowed`.

### Mapping

| Behaviour | Feature | Glue in `VeradaLiveHook` |
| --- | --- | --- |
| callbacks, address check, shared transient lock | `BaseHook` | |
| factory-only pools | `PoolInitGateHook` | `_isAllowedInitializer`: `sender == factory`, else reverts `InvalidPool` (keeps the original error) |
| quote and token rules | `PoolInitGateHook` key rule | `_validatePoolKey`: `InvalidPool`, `QuoteNotRoutable(quote)`, `TokenNotRegistered(token)` |
| gas floor, synced-currency check, gas-capped try, hold on failure, permissionless retry | `FeeConversionHook` | gas constants via `_conversionPreTryGas`, `_conversionGasBudget`, `_conversionFallbackReserve`, `_conversionGasRequired` (650,000 budget, the original values) |
| held amounts per `(token, causeId)` | `FeeConversionHook` buckets | bucket = `keccak256(token, causeId)`; `heldRaw(token, causeId)` reads `heldFees[bucket][quote]`; `totalHeld` is the feature's own (same selector as before) |
| conversion through the consolidator | `FeeConversionHook._executeConversion` | override delegates to `consolidator.convertClaims(quote, amount, vault, inSwap)` (it burns the hook's claims as its ERC-6909 operator and pays USDC to the vault); `_settleConverted` is a no-op; `_hopMinOutput` is unreachable (no routes stored in the hook) |
| credit the active cause | `_onFeeConverted`, `_onFeeHeld` | `creditLive(token, causeId, rotation, out)` on success; the `FeeTaken` event on both paths, from a transient conversion context `(token, causeId, rotation)` |
| `retryHeld(token, causeId, amount)` | `FeeConversionHook._retryHeld` | the Verada entry point sets the lock and context and calls `_retryHeld(bucket, quote, amount)`; the generic bucket-keyed `retryHeld` always reverts because it carries no context |
| LP fee 0 | `BaseHook._mergeLpFeeOverride` | `_beforeSwap` merges `OVERRIDE_FEE_FLAG` (fee 0) |
| quote-side fee on the gross flow | none | `_beforeSwap` (specified quote) and `_afterSwap` (unspecified quote, and the full-fill check) |
| swap lock with the original error | `BaseHook` lock slot and states | taken in `_beforeSwap`, released in `_afterSwap`, reverting `SwapReentered`; `_usesSwapLock()` returns false so `BaseHook` does not take it a second time |
| no donations | none | `_beforeDonate` reverts `DonateNotAllowed` |

### Why the fee is glue, not `SwapFeeHook`

`SwapFeeHook` charges a rate of the **unspecified** currency on the **net** pool amount, in
`afterSwap`. The live fee must always be in the quote, so when the quote is the specified currency
it has to be taken in `beforeSwap` through the specified delta, and an exact-output fee is grossed
up (`feeGrossUp(net, b) = ceil(net * b / (10_000 - b))`) so that it is `b` of the gross. That is a
different fee model, not a parameter of the generic one, so it stays a Verada override of
`_beforeSwap` and `_afterSwap`. Everything around it (claims accounting, conversion, hold, retry,
gas floor, lock) is the generic feature.

### What the library gained

Fitting Verada's live hook without forking `FeeConversionHook` produced three generic extension
points that any protocol can use:

| Extension point | Use |
| --- | --- |
| `_executeConversion(bucket, currency, amount, inSwap)` | delegate the conversion to an external converter (an aggregator, a protocol's own router) instead of the stored route; pair it with a `_settleConverted` that does not take again |
| `_onFeeHeld(bucket, currency, amount, reason)` | react to a held fee inside the swap (an event in your own schema, a transient note); runs within the fallback reserve, so keep it cheap |
| `_retryHeld(bucket, currency, amount)` | expose your own retry entry point (other key, other errors) while reusing the hold accounting |

See [FeeConversionHook.md](FeeConversionHook.md).

## Lessons for adopters

1. Keep your external ABI and flags. Override the features' extension points and map your
   storage onto theirs in `_beforeInitialize`; integrators and indexers see no change.
2. Freeze what should be fixed. `_initialPoolAdmin` returning zero (or `transferPoolAdmin(key,
   0)` after configuring) turns admin-configurable features into fixed terms.
3. Keep protocol economics in overrides, not forks. A decaying surcharge is `_swapFeeBps`; fee
   routing is `_onSwapFeeTaken`; a donation credit is `_onFeeConverted`.
4. When a behaviour genuinely differs from a feature's model (Verada's gross quote-side fee),
   write it as glue on the callbacks and reuse the features around it, rather than bending a
   feature's semantics.
5. Prove equivalence with the existing test suite. Verada kept its original hook test suites
   (weekly in `contracts/test/VeradaHook.t.sol`, live in `contracts/test/live/`) as the
   equivalence check for the composed hooks. The only edits were error selectors that moved to
   `BaseHook` (for example `NotPoolManager`), `Currency`-typed arguments in Solidity callers
   (`totalHeld(Currency)`, same ABI selector as `totalHeld(address)`), the TWAP rounding
   convention above, and new tests for the generic API the composition exposes.
