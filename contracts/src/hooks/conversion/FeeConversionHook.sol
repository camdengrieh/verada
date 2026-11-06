// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {ProtocolFeeLibrary} from "v4-core/libraries/ProtocolFeeLibrary.sol";
import {SafeCast} from "v4-core/libraries/SafeCast.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {BaseHook} from "../base/BaseHook.sol";

/// @title FeeConversionHook
/// @notice Converts fee claims (ERC-6909) held by this hook into one target currency inside the
///         swap that earned them, through a route of hookless pools and under a price guard the
///         concrete hook supplies. If the conversion cannot run or fails for any reason, the
///         claims are held under a bucket and anyone can retry them later, outside a swap, in
///         full or in chunks. The trader's swap never reverts because a conversion failed.
/// @dev This feature takes no fee itself. It is fed by a fee feature (normally `SwapFeeHook`
///      with `recipient = address(this)` and `asClaims = true`) that calls `_convertOrHold`
///      right after the pool manager minted the claims to this hook.
///
///      In-swap path (`_convertOrHold`):
///       1. Revert `InsufficientGas` when less than `_conversionGasRequired()` is left. The
///          requirement does not depend on state, so `eth_estimateGas` finds it; with less gas
///          the swap reverts rather than silently skipping the conversion.
///       2. Hold when a currency is synced on the pool manager (a router is between `sync` and
///          `settle`; moving pool manager balances now would break its settlement).
///       3. Otherwise run `convertInline` as a gas-capped self call with a bare `catch`. Every
///          state change of the conversion (burn, hops, payout, callback) happens inside that
///          frame, so a failure rolls it all back and the claims are held in full.
///
///      Invariants (for a hook whose only ERC-6909 claims are fees):
///       - `poolManager.balanceOf(this, id(c)) == totalHeld[c] == sum of heldFees[*][c]`.
///       - Every fee is either converted in its swap or held in full; a retry lowers the held
///         amounts by exactly the claims it burns.
///       - When the conversion returns, this hook's pool manager deltas are back where they
///         were before it (burn, hops and payout net to zero), and it never calls `sync`.
///
///      Reentrancy. The feature turns on the shared swap lock, so code reached during a
///      conversion (the recipient, `_onFeeConverted` callees, a native payout) can never swap
///      on a pool of this hook, and `retryHeld` (`hookNonReentrant`) cannot run inside a swap
///      of this hook or inside another retry. `unlockCallback` only runs for this hook's own
///      `LOCK_CALL` unlock. A concrete hook that combines this feature with another feature
///      that implements `IUnlockCallback` must override `unlockCallback` and dispatch.
abstract contract FeeConversionHook is BaseHook, IUnlockCallback {
    using SafeCast for uint256;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    /// @notice Longest conversion route.
    uint256 public constant MAX_ROUTE_HOPS = 3;
    /// @notice `reason` of `FeeHeld` when the conversion was skipped because a currency was
    ///         synced on the pool manager.
    bytes4 public constant SYNCED_CURRENCY_PENDING = bytes4(keccak256("SyncedCurrencyPending()"));
    /// @dev Basis point denominator of the guard helper.
    uint256 internal constant BPS = 10_000;

    /// @notice Bounds of the reference-tick guard (`_minOutFromReference`).
    /// @param referenceTick Trusted tick of the hop pool.
    /// @param maxDeviationTicks Allowed distance between spot and reference.
    /// @param maxSlippageBps Allowed shortfall from the expected output.
    /// @param hopFeePips Swap fee of the hop in pips.
    struct ReferenceGuard {
        int24 referenceTick;
        uint256 maxDeviationTicks;
        uint256 maxSlippageBps;
        uint256 hopFeePips;
    }

    /// @notice Currency every fee is converted into.
    Currency public immutable conversionTarget;

    /// @dev Route of hookless pools from a fee currency to `conversionTarget`.
    mapping(Currency => PoolKey[]) internal _conversionRoute;
    /// @notice Claims held after a failed or skipped conversion, per bucket and currency.
    mapping(bytes32 bucket => mapping(Currency => uint256)) public heldFees;
    /// @notice Sum of `heldFees` over every bucket, per currency.
    mapping(Currency => uint256) public totalHeld;

    /// @notice The route of `from` was set (`hops == 0` clears it).
    event ConversionRouteSet(Currency indexed from, uint256 hops);
    /// @notice `amountIn` of `currency` was converted into `amountOut` of the target.
    event FeeConverted(
        bytes32 indexed bucket,
        Currency indexed currency,
        uint256 amountIn,
        uint256 amountOut,
        bool inSwap
    );
    /// @notice The in-swap conversion did not run or failed; `amount` is held. `reason` is the
    ///         failure's error selector (zero when none was returned, `SYNCED_CURRENCY_PENDING`
    ///         when skipped).
    event FeeHeld(bytes32 indexed bucket, Currency indexed currency, uint256 amount, bytes4 reason);
    /// @notice `caller` converted `amountIn` of held `currency` into `amountOut`.
    event HeldFeeRetried(
        bytes32 indexed bucket,
        Currency indexed currency,
        address indexed caller,
        uint256 amountIn,
        uint256 amountOut
    );

    /// @notice The route is empty, too long, hooked, not contiguous or does not end at the
    ///         target, or no route is set for the currency.
    error InvalidRoute();
    /// @notice `convertInline` was not called by this hook.
    error NotSelf();
    /// @notice Less than `required` gas was left at the conversion.
    error InsufficientGas(uint256 required, uint256 left);
    /// @notice A hop returned `out`, less than its guard's `minOut`.
    error SlippageExceeded(uint256 out, uint256 minOut);
    /// @notice A hop's spot tick is outside the allowed band around its reference tick.
    error PriceDeviation(int24 spotTick, int24 referenceTick);
    /// @notice A hop did not consume its whole input.
    error PartialFill();
    /// @notice `retryHeld` was called while the pool manager is unlocked.
    error PoolManagerBusy();
    /// @notice `retryHeld` asked for more than the bucket holds.
    error AmountExceedsHeld(uint256 amount, uint256 held);
    /// @notice `retryHeld` was called with a zero amount.
    error NothingToRetry();
    /// @notice `unlockCallback` ran outside this hook's own retry unlock.
    error UnexpectedUnlock();
    /// @notice The conversion recipient of a bucket is the zero address.
    error ZeroConversionRecipient();

    constructor(Currency conversionTarget_) {
        conversionTarget = conversionTarget_;
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
        p.beforeSwap = true;
        p.afterSwap = true;
        return p;
    }

    function _usesSwapLock() internal pure virtual override returns (bool) {
        return true;
    }

    // ------------------------------------------------------------------ views

    /// @notice The conversion route of `from` (empty when none is set).
    /// @param from Fee currency.
    /// @return route Hookless pools from `from` to `conversionTarget`, in hop order.
    function conversionRoute(Currency from) external view returns (PoolKey[] memory route) {
        return _conversionRoute[from];
    }

    /// @notice Gas that must be left when a conversion is attempted inside a swap.
    function conversionGasRequired() external pure returns (uint256) {
        return _conversionGasRequired();
    }

    // ------------------------------------------------------------------ conversion

    /// @notice In-swap conversion of claims this hook just received. Self only.
    /// @dev Called through a gas-capped `try` by `_convertOrHold`; any revert is caught there
    ///      and the claims are held.
    /// @param bucket Accounting bucket of the fee (for example a pool id).
    /// @param currency Fee currency.
    /// @param amount Claims to convert.
    /// @return out Amount of `conversionTarget` produced.
    function convertInline(bytes32 bucket, Currency currency, uint256 amount)
        external
        returns (uint256 out)
    {
        if (msg.sender != address(this)) revert NotSelf();
        return _convert(bucket, currency, amount, true);
    }

    /// @notice Converts `amount` of held `currency` claims of `bucket` into the target and pays
    ///         them out. Permissionless; chunks are allowed.
    /// @dev Runs in its own pool manager unlock, so it reverts `PoolManagerBusy` when called
    ///      inside one, and `HookReentered` when called during a swap of this hook or another
    ///      guarded entry point. Uses the guard's retry bounds (`inSwap == false`).
    /// @param bucket Bucket the claims are held under.
    /// @param currency Held currency.
    /// @param amount Claims to convert (at most `heldFees[bucket][currency]`).
    /// @return out Amount of `conversionTarget` produced.
    function retryHeld(bytes32 bucket, Currency currency, uint256 amount)
        external
        hookNonReentrant
        returns (uint256 out)
    {
        return _retryHeld(bucket, currency, amount);
    }

    /// @dev Body of `retryHeld`. Precondition: the caller holds the shared lock in `LOCK_CALL`
    ///      (`hookNonReentrant` or an equivalent check). A concrete hook that exposes its own
    ///      retry entry point (other key, other errors) sets the lock and calls this.
    function _retryHeld(bytes32 bucket, Currency currency, uint256 amount)
        internal
        returns (uint256 out)
    {
        if (poolManager.isUnlocked()) revert PoolManagerBusy();
        if (amount == 0) revert NothingToRetry();
        uint256 held = heldFees[bucket][currency];
        if (amount > held) revert AmountExceedsHeld(amount, held);

        heldFees[bucket][currency] = held - amount;
        totalHeld[currency] -= amount;

        out = abi.decode(poolManager.unlock(abi.encode(bucket, currency, amount)), (uint256));
        emit HeldFeeRetried(bucket, currency, msg.sender, amount, out);
    }

    /// @notice Pool manager callback of `retryHeld`.
    /// @dev Runs only for the pool manager while this hook holds `LOCK_CALL`. Override and
    ///      dispatch when another inherited feature also unlocks the pool manager.
    /// @param data `abi.encode(bytes32 bucket, Currency currency, uint256 amount)`.
    /// @return `abi.encode(uint256 out)`.
    function unlockCallback(bytes calldata data) external virtual returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (_hookLockState() != LOCK_CALL) revert UnexpectedUnlock();
        (bytes32 bucket, Currency currency, uint256 amount) =
            abi.decode(data, (bytes32, Currency, uint256));
        return abi.encode(_convert(bucket, currency, amount, false));
    }

    // ------------------------------------------------------------------ core

    /// @notice Converts `amount` of `currency` claims inside the current swap, or holds them.
    /// @dev Precondition: this hook just received `amount` of `currency` as its own ERC-6909
    ///      claims (not yet in `totalHeld`) and the pool manager is unlocked. Reverts only with
    ///      `InsufficientGas`.
    /// @return converted Whether the claims were converted.
    /// @return out Amount of `conversionTarget` produced (zero when held).
    function _convertOrHold(bytes32 bucket, Currency currency, uint256 amount)
        internal
        returns (bool converted, uint256 out)
    {
        if (amount == 0) return (false, 0);
        uint256 required = _conversionGasRequired();
        if (gasleft() < required) revert InsufficientGas(required, gasleft());

        bytes4 reason;
        if (Currency.unwrap(poolManager.getSyncedCurrency()) != address(0)) {
            reason = SYNCED_CURRENCY_PENDING;
        } else {
            try this.convertInline{gas: _conversionGasBudget()}(bucket, currency, amount) returns (
                uint256 o
            ) {
                out = o;
                converted = true;
            } catch {
                reason = _returnSelector();
            }
        }
        if (!converted) {
            heldFees[bucket][currency] += amount;
            totalHeld[currency] += amount;
            emit FeeHeld(bucket, currency, amount, reason);
            _onFeeHeld(bucket, currency, amount, reason);
        }
    }

    /// @dev Converts `amount` of this hook's `currency` claims (`_executeConversion`), pays the
    ///      result out (`_settleConverted`) and notifies (`_onFeeConverted`).
    function _convert(bytes32 bucket, Currency currency, uint256 amount, bool inSwap)
        internal
        returns (uint256 out)
    {
        out = _executeConversion(bucket, currency, amount, inSwap);
        if (out == 0) revert SlippageExceeded(0, 1);

        _settleConverted(bucket, out);
        _onFeeConverted(bucket, currency, amount, out, inSwap);
        emit FeeConverted(bucket, currency, amount, out, inSwap);
    }

    /// @dev Turns `amount` of this hook's `currency` claims into `out` of `conversionTarget`,
    ///      leaving this hook with a pool manager credit of `out` in the target for
    ///      `_settleConverted`. Default: burn the claims and swap exact-input along the stored
    ///      route (no hop when `currency` is the target), each hop under `_hopMinOutput`.
    ///      Override to delegate to an external converter (it then burns the claims as an
    ///      ERC-6909 operator and pays the target itself; pair it with a `_settleConverted`
    ///      override that does not take again). Runs inside the try frame in a swap, so any
    ///      revert holds the fee.
    function _executeConversion(bytes32, Currency currency, uint256 amount, bool inSwap)
        internal
        virtual
        returns (uint256 out)
    {
        poolManager.burn(address(this), currency.toId(), amount);
        out = amount;
        if (!(currency == conversionTarget)) {
            PoolKey[] memory route = _conversionRoute[currency];
            if (route.length == 0) revert InvalidRoute();
            Currency current = currency;
            for (uint256 i; i < route.length; ++i) {
                (current, out) = _convertHop(route[i], current, out, inSwap);
            }
        }
    }

    /// @dev One exact-input hop with the guard's minimum and a full-fill check.
    function _convertHop(PoolKey memory hop, Currency current, uint256 amountIn, bool inSwap)
        private
        returns (Currency next, uint256 out)
    {
        bool zeroForOne = current == hop.currency0;
        (uint160 sqrtPriceX96, int24 spotTick,,) = poolManager.getSlot0(hop.toId());
        uint256 minOut = _hopMinOutput(hop, zeroForOne, amountIn, sqrtPriceX96, spotTick, inSwap);

        BalanceDelta delta = poolManager.swap(
            hop,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -amountIn.toInt256(),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 spent = zeroForOne ? delta.amount0() : delta.amount1();
        int128 received = zeroForOne ? delta.amount1() : delta.amount0();
        if (spent >= 0 || uint256(uint128(-spent)) != amountIn) revert PartialFill();
        out = received > 0 ? uint256(uint128(received)) : 0;
        if (out < minOut) revert SlippageExceeded(out, minOut);
        next = zeroForOne ? hop.currency1 : hop.currency0;
    }

    // ------------------------------------------------------------------ route config

    /// @dev Sets the route of `from`: 1 to `MAX_ROUTE_HOPS` hookless pools, contiguous from
    ///      `from` to `conversionTarget`. Reverts `InvalidRoute` otherwise (also when `from` is
    ///      the target, which needs no route). The concrete hook exposes it with its own access
    ///      control.
    function _setConversionRoute(Currency from, PoolKey[] calldata route) internal {
        uint256 n = route.length;
        if (n == 0 || n > MAX_ROUTE_HOPS || from == conversionTarget) revert InvalidRoute();
        delete _conversionRoute[from];
        Currency current = from;
        for (uint256 i; i < n; ++i) {
            PoolKey calldata hop = route[i];
            if (address(hop.hooks) != address(0)) revert InvalidRoute();
            if (hop.currency0 == current) current = hop.currency1;
            else if (hop.currency1 == current) current = hop.currency0;
            else revert InvalidRoute();
            _conversionRoute[from].push(hop);
        }
        if (!(current == conversionTarget)) revert InvalidRoute();
        emit ConversionRouteSet(from, n);
    }

    /// @dev Removes the route of `from`; its fees are then held until a route is set again.
    function _clearConversionRoute(Currency from) internal {
        delete _conversionRoute[from];
        emit ConversionRouteSet(from, 0);
    }

    // ------------------------------------------------------------------ extension points

    /// @dev Minimum output of one hop: the price guard. No default; the concrete hook supplies
    ///      the price reference (a TWAP, a feed, an admin reference tick) and should revert when
    ///      the hop's price is not trustworthy. `inSwap` is true for the in-swap conversion
    ///      (the trader chose the moment and may have moved route pools in the same
    ///      transaction, so use the tightest bounds) and false for a retry.
    function _hopMinOutput(
        PoolKey memory hop,
        bool zeroForOne,
        uint256 amountIn,
        uint160 sqrtPriceX96,
        int24 spotTick,
        bool inSwap
    ) internal view virtual returns (uint256 minOut);

    /// @dev Account the converted `out` of `conversionTarget` of `bucket` is paid to.
    function _conversionRecipient(bytes32 bucket) internal view virtual returns (address);

    /// @dev Pays out the converted amount. Default: take `out` of the target to
    ///      `_conversionRecipient(bucket)`. Override to mint claims, credit a vault, etc. Must
    ///      leave this hook's delta in the target at zero.
    function _settleConverted(bytes32 bucket, uint256 out) internal virtual {
        address to = _conversionRecipient(bucket);
        if (to == address(0)) revert ZeroConversionRecipient();
        poolManager.take(conversionTarget, to, out);
    }

    /// @dev Called after a successful conversion (in the same frame, so a revert here holds the
    ///      fee). Default no-op.
    function _onFeeConverted(
        bytes32 bucket,
        Currency currency,
        uint256 amountIn,
        uint256 out,
        bool inSwap
    ) internal virtual {}

    /// @dev Called when an in-swap conversion did not run or failed and `amount` was added to
    ///      the held amounts, with the same `reason` as `FeeHeld`. Runs in the swap, inside
    ///      `_conversionFallbackReserve()`: keep it cheap (an event, a transient write). Default
    ///      no-op.
    function _onFeeHeld(bytes32 bucket, Currency currency, uint256 amount, bytes4 reason)
        internal
        virtual {}

    /// @dev Gas used between the gas check and the try (synced-currency read, call setup).
    function _conversionPreTryGas() internal pure virtual returns (uint256) {
        return 40_000;
    }

    /// @dev Gas forwarded to the in-swap conversion: three hops, the payout and a callback.
    function _conversionGasBudget() internal pure virtual returns (uint256) {
        return 650_000;
    }

    /// @dev Gas kept for the hold path after a failed try (two fresh slots, event, return).
    function _conversionFallbackReserve() internal pure virtual returns (uint256) {
        return 70_000;
    }

    /// @dev Gas required at `_convertOrHold`: pre-try + budget * 64 / 63 (so the full budget is
    ///      forwarded despite the 63/64 rule) + fallback reserve. 770,317 by default.
    function _conversionGasRequired() internal pure virtual returns (uint256) {
        return
            _conversionPreTryGas() + (_conversionGasBudget() * 64) / 63
                + _conversionFallbackReserve();
    }

    // ------------------------------------------------------------------ guard helpers

    /// @notice Reference-tick guard: reverts `PriceDeviation` when `spotTick` is more than
    ///         `maxDeviationTicks` from `referenceTick`, else returns the expected output at the
    ///         better of spot and reference, minus `maxSlippageBps` and the hop fee (rounded up
    ///         to bps). A spot pushed below the reference inside the band therefore does not
    ///         lower the minimum. Returns zero when the tolerance reaches 100%.
    /// @param amountIn Hop input.
    /// @param zeroForOne Hop direction.
    /// @param sqrtSpot Spot sqrt price of the hop pool.
    /// @param spotTick Spot tick of the hop pool.
    /// @param referenceTick Trusted tick of the hop pool (price of currency0 in currency1).
    /// @param maxDeviationTicks Allowed distance between spot and reference.
    /// @param maxSlippageBps Allowed shortfall from the expected output.
    /// @param hopFeePips Swap fee of the hop in pips (1_000_000 = 100%).
    function _minOutFromReference(
        uint256 amountIn,
        bool zeroForOne,
        uint160 sqrtSpot,
        int24 spotTick,
        int24 referenceTick,
        uint256 maxDeviationTicks,
        uint256 maxSlippageBps,
        uint256 hopFeePips
    ) internal pure returns (uint256) {
        return _minOutFromReference(
            amountIn,
            zeroForOne,
            sqrtSpot,
            spotTick,
            ReferenceGuard(referenceTick, maxDeviationTicks, maxSlippageBps, hopFeePips)
        );
    }

    /// @notice Same as the eight-argument form with the guard in a struct (fewer stack slots
    ///         for a caller compiled without the IR pipeline).
    function _minOutFromReference(
        uint256 amountIn,
        bool zeroForOne,
        uint160 sqrtSpot,
        int24 spotTick,
        ReferenceGuard memory guard
    ) internal pure returns (uint256 minOut) {
        int256 diff = int256(spotTick) - int256(guard.referenceTick);
        if (uint256(diff < 0 ? -diff : diff) > guard.maxDeviationTicks) {
            revert PriceDeviation(spotTick, guard.referenceTick);
        }
        uint256 expected = _quoteAtPrice(amountIn, sqrtSpot, zeroForOne);
        uint256 atReference =
            _quoteAtPrice(amountIn, TickMath.getSqrtPriceAtTick(guard.referenceTick), zeroForOne);
        if (atReference > expected) expected = atReference;
        uint256 tolerance = guard.maxSlippageBps + (guard.hopFeePips + 99) / 100;
        if (tolerance >= BPS) return 0;
        minOut = (expected * (BPS - tolerance)) / BPS;
    }

    /// @notice Output of `amountIn` at `sqrtPriceX96`, before fees and price impact.
    function _quoteAtPrice(uint256 amountIn, uint160 sqrtPriceX96, bool zeroForOne)
        internal
        pure
        returns (uint256)
    {
        return zeroForOne
            ? FullMath.mulDiv(
                FullMath.mulDiv(amountIn, sqrtPriceX96, 1 << 96), sqrtPriceX96, 1 << 96
            )
            : FullMath.mulDiv(
                FullMath.mulDiv(amountIn, 1 << 96, sqrtPriceX96), 1 << 96, sqrtPriceX96
            );
    }

    /// @notice Total swap fee of a hop in pips: its LP fee combined with the pool manager's
    ///         protocol fee for the direction.
    function _hopSwapFeePips(PoolKey memory hop, bool zeroForOne) internal view returns (uint24) {
        (,, uint24 protocolFee, uint24 lpFee) = poolManager.getSlot0(hop.toId());
        uint16 p = zeroForOne
            ? ProtocolFeeLibrary.getZeroForOneFee(protocolFee)
            : ProtocolFeeLibrary.getOneForZeroFee(protocolFee);
        return p == 0 ? lpFee : ProtocolFeeLibrary.calculateSwapFee(p, lpFee);
    }

    /// @dev First 4 bytes of the last call's return data, or zero when shorter.
    function _returnSelector() private pure returns (bytes4 sel) {
        assembly ("memory-safe") {
            if gt(returndatasize(), 3) {
                let p := mload(0x40)
                returndatacopy(p, 0, 4)
                sel := and(mload(p), shl(224, 0xffffffff))
            }
        }
    }
}
