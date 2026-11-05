// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RotationPeriod} from "../interfaces/IRotationGovernor.sol";

/// @title RotationScheduleLib
/// @notice Anchor-based rotation schedule of a live-donation token. Rotation `n` covers
///         `[startOf(n), startOf(n + 1))`. The schedule is an anchor `(anchorTime, anchorIndex)`
///         with a period, plus at most one pending period change that takes effect at the start
///         of rotation `pendingFrom`.
/// @dev `block.timestamp / period` is never used: rotation indices are counted from the anchor,
///      so a period change never re-numbers past or current rotations.
///
///      Invariants (for `t` at or after the anchor):
///       - `indexAt` is non-decreasing in `t`, and `startOf(indexAt(t)) <= t < startOf(indexAt(t) + 1)`.
///       - At a switch, `indexAt(switchAt) == pendingFrom`: no index is skipped or reused.
///       - The period is constant within a rotation (`periodOf(n)` is fixed once `n` starts).
///       - `schedule` only ever changes the period from the next boundary on, so the start of the
///         current rotation and of the next one never move.
///      Packing: 40 + 64 + 8 + 8 + 8 + 64 = 192 bits, one storage slot.
library RotationScheduleLib {
    /// @notice Schedule of one token.
    /// @param anchorTime Start time of rotation `anchorIndex`.
    /// @param anchorIndex Rotation index starting at `anchorTime`.
    /// @param period Period of rotations from `anchorIndex` on (until a pending change applies).
    /// @param hasPending Whether a period change is scheduled.
    /// @param pendingPeriod Period of rotations from `pendingFrom` on.
    /// @param pendingFrom First rotation of the pending period.
    struct Schedule {
        uint40 anchorTime;
        uint64 anchorIndex;
        RotationPeriod period;
        bool hasPending;
        RotationPeriod pendingPeriod;
        uint64 pendingFrom;
    }

    /// @notice Length of a rotation of `p`, in seconds.
    function length(RotationPeriod p) internal pure returns (uint256) {
        if (p == RotationPeriod.OneHour) return 1 hours;
        if (p == RotationPeriod.TwelveHours) return 12 hours;
        if (p == RotationPeriod.OneDay) return 1 days;
        if (p == RotationPeriod.ThreeDays) return 3 days;
        return 7 days;
    }

    /// @notice Time before the end of a rotation of `p` at which its poll closes:
    ///         `min(length / 4, 6 hours)`, leaving that buffer to close, decrypt, submit and
    ///         finalize the tally before the next rotation starts.
    function closeBuffer(RotationPeriod p) internal pure returns (uint256) {
        uint256 quarter = length(p) / 4;
        return quarter < 6 hours ? quarter : 6 hours;
    }

    /// @notice Start time of rotation `pendingFrom` (meaningful when `hasPending`).
    function switchAt(Schedule memory s) internal pure returns (uint256) {
        return uint256(s.anchorTime) + uint256(s.pendingFrom - s.anchorIndex) * length(s.period);
    }

    /// @notice Rotation index at time `t`. Requires `t >= anchorTime`.
    function indexAt(Schedule memory s, uint256 t) internal pure returns (uint64) {
        if (s.hasPending) {
            uint256 sw = switchAt(s);
            if (t >= sw) return _toIndex(s.pendingFrom, (t - sw) / length(s.pendingPeriod));
        }
        return _toIndex(s.anchorIndex, (t - s.anchorTime) / length(s.period));
    }

    /// @notice Start time of rotation `n`. Requires `n >= anchorIndex`.
    function startOf(Schedule memory s, uint64 n) internal pure returns (uint256) {
        if (s.hasPending && n >= s.pendingFrom) {
            return switchAt(s) + uint256(n - s.pendingFrom) * length(s.pendingPeriod);
        }
        return uint256(s.anchorTime) + uint256(n - s.anchorIndex) * length(s.period);
    }

    /// @notice Period of rotation `n` (for `n >= anchorIndex`).
    function periodOf(Schedule memory s, uint64 n) internal pure returns (RotationPeriod) {
        return s.hasPending && n >= s.pendingFrom ? s.pendingPeriod : s.period;
    }

    /// @notice Folds a pending change that has taken effect by `t` into the anchor. The result
    ///         describes the same rotations for every time at or after the new anchor.
    function sync(Schedule memory s, uint256 t) internal pure returns (Schedule memory) {
        if (s.hasPending) {
            uint256 sw = switchAt(s);
            if (t >= sw) {
                // `sw` is a past timestamp, so it fits in 40 bits.
                // forge-lint: disable-next-line(unsafe-typecast)
                s.anchorTime = uint40(sw);
                s.anchorIndex = s.pendingFrom;
                s.period = s.pendingPeriod;
                s.hasPending = false;
                s.pendingPeriod = RotationPeriod.OneHour;
                s.pendingFrom = 0;
            }
        }
        return s;
    }

    /// @notice Schedules period `p` from the next boundary after `t`, replacing any pending
    ///         change that has not taken effect yet.
    function schedule(Schedule memory s, uint256 t, RotationPeriod p)
        internal
        pure
        returns (Schedule memory)
    {
        s = sync(s, t);
        uint64 next = indexAt(s, t) + 1;
        s.hasPending = true;
        s.pendingPeriod = p;
        s.pendingFrom = next;
        return s;
    }

    function _toIndex(uint64 base, uint256 offset) private pure returns (uint64) {
        // Indices stay far below 2^64 (one per hour for 2^64 hours); checked anyway.
        uint256 n = uint256(base) + offset;
        if (n > type(uint64).max) revert IndexOverflow();
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(n);
    }

    /// @notice A rotation index does not fit in 64 bits.
    error IndexOverflow();
}
