// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {FeeConsolidator} from "../../src/FeeConsolidator.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {LiveBase} from "../live/LiveBase.sol";
import {ClaimsSource, NoopRouteHook} from "../live/LiveMocks.sol";
import {MockOndoToken} from "./ConsolidatorMocks.sol";

/// @dev `FeeConsolidator.convertClaims`: ERC-6909 claims converted inside the caller's unlock
///      under the same route guards as weekly consolidation.
contract FeeConsolidatorClaimsTest is LiveBase {
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

    function _newQuote(string memory name, uint24 fee, int256 liquidity, IHooks hooks, bool seed)
        internal
        returns (MockOndoToken q, PoolKey memory k)
    {
        q = new MockOndoToken(name);
        q.mint(address(this), 1e30);
        _approveRouters(address(q));
        (Currency c0, Currency c1) = _sorted(address(q), address(usdc));
        k = PoolKey(c0, c1, fee, 60, hooks);
        int24 tick = _orientedTick(address(q), address(usdc), QUOTE_TICK);
        manager.initialize(k, TickMath.getSqrtPriceAtTick(tick));
        _addLiquidity(k, tick, liquidity);
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = k;
        registry.addQuoteAssetWithRoute(address(q), IQuoteRegistry.Kind.Ondo, r);
        if (seed) cons.seedReferences(r);
        q.mint(address(src), 1e24);
        src.deposit(address(q), 1e24);
    }

    function _routeHook() internal returns (NoopRouteHook h) {
        address at = address(uint160(0x5151 << 144) | Hooks.BEFORE_SWAP_FLAG);
        deployCodeTo("LiveMocks.sol:NoopRouteHook", at);
        h = NoopRouteHook(at);
    }

    function test_onlySource() public {
        vm.prank(trader);
        vm.expectRevert(IFeeConsolidator.NotAuthorized.selector);
        cons.convertClaims(address(quote), 1, to, true);
    }

    function test_revertsWhileLocked() public {
        cons.setSource(address(this), true);
        vm.expectRevert(IFeeConsolidator.PoolManagerLocked.selector);
        cons.convertClaims(address(quote), 1, to, true);
    }

    function test_rejectsZeroAmountAndRecipient() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IFeeConsolidator.NothingToConsolidate.selector, address(0), address(quote)
            )
        );
        src.convert(address(quote), 0, to, true);
        vm.expectRevert(FeeConsolidator.ZeroAddress.selector);
        src.convert(address(quote), 1, address(0), true);
    }

    function test_burnsExactlyAndPaysTo() public {
        uint256 claimsBefore = _claims(address(src), address(quote));
        uint256 amount = 3e18;
        vm.expectEmit(true, true, true, false, address(cons));
        emit IFeeConsolidator.ClaimsConverted(address(src), address(quote), to, amount, 0);
        uint256 out = src.convert(address(quote), amount, to, true);
        assertEq(claimsBefore - _claims(address(src), address(quote)), amount);
        assertEq(usdc.balanceOf(to), out);
        assertApproxEqRel(out, 300e6, 0.02e18, "about 100 USDC per quote");
        assertEq(usdc.balanceOf(address(cons)), 0, "nothing left behind");
    }

    function test_wethUnwrapHop() public {
        weth.transfer(address(src), 1e18);
        src.deposit(address(weth), 1e18);
        uint256 out = src.convert(address(weth), 1e18, to, true);
        assertApproxEqRel(out, 3000e6, 0.02e18);
    }

    function test_threeHopRoute() public {
        ondoB.mint(address(src), 1e20);
        src.deposit(address(ondoB), 1e20);
        uint256 out = src.convert(address(ondoB), 1e20, to, true);
        assertApproxEqRel(out, 5000e6, 0.05e18, "100 ondoB at ~50 USDC");
    }

    function test_pausedOndoStillConverts() public {
        quote.setPaused(true);
        uint256 out = src.convert(address(quote), 1e18, to, true);
        assertGt(out, 0);
    }

    function test_deviationGuard() public {
        cons.setMaxDeviationTicks(0);
        _swapAs(
            address(this),
            quoteUsdcKey,
            Currency.unwrap(quoteUsdcKey.currency0) == address(quote),
            -1e21
        );
        vm.expectPartialRevert(FeeConsolidator.PriceDeviation.selector);
        src.convert(address(quote), 1e18, to, true);
    }

    function test_noReference() public {
        (MockOndoToken q, PoolKey memory k) =
            _newQuote("NVDAon", 3000, 2e19, IHooks(address(0)), false);
        vm.expectRevert(abi.encodeWithSelector(FeeConsolidator.ReferenceNotSet.selector, k.toId()));
        src.convert(address(q), 1e18, to, true);
    }

    function test_slippageGuard() public {
        cons.setMaxSlippageBps(0);
        vm.expectPartialRevert(IFeeConsolidator.SlippageTooHigh.selector);
        src.convert(address(quote), 5e22, to, true);
    }

    function test_zeroOutput() public {
        vm.expectRevert(abi.encodeWithSelector(IFeeConsolidator.SlippageTooHigh.selector, 0, 1));
        src.convert(address(quote), 1, to, true);
    }

    function test_hopFeeTooHigh() public {
        (MockOndoToken q,) = _newQuote("MSFTon", 100_100, 2e19, IHooks(address(0)), true);
        vm.expectRevert(abi.encodeWithSelector(FeeConsolidator.HopFeeTooHigh.selector, 1001));
        src.convert(address(q), 1e18, to, true);
    }

    function test_partialFill() public {
        (MockOndoToken q,) = _newQuote("AMZNon", 3000, 1e9, IHooks(address(0)), true);
        vm.expectPartialRevert(FeeConsolidator.PartialFill.selector);
        src.convert(address(q), 1e24, to, true);
    }

    function test_hookedHop_onlyWhenAllowed() public {
        NoopRouteHook h = _routeHook();
        (MockOndoToken q,) = _newQuote("METAon", 3000, 2e19, IHooks(address(h)), true);
        vm.expectRevert(abi.encodeWithSelector(IFeeConsolidator.HookedRouteHop.selector, 0));
        src.convert(address(q), 1e18, to, true);
        uint256 out = src.convert(address(q), 1e18, to, false);
        assertGt(out, 0);
    }

    function test_reentrancyBlocked() public {
        NoopRouteHook h = _routeHook();
        (MockOndoToken q,) = _newQuote("GOOGon", 3000, 2e19, IHooks(address(h)), true);
        h.setCall(
            address(cons),
            abi.encodeCall(IFeeConsolidator.convertClaims, (address(quote), 1, to, false))
        );
        // The route hook's nested call is refused (wrapped by the pool manager).
        vm.expectRevert(
            abi.encodeWithSignature(
                "WrappedError(address,bytes4,bytes,bytes)",
                address(h),
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        src.convert(address(q), 1e18, to, false);
    }

    function test_referenceMoves() public {
        PoolId id = quoteUsdcKey.toId();
        (int24 refBefore,,,,) = cons.references(id);
        // Move spot within the deviation band, then convert a day later.
        _swapAs(
            address(this),
            quoteUsdcKey,
            Currency.unwrap(quoteUsdcKey.currency0) == address(quote),
            -3e21
        );
        int24 spot = _spotTick(quoteUsdcKey);
        assertTrue(spot != refBefore);
        vm.warp(block.timestamp + 1 days);
        src.convert(address(quote), 1e18, to, true);
        (int24 refAfter, uint40 updatedAt,,,) = cons.references(id);
        assertEq(updatedAt, block.timestamp);
        assertTrue(refAfter != refBefore, "reference followed spot");
        int256 moved = int256(refAfter) - int256(refBefore);
        assertLe(moved < 0 ? -moved : moved, int256(MAX_DEVIATION_TICKS / 10), "capped step");
    }

    function test_operatorRequired() public {
        src.setOperator(false);
        vm.expectRevert();
        src.convert(address(quote), 1e18, to, true);
    }
}
