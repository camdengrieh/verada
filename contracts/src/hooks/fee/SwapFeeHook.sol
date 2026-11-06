// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/libraries/FullMath.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {SafeCast} from "v4-core/libraries/SafeCast.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {PoolAdminHook} from "../base/PoolAdminHook.sol";

/// @title SwapFeeHook
/// @notice A hook fee on every swap, taken in `afterSwap` through the hook's return delta on the
///         unspecified currency (the output of an exact-input swap, the input of an exact-output
///         swap). The rate is set in basis points per pool by the pool admin and the fee is paid
///         to a per-pool recipient, either as ERC-6909 claims minted by the pool manager (no
///         token transfer and no external code inside the swap) or as tokens.
/// @dev Composition: `_afterSwap` calls `super` first and returns `superDelta + fee`. The fee is
///      computed from the pool's own swap delta, never from another feature's delta, so it
///      stacks additively with other hook fees. Contributes `afterSwap`, `afterSwapReturnDelta`
///      and (through `PoolAdminHook`) `beforeInitialize`. Does not read `hookData`.
///
///      Customization points (all `internal virtual`):
///       - `_swapFeeBps(sender, key, params)`: the rate for one swap (default: the stored rate).
///         Override for exemptions (return 0), decaying surcharges or tiers.
///       - `_maxSwapFeeBps()`: the highest rate the setter accepts (default 1_000 = 10%).
///       - `_onSwapFeeTaken(...)`: runs after the fee has been minted or taken (default no-op),
///         e.g. to account for claims held by the hook itself or to notify a collector.
abstract contract SwapFeeHook is PoolAdminHook {
    using SafeCast for uint256;

    /// @notice Basis-point denominator (10_000 = 100%).
    uint256 internal constant SWAP_FEE_DENOMINATOR = 10_000;

    /// @notice Hook fee configuration of a pool.
    /// @param feeBps Fee rate in basis points of the unspecified side of each swap.
    /// @param asClaims Whether the fee is paid as ERC-6909 claims (true) or as tokens (false).
    /// @param recipient Who receives the fee. Zero disables the fee for the pool.
    struct SwapFee {
        uint16 feeBps;
        bool asClaims;
        address recipient;
    }

    /// @notice Hook fee configuration of each pool (all zero: no fee).
    mapping(PoolId => SwapFee) public swapFee;

    /// @notice The pool admin set the hook fee of `poolId`.
    event SwapFeeSet(PoolId indexed poolId, uint16 feeBps, address recipient, bool asClaims);

    /// @notice A swap on `poolId` paid `amount` of `currency` to `recipient`.
    event SwapFeeTaken(
        PoolId indexed poolId, Currency indexed currency, address indexed recipient, uint256 amount
    );

    /// @notice The fee rate is above the maximum (setter) or above 100% (swap time).
    error InvalidSwapFee(uint16 feeBps);
    /// @notice The recipient is zero while a fee is set, or is this hook with token settlement
    ///         (tokens taken to the hook would be stranded).
    error InvalidFeeRecipient(address recipient);

    /// @notice Sets the hook fee of `key`'s pool. Only the pool admin.
    /// @param key The pool (its `hooks` must be this contract).
    /// @param feeBps Fee rate in basis points, at most `_maxSwapFeeBps()`.
    /// @param recipient Receiver of the fee; must be non-zero when `feeBps != 0`. This hook
    ///        itself is only allowed with `asClaims`.
    /// @param asClaims Pay the fee as ERC-6909 claims (true) or as tokens (false).
    /// @dev A zero recipient disables the fee entirely (`_swapFeeBps` is then not consulted).
    ///      A non-zero recipient with `feeBps == 0` keeps the fee off unless an override of
    ///      `_swapFeeBps` returns a rate.
    function setSwapFee(PoolKey calldata key, uint16 feeBps, address recipient, bool asClaims)
        external
        onlyPoolAdmin(key)
    {
        uint256 max = _maxSwapFeeBps();
        if (feeBps > max || feeBps > SWAP_FEE_DENOMINATOR) revert InvalidSwapFee(feeBps);
        if (feeBps != 0 && recipient == address(0)) revert InvalidFeeRecipient(recipient);
        if (recipient == address(this) && !asClaims) revert InvalidFeeRecipient(recipient);
        PoolId id = key.toId();
        swapFee[id] = SwapFee({feeBps: feeBps, asClaims: asClaims, recipient: recipient});
        emit SwapFeeSet(id, feeBps, recipient, asClaims);
    }

    // ------------------------------------------------------------------ customization

    /// @dev Highest rate `setSwapFee` accepts. Must not exceed 10_000.
    function _maxSwapFeeBps() internal pure virtual returns (uint16) {
        return 1000;
    }

    /// @dev Fee rate of one swap in basis points. `sender` is the caller of
    ///      `PoolManager.swap` (usually a router). Must not exceed 10_000 or the swap reverts.
    function _swapFeeBps(
        address, /* sender */
        PoolKey calldata key,
        SwapParams calldata /* params */
    )
        internal
        view
        virtual
        returns (uint16)
    {
        return swapFee[key.toId()].feeBps;
    }

    /// @dev Runs after `amount` of `currency` was minted (claims) or taken (tokens) to
    ///      `recipient`, inside the swap. Default no-op.
    function _onSwapFeeTaken(
        address sender,
        PoolKey calldata key,
        Currency currency,
        uint256 amount,
        address recipient,
        bool asClaims
    ) internal virtual {
        // Default: nothing to do.
    }

    // ------------------------------------------------------------------ hook

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.afterSwap = true;
        p.afterSwapReturnDelta = true;
        return p;
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal virtual override returns (bytes4 selector, int128 hookDelta) {
        (selector, hookDelta) = super._afterSwap(sender, key, params, delta, hookData);
        uint256 fee = _takeSwapFee(sender, key, params, delta);
        if (fee != 0) hookDelta += fee.toInt128();
    }

    /// @dev Computes, settles and reports the fee of one swap. Returns the amount taken.
    function _takeSwapFee(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta
    ) private returns (uint256 fee) {
        PoolId id = key.toId();
        SwapFee memory cfg = swapFee[id];
        if (cfg.recipient == address(0)) return 0;

        uint16 bps = _swapFeeBps(sender, key, params);
        if (bps == 0) return 0;
        if (bps > SWAP_FEE_DENOMINATOR) revert InvalidSwapFee(bps);

        (Currency currency, uint256 amount) = _unspecified(key, params, delta);
        fee = FullMath.mulDivRoundingUp(amount, bps, SWAP_FEE_DENOMINATOR);
        if (fee == 0) return 0;

        if (cfg.asClaims) poolManager.mint(cfg.recipient, currency.toId(), fee);
        else poolManager.take(currency, cfg.recipient, fee);

        emit SwapFeeTaken(id, currency, cfg.recipient, fee);
        _onSwapFeeTaken(sender, key, currency, fee, cfg.recipient, cfg.asClaims);
    }
}
