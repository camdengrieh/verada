// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {VaradaToken} from "../../src/VaradaToken.sol";
import {DonationAsset} from "../../src/interfaces/IDonationAsset.sol";
import {ILiveDonationVault} from "../../src/interfaces/ILiveDonationVault.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {IVaradaLiveHook} from "../../src/interfaces/IVaradaLiveHook.sol";
import {LiveBase} from "./LiveBase.sol";

/// @dev Live-donation tokens whose donation asset is ETH (WETH): fees convert inline into WETH,
///      the vault keeps a separate WETH ledger, and pushes to Endaoment convert WETH to USDC
///      through the consolidator (within the swap when gas allows, otherwise `flush`).
contract LiveDonationAssetTest is LiveBase {
    uint96 internal constant NO_PUSH = 1_000e18;

    function setUp() public {
        _liveSetUp();
        cons.setSource(address(vault), true);
        // Eth routes: quote -> WETH (one hop), ondoB -> quote -> WETH. WETH is implicit.
        PoolKey[] memory q = new PoolKey[](1);
        q[0] = quoteWethKey;
        registry.setRouteTo(address(quote), DonationAsset.Eth, q);
        PoolKey[] memory b = new PoolKey[](2);
        b[0] = ondoBQuoteKey;
        b[1] = quoteWethKey;
        registry.setRouteTo(address(ondoB), DonationAsset.Eth, b);
    }

    function _launchEth(address quoteAsset, uint96 threshold)
        internal
        returns (VaradaToken token, PoolKey memory key)
    {
        token = new VaradaToken("Live", "LIVE", "ipfs://live", creator, address(this));
        hook.configureToken(
            address(token), IVaradaLiveHook.LiveFeeConfig(BASE_BPS, 0, 0, 0)
        );
        vault.registerToken(address(token), threshold, CAUSE_A, RotationPeriod.OneHour, DonationAsset.Eth);
        (Currency c0, Currency c1) = _sorted(address(token), quoteAsset);
        key = PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        int24 tick = _orientedTick(address(token), quoteAsset, TOKEN_TICK);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(tick));
        _approveRouters(address(token));
        _addLiquidity(key, tick, 1e24);
        profiles.register(address(token), creator);
        _fundTrader(trader, token);
    }

    function _usdcOfOrg() internal view returns (uint256) {
        return usdc.balanceOf(endTreasury) + usdc.balanceOf(orgA);
    }

    // ------------------------------------------------------------------ registration

    function test_register_storesAsset() public {
        (VaradaToken t,) = _launchEth(address(quote), NO_PUSH);
        assertEq(uint256(vault.donationAssetOf(address(t))), 1);
        assertEq(vault.weth(), address(weth));
    }

    function test_register_ethThresholdCap() public {
        VaradaToken t = new VaradaToken("L", "L", "ipfs://l", creator, address(this));
        vm.expectRevert(abi.encodeWithSelector(ILiveDonationVault.ThresholdTooHigh.selector, uint256(1_001e18)));
        vault.registerToken(address(t), uint96(1_001e18), CAUSE_A, RotationPeriod.OneHour, DonationAsset.Eth);
    }

    function test_launchRejectsQuoteWithoutEthRoute() public {
        // Remove nothing: use an asset that never got an Eth route.
        VaradaToken t = new VaradaToken("L", "L", "ipfs://l", creator, address(this));
        hook.configureToken(address(t), IVaradaLiveHook.LiveFeeConfig(BASE_BPS, 0, 0, 0));
        vault.registerToken(address(t), NO_PUSH, CAUSE_A, RotationPeriod.OneHour, DonationAsset.Eth);
        // A fresh quote with a USDC route only.
        address solo = address(new MockSolo());
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = quoteUsdcKey; // does not start at solo, so use a registry add that is valid
        // The simplest unroutable case: the pool key's quote is not allowed at all.
        (Currency c0, Currency c1) = _sorted(address(t), solo);
        PoolKey memory key = PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        vm.expectRevert();
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
    }

    // ------------------------------------------------------------------ inline conversion

    function test_quoteSwapCreditsWeth() public {
        (VaradaToken t, PoolKey memory key) = _launchEth(address(quote), NO_PUSH);
        uint256 wethBefore = weth.balanceOf(address(vault));
        _buyExactIn(key, address(t), 100e18); // fee 3% of 100 quote = 3 quote = ~0.1 WETH
        uint256 credited = weth.balanceOf(address(vault)) - wethBefore;
        assertGt(credited, 0.09e18, "weth in vault");
        assertLt(credited, 0.1e18);
        assertEq(usdc.balanceOf(address(vault)), 0, "no usdc");
        assertEq(vault.platformAccruedEth(), (credited * 1000) / 10_000);
        (uint256 pending,) = vault.pendingOf(address(t), CAUSE_A);
        assertEq(pending + vault.platformAccruedEth(), credited);
        assertEq(vault.totalPendingEth(), pending);
        assertEq(vault.totalPending(), 0);
    }

    function test_threeHopOndoQuoteIntoWeth() public {
        (VaradaToken t, PoolKey memory key) = _launchEth(address(ondoB), NO_PUSH);
        _buyExactIn(key, address(t), 100e18);
        assertGt(weth.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_wethQuoteNeedsNoConversion() public {
        (VaradaToken t, PoolKey memory key) = _launchEth(address(weth), NO_PUSH);
        _buyExactIn(key, address(t), 10e18); // 3% fee = 0.3 WETH, exactly
        assertEq(weth.balanceOf(address(vault)), 0.3e18, "fee paid straight in WETH");
        assertEq(vault.platformAccruedEth(), 0.03e18);
        (uint256 pending,) = vault.pendingOf(address(t), CAUSE_A);
        assertEq(pending, 0.27e18);
    }

    function test_usdcTokenStillCreditsUsdc() public {
        (VaradaToken t, PoolKey memory key) = _launch(address(quote), NO_PUSH_USDC, RotationPeriod.OneHour, 0, 0);
        _fundTrader(trader, t);
        _buyExactIn(key, address(t), 100e18);
        assertGt(usdc.balanceOf(address(vault)), 0);
        assertEq(weth.balanceOf(address(vault)), 0);
        assertEq(vault.platformAccruedEth(), 0);
    }

    uint96 internal constant NO_PUSH_USDC = 1_000_000e6;

    // ------------------------------------------------------------------ pushes

    function test_flush_convertsWethToUsdcForEndaoment() public {
        (VaradaToken t, PoolKey memory key) = _launchEth(address(weth), NO_PUSH);
        _buyExactIn(key, address(t), 10e18);
        uint256 before = _usdcOfOrg();
        uint256 donated = vault.flush(address(t), CAUSE_A);
        assertEq(donated, 0.27e18, "debited in WETH");
        (uint256 pending,) = vault.pendingOf(address(t), CAUSE_A);
        assertEq(pending, 0);
        assertEq(vault.totalPendingEth(), 0);
        // 0.27 WETH ~ 810 USDC reaches the org (less the Endaoment fee).
        uint256 got = _usdcOfOrg() - before;
        assertGt(got, 700e6);
        assertLt(got, 820e6);
        assertEq(weth.balanceOf(address(vault)), vault.platformAccruedEth(), "only platform WETH left");
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(weth.allowance(address(vault), address(cons)), 0);
    }

    function test_thresholdPush_ethInSwapWhenGasAllows() public {
        // Hook credit with plenty of gas (the vault checks gasleft before an in-swap push).
        (VaradaToken t,) = _launchEth(address(weth), 0.1e18);
        weth.deposit{value: 1e18}();
        weth.transfer(address(vault), 1e18);
        uint256 before = _usdcOfOrg();
        vm.prank(address(hook));
        vault.creditLive{gas: 3_000_000}(address(t), CAUSE_A, 1, 1e18);
        (uint256 pending,) = vault.pendingOf(address(t), CAUSE_A);
        assertEq(pending, 0, "pushed");
        assertGt(_usdcOfOrg() - before, 2400e6, "0.9 WETH worth of USDC donated");
        assertEq(vault.totalPendingEth(), 0);
        assertEq(weth.balanceOf(address(vault)), 0.1e18, "platform share only");
    }

    function test_thresholdPush_deferredWithoutGasThenFlush() public {
        (VaradaToken t,) = _launchEth(address(weth), 0.1e18);
        weth.deposit{value: 1e18}();
        weth.transfer(address(vault), 1e18);
        vm.prank(address(hook));
        vault.creditLive{gas: 400_000}(address(t), CAUSE_A, 1, 1e18);
        (uint256 pending,) = vault.pendingOf(address(t), CAUSE_A);
        assertEq(pending, 0.9e18, "deferred");
        vault.flush(address(t), CAUSE_A);
        (pending,) = vault.pendingOf(address(t), CAUSE_A);
        assertEq(pending, 0);
    }

    function test_pushFailureKeepsCredit() public {
        (VaradaToken t,) = _launchEth(address(weth), 0);
        // Break the WETH/USDC route guard: the conversion reverts, the credit stays.
        cons.setReference(ethUsdcKey, int24(1000));
        weth.deposit{value: 1e18}();
        weth.transfer(address(vault), 1e18);
        vm.prank(address(hook));
        vault.creditLive{gas: 3_000_000}(address(t), CAUSE_A, 1, 1e18);
        (uint256 pending,) = vault.pendingOf(address(t), CAUSE_A);
        assertEq(pending, 0.9e18, "kept");
        vm.expectRevert();
        vault.flush(address(t), CAUSE_A);
        (pending,) = vault.pendingOf(address(t), CAUSE_A);
        assertEq(pending, 0.9e18);
    }

    // ------------------------------------------------------------------ ledgers

    function test_withdrawPlatformAndSkimPerAsset() public {
        (VaradaToken t, PoolKey memory key) = _launchEth(address(weth), NO_PUSH);
        _buyExactIn(key, address(t), 10e18);
        weth.deposit{value: 5 ether}();
        weth.transfer(address(vault), 5 ether); // stray
        vault.withdrawPlatform();
        assertEq(weth.balanceOf(treasury), 0.03e18);
        assertEq(vault.platformAccruedEth(), 0);
        assertEq(vault.skim(address(weth)), 5 ether);
        assertEq(weth.balanceOf(address(vault)), 0.27e18, "owed pending untouched");
    }

    function testFuzz_ethLedgerAlwaysBacked(uint96 amount, uint8 sells) public {
        amount = uint96(bound(amount, 1e15, 1e21));
        (VaradaToken t, PoolKey memory key) = _launchEth(address(weth), NO_PUSH);
        _buyExactIn(key, address(t), amount);
        for (uint256 i; i < sells % 3; ++i) {
            _sellExactIn(key, address(t), 1e18);
        }
        assertGe(weth.balanceOf(address(vault)), vault.platformAccruedEth() + vault.totalPendingEth());
        assertGe(usdc.balanceOf(address(vault)), vault.platformAccrued() + vault.totalPending());
    }
}

contract MockSolo {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}
