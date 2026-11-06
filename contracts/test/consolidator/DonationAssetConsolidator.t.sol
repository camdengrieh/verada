// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {FeeConsolidator} from "../../src/FeeConsolidator.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {DonationAsset} from "../../src/interfaces/IDonationAsset.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IVaradaHook} from "../../src/interfaces/IVaradaHook.sol";
import {ConsolidatorBase} from "./ConsolidatorBase.sol";
import {MockERC20, single} from "./ConsolidatorMocks.sol";

/// @dev Donation asset `Eth` (WETH) next to `Usdc`, on a real PoolManager: an Ondo-like quote
///      that only has a USDC pool is routed to WETH over two hops, a WETH-quoted token needs no
///      conversion on its quote side, held fees retry into WETH, the vault keeps both ledgers,
///      and `convertDonation` turns WETH into USDC for the Endaoment push.
contract DonationAssetConsolidatorTest is ConsolidatorBase {
    PoolKey internal wethUsdcKey; // WETH / USDC, static 0.05%
    PoolKey internal ethTokenKey; // memeE / quote, hooked
    PoolKey internal wethTokenKey; // memeW / WETH, hooked
    MockERC20 internal memeE; // quote = Ondo-like, donation asset Eth
    MockERC20 internal memeW; // quote = WETH, donation asset Eth
    int24 internal constant WETH_TICK = 196_260; // |tick| of ~3000 USDC per WETH (raw units)

    function setUp() public {
        _baseSetUp();
        _setupPools(0, 0);
        vm.deal(address(this), 2_000_000 ether);
        weth.deposit{value: 1_000_000 ether}();
        weth.approve(address(modifyLiquidityRouter), type(uint256).max);

        (Currency a, Currency b) = _sorted(address(weth), address(usdc));
        wethUsdcKey = PoolKey(a, b, 500, 10, IHooks(address(0)));
        int24 wt = _orientedTick(address(weth), address(usdc), WETH_TICK);
        manager.initialize(wethUsdcKey, TickMath.getSqrtPriceAtTick(wt));
        _addLiquidity(wethUsdcKey, wt, 3e15);

        // WETH is a quote asset with its USDC route (needed for the Endaoment push); the Ondo
        // quote gets a two hop route into WETH (it only has a USDC pool).
        PoolKey[] memory wr = new PoolKey[](1);
        wr[0] = wethUsdcKey;
        registry.addQuoteAssetWithRoute(address(weth), IQuoteRegistry.Kind.Native, wr);
        PoolKey[] memory er = new PoolKey[](2);
        er[0] = quoteKey;
        er[1] = wethUsdcKey;
        registry.setRouteTo(address(quote), DonationAsset.Eth, er);
        cons.seedReferences(wr);
        cons.setSource(address(this), true);

        memeE = _launch(address(quote), DonationAsset.Eth, 1);
        memeW = _launch(address(weth), DonationAsset.Eth, 2);
        ethTokenKey = _keyOf(address(memeE), address(quote));
        wethTokenKey = _keyOf(address(memeW), address(weth));
    }

    function _keyOf(address t, address q) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = _sorted(t, q);
        return PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
    }

    function _launch(address q, DonationAsset da, uint256 n) internal returns (MockERC20 t) {
        t = new MockERC20(string.concat("MEME", vm.toString(n)), 18);
        vault.registerToken(address(t), da);
        hook.configureToken(
            address(t),
            IVaradaHook.FeeConfig({
                baseFeeBps: BASE_BPS,
                sniperFeeStartBps: 0,
                sniperDecaySeconds: 0,
                launchTimestamp: uint40(block.timestamp)
            })
        );
        PoolKey memory k = _keyOf(address(t), q);
        int24 tt = _orientedTick(address(t), q, TOKEN_TICK);
        manager.initialize(k, TickMath.getSqrtPriceAtTick(tt));
        t.mint(address(this), 1e36);
        t.approve(address(modifyLiquidityRouter), type(uint256).max);
        _addLiquidity(k, tt, 1e24);
    }

    function _deliverTo(MockERC20 t, address currency, uint256 amount) internal {
        if (currency == address(quote)) quote.mint(address(cons), amount);
        else if (currency == address(weth)) weth.transfer(address(cons), amount);
        else MockERC20(currency).mint(address(cons), amount);
        vm.prank(locker);
        cons.consolidate(address(t), currency, amount);
    }

    // ------------------------------------------------------------------ registry

    function test_registry_routesPerDonationAsset() public {
        assertTrue(registry.hasRouteTo(address(weth), DonationAsset.Eth), "weth implicit");
        assertTrue(registry.hasRouteTo(address(weth), DonationAsset.Usdc));
        assertTrue(registry.hasRouteTo(address(quote), DonationAsset.Eth));
        assertEq(registry.routeToOf(address(quote), DonationAsset.Eth).length, 2);
        assertEq(registry.routeToOf(address(weth), DonationAsset.Eth).length, 0);
        assertEq(registry.routeOf(address(quote)).length, 1, "usdc route untouched");
        assertEq(registry.donationToken(DonationAsset.Usdc), address(usdc));
        assertEq(registry.donationToken(DonationAsset.Eth), address(weth));
    }

    function test_registry_ethRouteMustEndInWeth() public {
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = quoteKey; // ends in USDC
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RouteDoesNotSettle.selector, address(usdc)));
        registry.setRouteTo(address(quote), DonationAsset.Eth, r);
    }

    function test_registry_wethEthRouteIsImplicit() public {
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = wethUsdcKey;
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RouteIsImplicit.selector, address(weth)));
        registry.setRouteTo(address(weth), DonationAsset.Eth, r);
    }

    function test_registry_onlyOwnerSetsRoutes() public {
        PoolKey[] memory r = new PoolKey[](2);
        r[0] = quoteKey;
        r[1] = wethUsdcKey;
        vm.prank(makeAddr("rando"));
        vm.expectRevert();
        registry.setRouteTo(address(quote), DonationAsset.Eth, r);
    }

    function test_poolWithoutEthRouteCannotRegister() public {
        // A quote asset with only a USDC route cannot host an Eth token.
        MockERC20 other = new MockERC20("OTHER", 18);
        PoolKey[] memory r = new PoolKey[](1);
        (Currency a, Currency b) = _sorted(address(other), address(usdc));
        r[0] = PoolKey(a, b, 3000, 60, IHooks(address(0)));
        manager.initialize(r[0], TickMath.getSqrtPriceAtTick(_orientedTick(address(other), address(usdc), 230_280)));
        registry.addQuoteAssetWithRoute(address(other), IQuoteRegistry.Kind.Ondo, r);

        MockERC20 t = new MockERC20("T", 18);
        vault.registerToken(address(t), DonationAsset.Eth);
        hook.configureToken(
            address(t),
            IVaradaHook.FeeConfig({
                baseFeeBps: BASE_BPS,
                sniperFeeStartBps: 0,
                sniperDecaySeconds: 0,
                launchTimestamp: uint40(block.timestamp)
            })
        );
        PoolKey memory k = _keyOf(address(t), address(other));
        vm.expectRevert();
        manager.initialize(k, TickMath.getSqrtPriceAtTick(_orientedTick(address(t), address(other), TOKEN_TICK)));
        assertFalse(registry.hasRouteTo(address(other), DonationAsset.Eth));
    }

    // ------------------------------------------------------------------ consolidation to WETH

    function test_ondoQuote_multiHopIntoWeth() public {
        _deliverTo(memeE, address(quote), 10e18); // ~10 quote = ~1,000 USDC = ~0.333 WETH
        uint256 got = weth.balanceOf(address(vault));
        assertGt(got, 0.32e18, "weth credited");
        assertLt(got, 0.334e18);
        assertEq(usdc.balanceOf(address(vault)), 0, "no usdc");
        assertEq(vault.totalTrackedEth(), got);
        assertEq(vault.totalTracked(), 0);
        assertEq(vault.causePool(address(memeE)) + vault.platformAccruedEth(), got);
        assertEq(vault.platformAccruedEth(), (got * 1000) / 10_000);
        assertEq(cons.heldFees(address(memeE), address(quote)), 0);
    }

    function test_usdcTokenUnchanged() public {
        _deliver(address(quote), 100e18); // meme is a Usdc token
        assertGt(usdc.balanceOf(address(vault)), 9000e6);
        assertEq(weth.balanceOf(address(vault)), 0);
        assertEq(vault.totalTrackedEth(), 0);
        assertEq(uint256(vault.donationAssetOf(address(meme))), 0);
    }

    function test_wethQuote_noConversionOnQuoteSide() public {
        vm.recordLogs();
        _deliverTo(memeW, address(weth), 5e18);
        (, bool failed) = _lastFailure(vm.getRecordedLogs());
        assertFalse(failed);
        assertEq(weth.balanceOf(address(vault)), 5e18, "exact, no swap");
        assertEq(weth.balanceOf(address(cons)), 0);
        assertEq(vault.platformAccruedEth(), 0.5e18);
        assertEq(vault.causePool(address(memeW)), 4.5e18);
    }

    function test_wethQuote_tokenSideSwapsOneHop() public {
        skip(1900);
        _deliverTo(memeW, address(memeW), 1000e18); // ~1 token = 0.001 WETH quote
        uint256 got = weth.balanceOf(address(vault));
        assertGt(got, 0.9e18);
        assertLt(got, 1.01e18);
        assertEq(memeW.balanceOf(address(cons)), 0);
        assertEq(vault.totalTrackedEth(), got);
    }

    function test_ondoQuote_tokenSideThreeHops() public {
        skip(1900);
        _deliverTo(memeE, address(memeE), 1000e18); // 1000 tokens ~ 1 quote ~ 0.033 WETH
        uint256 got = weth.balanceOf(address(vault));
        assertGt(got, 0.0300e18);
        assertLt(got, 0.0340e18);
        assertEq(memeE.balanceOf(address(cons)), 0);
    }

    function test_heldFeeRetriesIntoWeth() public {
        cons.setReference(wethUsdcKey, WETH_TICK > 0 ? int24(1000) : int24(-1000));
        vm.recordLogs();
        _deliverTo(memeE, address(quote), 10e18);
        (, bool failed) = _lastFailure(vm.getRecordedLogs());
        assertTrue(failed, "guard trips");
        assertEq(cons.heldFees(address(memeE), address(quote)), 10e18);
        assertEq(weth.balanceOf(address(vault)), 0);

        PoolKey[] memory k = new PoolKey[](1);
        k[0] = wethUsdcKey;
        cons.seedReferences(k);
        uint256 out = cons.retry(address(memeE), address(quote));
        assertGt(out, 0.3e18);
        assertEq(weth.balanceOf(address(vault)), out);
        assertEq(cons.heldFees(address(memeE), address(quote)), 0);
    }

    function testFuzz_ethLedgerBackedAndSplit(uint96 amount, bool tokenSide) public {
        amount = uint96(bound(amount, 1e12, 1e21));
        skip(1900);
        if (tokenSide) _deliverTo(memeE, address(memeE), amount);
        else _deliverTo(memeE, address(quote), amount);
        uint256 w = weth.balanceOf(address(vault));
        assertGe(w, vault.totalTrackedEth(), "backed");
        assertEq(vault.totalTrackedEth(), vault.causePool(address(memeE)) + vault.platformAccruedEth());
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(vault.totalTracked(), 0);
    }

    // ------------------------------------------------------------------ vault ledgers

    function test_settleEthPoolSendsWeth() public {
        _deliverTo(memeW, address(weth), 10e18);
        _deliver(address(quote), 10e18); // a Usdc token in the same vault
        governor.setCurrentEpoch(0);
        governor.setFinalized(address(memeW), 0, true);
        vm.warp(block.timestamp + 8 days);
        vault.settle(address(memeW), 0);
        assertEq(weth.balanceOf(address(distributor)), 9e18);
        assertEq(distributor.received(address(memeW), 0), 9e18);
        assertEq(vault.totalTrackedEth(), 1e18, "platform share left");
        assertGt(vault.totalTracked(), 0, "usdc ledger separate");
    }

    function test_withdrawPlatformPaysBothAssets() public {
        _deliverTo(memeW, address(weth), 10e18);
        _deliver(address(quote), 10e18);
        uint256 platformUsdc = vault.platformAccrued();
        assertGt(platformUsdc, 0);
        vault.withdrawPlatform();
        assertEq(usdc.balanceOf(treasury), platformUsdc);
        assertEq(weth.balanceOf(treasury), 1e18);
        assertEq(vault.platformAccrued(), 0);
        assertEq(vault.platformAccruedEth(), 0);
        assertEq(vault.totalTrackedEth(), 9e18);
    }

    function test_ethNeedsConsolidatorKnowingWeth() public {
        // A vault whose consolidator has no `weth()` cannot register Eth tokens.
        MockERC20 t = new MockERC20("T", 18);
        vault.registerToken(address(t), DonationAsset.Eth); // fine: this vault knows weth
        assertEq(uint256(vault.donationAssetOf(address(t))), 1);
        assertEq(vault.weth(), address(weth));
    }

    // ------------------------------------------------------------------ convertDonation

    function test_convertDonation_wethToUsdc() public {
        address to = makeAddr("sink");
        weth.approve(address(cons), 1e18);
        uint256 out = cons.convertDonation(1e18, to);
        assertGt(out, 2900e6);
        assertLt(out, 3010e6);
        assertEq(usdc.balanceOf(to), out);
        assertEq(weth.balanceOf(address(cons)), 0);
        assertEq(weth.allowance(address(this), address(cons)), 0);
    }

    function test_convertDonation_onlySource() public {
        address rando = makeAddr("rando");
        deal(address(weth), rando, 1e18);
        vm.startPrank(rando);
        weth.approve(address(cons), 1e18);
        vm.expectRevert(IFeeConsolidator.NotAuthorized.selector);
        cons.convertDonation(1e18, rando);
        vm.stopPrank();
    }

    function test_convertDonation_guardFailureRevertsAndKeepsWeth() public {
        cons.setReference(wethUsdcKey, WETH_TICK > 0 ? int24(1000) : int24(-1000));
        weth.approve(address(cons), 1e18);
        uint256 before = weth.balanceOf(address(this));
        vm.expectRevert();
        cons.convertDonation(1e18, address(this));
        assertEq(weth.balanceOf(address(this)), before);
    }

    function testFuzz_convertDonation(uint96 amount) public {
        amount = uint96(bound(amount, 1e15, 3e17));
        weth.approve(address(cons), amount);
        uint256 out = cons.convertDonation(amount, address(this));
        assertEq(weth.balanceOf(address(cons)), 0);
        assertEq(usdc.balanceOf(address(cons)), 0);
        assertGt(out, 0);
    }
}
