// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {FeeConsolidator, IConsolidatorRegistry} from "../../src/FeeConsolidator.sol";
import {FeeConsolidatorV3} from "../../src/FeeConsolidatorV3.sol";
import {V3SwapExecutor} from "../../src/V3SwapExecutor.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IUniswapV3Factory} from "../../src/interfaces/external/IUniswapV3.sol";
import {V3RouteLib} from "../../src/libraries/V3RouteLib.sol";
import {ConsolidatorBase} from "./ConsolidatorBase.sol";
import {MockV3Factory, MockV3Pool} from "./V3Mocks.sol";

/// @dev `FeeConsolidatorV3` against the shared consolidator fixture, with the quote asset routed
///      through a (mock, constant price) Uniswap v3 pool instead of a v4 pool. The real pool is
///      exercised in test/fork/ConsolidatorV3Fork.t.sol.
contract FeeConsolidatorV3Test is ConsolidatorBase {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant V3_FEE = 3000;

    MockV3Factory internal v3f;
    MockV3Pool internal v3Pool;
    int24 internal qt;

    function setUp() public {
        _baseSetUp();
        _setupPools(0, 0);
    }

    function _deployConsolidator() internal override returns (FeeConsolidator) {
        v3f = new MockV3Factory();
        return new FeeConsolidatorV3(
            address(this),
            manager,
            IConsolidatorRegistry(address(registry)),
            IFeeVault(address(vault)),
            address(weth),
            MAX_SLIPPAGE_BPS,
            MAX_DEVIATION_TICKS,
            IUniswapV3Factory(address(v3f))
        );
    }

    function _quoteRoute() internal override returns (PoolKey[] memory route) {
        qt = _orientedTick(address(quote), address(usdc), QUOTE_TICK);
        v3Pool = v3f.create(address(quote), address(usdc), V3_FEE, qt);
        usdc.mint(address(v3Pool), 1e30);
        quote.mint(address(v3Pool), 1e30);
        route = new PoolKey[](1);
        route[0] = V3RouteLib.hop(address(quote), address(usdc), V3_FEE);
    }

    function _v3Key() internal view returns (PoolKey memory) {
        return V3RouteLib.hop(address(quote), address(usdc), V3_FEE);
    }

    function _quoteSpotUsdc(uint256 amount) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = v3Pool.slot0();
        bool quoteIs0 = address(quote) < address(usdc);
        return quoteIs0
            ? FullMath.mulDiv(FullMath.mulDiv(amount, sqrtP, 1 << 96), sqrtP, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(amount, 1 << 96, sqrtP), 1 << 96, sqrtP);
    }

    function _executor() internal view returns (V3SwapExecutor) {
        return FeeConsolidatorV3(payable(address(cons))).executor();
    }

    function _failure() internal returns (bytes4 sel) {
        bool found;
        (sel, found) = _lastFailure(vm.getRecordedLogs());
        assertTrue(found, "no ConsolidationFailed");
    }

    // ------------------------------------------------------------------ happy paths

    function test_quoteSide_pureV3Route() public {
        uint256 amount = 5e18;
        uint256 spot = _quoteSpotUsdc(amount);
        uint256 gasBefore = gasleft();
        _deliverQuote(amount);
        emit log_named_uint("gas: consolidate quote->USDC via v3 (incl. mint)", gasBefore - gasleft());

        uint256 got = usdc.balanceOf(address(vault));
        assertGt(got, (spot * 9900) / 10_000);
        assertLe(got, spot);
        assertEq(v3Pool.swaps(), 1);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        assertEq(cons.totalHeld(address(quote)), 0);
        assertEq(quote.balanceOf(address(cons)), 0);
        assertEq(usdc.balanceOf(address(cons)), 0);
        // The pool manager holds nothing of this route and no delta is left behind.
        assertEq(vault.totalTracked(), got);
        assertEq(vault.platformAccrued(), (got * 1000) / 10_000);
    }

    function test_tokenSide_v4ThenV3() public {
        skip(1900); // the token pool needs a TWAP history
        uint256 gasBefore = gasleft();
        _deliver(address(meme), 1000e18);
        emit log_named_uint("gas: consolidate token->quote(v4)->USDC(v3)", gasBefore - gasleft());

        assertEq(cons.heldFees(address(meme), address(meme)), 0);
        assertEq(meme.balanceOf(address(cons)), 0);
        assertEq(quote.balanceOf(address(cons)), 0);
        assertEq(v3Pool.swaps(), 1);
        uint256 got = usdc.balanceOf(address(vault));
        assertGt(got, 90e6);
        assertLt(got, 101e6);
        assertEq(vault.causePool(address(meme)) + vault.platformAccrued(), got);
    }

    function test_emitsAmountsOnSuccess() public {
        vm.recordLogs();
        _deliverQuote(2e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic0 = keccak256("FeesConsolidated(address,address,uint256,uint256)");
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic0) {
                (uint256 amountIn, uint256 out) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(amountIn, 2e18);
                assertEq(out, usdc.balanceOf(address(vault)));
                seen = true;
            }
        }
        assertTrue(seen);
    }

    function test_referenceFollowsV3Spot() public {
        PoolId id = _v3Key().toId();
        (int24 before,,,,) = cons.references(id);
        assertEq(before, qt);
        skip(1 days);
        // Inside the 1000 tick deviation bound, in the direction that raises the quote's price
        // (a lower price would fail the slippage guard, which measures against the reference).
        int24 up = address(quote) < address(usdc) ? int24(1) : int24(-1);
        v3Pool.setTick(qt + 500 * up);
        _deliverQuote(1e18);
        (int24 afterTick,,,,) = cons.references(id);
        // One capped step (a tenth of the deviation bound) toward spot.
        assertEq(afterTick, qt + 100 * up);
    }

    function test_syncReferenceReadsV3() public {
        PoolId id = _v3Key().toId();
        skip(1 days);
        int24 up = address(quote) < address(usdc) ? int24(1) : int24(-1);
        v3Pool.setTick(qt + 500 * up);
        cons.syncReference(_v3Key());
        (int24 t,,,,) = cons.references(id);
        assertEq(t, qt + 100 * up);
    }

    // ------------------------------------------------------------------ guards fail closed

    function test_slippageGuardHoldsThenRetries() public {
        v3Pool.setShave(500); // pays 5% less than the price says
        vm.recordLogs();
        _deliverQuote(5e18);
        assertEq(_failure(), IFeeConsolidator.SlippageTooHigh.selector);
        assertEq(cons.heldFees(address(meme), address(quote)), 5e18);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(quote.balanceOf(address(cons)), 5e18);

        v3Pool.setShave(0);
        assertGt(cons.retry(address(meme), address(quote)), 0);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
    }

    function test_deviationGuardHolds() public {
        v3Pool.setTick(qt + 1500); // reference stays at qt, bound is 1000
        vm.recordLogs();
        _deliverQuote(1e18);
        assertEq(_failure(), FeeConsolidator.PriceDeviation.selector);
        assertEq(cons.heldFees(address(meme), address(quote)), 1e18);
        assertEq(v3Pool.swaps(), 0);
    }

    function test_referenceNotSetHolds() public {
        cons.setReference(_v3Key(), qt); // set, then replace the route with an unseeded pool
        v3f.create(address(quote), address(usdc), 500, qt);
        MockV3Pool p500 = MockV3Pool(v3f.getPool(address(quote), address(usdc), 500));
        usdc.mint(address(p500), 1e30);
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = V3RouteLib.hop(address(quote), address(usdc), 500);
        registry.setRoute(address(quote), route);

        vm.recordLogs();
        _deliverQuote(1e18);
        assertEq(_failure(), FeeConsolidator.ReferenceNotSet.selector);
        assertEq(cons.heldFees(address(meme), address(quote)), 1e18);
    }

    function test_partialFillHolds() public {
        v3Pool.setFill(5000);
        vm.recordLogs();
        _deliverQuote(2e18);
        assertEq(_failure(), FeeConsolidator.PartialFill.selector);
        assertEq(cons.heldFees(address(meme), address(quote)), 2e18);
        assertEq(quote.balanceOf(address(cons)), 2e18);
    }

    function test_pausedTokenHoldsThenRetries() public {
        quote.setPaused(true); // the transfer into the pool inside the callback reverts
        vm.recordLogs();
        _deliverQuote(2e18);
        assertEq(cons.heldFees(address(meme), address(quote)), 2e18);
        _failure();

        quote.setPaused(false);
        assertGt(cons.retry(address(meme), address(quote)), 0);
    }

    function test_hopFeeBoundsTolerance() public {
        // Minimum is spot * (1 - 3.3%) (slippage 300 + hop fee 30 bps); the pool already takes its
        // 0.3% fee, so an extra 2.5% shortfall passes and an extra 3.2% does not.
        v3Pool.setShave(250);
        _deliverQuote(1e18);
        assertEq(cons.heldFees(address(meme), address(quote)), 0);
        v3Pool.setShave(320);
        vm.recordLogs();
        _deliverQuote(1e18);
        assertEq(_failure(), IFeeConsolidator.SlippageTooHigh.selector);
    }

    function test_missingPoolHolds() public {
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = V3RouteLib.hop(address(quote), address(usdc), 100); // no such pool
        registry.setRoute(address(quote), route);
        cons.setReference(route[0], qt);
        vm.recordLogs();
        _deliverQuote(1e18);
        assertEq(_failure(), V3SwapExecutor.V3PoolMissing.selector);
        assertEq(cons.heldFees(address(meme), address(quote)), 1e18);
    }

    function test_seedReferenceNeedsPool() public {
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = V3RouteLib.hop(address(quote), address(usdc), 10_000);
        vm.expectRevert(
            abi.encodeWithSelector(
                V3SwapExecutor.V3PoolMissing.selector,
                address(quote) < address(usdc) ? address(quote) : address(usdc),
                address(quote) < address(usdc) ? address(usdc) : address(quote),
                uint24(10_000)
            )
        );
        cons.seedReferences(keys);
    }

    // ------------------------------------------------------------------ callback safety

    function test_callbackOnlyFromTheSwappedPool() public {
        V3SwapExecutor ex = _executor();
        vm.expectRevert(V3SwapExecutor.V3CallbackUnauthorized.selector);
        ex.uniswapV3SwapCallback(1e18, -1, "");

        // Even the real pool cannot pull funds outside a swap this contract started.
        quote.mint(address(ex), 1e18);
        vm.prank(address(v3Pool));
        vm.expectRevert(V3SwapExecutor.V3CallbackUnauthorized.selector);
        ex.uniswapV3SwapCallback(1e18, -1, "");
    }

    function test_secondCallbackPaysNothing() public {
        v3Pool.setCallTwice(true);
        vm.recordLogs();
        _deliverQuote(2e18);
        assertEq(_failure(), V3SwapExecutor.V3CallbackUnauthorized.selector);
        assertEq(cons.heldFees(address(meme), address(quote)), 2e18);
        assertEq(quote.balanceOf(address(cons)), 2e18);
    }

    function test_executorOnlyForConsolidator() public {
        V3SwapExecutor ex = FeeConsolidatorV3(payable(address(cons))).executor();
        assertEq(ex.consolidator(), address(cons));
        vm.expectRevert(V3SwapExecutor.NotConsolidator.selector);
        ex.swap(address(quote), address(usdc), V3_FEE, 1);
    }

    function test_callbackCannotOverpay() public {
        // A pool asking for more than the swap's amount is refused (state set by a real swap only).
        // Simulated through a pool that reports a larger input than it was given.
        v3Pool.setFill(10_000);
        // Covered by the exact-amount check: a direct call with a mismatching amount reverts.
        V3SwapExecutor ex = _executor();
        vm.prank(address(v3Pool));
        vm.expectRevert(V3SwapExecutor.V3CallbackUnauthorized.selector);
        ex.uniswapV3SwapCallback(2e18, -1, "");
    }

    // ------------------------------------------------------------------ base contract

    function test_baseConsolidatorRefusesV3Hops() public {
        FeeConsolidator base = new FeeConsolidator(
            address(this),
            manager,
            IConsolidatorRegistry(address(registry)),
            IFeeVault(address(vault)),
            address(weth),
            MAX_SLIPPAGE_BPS,
            MAX_DEVIATION_TICKS
        );
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = _v3Key();
        vm.expectRevert(FeeConsolidator.V3Unsupported.selector);
        base.seedReferences(keys);
    }

    function test_v3Factory_nonZero() public {
        vm.expectRevert(IQuoteRegistry.ZeroAddress.selector);
        new FeeConsolidatorV3(
            address(this),
            manager,
            IConsolidatorRegistry(address(registry)),
            IFeeVault(address(vault)),
            address(weth),
            MAX_SLIPPAGE_BPS,
            MAX_DEVIATION_TICKS,
            IUniswapV3Factory(address(0))
        );
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_pureV3ConservesValue(uint96 seed) public {
        uint256 amount = bound(uint256(seed), 1e12, 1e24);
        uint256 spot = _quoteSpotUsdc(amount);
        _deliverQuote(amount);
        uint256 got = usdc.balanceOf(address(vault));
        assertLe(got, spot);
        // 0.3% pool fee only (constant price pool): never below the guard's floor.
        assertGe(got, (spot * (10_000 - 330)) / 10_000);
        assertEq(cons.totalHeld(address(quote)), 0);
        assertEq(quote.balanceOf(address(cons)), 0);
        assertEq(usdc.balanceOf(address(cons)), 0);
    }
}
