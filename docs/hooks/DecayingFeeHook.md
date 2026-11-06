# DecayingFeeHook

`contracts/src/hooks/fee/DecayingFeeHook.sol` - `abstract contract DecayingFeeHook is PoolAdminHook`

A dynamic LP fee, set per pool, that starts at `startFee` and decays linearly to `endFee` over
`duration` seconds from `startTime`. Right after a launch the fee is high, so sniping the first
blocks is expensive, and the fee goes to the pool's LPs. Once the window ends the pool trades at
`endFee`. With `startFee == endFee` the hook is a plain dynamic fee that the pool admin sets.

The schedule math is in `contracts/src/hooks/libraries/LinearDecay.sol`. It is a pure library
that any feature can use for a time-based ramp down (a decaying hook fee, for example).

## Fee schedule

All fees are in pips, the v4 unit: `1_000_000` is 100%, `3000` is 0.30%.

```
fee(t) = startFee                                                     t <  startTime
       = endFee + ceil((startFee - endFee) * remaining / duration)    inside the window
       = endFee                                                       t >= startTime + duration
remaining = startTime + duration - t
```

At `startTime` the fee is exactly `startFee`. Values round up, so the fee is never below the exact
linear value and is at most 1 pip above it. A zero `duration` (only allowed when
`startFee == endFee`) gives a constant fee.

Example: `startFee = 100_000` (10%), `endFee = 3000` (0.30%), `duration = 3600`. After 1000 s the
fee is `3000 + ceil(97_000 * 2600 / 3600) = 73_056` (7.3056%). After 1800 s it is `51_500`. From
3600 s on it is `3000`.

## Configuration

| Function | Who | Effect |
| --- | --- | --- |
| `setDecayingFee(PoolKey key, uint24 startFee, uint24 endFee, uint32 duration, uint40 startTime)` | pool admin | sets or replaces the pool's schedule; `startTime == 0` means `block.timestamp` |
| `_setDecayingFee(PoolId id, uint24 startFee, uint24 endFee, uint32 duration, uint40 startTime)` | internal, the concrete hook | the body of `setDecayingFee` without the admin check: same validation, same event |
| `transferPoolAdmin(PoolKey key, address newAdmin)` (PoolAdminHook) | pool admin | hands over the role; `address(0)` freezes the schedule |
| `currentFee(PoolId) returns (uint24)` | view | the fee the hook applies now (0 when unset) |
| `decayingFee(PoolId)` | view | the stored `DecayingFee` struct |
| `poolAdmin(PoolId)` (PoolAdminHook) | view | the pool's admin |

The schedule is valid when all of these hold, else `InvalidDecayingFee(startFee, endFee,
duration)`:

- `endFee <= startFee <= LPFeeLibrary.MAX_LP_FEE`
- `duration <= _maxDecayDuration()` (30 days by default; `internal pure virtual`)
- `duration > 0` whenever `startFee != endFee`

A `startTime` in the past is allowed; the schedule is then already partly decayed. A
`startTime` in the future holds `startFee` until then. Calling again replaces the whole schedule.

The pool admin is whoever called `PoolManager.initialize` for the pool (see `PoolAdminHook`).
Because the admin only exists once the pool is initialized, a launcher should initialize and call
`setDecayingFee` **in the same transaction** (a factory or a multicall contract). Otherwise
swaps between the two transactions trade at the pool's stored fee, which is 0 for a new dynamic-fee
pool.

A protocol that derives the schedule from its own rules, with no admin call, writes it from the
concrete hook's `_beforeInitialize` (after `super`, so the dynamic-fee check has passed) with
`_setDecayingFee(key.toId(), ...)`. The pool then has its schedule from its first swap, and
`_initialPoolAdmin` can return zero so nobody can change it later.

## Behaviour in the pool

- `beforeInitialize`: runs `super` (PoolAdminHook records the admin), then reverts
  `NotDynamicFee()` unless `key.fee == LPFeeLibrary.DYNAMIC_FEE_FLAG`. A static-fee pool cannot be
  created with this hook.
- `beforeSwap`: runs `super` first. If the pool has a schedule, the result's LP fee becomes
  `_mergeLpFeeOverride(superFee, currentFee | OVERRIDE_FEE_FLAG)`. Without a schedule `super`'s
  values pass through unchanged and the pool trades at its stored LP fee (0 unless another feature
  sets it). A schedule of `0, 0` is still an override and forces a 0 fee.
- The hook never calls `updateDynamicLPFee`; the fee is applied per swap only. The fee in the
  PoolManager `Swap` event is the applied fee.
- No deltas, no token movements, no external calls, no `hookData`.

## Permissions

| Flag | From |
| --- | --- |
| `beforeInitialize` | PoolAdminHook |
| `beforeSwap` | DecayingFeeHook |

Standalone address flags: `Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG`. Mine the
address with `script/HookMiner.sol`; in tests use `HookTest._deployHook`.

## Deploying it alone

`contracts/src/hooks/examples/DecayingFeeExample.sol`:

```solidity
contract DecayingFeeExample is DecayingFeeHook {
    constructor(IPoolManager poolManager_) BaseHook(poolManager_) {}
}
```

Then:

1. Initialize a pool with `fee = LPFeeLibrary.DYNAMIC_FEE_FLAG` and `hooks = example`.
2. In the same transaction, call `setDecayingFee(key, startFee, endFee, duration, 0)`.
3. Optionally renounce with `transferPoolAdmin(key, address(0))` to fix the schedule for good.

## Composition

Inherit it with other features and re-declare the shared overrides (DESIGN.md rule 6):

```solidity
contract MyHook is DecayingFeeHook, OtherFeature {
    constructor(IPoolManager m) BaseHook(m) {}

    function _hookPermissions(Hooks.Permissions memory p)
        internal pure override(DecayingFeeHook, OtherFeature) returns (Hooks.Permissions memory)
    { return super._hookPermissions(p); }

    function _beforeInitialize(address s, PoolKey calldata k, uint160 px)
        internal override(DecayingFeeHook, OtherFeature) returns (bytes4)
    { return super._beforeInitialize(s, k, px); }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata p, bytes calldata d)
        internal override(DecayingFeeHook, OtherFeature) returns (bytes4, BeforeSwapDelta, uint24)
    { return super._beforeSwap(s, k, p, d); }
}
```

- LP fee overrides from several features merge to the **highest** fee, whatever the inheritance
  order. With another feature asking for 0.30%, the pool pays the decaying fee while it is above
  0.30% and 0.30% after that (tested in `test_composedFeeIsMaxOfFeatures`).
- To change who may configure (for example "only the factory"), override `_isPoolAdmin` or
  `_initialPoolAdmin` from `PoolAdminHook`. To allow longer windows, override
  `_maxDecayDuration`.
- `LinearDecay.value` can drive other schedules, such as a decaying hook fee in a `SwapFeeHook`
  override of `_swapFeeBps`.

## Events and errors

- `DecayingFeeSet(PoolId indexed poolId, uint24 startFee, uint24 endFee, uint32 duration, uint40
  startTime)` (the resolved `startTime`, never 0).
- `NotDynamicFee()`: pool initialization with a static fee.
- `InvalidDecayingFee(uint24 startFee, uint24 endFee, uint32 duration)`: rejected schedule.
- `NotPoolAdmin(PoolId, address)` (PoolAdminHook): caller is not the admin, or `key.hooks` is
  not this hook.

## Security notes

- Callbacks are pool-manager only (BaseHook). `setDecayingFee` checks `key.hooks == this` and the
  admin through `onlyPoolAdmin`.
- Reverts this feature can add to a trader's swap: none of its own. At `startFee` (or any current
  fee) of 100% (`MAX_LP_FEE`), the pool manager rejects exact-output swaps
  (`InvalidFeeForExactOut`) and an exact-input swap gives its whole input to LPs. Keep `startFee`
  well below 100% unless that is the intent.
- The admin can raise the fee at any time (up to 100%) by setting a new schedule. Traders who
  need a bound should check that the admin is renounced (`poolAdmin == address(0)`) or is a
  contract that cannot change it, and should always use a slippage limit.
- Before the schedule is set the pool trades at its stored fee (0 for a new dynamic-fee pool). See
  "Configuration" for setting it atomically with the initialization.
- The fee goes to in-range LPs through the pool's normal fee growth; the hook holds no funds.
- Time is `block.timestamp`; validators can shift it by a few seconds, which moves the fee by at
  most `(startFee - endFee) * seconds / duration`.

## Tests

`contracts/test/hooks/fee/DecayingFeeHook.t.sol` (real `PoolManager` from v4-core `Deployers`,
hook placed at a flag address by `HookTest._deployHook`):

- `LinearDecay` fixed values, rounding cases, fuzz against a reference formula (bounds and the
  round-up property), monotonic fuzz, revert on a rising schedule.
- Permissions and address check; callbacks only from the pool manager.
- Config: stored values and event, `startTime == 0`, future start, replacement, valid boundaries,
  each invalid case, admin only, key of another hook, transferred admin, frozen admin;
  `_setDecayingFee` skips the admin check but validates like the setter.
- Pool: fee in the `Swap` event at t0, mid-window (rounded up), half way, end and long after;
  unset pool trades at its stored fee; static-fee pool cannot initialize; per-pool schedules;
  output halves at a 50% fee; a 100% fee blocks exact-output swaps.
- Composition with a stub feature: merged permissions, both `beforeInitialize` steps run, the
  stub's fee passes through on an unset pool, and the higher of the two fees applies.

Run: `cd contracts && FOUNDRY_PROFILE=hooks forge test --match-path test/hooks/fee/DecayingFeeHook.t.sol`.
