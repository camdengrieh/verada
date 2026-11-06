# Generic Uniswap v4 hooks: design

Status: implemented. This is the spec the base, the six feature modules, the examples and the
Verada rebuild were built against; the user-facing docs start at [README.md](README.md).
Everything here targets Ethereum mainnet, Solidity 0.8.26, `cancun`, and the Uniswap v4 core and
periphery in `contracts/lib`.

## Why

Verada's two production hooks (`VeradaHook`, `VeradaLiveHook`) each bundle every feature into one
bespoke contract: factory-only pool creation, a launch fee that decays, a base fee, a TWAP oracle,
a hook fee, in-swap conversion of that fee and charity routing. None of it can be reused by another
LP or protocol, and none of it can be used without the rest.

This library splits those features into **generic hooks**, each named for what it does, each usable
on its own and combinable with the others into one concrete hook (a v4 pool has exactly one hook
address). The protocol-specific parts (token factory, locked launch liquidity, charity fee routing,
governance) stay as thin glue on top.

The production hooks were then rebuilt as compositions of the generic modules, keeping their
external interfaces and address flags (see "Verada as a composition" and [Verada.md](Verada.md)).

## Layout

```
contracts/src/hooks/
  base/        BaseHook.sol, PoolAdminHook.sol        shared, owned by the base
  fee/         DecayingFeeHook.sol, SwapFeeHook.sol
  oracle/      TwapOracleHook.sol
  access/      PoolInitGateHook.sol, LiquidityGateHook.sol
  conversion/  FeeConversionHook.sol
  libraries/   LinearDecay.sol
  interfaces/  ITwapOracle.sol
  examples/    one minimal concrete hook per feature, the bonding curve, the launchpad composition
contracts/test/hooks/
  utils/HookTest.sol                                  shared test base
  base/ fee/ oracle/ access/ conversion/ examples/ integration/
docs/hooks/
  README.md (catalogue, install, gas, trust), DESIGN.md (this file), one <Module>.md per module,
  BaseHook.md, ComposeYourOwn.md (tutorial), Composition.md (reference), Verada.md (case study)
```

Build and test only the hooks (no `via_ir`, separate `out-hooks/` and `cache-hooks/`, a few
seconds):

```
cd contracts
FOUNDRY_PROFILE=hooks forge build
FOUNDRY_PROFILE=hooks forge test
```

The default profile still builds everything (including `src/hooks`) with `via_ir`.

## Naming

- A feature hook is an `abstract contract <What>Hook is BaseHook` (or `is PoolAdminHook` when it has
  per-pool config). The name says what it does: `DecayingFeeHook`, `SwapFeeHook`, `TwapOracleHook`,
  `PoolInitGateHook`, `LiquidityGateHook`, `FeeConversionHook`. No protocol names in `src/hooks`
  outside `examples/`.
- A deployable hook is a non-abstract contract in `examples/`: `<Feature>Example` for the single
  feature demo, a descriptive name for compositions (`LaunchpadHook`, `BondingCurveHook`).
- Internal callback overrides are `_beforeSwap`, `_afterSwap`, ... (the `IHooks` name with a
  leading underscore). Feature internals that a protocol may customize are `internal virtual` and
  prefixed by the feature (`_swapFeeBps`, `_onSwapFeeTaken`, `_conversionRecipient`).
- Errors and events carry the feature's vocabulary (`SwapFeeTaken`, `InvalidDecayingFee`), never a
  protocol's.

## The composition rule

`BaseHook` (`contracts/src/hooks/base/BaseHook.sol`) implements `IHooks`. Every external entry
point is `onlyPoolManager` and forwards to `internal virtual _<callback>`. A concrete hook inherits
one or more features:

```solidity
contract MyHook is TwapOracleHook, DecayingFeeHook, SwapFeeHook {
    constructor(IPoolManager m) BaseHook(m) TwapOracleHook(5 minutes, 24) {}
    // re-declare each callback that two or more bases define (rule 6)
}
```

1. **Callbacks: call `super` first.** A feature overrides `_x`, calls `super._x(...)` first, then
   does its own work and combines its result with super's. Logic therefore runs in inheritance
   list order (for `is A, B, C`: A, then B, then C). The root of every chain is `BaseHook`: it
   returns the neutral result (selector, zero delta, no fee override) when the hook's address
   enables that callback and reverts `HookNotImplemented` when it does not.
2. **Permissions are OR-merged.** Features never override `getHookPermissions()`. They override
   `_hookPermissions(Hooks.Permissions memory p)`, call `super`, and only ever set flags. The
   constructor checks the deployed address against the merged set
   (`Hooks.validateHookPermissions`), so the address must be mined (`script/HookMiner.sol`) or, in
   tests, placed with `HookTest._deployHook`.
3. **Return values.**
   - Selector: pass on the one from `super`.
   - `afterSwap`, `afterAddLiquidity`, `afterRemoveLiquidity` deltas: **summed**
     (`return (sel, superDelta + ownDelta)`).
   - `beforeSwap` delta: summed per component with `_addBeforeSwapDelta`.
   - `beforeSwap` LP fee override: merged with `_mergeLpFeeOverride(superFee, ownFee)`. A value
     without `LPFeeLibrary.OVERRIDE_FEE_FLAG` never replaces one with it; of two overrides the
     **higher fee wins**. The merge is commutative, so inheritance order never changes the fee.
   - Every feature computes its own delta from the callback arguments (the pool's swap or liquidity
     delta), never from another feature's delta. Two hook fees of 1% and 2% take 3% of the same
     base; they do not compound.
   - Overflow of a summed `int128` reverts (checked arithmetic).
4. **Reentrancy: one shared transient lock** (`HOOK_LOCK_SLOT`).
   - `hookNonReentrant` modifier for external entry points that call out or unlock the pool
     manager (retries, claims). It holds `LOCK_CALL`.
   - Swap span lock: any feature returns `true` from `_usesSwapLock()` (OR-merged like the
     permissions). `BaseHook.beforeSwap` then takes `LOCK_SWAP` and `afterSwap` releases it.
     Requires both swap flags (checked in the constructor).
   - While the lock is held (either state), a swap on any pool of this hook reverts
     `HookReentered(state)` (when the swap lock is enabled), and every `hookNonReentrant` entry
     point reverts.
   - Features read the state with `_hookLockState()` (e.g. an `unlockCallback` that must only run
     for its own `LOCK_CALL`).
5. **hookData is shared and opaque.** A feature that decodes `hookData` must document the encoding;
   at most one such feature per concrete hook unless the concrete hook splits it.
6. **Concrete hooks re-declare shared overrides.** Solidity requires the concrete contract to
   override every internal function that two or more of its bases define (BaseHook counts), with
   `override(BaseHook, A, B)` (list every base that defines it) and body `return super._x(...)`.
   The C3 linearization then calls every feature exactly once.
7. **Per-pool config belongs to the pool admin.** `PoolAdminHook` records the caller of
   `PoolManager.initialize` as the pool's admin (an EOA or a factory calls the pool manager
   directly). Features with per-pool config inherit `PoolAdminHook` and guard their setters with
   `onlyPoolAdmin(key)` (which also checks `key.hooks == this`). The admin can
   `transferPoolAdmin(key, newAdmin)`; transferring to zero freezes the pool's config. Protocols
   override `_isPoolAdmin` / `_initialPoolAdmin` (e.g. factory-only). Config entry points take a
   `PoolKey calldata`, not a `PoolId`. A pool with no config behaves neutrally (no fee, no gate).
8. **Hook-level config** (not per pool: allowed initializers, conversion routes) is set through
   `internal` setters. The feature never picks an access-control scheme; the concrete hook exposes
   them (the examples use `Ownable` from OpenZeppelin contracts).
9. **Rounding** favours the side the feature protects: fees round up, oracle averages round toward
   negative infinity.
10. **Shared helpers in BaseHook**: `_specifiedIsCurrency0(params)`, `_unspecified(key, params,
    delta)` (currency and absolute amount of the unspecified side), `_hasFlag(flag)`.

Tests for features and examples extend `test/hooks/utils/HookTest.sol` (real `PoolManager` and
routers from v4-core `Deployers`, `_deployHook("File.sol:Contract", args, flags)` to deploy at a
flag-encoding address).

## Modules

Each module owns the files listed; nobody else edits them. Shared files (`base/*`,
`test/hooks/utils/HookTest.sol`, this file) are read-only for module work; propose changes in the
module's report instead. Every module ships: the abstract feature, a concrete example, unit tests
against the real `PoolManager`, a `docs/hooks/<Module>.md` page (purpose, config, permissions,
composition notes, security notes), and must pass `forge fmt --check` and
`FOUNDRY_PROFILE=hooks forge test`.

### 1. DecayingFeeHook (fee/)

A dynamic LP fee that starts high when a pool launches and decays linearly to a base fee over a
window (anti-sniper protection that pays LPs). Per pool, set by the pool admin.

- Files: `src/hooks/fee/DecayingFeeHook.sol`, `src/hooks/libraries/LinearDecay.sol`,
  `src/hooks/examples/DecayingFeeExample.sol`, `test/hooks/fee/DecayingFeeHook.t.sol`,
  `docs/hooks/DecayingFeeHook.md`.
- `abstract contract DecayingFeeHook is PoolAdminHook`.
- Storage: `mapping(PoolId => DecayingFee) decayingFee` with
  `struct DecayingFee { uint24 startFee; uint24 endFee; uint32 duration; uint40 startTime; bool set; }`
  (fees in pips, the v4 unit, 1_000_000 = 100%).
- Config: `setDecayingFee(PoolKey calldata key, uint24 startFee, uint24 endFee, uint32 duration,
  uint40 startTime) external onlyPoolAdmin(key)`; `startTime == 0` means `block.timestamp`.
  Valid when `endFee <= startFee <= LPFeeLibrary.MAX_LP_FEE`, `duration <= _maxDecayDuration()`
  (internal pure virtual, default 30 days), and `duration > 0` whenever `startFee != endFee`.
  May be called again (replaces the schedule).
- Views: `currentFee(PoolId) returns (uint24)` (0 when unset).
- Fee: before `startTime` it is `startFee`; then `endFee + ceil((startFee - endFee) * remaining /
  duration)`; after the window `endFee`. Computed by `LinearDecay.value(start, end, duration,
  startTime, now)` (pure, reusable by other features, rounds up).
- Callbacks: `_beforeInitialize` (super then revert `NotDynamicFee()` unless
  `LPFeeLibrary.isDynamicFee(key.fee)`), `_beforeSwap` (when set: merge `currentFee |
  OVERRIDE_FEE_FLAG` into super's fee; when unset: pass super through unchanged).
- Flags: `beforeInitialize` (via PoolAdminHook), `beforeSwap`.
- Events: `DecayingFeeSet(PoolId indexed poolId, uint24 startFee, uint24 endFee, uint32 duration,
  uint40 startTime)`. Errors: `NotDynamicFee()`, `InvalidDecayingFee(uint24 startFee, uint24
  endFee, uint32 duration)`.
- Example: `DecayingFeeExample is DecayingFeeHook` (constructor takes the pool manager only).
- Tests: schedule math incl. fuzz against a reference formula and rounding; fee seen in the
  `Swap` event at t0, mid-window and after; unset pool uses the stored fee; static-fee pool cannot
  initialize; only the admin configures; frozen admin.

### 2. SwapFeeHook (fee/)

A hook fee taken in `afterSwap` through the return delta on the unspecified currency (output of
exact-in, input of exact-out), per-pool bps, paid to a per-pool recipient either as ERC-6909 claims
(minted by the pool manager, no token transfer inside the swap) or as tokens.

- Files: `src/hooks/fee/SwapFeeHook.sol`, `src/hooks/examples/SwapFeeExample.sol`,
  `test/hooks/fee/SwapFeeHook.t.sol`, `docs/hooks/SwapFeeHook.md`.
- `abstract contract SwapFeeHook is PoolAdminHook`.
- Storage: `mapping(PoolId => SwapFee) swapFee` with
  `struct SwapFee { uint16 feeBps; bool asClaims; address recipient; }`.
- Config: `setSwapFee(PoolKey calldata key, uint16 feeBps, address recipient, bool asClaims)
  external onlyPoolAdmin(key)`. `feeBps <= _maxSwapFeeBps()` (internal pure virtual, default
  1_000 = 10%); `recipient != 0` when `feeBps != 0`; `recipient == address(this)` only with
  `asClaims` (tokens taken to the hook would be stranded).
- Fee: `fee = ceil(|unspecified pool delta| * bps / 10_000)` where `bps = _swapFeeBps(sender, key,
  params)` (internal view virtual, default the stored `feeBps`; override for exemptions, decaying
  surcharges, tiers). Zero fee: no action. Settlement: `poolManager.mint(recipient, id, fee)` when
  `asClaims`, else `poolManager.take(currency, recipient, fee)`; the hook returns `+fee` so its own
  delta nets to zero. Then `_onSwapFeeTaken(address sender, PoolKey calldata key, Currency currency,
  uint256 amount, address recipient, bool asClaims)` (internal virtual, default no-op) runs.
- Callbacks: `_afterSwap` (super first, then add `fee` to super's delta).
- Flags: `beforeInitialize` (via PoolAdminHook), `afterSwap`, `afterSwapReturnDelta`.
- Events: `SwapFeeSet(PoolId indexed poolId, uint16 feeBps, address recipient, bool asClaims)`,
  `SwapFeeTaken(PoolId indexed poolId, Currency indexed currency, address indexed recipient,
  uint256 amount)`. Errors: `InvalidSwapFee(uint16 feeBps)`, `InvalidFeeRecipient(address)`.
- Example: `SwapFeeExample is SwapFeeHook`.
- Tests: all four swap shapes (zeroForOne x exact-in/out) charge the unspecified side exactly;
  claims vs tokens; recipient balances; fuzz amount and bps (fee <= gross, rounding up); exemption
  via an override in a test harness; config validation and admin gating; composes with
  `DecayingFeeHook` in a test-only concrete (sum and fee override both apply).

### 3. TwapOracleHook (oracle/)

A per-pool tick accumulator with a ring buffer of checkpoints, and a time-weighted average tick
over a window. Generic replacement of the weekly hook's oracle, keyed by `PoolId`.

- Files: `src/hooks/oracle/TwapOracleHook.sol`, `src/hooks/interfaces/ITwapOracle.sol`,
  `src/hooks/examples/TwapOracleExample.sol`, `test/hooks/oracle/TwapOracleHook.t.sol`,
  `docs/hooks/TwapOracleHook.md`.
- `abstract contract TwapOracleHook is BaseHook, ITwapOracle`, constructor
  `TwapOracleHook(uint32 observationInterval, uint16 observationCapacity)` (immutables; interval
  > 0, capacity >= 2, else `InvalidOracleConfig()`).
- Storage: `mapping(PoolId => OracleState)` with
  `struct OracleState { uint40 lastTimestamp; int56 tickCumulative; uint16 head; uint16 count; }`
  and `mapping(PoolId => mapping(uint256 => Observation))` with
  `struct Observation { uint40 timestamp; int56 tickCumulative; }`.
- Callbacks: `_afterInitialize` (super, then seed checkpoint 0 at `block.timestamp` with cumulative
  0), `_beforeSwap` (super, then accrue the tick that held since the last update, read from
  `slot0` before the swap, and store a checkpoint when the newest is at least
  `observationInterval` old). Accruing before the swap weights each period by the tick that held
  during it, so a swap cannot move its own block's average.
- `ITwapOracle`: `twapTick(PoolId poolId, uint32 window) external view returns (bool ok, int24
  avgTick, uint32 span)` (uses the newest checkpoint at least `window` old and the live `slot0`
  tick for the tail; `ok == false` when the history is shorter than `window`, the pool is unknown
  or `window == 0`; average rounds toward negative infinity), `observationCount(PoolId) returns
  (uint16)`, `observation(PoolId, uint16 index) returns (uint40 timestamp, int56 tickCumulative)`.
- Flags: `afterInitialize`, `beforeSwap`. No per-pool config, no admin.
- Events: none (gas). Errors: `InvalidOracleConfig()`.
- Example: `TwapOracleExample is TwapOracleHook` with `(5 minutes, 24)`.
- Tests: average equals the hand-computed time-weighted tick across several swaps and warps
  (positive and negative ticks, rounding); ring buffer wrap; `ok == false` cases; same-block swaps
  do not move the average; differential check against the production weekly hook's `twapTick` for
  the same swap sequence is optional (only if it compiles in the hooks profile without via_ir).

### 4. PoolInitGateHook and LiquidityGateHook (access/)

Two independent gates. `PoolInitGateHook`: only allowed initializers may create pools with this
hook, plus an overridable pool key rule. `LiquidityGateHook`: optional per-pool allowlist for who
may add and/or remove liquidity (for locked launch liquidity: allow only the locker, or gate
removal with an empty list to lock forever).

- Files: `src/hooks/access/PoolInitGateHook.sol`, `src/hooks/access/LiquidityGateHook.sol`,
  `src/hooks/examples/PoolInitGateExample.sol`, `src/hooks/examples/LiquidityGateExample.sol`,
  `test/hooks/access/PoolInitGateHook.t.sol`, `test/hooks/access/LiquidityGateHook.t.sol`,
  `docs/hooks/AccessGates.md`.
- `abstract contract PoolInitGateHook is BaseHook`:
  - Storage: `mapping(address => bool) public isPoolInitializer`.
  - Internal config: `_setPoolInitializer(address account, bool allowed)` (concrete exposes it).
  - `_isAllowedInitializer(address sender) internal view virtual returns (bool)` (default the
    mapping); `_validatePoolKey(PoolKey calldata key, uint160 sqrtPriceX96) internal view virtual`
    (default no-op; override for currency rules such as an allowed quote list or one pool per
    token, reverting `InvalidPoolKey()`).
  - Callback: `_beforeInitialize` (super, then revert `InitializerNotAllowed(sender)` unless
    allowed, then `_validatePoolKey`).
  - Flags: `beforeInitialize`. Events: `PoolInitializerSet(address indexed account, bool
    allowed)`. Errors: `InitializerNotAllowed(address)`, `InvalidPoolKey()`.
  - Example: `PoolInitGateExample is PoolInitGateHook, Ownable` (owner sets initializers).
- `abstract contract LiquidityGateHook is PoolAdminHook`:
  - Storage: `mapping(PoolId => LiquidityGate) liquidityGate` with
    `struct LiquidityGate { bool gateAdd; bool gateRemove; }` and
    `mapping(PoolId => mapping(address => bool)) isLiquidityProvider`.
  - Config (pool admin): `setLiquidityGate(PoolKey calldata key, bool gateAdd, bool gateRemove)`,
    `setLiquidityProvider(PoolKey calldata key, address account, bool allowed)`.
  - Callbacks: `_beforeAddLiquidity` / `_beforeRemoveLiquidity` (super, then revert
    `LiquidityNotAllowed(poolId, sender)` when gated and `sender` is not allowed). `sender` is the
    caller of `PoolManager.modifyLiquidity` (the position manager, a router or a locker), not the
    end user; documented prominently.
  - Flags: `beforeInitialize` (via PoolAdminHook), `beforeAddLiquidity`, `beforeRemoveLiquidity`.
  - Events: `LiquidityGateSet(PoolId indexed, bool gateAdd, bool gateRemove)`,
    `LiquidityProviderSet(PoolId indexed, address indexed account, bool allowed)`.
    Errors: `LiquidityNotAllowed(PoolId poolId, address sender)`.
  - Example: `LiquidityGateExample is LiquidityGateHook`.
  - Locked liquidity recipe (documented and tested): admin gates add and remove, allows the
    locker, the locker adds the position, admin renounces (`transferPoolAdmin(key, 0)`); nobody
    can then remove it or change the gate.
- Tests: allowed / disallowed initializer, key rule override, gate off by default, add/remove
  gating separately, renounced admin freezes the gate, both gates composed into one test-only
  concrete (permissions merged, both `beforeInitialize` logics run).

### 5. FeeConversionHook (conversion/)

Converts fee claims the hook holds into a target currency **inside the swap** that earned them,
through a route of hookless pools, under a pluggable price guard; on any failure it holds the
claims and anyone can retry later outside a swap. Generic form of the live-mode path. It does not
take fees itself; it is fed by a fee feature (normally `SwapFeeHook` with `recipient = this`,
`asClaims = true`).

- Files: `src/hooks/conversion/FeeConversionHook.sol`,
  `src/hooks/examples/ConvertingSwapFeeExample.sol` (composes `SwapFeeHook` from module 2 against
  its spec above; until it lands, test with a local mock fee feature),
  `test/hooks/conversion/FeeConversionHook.t.sol`, `docs/hooks/FeeConversionHook.md`.
- `abstract contract FeeConversionHook is BaseHook, IUnlockCallback`, constructor
  `FeeConversionHook(Currency conversionTarget)` (immutable).
- Storage: `mapping(Currency => PoolKey[]) _conversionRoute`, `mapping(bytes32 bucket =>
  mapping(Currency => uint256)) public heldFees`, `mapping(Currency => uint256) public totalHeld`.
- Internal config: `_setConversionRoute(Currency from, PoolKey[] calldata route)`: 1 to
  `MAX_ROUTE_HOPS` (3) hops, every hop hookless (`address(hooks) == 0`), contiguous from `from` to
  `conversionTarget`; else `InvalidRoute()`. View `conversionRoute(Currency)`.
- Core: `_convertOrHold(bytes32 bucket, Currency currency, uint256 amount) internal returns (bool
  converted, uint256 out)`. Precondition: the hook just received `amount` of `currency` as its own
  ERC-6909 claims (not yet in `totalHeld`) and the pool manager is unlocked (inside a callback).
  Steps: revert `InsufficientGas(required, left)` when `gasleft() < _conversionGasRequired()`
  (deterministic, so `eth_estimateGas` finds it; required = pre-try + budget * 64 / 63 + fallback
  reserve, each an internal pure virtual); hold when `poolManager.getSyncedCurrency()` is non-zero
  (a router is mid-settlement); otherwise `try this.convertInline{gas: _conversionGasBudget()}(...)`
  with a bare `catch` (no return data copy beyond 4 bytes). On failure: `heldFees[bucket][currency]
  += amount`, `totalHeld[currency] += amount`, emit `FeeHeld`.
- `convertInline(bytes32 bucket, Currency currency, uint256 amount) external returns (uint256)`:
  self only (`NotSelf()`); runs `_convert(..., inSwap = true)`.
- `_convert`: burns the hook's own claims, swaps exact-in hop by hop with full-fill checks, per hop
  `minOut = _hopMinOutput(PoolKey memory hop, bool zeroForOne, uint256 amountIn, uint160
  sqrtPriceX96, int24 spotTick, bool inSwap)` (**internal view virtual, no default: the concrete
  supplies the price reference**, e.g. a TWAP from a `TwapOracleHook` pool, a feed, or an admin
  reference tick), reverts `SlippageExceeded(out, minOut)`, then `_settleConverted(bytes32 bucket,
  uint256 out)` (internal virtual, default `poolManager.take(conversionTarget,
  _conversionRecipient(bucket), out)`) and `_onFeeConverted(bucket, currency, amount, out,
  inSwap)` (internal virtual, default no-op, e.g. a vault credit). All of it runs inside the try
  frame, so any failure rolls back to "held". Helper for guards:
  `_minOutFromReference(amountIn, zeroForOne, sqrtSpot, spotTick, referenceTick,
  maxDeviationTicks, maxSlippageBps, hopFeePips)` (reverts `PriceDeviation` when spot is more than
  `maxDeviationTicks` from the reference; expected output at the better of spot and reference,
  minus slippage and the hop fee).
- `_conversionRecipient(bytes32 bucket) internal view virtual returns (address)` (abstract).
- Retry: `retryHeld(bytes32 bucket, Currency currency, uint256 amount) external hookNonReentrant
  returns (uint256 out)`, permissionless, chunks allowed; reverts `PoolManagerBusy()` when the
  pool manager is unlocked and `AmountExceedsHeld(amount, held)`; lowers the held amounts first,
  then `poolManager.unlock`; `unlockCallback` requires `msg.sender == poolManager` and
  `_hookLockState() == LOCK_CALL`, runs `_convert(..., inSwap = false)`.
- Enables the swap lock (`_usesSwapLock() == true`), so code reached during a conversion (route
  pools are hookless; the recipient or a credit hook is not) can never swap on a pool of this
  hook. Flags: `beforeSwap`, `afterSwap`.
- Events: `ConversionRouteSet(Currency indexed from, uint256 hops)`, `FeeConverted(bytes32 indexed
  bucket, Currency indexed currency, uint256 amountIn, uint256 amountOut, bool inSwap)`,
  `FeeHeld(bytes32 indexed bucket, Currency indexed currency, uint256 amount, bytes4 reason)`,
  `HeldFeeRetried(bytes32 indexed bucket, Currency indexed currency, address indexed caller,
  uint256 amountIn, uint256 amountOut)`. Errors: `InvalidRoute()`, `NotSelf()`,
  `InsufficientGas(uint256 required, uint256 left)`, `SlippageExceeded(uint256 out, uint256
  minOut)`, `PriceDeviation(int24 spotTick, int24 referenceTick)`, `PartialFill()`,
  `PoolManagerBusy()`, `AmountExceedsHeld(uint256 amount, uint256 held)`.
- Invariants (tested): `poolManager.balanceOf(hook, id(c)) == totalHeld[c]` after every swap and
  retry (for a hook whose only claims are fees); a fee is either converted in its swap or held in
  full; the trader's swap never reverts for a conversion failure (only `InsufficientGas`).
- Example: `ConvertingSwapFeeExample is SwapFeeHook, FeeConversionHook, Ownable`: `_onSwapFeeTaken`
  calls `_convertOrHold(PoolId.unwrap(key.toId()), currency, amount)` when the recipient is the
  hook and fees are claims; owner sets routes, a per-hop reference tick and bounds, and the payout
  address.
- Tests: in-swap conversion success (1 and 2 hops), pushed route pool -> held, synced currency ->
  held, insufficient gas -> revert, retry success and chunked retry, retry inside a swap or a
  nested retry -> revert, invariant above.

### 6. BondingCurveHook (examples/, reference only)

A custom pricing curve that replaces the pool's own liquidity through `beforeSwap` return deltas
(NoOp-style custom curve), with a graduation flag. Reference implementation and tests only; not used
by Verada in production.

- Files: `src/hooks/examples/BondingCurveHook.sol`, `test/hooks/examples/BondingCurveHook.t.sol`,
  `docs/hooks/BondingCurveHook.md`.
- `contract BondingCurveHook is PoolAdminHook`: one side of each pool is the curve token, the
  other the quote. Virtual constant-product curve `(virtualQuote + quoteRaised) * tokenReserve =
  k`; the hook holds its reserves as ERC-6909 claims and settles each swap with `mint` / `burn` of
  its own claims, returning a `BeforeSwapDelta` that fully consumes the specified amount so the
  pool's liquidity is never touched.
- Storage: `mapping(PoolId => Curve)` with `struct Curve { bool tokenIs0; uint128 virtualQuote;
  uint128 tokenReserve; uint128 quoteReserve; uint128 graduationQuote; bool graduated; }`.
- Config (pool admin): `configureCurve(PoolKey calldata key, bool tokenIs0, uint128 virtualQuote,
  uint128 graduationQuote)` once, `seed(PoolKey calldata key, uint256 tokenAmount)` (pulls tokens
  from the admin through an unlock and mints the hook claims), `withdrawAfterGraduation(PoolKey
  calldata key, address to)` (claims to `to` once graduated).
- Swaps: exact-input in both directions (exact-output reverts `ExactOutputNotSupported()`); when
  `quoteReserve >= graduationQuote` after a buy, set `graduated` and emit `Graduated`; later swaps
  revert `CurveGraduated()`. Adding liquidity reverts `LiquidityNotAllowed()`.
- Flags: `beforeInitialize` (admin), `beforeAddLiquidity`, `beforeSwap`, `beforeSwapReturnDelta`.
- Events: `CurveConfigured`, `CurveSeeded`, `CurveSwap(PoolId indexed, address indexed sender,
  bool buy, uint256 amountIn, uint256 amountOut)`, `Graduated(PoolId indexed, uint256
  quoteRaised)`. Errors as above plus `CurveNotReady()`, `InsufficientReserve()`.
- Tests: buy and sell amounts match the curve formula (fuzz, k never decreases), graduation
  threshold, post-graduation revert, liquidity blocked, claims accounting
  (`balanceOf(hook) == reserves`).

### 7. Launchpad composition and integration (examples/, runs after 1 to 4)

Proves the composition rule on a realistic stack: a generic token-launch hook in the style of a
fair-launch launchpad (factory creates pools, locked single-sided liquidity, decaying launch fee,
hook fee to a recipient, TWAP).

- Files: `src/hooks/examples/LaunchpadHook.sol`, `test/hooks/integration/LaunchpadHook.t.sol`,
  `docs/hooks/Composition.md`.
- `contract LaunchpadHook is PoolInitGateHook, LiquidityGateHook, TwapOracleHook,
  DecayingFeeHook, SwapFeeHook, Ownable`, re-declaring each shared override (rule 6).
- Tests: merged permissions equal the expected flag set; the address check; a launch flow
  (owner allows a factory stand-in, it initializes, configures the decay, swap fee and gate, adds
  locked liquidity, renounces); swaps see the decayed LP fee (max merge), the hook fee (summed
  delta) and a growing TWAP; removal is blocked; a foreign initializer is blocked.

## Verada as a composition

How the production hooks map onto the generic modules. This table was the plan; the rebuild as
implemented differs in places (the live fee stays glue rather than `SwapFeeHook`, conversion is
delegated to the consolidator through `_executeConversion`, pools have no admin, the locker alone
keeps the liquidity locked). [Verada.md](Verada.md) documents the implemented composition.

| Production behaviour | Generic module | Verada glue |
| --- | --- | --- |
| Factory-only pool creation, allowed quote assets | `PoolInitGateHook` (`_validatePoolKey`: quote registry, one pool per token) | factory is the only initializer and the pool admin (`_isPoolAdmin`) |
| Base LP fee 1% to 5% to the locked position | `DecayingFeeHook` with `startFee == endFee` | locker forwards LP fees to the fee vault |
| Launch surcharge decaying to zero, sent to the consolidator | `SwapFeeHook` with `_swapFeeBps` = `LinearDecay` surcharge, consolidator exempt | `_onSwapFeeTaken` calls the consolidator |
| TWAP checkpoints for the consolidator | `TwapOracleHook` (`twapTick(PoolId, window)`) | an adapter maps token to pool id |
| Live mode: fee in the quote, converted in-swap, held and retried | `SwapFeeHook` (claims to self) + `FeeConversionHook` | bucket = active cause, `_onFeeConverted` credits the donation vault, guard from the consolidator's reference ticks |
| Locked launch liquidity | `LiquidityGateHook` (locker only, then renounce) | the LP locker |
| Donations refused | a one-line `_beforeDonate` revert in the concrete hook | |

Live mode also takes part of the fee in `beforeSwap` (when the quote is the specified currency) so
the fee is always in the quote. That stays protocol glue: a concrete hook overrides `_beforeSwap`
for that case. The generic `SwapFeeHook` only charges the unspecified currency.

## Security notes for every module

- Callbacks are pool-manager only (base). Config entry points check `key.hooks == this`.
- A feature never transfers tokens out of the pool manager inside a swap except to its configured
  recipient; prefer ERC-6909 claims (no external code runs).
- Every revert a feature can add to a trader's swap is listed in its doc page.
- No owner-upgradeable state; no `delegatecall`; no `selfdestruct`.
- Native currency (`address(0)`) is supported wherever a `Currency` is accepted; tests cover one
  native pool where the feature moves funds.
