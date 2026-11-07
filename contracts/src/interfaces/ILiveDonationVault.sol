// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DonationAsset} from "./IDonationAsset.sol";
import {RotationPeriod} from "./IRotationGovernor.sol";

/// @title ILiveDonationVault
/// @notice USDC ledger of live-donation tokens. Every conversion is split 10% platform / 90%
///         cause; the cause share is credited to the cause that was active when the fee was earned
///         and pushed to its Endaoment org when the token's threshold is reached (on every swap
///         for a zero threshold), or by anyone through `flush`.
interface ILiveDonationVault {
    event HookSet(address indexed hook);
    event LiveTokenRegistered(
        address indexed token,
        uint96 threshold,
        bytes32 indexed initialCause,
        RotationPeriod period,
        DonationAsset asset
    );
    /// @notice `gross` USDC was credited for `token`: `platform` to the platform, `causeShare` to
    ///         `causeId`. `rotation` is the rotation the fee was earned in (`type(uint64).max` for
    ///         a retried held fee, which keeps the cause it was earned for).
    event Credited(
        address indexed token,
        bytes32 indexed causeId,
        uint64 indexed rotation,
        uint256 gross,
        uint256 platform,
        uint256 causeShare,
        DonationAsset asset
    );
    /// @notice `amount` USDC was sent to `org` for `causeId`. `orgDeployed` when the org was
    ///         deployed by this donation; `inSwap` when pushed inside a swap.
    event Donated(
        address indexed token,
        bytes32 indexed causeId,
        address indexed org,
        uint256 amount,
        bool orgDeployed,
        bool inSwap,
        DonationAsset asset,
        uint256 usdcAmount
    );
    /// @notice A due push was not made; `pending` stays credited. `reason` is the 4-byte revert
    ///         selector (zero when there was none).
    event DonationDeferred(
        address indexed token, bytes32 indexed causeId, uint256 pending, bytes4 reason
    );
    event PlatformWithdrawn(address indexed treasury, uint256 amount);
    event PlatformWithdrawnEth(address indexed treasury, uint256 amount);
    event Skimmed(address indexed asset, uint256 amount);

    error NotHook();
    error NotFactory();
    error NotSelf();
    error ZeroAddress();
    error HookAlreadySet();
    error SettlementMismatch();
    error AlreadyRegistered(address token);
    error TokenNotRegistered(address token);
    error ThresholdTooHigh(uint256 threshold);
    error UnbackedCredit(uint256 balance, uint256 required);
    error NothingToFlush(address token, bytes32 causeId);
    error PoolManagerStateChanged();
    error InsufficientPushGas();
    error NothingToWithdraw();
    error NothingToSkim(address asset);
    error EthUnsupported();

    /// @notice The settlement asset (USDC), equal to Endaoment's base token.
    function usdc() external view returns (address);

    /// @notice Registers a live-donation token with its donation threshold, and registers it with
    ///         the rotation governor (initial cause and period). Factory only, once per token.
    /// @param threshold USDC (6 decimals) cause credit at which a swap pushes; 0 pushes every swap.
    function registerToken(
        address token,
        uint96 threshold,
        bytes32 initialCause,
        RotationPeriod period
    ) external;

    /// @notice Whether `token` is registered.
    /// @notice Registers a token with a donation asset. Threshold is in that asset's units.
    function registerToken(
        address token,
        uint96 threshold,
        bytes32 initialCause,
        RotationPeriod period,
        DonationAsset asset
    ) external;

    function donationAssetOf(address token) external view returns (DonationAsset);

    function platformAccruedEth() external view returns (uint256);

    function totalPendingEth() external view returns (uint256);

    function isRegistered(address token) external view returns (bool);

    /// @notice Credits `amount` USDC (already transferred here) earned by `token` while `causeId`
    ///         was active, and pushes the cause's credit when due. Hook only. Never reverts because
    ///         a push fails.
    function creditLive(address token, bytes32 causeId, uint64 rotation, uint256 amount) external;

    /// @notice Sends the whole credit of `(token, causeId)` to the cause's org, deploying the org
    ///         if needed. Permissionless; reverts atomically on failure.
    function flush(address token, bytes32 causeId) external returns (uint256 donated);

    /// @notice Sends the accrued platform share to the platform treasury. Permissionless.
    function withdrawPlatform() external returns (uint256 amount);

    /// @notice Sends a balance not owed to anyone (USDC above the ledger, any other asset) to the
    ///         platform treasury. Permissionless.
    function skim(address asset) external returns (uint256 amount);

    /// @notice Undonated credit of `(token, causeId)` and the earliest time of the next in-swap
    ///         push attempt.
    function pendingOf(address token, bytes32 causeId)
        external
        view
        returns (uint256 pending, uint40 pushRetryAt);

    /// @notice Platform share not yet withdrawn.
    function platformAccrued() external view returns (uint256);

    /// @notice Sum of all undonated cause credit.
    function totalPending() external view returns (uint256);
}
