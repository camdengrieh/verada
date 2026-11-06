// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

/// @title BaseHook
/// @notice Abstract base of every hook in `src/hooks`. It implements `IHooks`, restricts every
///         callback to the pool manager, checks at construction that the deployed address
///         encodes exactly the permissions the hook declares, and defines the rules that let
///         several feature hooks be inherited into one concrete hook (a v4 pool has one hook).
/// @dev Composition rule (see docs/hooks/DESIGN.md for the full statement):
///
///  1. Callbacks. Every `IHooks` entry point is `external onlyPoolManager` and forwards to an
///     `internal virtual` function of the same name with a leading underscore. A feature
///     overrides the internal function, calls `super` FIRST and then adds its own work, so the
///     features of `contract H is A, B, C` run their logic in list order (A, then B, then C).
///     The root of every chain (this contract) returns the neutral result when the hook's
///     address enables that callback, and reverts `HookNotImplemented` when it does not.
///
///  2. Permissions. A feature never overrides `getHookPermissions`. It overrides
///     `_hookPermissions(p)`, calls `super` and sets (only ever sets) the flags it needs, so
///     the flags of all inherited features are OR-merged. The address is checked against the
///     merged set in the constructor.
///
///  3. Return values. Every feature passes on the selector it got from `super`.
///      - afterSwap / afterAddLiquidity / afterRemoveLiquidity deltas are summed: a feature
///        returns `superDelta + ownDelta`.
///      - beforeSwap deltas are summed per component with `_addBeforeSwapDelta`.
///      - the beforeSwap LP fee override is merged with `_mergeLpFeeOverride`: a value without
///        `OVERRIDE_FEE_FLAG` never replaces one with it, and of two overrides the higher fee
///        wins. The merge is commutative, so the result does not depend on inheritance order.
///     Each feature computes its delta from the callback arguments (the pool's own swap or
///     liquidity delta), never from another feature's delta, so two fees stack additively on the
///     same base instead of compounding.
///
///  4. Reentrancy. One transient lock slot is shared by all features: `hookNonReentrant` for
///     external entry points that call out (claims, retries, admin actions that unlock the
///     pool manager), and an optional swap span lock from `beforeSwap` to `afterSwap`, turned
///     on by any feature through `_usesSwapLock` (OR-merged like the permissions). While either
///     is held, a nested swap on any pool of this hook reverts `HookReentered`.
///
///  5. hookData is shared and opaque. A feature that decodes it must say so; at most one such
///     feature per concrete hook unless the concrete hook splits the data itself.
///
///  6. Concrete hooks. Solidity requires the concrete contract to re-declare every internal
///     function that two or more of its bases define, with the body `return super._x(...)`.
///     The `override(...)` list names exactly the bases that define the function directly and
///     are not overridden on some inheritance path: every feature that implements it, plus
///     BaseHook only when at least one inherited base reaches BaseHook's definition without
///     overriding it (a feature that does not implement that callback). Listing BaseHook when
///     every path already overrides it fails with error 2353 ("Invalid contract specified in
///     override list"); leaving out a base that is still open fails with error 4327. The
///     linearization then calls every feature exactly once.
abstract contract BaseHook is IHooks {
    /// @notice The pool manager this hook serves.
    IPoolManager public immutable poolManager;

    /// @notice Lock states of the shared transient lock.
    uint256 internal constant LOCK_IDLE = 0;
    /// @notice Held between `beforeSwap` and `afterSwap` of a swap on a pool of this hook.
    uint256 internal constant LOCK_SWAP = 1;
    /// @notice Held by an external entry point marked `hookNonReentrant`.
    uint256 internal constant LOCK_CALL = 2;
    /// @dev Transient slot of the lock.
    bytes32 internal constant HOOK_LOCK_SLOT = bytes32(uint256(keccak256("hooks.base.lock")) - 1);

    /// @notice The caller is not the pool manager.
    error NotPoolManager();
    /// @notice The callback is not enabled by this hook's address.
    error HookNotImplemented();
    /// @notice A guarded entry point or a swap on a pool of this hook ran while the lock was
    ///         held in `state`.
    error HookReentered(uint256 state);
    /// @notice A feature enabled the swap lock without both swap callbacks.
    error SwapLockNeedsSwapCallbacks();
    /// @notice The pool manager address is zero.
    error ZeroPoolManager();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @notice Holds the shared lock in `LOCK_CALL` for the duration of the call.
    modifier hookNonReentrant() {
        uint256 state = _hookLockState();
        if (state != LOCK_IDLE) revert HookReentered(state);
        _setHookLockState(LOCK_CALL);
        _;
        _setHookLockState(LOCK_IDLE);
    }

    constructor(IPoolManager poolManager_) {
        if (address(poolManager_) == address(0)) revert ZeroPoolManager();
        poolManager = poolManager_;
        Hooks.Permissions memory p = getHookPermissions();
        if (_usesSwapLock() && !(p.beforeSwap && p.afterSwap)) {
            revert SwapLockNeedsSwapCallbacks();
        }
        _validateHookAddress(p);
    }

    // ------------------------------------------------------------------ permissions

    /// @notice Permission flags this hook's address must encode: the OR of every inherited
    ///         feature's flags.
    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        return _hookPermissions(p);
    }

    /// @dev Features override this, call `super` and set the flags they need. Never clear a flag.
    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        returns (Hooks.Permissions memory)
    {
        return p;
    }

    /// @dev Features that need the swap span lock override this as
    ///      `return super._usesSwapLock() || true;` (or just `true`).
    function _usesSwapLock() internal pure virtual returns (bool) {
        return false;
    }

    /// @dev Reverts unless this address encodes exactly `p`. Override only in test harnesses.
    function _validateHookAddress(Hooks.Permissions memory p) internal view virtual {
        Hooks.validateHookPermissions(IHooks(address(this)), p);
    }

    /// @dev Whether this hook's address enables `flag` (one of the `Hooks.*_FLAG` constants).
    function _hasFlag(uint160 flag) internal view returns (bool) {
        return uint160(address(this)) & flag != 0;
    }

    // ------------------------------------------------------------------ lock

    /// @notice Current state of the shared transient lock.
    function _hookLockState() internal view returns (uint256 state) {
        bytes32 slot = HOOK_LOCK_SLOT;
        assembly ("memory-safe") {
            state := tload(slot)
        }
    }

    function _setHookLockState(uint256 state) internal {
        bytes32 slot = HOOK_LOCK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, state)
        }
    }

    // ------------------------------------------------------------------ merge helpers

    /// @notice Component-wise sum of two beforeSwap deltas (checked).
    function _addBeforeSwapDelta(BeforeSwapDelta a, BeforeSwapDelta b)
        internal
        pure
        returns (BeforeSwapDelta)
    {
        return toBeforeSwapDelta(
            BeforeSwapDeltaLibrary.getSpecifiedDelta(a)
                + BeforeSwapDeltaLibrary.getSpecifiedDelta(b),
            BeforeSwapDeltaLibrary.getUnspecifiedDelta(a)
                + BeforeSwapDeltaLibrary.getUnspecifiedDelta(b)
        );
    }

    /// @notice Merges two beforeSwap LP fee results. A value without `OVERRIDE_FEE_FLAG` never
    ///         replaces one with it; of two overrides the higher fee wins (ties keep `current`).
    function _mergeLpFeeOverride(uint24 current, uint24 next) internal pure returns (uint24) {
        bool nextSet = next & LPFeeLibrary.OVERRIDE_FEE_FLAG != 0;
        if (!nextSet) return current;
        if (current & LPFeeLibrary.OVERRIDE_FEE_FLAG == 0) return next;
        return (next & LPFeeLibrary.REMOVE_OVERRIDE_MASK)
            > (current & LPFeeLibrary.REMOVE_OVERRIDE_MASK)
            ? next
            : current;
    }

    // ------------------------------------------------------------------ swap helpers

    /// @notice Whether the specified currency of a swap is currency0.
    function _specifiedIsCurrency0(SwapParams calldata params) internal pure returns (bool) {
        return (params.amountSpecified < 0) == params.zeroForOne;
    }

    /// @notice The unspecified currency of a swap (the output of an exact-input swap, the input
    ///         of an exact-output swap) and the absolute pool delta in it.
    function _unspecified(PoolKey calldata key, SwapParams calldata params, BalanceDelta delta)
        internal
        pure
        returns (Currency currency, uint256 amount)
    {
        int128 d;
        (currency, d) = _specifiedIsCurrency0(params)
            ? (key.currency1, delta.amount1())
            : (key.currency0, delta.amount0());
        amount = d < 0 ? uint256(uint128(-d)) : uint256(uint128(d));
    }

    // ------------------------------------------------------------------ IHooks entry points

    function beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        external
        onlyPoolManager
        returns (bytes4)
    {
        return _beforeInitialize(sender, key, sqrtPriceX96);
    }

    function afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick)
        external
        onlyPoolManager
        returns (bytes4)
    {
        return _afterInitialize(sender, key, sqrtPriceX96, tick);
    }

    function beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4) {
        return _beforeAddLiquidity(sender, key, params, hookData);
    }

    function afterAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        BalanceDelta delta,
        BalanceDelta feesAccrued,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, BalanceDelta) {
        return _afterAddLiquidity(sender, key, params, delta, feesAccrued, hookData);
    }

    function beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4) {
        return _beforeRemoveLiquidity(sender, key, params, hookData);
    }

    function afterRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        BalanceDelta delta,
        BalanceDelta feesAccrued,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, BalanceDelta) {
        return _afterRemoveLiquidity(sender, key, params, delta, feesAccrued, hookData);
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        if (_usesSwapLock()) {
            uint256 state = _hookLockState();
            if (state != LOCK_IDLE) revert HookReentered(state);
            _setHookLockState(LOCK_SWAP);
        }
        return _beforeSwap(sender, key, params, hookData);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4 selector, int128 hookDelta) {
        (selector, hookDelta) = _afterSwap(sender, key, params, delta, hookData);
        if (_usesSwapLock()) _setHookLockState(LOCK_IDLE);
    }

    function beforeDonate(
        address sender,
        PoolKey calldata key,
        uint256 amount0,
        uint256 amount1,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4) {
        return _beforeDonate(sender, key, amount0, amount1, hookData);
    }

    function afterDonate(
        address sender,
        PoolKey calldata key,
        uint256 amount0,
        uint256 amount1,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4) {
        return _afterDonate(sender, key, amount0, amount1, hookData);
    }

    // ------------------------------------------------------------------ chain roots

    function _beforeInitialize(address, PoolKey calldata, uint160)
        internal
        virtual
        returns (bytes4)
    {
        if (!_hasFlag(Hooks.BEFORE_INITIALIZE_FLAG)) revert HookNotImplemented();
        return IHooks.beforeInitialize.selector;
    }

    function _afterInitialize(address, PoolKey calldata, uint160, int24)
        internal
        virtual
        returns (bytes4)
    {
        if (!_hasFlag(Hooks.AFTER_INITIALIZE_FLAG)) revert HookNotImplemented();
        return IHooks.afterInitialize.selector;
    }

    function _beforeAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) internal virtual returns (bytes4) {
        if (!_hasFlag(Hooks.BEFORE_ADD_LIQUIDITY_FLAG)) {
            revert HookNotImplemented();
        }
        return IHooks.beforeAddLiquidity.selector;
    }

    function _afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) internal virtual returns (bytes4, BalanceDelta) {
        if (!_hasFlag(Hooks.AFTER_ADD_LIQUIDITY_FLAG)) revert HookNotImplemented();
        return (IHooks.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function _beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        bytes calldata
    ) internal virtual returns (bytes4) {
        if (!_hasFlag(Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG)) {
            revert HookNotImplemented();
        }
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function _afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) internal virtual returns (bytes4, BalanceDelta) {
        if (!_hasFlag(Hooks.AFTER_REMOVE_LIQUIDITY_FLAG)) {
            revert HookNotImplemented();
        }
        return (IHooks.afterRemoveLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        virtual
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!_hasFlag(Hooks.BEFORE_SWAP_FLAG)) revert HookNotImplemented();
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _afterSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) internal virtual returns (bytes4, int128) {
        if (!_hasFlag(Hooks.AFTER_SWAP_FLAG)) revert HookNotImplemented();
        return (IHooks.afterSwap.selector, 0);
    }

    function _beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal
        virtual
        returns (bytes4)
    {
        if (!_hasFlag(Hooks.BEFORE_DONATE_FLAG)) revert HookNotImplemented();
        return IHooks.beforeDonate.selector;
    }

    function _afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal
        virtual
        returns (bytes4)
    {
        if (!_hasFlag(Hooks.AFTER_DONATE_FLAG)) revert HookNotImplemented();
        return IHooks.afterDonate.selector;
    }
}
