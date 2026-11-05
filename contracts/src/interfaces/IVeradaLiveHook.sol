// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IVeradaLiveHook
/// @notice Uniswap v4 hook of live-donation tokens. A fee (base fee plus the decaying launch
///         surcharge) is taken from every swap in the quote currency and converted to USDC inside
///         the same swap; the USDC is credited to the cause active at that moment. A failed
///         conversion never reverts the swap: the fee is held as ERC-6909 claims attributed to that
///         cause and anyone can retry it later.
interface IVeradaLiveHook {
    /// @notice Per-token fee configuration. Same ABI layout as `IVeradaHook.FeeConfig`.
    /// @param baseFeeBps Base fee in basis points, in [100, 500].
    /// @param launchSurchargeBps Launch surcharge at launch in basis points, at most 8000.
    /// @param surchargeDecaySeconds Seconds over which the surcharge decays linearly to zero.
    /// @param launchTimestamp Start of the decay (0 means the configuration time).
    struct LiveFeeConfig {
        uint24 baseFeeBps;
        uint24 launchSurchargeBps;
        uint32 surchargeDecaySeconds;
        uint40 launchTimestamp;
    }

    event TokenConfigured(
        address indexed token,
        uint24 baseFeeBps,
        uint24 launchSurchargeBps,
        uint32 surchargeDecaySeconds,
        uint40 launchTimestamp
    );
    event PoolRegistered(address indexed token, address indexed quote, bytes32 indexed poolId);
    /// @notice A fee of `quoteAmount` was taken from a swap of `token` while `causeId` was active
    ///         in `rotation`. `converted`: it became `usdcOut` USDC in the vault; otherwise it is
    ///         held and `failure` is the 4-byte reason.
    event FeeTaken(
        address indexed token,
        bytes32 indexed causeId,
        uint64 indexed rotation,
        address quote,
        uint256 quoteAmount,
        uint256 usdcOut,
        bool converted,
        bytes4 failure
    );
    /// @notice `quoteIn` held for `(token, causeId)` was converted to `usdcOut` by `caller`.
    event HeldRetried(
        address indexed token,
        bytes32 indexed causeId,
        address indexed caller,
        uint256 quoteIn,
        uint256 usdcOut
    );

    error NotPoolManager();
    error NotFactory();
    error NotSelf();
    error ZeroAddress();
    error SettlementMismatch();
    error HookNotImplemented();
    /// @notice `PoolManager.donate` to a live pool is refused: the locked position could never
    ///         collect the donation.
    error DonateNotAllowed();
    error InvalidPool();
    error AlreadyConfigured(address token);
    error TokenNotConfigured(address token);
    error TokenNotRegistered(address token);
    error QuoteNotRoutable(address quote);
    error SwapReentered();
    error PartialFillNotSupported(uint256 filled, uint256 expected);
    error InsufficientGas(uint256 required, uint256 available);
    error PoolManagerBusy();
    error Busy();
    error NothingHeld();
    error AmountExceedsHeld(uint256 amount, uint256 held);

    /// @notice Registers the fee configuration of `token`. Factory only, once. Same selector as
    ///         `IVeradaHook.configureToken`.
    function configureToken(address token, LiveFeeConfig calldata cfg) external;

    /// @notice Converts `amount` of the quote held for `(token, causeId)` into USDC and credits it
    ///         to that cause. Permissionless; outside any pool manager flow. Reverts with the
    ///         route's reason on failure (nothing changes).
    function retryHeld(address token, bytes32 causeId, uint256 amount)
        external
        returns (uint256 usdcOut);

    /// @notice In-swap conversion step, called by this hook only (through a gas-capped try).
    function inlineConvert(
        address token,
        bytes32 causeId,
        uint64 rotation,
        address quote,
        uint256 amount
    ) external returns (uint256 usdcOut);

    /// @notice Fee configuration of `token`.
    function feeConfig(address token) external view returns (LiveFeeConfig memory);

    /// @notice Current fee of `token` in basis points (base plus launch surcharge).
    function currentFeeBps(address token) external view returns (uint24);

    /// @notice Quote currency of `token`'s pool (zero before initialization).
    function quoteOf(address token) external view returns (address);

    /// @notice Whether `token` has a fee configuration.
    function configured(address token) external view returns (bool);

    /// @notice Whether `token`'s pool was initialized.
    function poolInitialized(address token) external view returns (bool);

    /// @notice Quote held unconverted for `(token, causeId)`.
    function heldRaw(address token, bytes32 causeId) external view returns (uint256);

    /// @notice Total quote held unconverted in `quote` (equals the hook's ERC-6909 balance).
    function totalHeld(address quote) external view returns (uint256);

    /// @notice The live-donation vault receiving the USDC.
    function vault() external view returns (address);
}
