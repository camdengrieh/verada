// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {BaseHook} from "../base/BaseHook.sol";
import {ITwapOracle} from "../interfaces/ITwapOracle.sol";

/// @title TwapOracleHook
/// @notice Generic Uniswap v4 hook feature: a per-pool tick accumulator with a ring buffer of
///         checkpoints, and a time-weighted average tick over a caller-chosen window. Any pool
///         that uses a hook inheriting this feature gets an oracle without configuration.
/// @dev Accrual happens in `beforeSwap`, before the pool's price moves, so every period is
///      weighted by the tick that actually held during it. A swap therefore never moves the
///      average of its own block; moving the average needs the manipulated price to survive
///      across blocks, which costs the manipulator arbitrage for the whole window.
///
///      Composition: inherit together with other features of `src/hooks` and re-declare
///      `_hookPermissions`, `_afterInitialize` and `_beforeSwap` in the concrete hook when another
///      base also defines them (rule 6 of BaseHook). The feature never changes return values.
///
///      Stored per pool: one slot of state plus `observationCapacity` checkpoint slots. Gas per
///      swap: one slot read and write for the accumulator, plus one checkpoint write at most every
///      `observationInterval` seconds.
abstract contract TwapOracleHook is BaseHook, ITwapOracle {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @notice Accumulator state of a pool.
    /// @param lastTimestamp Block timestamp of the last accrual.
    /// @param tickCumulative Sum of tick * seconds from initialization to `lastTimestamp`.
    /// @param head Ring slot of the newest checkpoint.
    /// @param count Number of stored checkpoints (0 for a pool this hook never initialized).
    struct OracleState {
        uint40 lastTimestamp;
        int56 tickCumulative;
        uint16 head;
        uint16 count;
    }

    /// @notice A stored checkpoint of the accumulator.
    struct Observation {
        uint40 timestamp;
        int56 tickCumulative;
    }

    /// @notice Minimum spacing in seconds between two stored checkpoints.
    uint32 public immutable observationInterval;
    /// @notice Number of checkpoints kept per pool (ring buffer size). The longest window that
    ///         can be answered is at least `observationInterval * (observationCapacity - 1)`.
    uint16 public immutable observationCapacity;

    /// @notice Accumulator state per pool.
    mapping(PoolId => OracleState) internal _oracleState;
    /// @notice Ring buffer of checkpoints per pool, slots `0 .. observationCapacity - 1`.
    mapping(PoolId => mapping(uint256 => Observation)) internal _observations;

    /// @notice The interval is zero or the capacity is below 2.
    error InvalidOracleConfig();

    /// @param observationInterval_ Minimum spacing in seconds between stored checkpoints (> 0).
    /// @param observationCapacity_ Checkpoints kept per pool (>= 2).
    constructor(uint32 observationInterval_, uint16 observationCapacity_) {
        if (observationInterval_ == 0 || observationCapacity_ < 2) revert InvalidOracleConfig();
        observationInterval = observationInterval_;
        observationCapacity = observationCapacity_;
    }

    // ------------------------------------------------------------------ permissions

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.afterInitialize = true;
        p.beforeSwap = true;
        return p;
    }

    // ------------------------------------------------------------------ callbacks

    /// @dev Seeds the oracle of the pool being initialized (`_seedOracle`).
    function _afterInitialize(
        address sender,
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        int24 tick
    ) internal virtual override returns (bytes4 selector) {
        selector = super._afterInitialize(sender, key, sqrtPriceX96, tick);
        _seedOracle(key.toId());
    }

    /// @dev Starts the oracle of `id`: checkpoint 0 at `block.timestamp` with a zero
    ///      accumulator. Until it runs, the pool has no oracle (`observationCount == 0`, accrual
    ///      is a no-op). The seed does not depend on the tick (the first accrual reads the pool's
    ///      tick), so a composer that must keep `afterInitialize` off can clear that flag in its
    ///      `_hookPermissions` and call this from `_beforeInitialize` instead. Call it once per
    ///      pool, at initialization: seeding again would restart the accumulator.
    function _seedOracle(PoolId id) internal {
        _oracleState[id] = OracleState({
            lastTimestamp: uint40(block.timestamp), tickCumulative: 0, head: 0, count: 1
        });
        _observations[id][0] = Observation({timestamp: uint40(block.timestamp), tickCumulative: 0});
    }

    /// @dev Accrues the pre-swap tick and stores a checkpoint when due. Return values of `super`
    ///      pass through unchanged.
    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) internal virtual override returns (bytes4 selector, BeforeSwapDelta delta, uint24 lpFee) {
        (selector, delta, lpFee) = super._beforeSwap(sender, key, params, hookData);
        PoolId id = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(id);
        _writeObservation(id, tick);
    }

    // ------------------------------------------------------------------ accumulator

    /// @dev Accrues `tick` for the time since the last update and stores a checkpoint when the
    ///      newest one is at least `observationInterval` old. A no-op for a pool the hook never
    ///      initialized.
    function _writeObservation(PoolId id, int24 tick) internal {
        OracleState memory s = _oracleState[id];
        if (s.count == 0) return;
        uint256 dt = block.timestamp - s.lastTimestamp;
        if (dt == 0) return; // same block: nothing to accrue, newest checkpoint is this block's
        s.tickCumulative += int56(tick) * int56(int256(dt));
        s.lastTimestamp = uint40(block.timestamp);

        if (block.timestamp - _observations[id][s.head].timestamp >= observationInterval) {
            uint16 next = uint16((uint256(s.head) + 1) % observationCapacity);
            _observations[id][next] =
                Observation({timestamp: uint40(block.timestamp), tickCumulative: s.tickCumulative});
            s.head = next;
            if (s.count < observationCapacity) ++s.count;
        }
        _oracleState[id] = s;
    }

    // ------------------------------------------------------------------ ITwapOracle

    /// @inheritdoc ITwapOracle
    function twapTick(PoolId poolId, uint32 window)
        external
        view
        virtual
        returns (bool ok, int24 avgTick, uint32 span)
    {
        OracleState memory s = _oracleState[poolId];
        if (s.count == 0 || window == 0) return (false, 0, 0);
        (, int24 tick,,) = poolManager.getSlot0(poolId);
        int256 cumNow = int256(s.tickCumulative) + int256(tick)
            * int256(block.timestamp - uint256(s.lastTimestamp));

        uint256 target = block.timestamp > window ? block.timestamp - window : 0;
        uint256 idx = s.head;
        for (uint256 i; i < s.count; ++i) {
            Observation memory o = _observations[poolId][idx];
            if (o.timestamp <= target) {
                uint256 elapsed = block.timestamp - o.timestamp;
                if (elapsed == 0 || elapsed > type(uint32).max) return (false, 0, 0);
                return (
                    true,
                    _floorDiv(cumNow - int256(o.tickCumulative), int256(elapsed)),
                    uint32(elapsed)
                );
            }
            idx = idx == 0 ? observationCapacity - 1 : idx - 1;
        }
        return (false, 0, 0);
    }

    /// @inheritdoc ITwapOracle
    function observationCount(PoolId poolId) external view returns (uint16) {
        return _oracleState[poolId].count;
    }

    /// @inheritdoc ITwapOracle
    function observation(PoolId poolId, uint16 index)
        external
        view
        returns (uint40 timestamp, int56 tickCumulative)
    {
        OracleState memory s = _oracleState[poolId];
        if (index >= s.count) return (0, 0);
        uint256 cap = observationCapacity;
        uint256 slot = (uint256(s.head) + cap + 1 - s.count + index) % cap;
        Observation memory o = _observations[poolId][slot];
        return (o.timestamp, o.tickCumulative);
    }

    /// @dev `a / b` rounded toward negative infinity (`b > 0`). The result is an average of valid
    ///      ticks, so it fits `int24`.
    function _floorDiv(int256 a, int256 b) internal pure returns (int24) {
        int256 q = a / b;
        if (a % b != 0 && a < 0) --q;
        return int24(q);
    }
}
