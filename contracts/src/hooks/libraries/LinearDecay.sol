// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/libraries/FullMath.sol";

/// @title LinearDecay
/// @notice Value of a linear schedule that moves from `start` down to `end` over `duration`
///         seconds beginning at `startTime`. Used for decaying fees; reusable by any feature
///         that needs a time-based ramp down.
/// @dev Rounds up (toward `start`), so a fee computed with it is never below the exact linear
///      value. Requires `end <= start` (reverts on underflow otherwise).
library LinearDecay {
    /// @notice The schedule's value at `timestamp`.
    /// @param start Value at and before `startTime`.
    /// @param end Value once the window has elapsed (`end <= start`).
    /// @param duration Length of the window in seconds. Zero means a step: `start` before
    ///        `startTime`, `end` from `startTime` on.
    /// @param startTime First second of the window.
    /// @param timestamp The time to evaluate at (normally `block.timestamp`).
    /// @return `start` when `timestamp < startTime`; `end + ceil((start - end) * remaining /
    ///         duration)` inside the window, where `remaining = startTime + duration - timestamp`
    ///         (so exactly `start` at `startTime`); `end` once `timestamp >= startTime +
    ///         duration`.
    function value(
        uint256 start,
        uint256 end,
        uint256 duration,
        uint256 startTime,
        uint256 timestamp
    ) internal pure returns (uint256) {
        uint256 range = start - end;
        if (timestamp < startTime) return start;
        uint256 elapsed = timestamp - startTime;
        if (elapsed >= duration) return end;
        return end + FullMath.mulDivRoundingUp(range, duration - elapsed, duration);
    }
}
