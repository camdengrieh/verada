# TwapOracleHook

A generic Uniswap v4 hook that gives every pool using it a time-weighted average tick (TWAP)
oracle. It needs no setup, has no admin and emits no events. It works on any pool: any currencies,
static or dynamic fee.

- Feature: `contracts/src/hooks/oracle/TwapOracleHook.sol` (`abstract contract TwapOracleHook is
  BaseHook, ITwapOracle`)
- Read interface: `contracts/src/hooks/interfaces/ITwapOracle.sol`
- Deployable example: `contracts/src/hooks/examples/TwapOracleExample.sol` (5 minutes, 24
  checkpoints)
- Tests: `contracts/test/hooks/oracle/TwapOracleHook.t.sol`

## How it works

Each pool has a tick accumulator, the sum of `tick * seconds` since the pool was initialized, and a
ring buffer of checkpoints of that accumulator.

- `afterInitialize` seeds checkpoint 0 at `block.timestamp` with accumulator 0
  (`_seedOracle(poolId)`).
- `beforeSwap` reads the pool's current `slot0` tick **before the swap moves it**, adds
  `tick * (now - lastTimestamp)` to the accumulator, and stores a new checkpoint when the newest one
  is at least `observationInterval` seconds old. When the ring is full, the oldest checkpoint is
  overwritten.
- Between swaps, the tick does not change, so readers extend the accumulator to `now` with the live
  `slot0` tick. No write is needed to keep the oracle current.

`twapTick(poolId, window)` picks the **newest checkpoint that is at least `window` seconds old** and
returns

```
avgTick = floor((cumulativeNow - checkpoint.tickCumulative) / (now - checkpoint.timestamp))
span    = now - checkpoint.timestamp            // >= window
```

The average rounds toward negative infinity (-1/3 gives -1, 19/3 gives 6), the same convention as
v4 tick math. Because checkpoints are spaced at least `observationInterval` apart, `span` can exceed
`window` by up to one interval (plus any idle time with no swaps). Callers that need a tight window
should check `span`.

## Interface

| Function | Returns |
| --- | --- |
| `twapTick(PoolId poolId, uint32 window)` | `(bool ok, int24 avgTick, uint32 span)` |
| `observationCount(PoolId poolId)` | `uint16`: stored checkpoints (0 for an unknown pool) |
| `observation(PoolId poolId, uint16 index)` | `(uint40 timestamp, int56 tickCumulative)`, chronological: 0 is the oldest kept, `count - 1` the newest; `(0, 0)` past the end |
| `observationInterval()` | `uint32`: minimum spacing between checkpoints |
| `observationCapacity()` | `uint16`: checkpoints kept per pool |

`ok` is false (and `avgTick`, `span` are 0) when:

- the pool was never initialized with this hook,
- `window == 0`,
- no kept checkpoint is at least `window` old: the pool is younger than `window`, or the checkpoint
  that old has been overwritten by the ring buffer.

A consumer must treat `ok == false` as "no price" and refuse to act, never as tick 0.

## Configuration

Two constructor arguments, stored as immutables:

```solidity
constructor(IPoolManager m) BaseHook(m) TwapOracleHook(observationInterval, observationCapacity) {}
```

- `observationInterval > 0` (seconds) and `observationCapacity >= 2`, else `InvalidOracleConfig()`.
- The longest window always answerable is about `observationInterval * (observationCapacity - 1)`
  on a busy pool. On a quiet pool, checkpoints are further apart, so the history reaches further
  back. The example (5 minutes, 24) covers at least 115 minutes.
- Storage per pool: one slot of state plus up to `observationCapacity` checkpoint slots. Gas per
  swap: one state slot read and written, plus a checkpoint write at most once per interval.

### Seeding without `afterInitialize`

The seed is an internal function:

```solidity
function _seedOracle(PoolId id) internal; // checkpoint 0 at block.timestamp, accumulator 0
```

It does not depend on the pool's tick (the first accrual reads `slot0`), so a concrete hook that
must keep the `afterInitialize` flag off (for example to keep an address it already deployed
with) can clear that flag in its `_hookPermissions` and call `_seedOracle(key.toId())` from its
`_beforeInitialize` instead. Call it exactly once per pool, at initialization: seeding again
restarts the accumulator and drops the history. A pool that was never seeded has no oracle
(`observationCount == 0`, `ok == false`) and accrual is a no-op.

## Permissions

`afterInitialize`, `beforeSwap`. The deployed address must encode exactly the merged flags of the
concrete hook (mine it with `contracts/script/HookMiner.sol`). For `TwapOracleExample` that is
`AFTER_INITIALIZE_FLAG | BEFORE_SWAP_FLAG`.

## Composition

The feature follows the composition rule in `DESIGN.md`. It calls `super` first in
`_afterInitialize` and `_beforeSwap`, and it passes on super's selector, delta and LP fee override
unchanged. It never decodes `hookData` and never takes the swap lock. In a concrete hook with
other features, re-declare the functions that two or more bases define:

```solidity
contract MyHook is TwapOracleHook, DecayingFeeHook {
    constructor(IPoolManager m) BaseHook(m) TwapOracleHook(5 minutes, 24) {}

    function _hookPermissions(Hooks.Permissions memory p)
        internal pure override(TwapOracleHook, DecayingFeeHook) returns (Hooks.Permissions memory)
    { return super._hookPermissions(p); }

    // DecayingFeeHook defines it; TwapOracleHook reaches BaseHook's definition
    function _beforeInitialize(address s, PoolKey calldata k, uint160 px)
        internal override(BaseHook, DecayingFeeHook) returns (bytes4)
    { return super._beforeInitialize(s, k, px); }

    // DecayingFeeHook does not define _afterInitialize: list BaseHook instead
    function _afterInitialize(address s, PoolKey calldata k, uint160 p, int24 t)
        internal override(BaseHook, TwapOracleHook) returns (bytes4)
    { return super._afterInitialize(s, k, p, t); }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal override(TwapOracleHook, DecayingFeeHook) returns (bytes4, BeforeSwapDelta, uint24)
    { return super._beforeSwap(s, k, sp, d); }
}
```

Every fee feature in the library is built on `PoolAdminHook`, so composing one with the oracle
always needs the `_beforeInitialize` re-declaration; with `SwapFeeHook`, which does not define it
itself, the list is `override(BaseHook, PoolAdminHook)`. With a feature built directly on
`BaseHook` that does not define `_beforeInitialize`, drop it.

The oracle reads `slot0` in `beforeSwap`, before any feature's delta or fee takes effect, so the
order of features in the inheritance list does not change what it records. The tests cover both
orders with a stub fee feature.

Other features of the same concrete hook can read the oracle internally, e.g. as the price reference
of `FeeConversionHook._hopMinOutput`, by calling `this.twapTick(...)`. They can also read
`_oracleState` and `_observations` directly.

## Security notes

- **Same-block manipulation is free of effect.** Accrual uses the tick that held *before* the swap,
  and a second swap in the same block accrues nothing (`dt == 0`). A flash swap or sandwich inside
  one block cannot move the average. Moving it requires the manipulated price to hold for real
  seconds across blocks, where arbitrageurs can trade against it. The cost scales with the share of
  the window being manipulated.
- **Multi-block manipulation is not prevented.** A validator or builder who controls consecutive
  blocks can hold a price for a few seconds. Pick a window long relative to the block time (12
  seconds) and to the value at stake. Bound deviations with `span` and a maximum allowed distance
  from spot.
- **Idle pools.** With no swaps, the live `slot0` tick extends the average. That is correct, because
  the tick did not change. But a pool can sit idle at a stale price that nobody arbitrages. Consider
  liquidity depth as well as the TWAP.
- **Tick, not price.** The result is the geometric mean price as a tick. Convert with
  `TickMath.getSqrtPriceAtTick`. Low-liquidity pools give low-quality oracles regardless of window.
- **Accumulator range.** `int56` holds `887272 * 2^35` (more than 1,000 years at the extreme tick).
  The accumulation uses checked arithmetic.
- **No admin, no upgrade, no external calls** beyond `extsload` reads of the pool manager. The hook
  stores nothing from callers.

## Tests

`FOUNDRY_PROFILE=hooks forge test --match-path test/hooks/oracle/TwapOracleHook.t.sol`, run against
the real `PoolManager` and routers:

- permissions and flag-encoded address, constructor config reverts, `onlyPoolManager`, unflagged
  callbacks
- checkpoint seeding at initialization, and `_seedOracle` called from `_beforeInitialize` with the
  `afterInitialize` flag cleared (`test_seedOracle_inBeforeInitialize`)
- hand-computed averages over four tick periods (positive and negative), checkpoint selection by
  window, and rounding toward negative infinity in both signs
- fuzz: a two-period average against a reference floor formula, and the floor division itself
- same-block swaps leave the average unchanged; one block later, the manipulated tick weighs one
  second
- ring buffer wrap: chronological indexing, the overwritten-history `ok == false` case, and
  checkpoint spacing
- `ok == false`: unknown pool, pool of another hook, zero window, history too short
- independence of two pools on one hook
- composition with a stub fee feature in both inheritance orders: merged flags, the fee override
  applied in the `Swap` event, the oracle still recording correctly
