// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {FeeConsolidator} from "../../src/FeeConsolidator.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {IVeradaLiveHook} from "../../src/interfaces/IVeradaLiveHook.sol";
import {LiveBase} from "../live/LiveBase.sol";
import {ClaimsSource} from "../live/LiveMocks.sol";

/// @dev Audit regressions for the route-pool price guards:
///      - the minimum output of a hop is measured against the reference as well as spot, so a
///        spot pushed inside the deviation band no longer widens the slippage allowance;
///      - in-swap claim conversions use tighter deviation and slippage bounds;
///      - frequent conversions no longer freeze the reference (`_moveReference` truncation);
///      - `syncReference` lets a reference follow a market whose conversions fail the guards.
contract FeeConsolidatorPriceGuardsTest is LiveBase {
    using PoolIdLibrary for PoolKey;

    ClaimsSource internal src;
    address internal to = makeAddr("to");

    function setUp() public {
        _liveSetUp();
        src = new ClaimsSource(manager, IFeeConsolidator(address(cons)));
        cons.setSource(address(src), true);
        quote.mint(address(src), 1e24);
        src.deposit(address(quote), 1e24);
    }

    // ------------------------------------------------------------------ helpers

    function _refTick(PoolKey memory key) internal view returns (int24 t) {
        (t,,,) = cons.references(key.toId());
    }

    function _dist(PoolKey memory key) internal view returns (uint256) {
        int256 d = int256(_spotTick(key)) - int256(_refTick(key));
        return uint256(d < 0 ? -d : d);
    }

    /// @dev Sells (`down`) or buys quote in quote/USDC in small chunks until spot is at least
    ///      `ticks` from the reference, in the direction that lowers (or raises) the quote price.
    function _push(uint256 ticks, bool down) internal {
        bool quoteIs0 = Currency.unwrap(quoteUsdcKey.currency0) == address(quote);
        for (uint256 i; i < 400 && _dist(quoteUsdcKey) < ticks; ++i) {
            if (down) {
                _swapAs(address(this), quoteUsdcKey, quoteIs0, -int256(5e20));
            } else {
                _swapAs(address(this), quoteUsdcKey, !quoteIs0, -int256(5e10));
            }
        }
        assertGe(_dist(quoteUsdcKey), ticks, "pushed");
    }

    /// @dev USDC value of `amount` quote at the reference price.
    function _atReference(uint256 amount) internal view returns (uint256) {
        bool quoteIs0 = Currency.unwrap(quoteUsdcKey.currency0) == address(quote);
        uint256 sp = TickMath.getSqrtPriceAtTick(_refTick(quoteUsdcKey));
        return quoteIs0 ? (((amount * sp) >> 96) * sp) >> 96 : (((amount << 96) / sp) << 96) / sp;
    }

    // ------------------------------------------------------------------ finding: band + slippage

    /// @dev Spot pushed 600 ticks (about 6%) below the reference: inside the general band (1000),
    ///      so the old spot-based minimum (spot * 0.967) let the conversion execute about 6% below
    ///      fair. The minimum is now measured against the reference, so it fails closed.
    function test_pushedSpotInsideBand_failsAgainstReference() public {
        _push(600, true);
        assertLe(_dist(quoteUsdcKey), MAX_DEVIATION_TICKS, "inside the general band");
        vm.expectPartialRevert(IFeeConsolidator.SlippageTooHigh.selector);
        src.convert(address(quote), 1e18, to, false);
    }

    /// @dev In-swap conversions refuse a spot outside the tight in-swap band even when it is
    ///      inside the general band.
    function test_inSwap_tighterDeviationBand() public {
        _push(400, false); // quote price up: favourable, but still outside the in-swap band
        assertGt(_dist(quoteUsdcKey), cons.inSwapMaxDeviationTicks());
        vm.expectPartialRevert(FeeConsolidator.PriceDeviation.selector);
        src.convert(address(quote), 1e18, to, true);
        // The retry path (general band) still converts at the favourable price.
        uint256 out = src.convert(address(quote), 1e18, to, false);
        assertGe(out, (_atReference(1e18) * 9670) / 10_000);
    }

    /// @dev Whatever the manipulation inside the in-swap band, a conversion that succeeds pays
    ///      at least the reference value less the in-swap slippage and the hop fee.
    function testFuzz_inSwap_neverBelowReferenceTolerance(uint256 ticks) public {
        ticks = bound(ticks, 0, 290);
        if (ticks != 0) _push(ticks, true);
        uint256 fair = _atReference(1e18);
        try src.convert(address(quote), 1e18, to, true) returns (uint256 out) {
            uint256 tol = cons.inSwapMaxSlippageBps() + 30; // 0.30% pool fee
            assertGe(out, (fair * (10_000 - tol)) / 10_000, "bounded loss");
        } catch {}
    }

    function test_setInSwapBounds() public {
        assertEq(cons.inSwapMaxDeviationTicks(), cons.DEFAULT_IN_SWAP_DEVIATION_TICKS());
        assertEq(cons.inSwapMaxSlippageBps(), cons.DEFAULT_IN_SWAP_SLIPPAGE_BPS());
        cons.setInSwapBounds(150, 50);
        assertEq(cons.inSwapMaxDeviationTicks(), 150);
        assertEq(cons.inSwapMaxSlippageBps(), 50);
        vm.expectRevert(abi.encodeWithSelector(IFeeConsolidator.InvalidSlippage.selector, 2001));
        cons.setInSwapBounds(150, 2001);
        vm.prank(trader);
        vm.expectRevert();
        cons.setInSwapBounds(1, 1);
    }

    /// @dev End to end: a searcher sells quote into the route pool right before a live buy. The
    ///      fee is held (for a later retry at a fair price) instead of being converted at the
    ///      manipulated price.
    function test_liveSwap_afterRouteManipulation_holdsInsteadOfConverting() public {
        (VeradaToken token, PoolKey memory liveKey) = _launchDefault(address(quote), 1_000_000e6);
        _fundTrader(trader, token);
        _push(250, true); // inside the in-swap band, beyond the in-swap tolerance
        vm.recordLogs();
        _buyExactIn(liveKey, address(token), 10e18);
        (bool found,,, uint256 f,, bool converted, bytes4 failure) =
            _lastFeeTaken(vm.getRecordedLogs());
        assertTrue(found);
        assertFalse(converted, "not converted at the pushed price");
        assertEq(failure, IFeeConsolidator.SlippageTooHigh.selector);
        assertEq(hook.heldRaw(address(token), CAUSE_A), f);
    }

    // ------------------------------------------------------------------ finding: frozen reference

    /// @dev Conversions every minute with spot ~200 ticks above the reference: the old step
    ///      (`diff * 60 / 1 days`) truncated to zero on every update and reset `updatedAt`, so
    ///      the reference never moved. Elapsed time now accumulates until a whole tick is due.
    function test_frequentConversions_referenceConverges() public {
        _push(200, false);
        int24 refBefore = _refTick(quoteUsdcKey);
        uint256 distBefore = _dist(quoteUsdcKey);
        // A local clock: under via-IR, `block.timestamp` may be read once per function.
        uint256 t = block.timestamp;
        for (uint256 i; i < 360; ++i) {
            t += 60;
            vm.warp(t);
            src.convert(address(quote), 1e16, to, true);
        }
        int24 refAfter = _refTick(quoteUsdcKey);
        int256 moved = int256(refAfter) - int256(refBefore);
        assertGe(moved < 0 ? -moved : moved, 30, "reference follows spot");
        assertLt(_dist(quoteUsdcKey), distBefore, "closer to spot");
    }

    function test_moveReference_keepsTimeWhenStepTruncates() public {
        _push(200, false);
        (, uint40 updatedBefore,,) = cons.references(quoteUsdcKey.toId());
        vm.warp(block.timestamp + 12);
        src.convert(address(quote), 1e16, to, true);
        (, uint40 updatedAfter,,) = cons.references(quoteUsdcKey.toId());
        assertEq(updatedAfter, updatedBefore, "zero step keeps the elapsed time");
    }

    // ------------------------------------------------------------------ syncReference

    /// @dev A legitimate 6% drop makes every conversion fail against the reference; syncing the
    ///      reference over time lets conversions resume without the owner.
    function test_syncReference_unfreezesAfterMarketMove() public {
        _push(600, true);
        vm.expectPartialRevert(IFeeConsolidator.SlippageTooHigh.selector);
        src.convert(address(quote), 1e18, to, false);
        uint256 t = block.timestamp;
        for (uint256 i; i < 48; ++i) {
            t += 1 hours;
            vm.warp(t);
            vm.prank(trader);
            cons.syncReference(quoteUsdcKey);
        }
        // Bounded by the anchor band (500 ticks), the reference got within 100 ticks of spot.
        assertLe(_dist(quoteUsdcKey), 150);
        assertGt(src.convert(address(quote), 1e18, to, false), 0);
    }

    function test_syncReference_cappedStepAndUnsetPool() public {
        _push(900, true);
        int24 before = _refTick(quoteUsdcKey);
        vm.warp(block.timestamp + 1 days);
        vm.recordLogs();
        cons.syncReference(quoteUsdcKey);
        int256 moved = int256(_refTick(quoteUsdcKey)) - int256(before);
        assertEq(moved < 0 ? -moved : moved, int256(MAX_DEVIATION_TICKS / 10), "one capped step");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, FeeConsolidator.ReferenceSynced.selector), 1);

        PoolKey memory unknown = quoteUsdcKey;
        unknown.fee = 500;
        vm.expectRevert(
            abi.encodeWithSelector(FeeConsolidator.ReferenceNotSet.selector, unknown.toId())
        );
        cons.syncReference(unknown);
    }
}
