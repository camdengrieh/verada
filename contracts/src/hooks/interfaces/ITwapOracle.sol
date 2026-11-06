// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolId} from "v4-core/types/PoolId.sol";

/// @title ITwapOracle
/// @notice Read side of a per-pool time-weighted average tick oracle kept by a Uniswap v4 hook.
interface ITwapOracle {
    /// @notice Time-weighted average tick of `poolId` over at least `window` seconds.
    /// @dev Uses the newest stored checkpoint that is at least `window` seconds old and the live
    ///      `slot0` tick for the tail since the last update. The average rounds toward negative
    ///      infinity. Swaps in the current block cannot move it.
    /// @param poolId The pool.
    /// @param window The minimum number of seconds the average must cover.
    /// @return ok False when the pool is unknown, `window == 0`, or no stored checkpoint is at
    ///         least `window` seconds old (history too short or already overwritten).
    /// @return avgTick The average tick over `span` seconds (0 when `ok` is false).
    /// @return span The number of seconds actually covered, `>= window` (0 when `ok` is false).
    function twapTick(PoolId poolId, uint32 window)
        external
        view
        returns (bool ok, int24 avgTick, uint32 span);

    /// @notice Number of checkpoints currently stored for `poolId` (0 for an unknown pool, at most
    ///         the hook's observation capacity).
    /// @param poolId The pool.
    /// @return count The number of stored checkpoints.
    function observationCount(PoolId poolId) external view returns (uint16 count);

    /// @notice A stored checkpoint of `poolId`, in chronological order: index 0 is the oldest
    ///         retained checkpoint and `observationCount(poolId) - 1` the newest.
    /// @dev Returns `(0, 0)` when `index >= observationCount(poolId)`.
    /// @param poolId The pool.
    /// @param index Chronological index of the checkpoint.
    /// @return timestamp Block timestamp of the checkpoint.
    /// @return tickCumulative Tick accumulator (sum of tick * seconds since initialization).
    function observation(PoolId poolId, uint16 index)
        external
        view
        returns (uint40 timestamp, int56 tickCumulative);
}
