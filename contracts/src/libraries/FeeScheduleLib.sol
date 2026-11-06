// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/libraries/FullMath.sol";

import {IVaradaLiveHook} from "../interfaces/IVaradaLiveHook.sol";

/// @title FeeScheduleLib
/// @notice Fee bounds, the decaying launch surcharge and fee arithmetic of the live-donation hook.
/// @dev The bounds and the surcharge formula are the same as the weekly `VaradaHook` (base fee in
///      [100, 500] bps, launch surcharge up to 8000 bps decaying linearly to zero over at most one
///      day, rounded up). They are copied rather than shared so the weekly hook's bytecode stays
///      unchanged; a differential fuzz test asserts both produce the same surcharge.
///
///      Invariants:
///       - `totalBps` never exceeds `MAX_FEE_BPS + MAX_LAUNCH_SURCHARGE_BPS` (8500), so
///         `BPS - bps` in `feeGrossUp` is never zero.
///       - `feeOnGross` and `feeGrossUp` round up (in favour of the cause).
///       - Gross-up identity: for `fee = feeGrossUp(net, bps)`,
///         `fee == feeOnGross(net + fee, bps)`, so a fee charged on top of a net amount is the
///         same share of the gross flow as a fee taken out of a gross amount.
library FeeScheduleLib {
    /// @notice Lowest allowed base fee in basis points.
    uint24 internal constant MIN_FEE_BPS = 100;
    /// @notice Highest allowed base fee in basis points.
    uint24 internal constant MAX_FEE_BPS = 500;
    /// @notice Highest allowed initial launch surcharge in basis points (80%).
    uint24 internal constant MAX_LAUNCH_SURCHARGE_BPS = 8000;
    /// @notice Longest allowed launch-surcharge decay window.
    uint32 internal constant MAX_SURCHARGE_DECAY_SECONDS = 1 days;
    /// @dev Basis points denominator.
    uint256 internal constant BPS = 10_000;

    /// @notice The base fee is outside [MIN_FEE_BPS, MAX_FEE_BPS] (same selector as the weekly
    ///         hook's `InvalidFee`).
    error InvalidFee(uint24 feeBps);
    /// @notice The launch surcharge or its decay window is out of bounds.
    error InvalidLaunchSurcharge(uint24 startBps, uint32 decaySeconds);

    /// @notice Reverts unless the base fee and the launch surcharge are within bounds. A non-zero
    ///         surcharge needs a decay window in (0, MAX_SURCHARGE_DECAY_SECONDS].
    function validate(uint24 baseBps, uint24 startBps, uint32 decaySeconds) internal pure {
        if (baseBps < MIN_FEE_BPS || baseBps > MAX_FEE_BPS) revert InvalidFee(baseBps);
        if (startBps > MAX_LAUNCH_SURCHARGE_BPS) {
            revert InvalidLaunchSurcharge(startBps, decaySeconds);
        }
        if (startBps != 0 && (decaySeconds == 0 || decaySeconds > MAX_SURCHARGE_DECAY_SECONDS)) {
            revert InvalidLaunchSurcharge(startBps, decaySeconds);
        }
    }

    /// @notice Launch surcharge in basis points at `nowTs`: `startBps` until launch, then a
    ///         linear decay to zero over `decaySeconds`, rounded up.
    function surchargeBps(uint24 startBps, uint32 decaySeconds, uint40 launch, uint256 nowTs)
        internal
        pure
        returns (uint24)
    {
        if (startBps == 0 || decaySeconds == 0) return 0;
        if (nowTs <= launch) return startBps;
        uint256 elapsed = nowTs - launch;
        if (elapsed >= decaySeconds) return 0;
        // Bounded by `startBps`, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint24(FullMath.mulDivRoundingUp(startBps, decaySeconds - elapsed, decaySeconds));
    }

    /// @notice Base fee plus the launch surcharge at `nowTs`, in basis points (at most 8500).
    function totalBps(IVaradaLiveHook.LiveFeeConfig memory c, uint256 nowTs)
        internal
        pure
        returns (uint256)
    {
        return uint256(c.baseFeeBps)
            + surchargeBps(c.launchSurchargeBps, c.surchargeDecaySeconds, c.launchTimestamp, nowTs);
    }

    /// @notice Fee on a gross amount: `ceil(gross * bps / BPS)`.
    function feeOnGross(uint256 gross, uint256 bps) internal pure returns (uint256) {
        return FullMath.mulDivRoundingUp(gross, bps, BPS);
    }

    /// @notice Fee that, added to `net`, makes the fee `bps` of the gross: `ceil(net * bps /
    ///         (BPS - bps))`. Requires `bps < BPS`.
    function feeGrossUp(uint256 net, uint256 bps) internal pure returns (uint256) {
        return FullMath.mulDivRoundingUp(net, bps, BPS - bps);
    }
}
