// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {PoolAdminHook} from "../base/PoolAdminHook.sol";
import {LinearDecay} from "../libraries/LinearDecay.sol";

/// @title DecayingFeeHook
/// @notice Dynamic LP fee per pool that starts at `startFee` and decays linearly to `endFee`
///         over `duration` seconds from `startTime`. A high fee right after a launch makes
///         sniping expensive and pays the LPs; once the window ends the pool trades at
///         `endFee` (set `startFee == endFee` for a plain admin-set dynamic fee).
/// @dev Fees are in pips (1_000_000 = 100%). The pool must be a dynamic-fee pool
///      (`key.fee == LPFeeLibrary.DYNAMIC_FEE_FLAG`). The fee is applied as a `beforeSwap`
///      override and merged with other features through `_mergeLpFeeOverride` (higher fee
///      wins). A pool without a schedule passes through unchanged and trades at its stored LP
///      fee. Flags: `beforeInitialize` (via PoolAdminHook), `beforeSwap`.
abstract contract DecayingFeeHook is PoolAdminHook {
    /// @notice A pool's fee schedule.
    /// @param startFee Fee in pips at and before `startTime`.
    /// @param endFee Fee in pips once the window has elapsed.
    /// @param duration Window length in seconds.
    /// @param startTime Start of the window (unix seconds).
    /// @param set Whether a schedule exists for the pool.
    struct DecayingFee {
        uint24 startFee;
        uint24 endFee;
        uint32 duration;
        uint40 startTime;
        bool set;
    }

    /// @notice Fee schedule of each pool.
    mapping(PoolId => DecayingFee) public decayingFee;

    /// @notice The schedule of `poolId` was set or replaced.
    event DecayingFeeSet(
        PoolId indexed poolId, uint24 startFee, uint24 endFee, uint32 duration, uint40 startTime
    );

    /// @notice The pool being initialized is not a dynamic-fee pool.
    error NotDynamicFee();
    /// @notice The schedule is invalid (see `setDecayingFee`).
    error InvalidDecayingFee(uint24 startFee, uint24 endFee, uint32 duration);

    /// @notice Sets or replaces the fee schedule of `key`'s pool. Pool admin only.
    /// @dev Valid when `endFee <= startFee <= LPFeeLibrary.MAX_LP_FEE`,
    ///      `duration <= _maxDecayDuration()` and `duration > 0` whenever `startFee != endFee`.
    ///      A start time in the past is allowed (the schedule is then already partly decayed).
    ///      Configure in the same transaction as the pool's initialization to leave no window
    ///      at the pool's stored fee.
    /// @param key The pool (its `hooks` must be this contract).
    /// @param startFee Fee in pips at and before `startTime`.
    /// @param endFee Fee in pips after the window.
    /// @param duration Window length in seconds.
    /// @param startTime Start of the window; zero means `block.timestamp`.
    function setDecayingFee(
        PoolKey calldata key,
        uint24 startFee,
        uint24 endFee,
        uint32 duration,
        uint40 startTime
    ) external onlyPoolAdmin(key) {
        if (
            endFee > startFee || startFee > LPFeeLibrary.MAX_LP_FEE
                || duration > _maxDecayDuration() || (duration == 0 && startFee != endFee)
        ) revert InvalidDecayingFee(startFee, endFee, duration);
        if (startTime == 0) startTime = uint40(block.timestamp);
        PoolId id = key.toId();
        decayingFee[id] = DecayingFee({
            startFee: startFee, endFee: endFee, duration: duration, startTime: startTime, set: true
        });
        emit DecayingFeeSet(id, startFee, endFee, duration, startTime);
    }

    /// @notice The LP fee in pips this feature asks for on `poolId` now (0 when unset).
    /// @param poolId The pool.
    /// @return The current fee of the schedule, without the override flag.
    function currentFee(PoolId poolId) public view returns (uint24) {
        DecayingFee memory f = decayingFee[poolId];
        if (!f.set) return 0;
        return
            uint24(
                LinearDecay.value(f.startFee, f.endFee, f.duration, f.startTime, block.timestamp)
            );
    }

    /// @dev Longest allowed decay window. Override to change it.
    function _maxDecayDuration() internal pure virtual returns (uint32) {
        return 30 days;
    }

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeSwap = true;
        return p;
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        virtual
        override
        returns (bytes4 selector)
    {
        selector = super._beforeInitialize(sender, key, sqrtPriceX96);
        if (!LPFeeLibrary.isDynamicFee(key.fee)) revert NotDynamicFee();
    }

    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) internal virtual override returns (bytes4 selector, BeforeSwapDelta delta, uint24 fee) {
        (selector, delta, fee) = super._beforeSwap(sender, key, params, hookData);
        PoolId id = key.toId();
        if (!decayingFee[id].set) return (selector, delta, fee);
        fee = _mergeLpFeeOverride(fee, currentFee(id) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
