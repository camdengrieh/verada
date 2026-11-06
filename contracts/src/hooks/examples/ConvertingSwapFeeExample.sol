// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {PoolInitGateHook} from "../access/PoolInitGateHook.sol";
import {BaseHook} from "../base/BaseHook.sol";
import {PoolAdminHook} from "../base/PoolAdminHook.sol";
import {FeeConversionHook} from "../conversion/FeeConversionHook.sol";
import {SwapFeeHook} from "../fee/SwapFeeHook.sol";

/// @title ConvertingSwapFeeExample
/// @notice A hook fee that is converted into one target currency inside the swap that paid it.
///         Pool admins set a `SwapFeeHook` fee with `recipient = this hook` and
///         `asClaims = true`; each fee is then swapped through the owner's hookless route into
///         `conversionTarget` and paid to `payout`, or held per pool and retried by anyone.
/// @dev Composition of `SwapFeeHook` and `FeeConversionHook`; bucket = the pool id. The price
///      guard is a per-hop reference tick set by the owner with separate in-swap and retry
///      bounds (keep the in-swap bounds tight: the trader chooses that moment). Fees paid to any
///      other recipient, or as tokens, are not converted. Any swap whose fee is converted needs
///      `conversionGasRequired()` gas left at `afterSwap`, or it reverts `InsufficientGas`.
///      Only initializers the owner allows may create pools (`PoolInitGateHook`); the
///      initializer becomes the pool admin.
contract ConvertingSwapFeeExample is PoolInitGateHook, SwapFeeHook, FeeConversionHook, Ownable {
    /// @notice Price guard of one route hop.
    struct HopGuard {
        bool set;
        int24 referenceTick;
        uint24 inSwapDeviationTicks;
        uint16 inSwapSlippageBps;
        uint24 retryDeviationTicks;
        uint16 retrySlippageBps;
    }

    /// @notice Highest slippage bound the owner may set.
    uint16 public constant MAX_GUARD_SLIPPAGE_BPS = 2000;

    /// @notice Guard of each route pool.
    mapping(PoolId => HopGuard) public hopGuard;
    /// @notice Receiver of every converted fee.
    address public payout;

    /// @notice The owner set the guard of `poolId`.
    event HopGuardSet(
        PoolId indexed poolId,
        int24 referenceTick,
        uint24 inSwapDeviationTicks,
        uint16 inSwapSlippageBps,
        uint24 retryDeviationTicks,
        uint16 retrySlippageBps
    );
    /// @notice The owner set the payout address.
    event PayoutSet(address indexed payout);

    /// @notice A guard bound is out of range.
    error InvalidHopGuard();
    /// @notice A route hop has no guard.
    error HopGuardNotSet(PoolId poolId);
    /// @notice The payout address is zero.
    error ZeroPayout();

    /// @param manager The pool manager.
    /// @param target Currency every fee is converted into.
    /// @param owner_ Sets routes, guards and the payout.
    /// @param payout_ Receiver of converted fees.
    constructor(IPoolManager manager, Currency target, address owner_, address payout_)
        BaseHook(manager)
        FeeConversionHook(target)
        Ownable(owner_)
    {
        _setPayout(payout_);
    }

    // ------------------------------------------------------------------ owner config

    /// @notice Allows or disallows `account` to initialize pools with this hook.
    /// @param account The initializer.
    /// @param allowed Whether `account` may call `PoolManager.initialize` for this hook.
    function setPoolInitializer(address account, bool allowed) external onlyOwner {
        _setPoolInitializer(account, allowed);
    }

    /// @notice Sets the conversion route of `from` (1 to 3 hookless pools ending at the target).
    /// @param from Fee currency.
    /// @param route Pools in hop order.
    function setConversionRoute(Currency from, PoolKey[] calldata route) external onlyOwner {
        _setConversionRoute(from, route);
    }

    /// @notice Removes the route of `from`; its fees are held until a route is set again.
    /// @param from Fee currency.
    function clearConversionRoute(Currency from) external onlyOwner {
        _clearConversionRoute(from);
    }

    /// @notice Sets the price guard of a route pool.
    /// @param hop The route pool.
    /// @param referenceTick Trusted tick of the pool.
    /// @param inSwapDeviationTicks Allowed spot distance from the reference inside a swap.
    /// @param inSwapSlippageBps Allowed output shortfall inside a swap.
    /// @param retryDeviationTicks Allowed spot distance on a retry.
    /// @param retrySlippageBps Allowed output shortfall on a retry.
    function setHopGuard(
        PoolKey calldata hop,
        int24 referenceTick,
        uint24 inSwapDeviationTicks,
        uint16 inSwapSlippageBps,
        uint24 retryDeviationTicks,
        uint16 retrySlippageBps
    ) external onlyOwner {
        if (
            referenceTick < TickMath.MIN_TICK || referenceTick > TickMath.MAX_TICK
                || inSwapSlippageBps > MAX_GUARD_SLIPPAGE_BPS
                || retrySlippageBps > MAX_GUARD_SLIPPAGE_BPS
                || inSwapDeviationTicks > uint24(TickMath.MAX_TICK)
                || retryDeviationTicks > uint24(TickMath.MAX_TICK)
        ) revert InvalidHopGuard();
        PoolId id = hop.toId();
        hopGuard[id] = HopGuard({
            set: true,
            referenceTick: referenceTick,
            inSwapDeviationTicks: inSwapDeviationTicks,
            inSwapSlippageBps: inSwapSlippageBps,
            retryDeviationTicks: retryDeviationTicks,
            retrySlippageBps: retrySlippageBps
        });
        emit HopGuardSet(
            id,
            referenceTick,
            inSwapDeviationTicks,
            inSwapSlippageBps,
            retryDeviationTicks,
            retrySlippageBps
        );
    }

    /// @notice Sets the receiver of converted fees.
    /// @param payout_ New receiver (non-zero).
    function setPayout(address payout_) external onlyOwner {
        _setPayout(payout_);
    }

    function _setPayout(address payout_) internal {
        if (payout_ == address(0)) revert ZeroPayout();
        payout = payout_;
        emit PayoutSet(payout_);
    }

    // ------------------------------------------------------------------ glue

    function _onSwapFeeTaken(
        address sender,
        PoolKey calldata key,
        Currency currency,
        uint256 amount,
        address recipient,
        bool asClaims
    ) internal override {
        super._onSwapFeeTaken(sender, key, currency, amount, recipient, asClaims);
        if (recipient == address(this) && asClaims) {
            _convertOrHold(PoolId.unwrap(key.toId()), currency, amount);
        }
    }

    function _hopMinOutput(
        PoolKey memory hop,
        bool zeroForOne,
        uint256 amountIn,
        uint160 sqrtPriceX96,
        int24 spotTick,
        bool inSwap
    ) internal view override returns (uint256) {
        PoolId id = hop.toId();
        HopGuard memory g = hopGuard[id];
        if (!g.set) revert HopGuardNotSet(id);
        ReferenceGuard memory r = ReferenceGuard(
            g.referenceTick,
            inSwap ? g.inSwapDeviationTicks : g.retryDeviationTicks,
            inSwap ? g.inSwapSlippageBps : g.retrySlippageBps,
            _hopSwapFeePips(hop, zeroForOne)
        );
        return _minOutFromReference(amountIn, zeroForOne, sqrtPriceX96, spotTick, r);
    }

    function _conversionRecipient(bytes32) internal view override returns (address) {
        return payout;
    }

    /// @dev The caller of `PoolManager.initialize` passed the init gate, so it is the admin.
    function _initialPoolAdmin(address sender, PoolKey calldata)
        internal
        pure
        override
        returns (address)
    {
        return sender;
    }

    // ------------------------------------------------------------------ rule 6 re-declarations

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(PoolInitGateHook, SwapFeeHook, FeeConversionHook)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _usesSwapLock() internal pure override(BaseHook, FeeConversionHook) returns (bool) {
        return super._usesSwapLock();
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        override(BaseHook, PoolAdminHook, PoolInitGateHook)
        returns (bytes4)
    {
        return super._beforeInitialize(sender, key, sqrtPriceX96);
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal override(BaseHook, SwapFeeHook) returns (bytes4, int128) {
        return super._afterSwap(sender, key, params, delta, hookData);
    }
}
