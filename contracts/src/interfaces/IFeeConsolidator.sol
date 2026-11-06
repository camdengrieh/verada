// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IFeeConsolidator
/// @notice Swaps raw fees (token side and quote side) into the settlement asset (USDC) through
///         Uniswap v4 and hands the proceeds to the fee vault. A failed route never reverts the
///         caller: the raw amount is held and can be retried.
interface IFeeConsolidator {
    /// @notice Emitted when raw fees were swapped and forwarded to the vault.
    /// @param token The launched token the fees belong to.
    /// @param currencyIn The raw fee currency that was swapped.
    /// @param amountIn Raw amount swapped.
    /// @param settlementOut Settlement asset amount forwarded to the vault.
    event FeesConsolidated(
        address indexed token, address indexed currencyIn, uint256 amountIn, uint256 settlementOut
    );

    /// @notice Emitted when a route failed and the raw amount is held for retry.
    /// @param reason Revert data of the failed route (may be empty).
    event ConsolidationFailed(
        address indexed token, address indexed currencyIn, uint256 amountIn, bytes reason
    );

    event MaxSlippageBpsUpdated(uint256 maxSlippageBps);

    /// @notice Emitted when a source's ERC-6909 claims were converted into the settlement asset.
    /// @param source The source whose claims were burned.
    /// @param currency The claim currency converted.
    /// @param to Recipient of the settlement asset.
    /// @param amountIn Claims burned.
    /// @param settlementOut Settlement asset paid to `to`.
    event ClaimsConverted(
        address indexed source,
        address indexed currency,
        address indexed to,
        uint256 amountIn,
        uint256 settlementOut
    );

    error NotAuthorized();
    error NothingToConsolidate(address token, address currency);
    error SlippageTooHigh(uint256 amountOut, uint256 minOut);
    error InvalidSlippage(uint256 bps);
    /// @notice `convertClaims` needs the caller's already unlocked pool manager flow.
    error PoolManagerLocked();
    /// @notice A route hop goes through a hooked pool while only hookless hops are allowed.
    error HookedRouteHop(uint256 hop);

    /// @notice Settlement asset all fees are converted to (USDC).
    function settlementAsset() external view returns (address);

    /// @notice Receives raw fees for `token` earned in the current epoch. `amount` of `currency`
    ///         must already be transferred before the call. Must not revert on route failure.
    function consolidate(address token, address currency, uint256 amount) external;

    /// @notice Like `consolidate`, for fees earned evenly between `accruedSince` and now (LP fees
    ///         settled from a position). The amount is attributed to the epochs of that interval
    ///         in proportion to the time each epoch covers.
    function consolidateAccrued(
        address token,
        address currency,
        uint256 amount,
        uint256 accruedSince
    ) external;

    /// @notice Retries consolidation of held (previously failed) raw fees.
    /// @return settlementOut Settlement asset forwarded to the vault.
    function retry(address token, address currency) external returns (uint256 settlementOut);

    /// @notice Tries to consolidate every held balance of `token` that has a part earned in
    ///         `epoch` or earlier, so those fees reach their own epoch before it is settled.
    ///         Permissionless; never reverts on a route failure.
    /// @return clear True when nothing earned in `epoch` or earlier is held afterwards.
    function flushThrough(address token, uint256 epoch) external returns (bool clear);

    /// @notice Whether part of the held `currency` of `token` was earned in `epoch` or earlier.
    function heldThrough(address token, address currency, uint256 epoch)
        external
        view
        returns (bool);

    /// @notice Raw fees held unconsolidated for `token` in `currency`.
    function heldFees(address token, address currency) external view returns (uint256);

    /// @notice Converts `amount` ERC-6909 claims of `currency` held by the caller into the
    ///         settlement asset along the quote registry route, under the route-pool guards, and
    ///         pays `to`. Source only, inside the caller's unlocked pool manager flow. The caller
    ///         must have made this contract its ERC-6909 operator. Reverts on any failure.
    /// @param inSwap The conversion runs inside a trader's swap (the live hook's in-line
    ///        conversion): every route hop must be hookless, and the tighter in-swap deviation
    ///        and slippage bounds apply instead of the general ones.
    /// @return settlementOut Settlement asset paid to `to`.
    function convertClaims(address currency, uint256 amount, address to, bool inSwap)
        external
        returns (uint256 settlementOut);

    /// @notice Part of `heldFees(token, currency)` earned in `epoch`.
    function heldFeesIn(address token, address currency, uint256 epoch)
        external
        view
        returns (uint256);

    /// @notice Maximum tolerated slippage versus the guard price, in basis points.
    function maxSlippageBps() external view returns (uint256);
}
