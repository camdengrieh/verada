// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {VaradaToken} from "../../src/VaradaToken.sol";
import {DonationAsset} from "../../src/interfaces/IDonationAsset.sol";
import {ILiveDonationVault} from "../../src/interfaces/ILiveDonationVault.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {IVaradaLiveHook} from "../../src/interfaces/IVaradaLiveHook.sol";
import {LiveDonationForkTest} from "./LiveDonationFork.t.sol";

/// @notice Mainnet fork: `Eth` donation asset against the real PoolManager, WETH, USDC, AMZNon
///         and Endaoment. Run with `--match-contract DonationAssetForkTest` (the inherited
///         suite also runs otherwise). Skipped when ETH_RPC_URL is unset.
/// @dev Pools used: native ETH/USDC 0.05% (WETH unwrap hop; also the end of the Ondo route, where
///      native ETH is wrapped back), AMZNon/USDC 1% (the Ondo token only has a USDC pool).
contract DonationAssetForkTest is LiveDonationForkTest {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    PoolKey internal ethUsdc;
    PoolKey internal amznUsdc;
    bool internal amznReady;

    function _ethInit() internal {
        cons.setSource(address(vault), true);
        ethUsdc = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 500, 10, IHooks(address(0)));
        (address a, address b) = AMZN_ON < USDC ? (AMZN_ON, USDC) : (USDC, AMZN_ON);
        amznUsdc = PoolKey(Currency.wrap(a), Currency.wrap(b), 10_000, 100, IHooks(address(0)));
        if (PM.getLiquidity(amznUsdc.toId()) == 0) return;
        PoolKey[] memory usdcRoute = new PoolKey[](1);
        usdcRoute[0] = amznUsdc;
        registry.addQuoteAssetWithRoute(AMZN_ON, IQuoteRegistry.Kind.Ondo, usdcRoute);
        // AMZNon -> USDC -> native ETH (wrapped on the way out): two hops, USDC pool only.
        PoolKey[] memory ethRoute = new PoolKey[](2);
        ethRoute[0] = amznUsdc;
        ethRoute[1] = ethUsdc;
        registry.setRouteTo(AMZN_ON, DonationAsset.Eth, ethRoute);
        cons.seedReferences(usdcRoute);
        amznReady = true;
    }

    function _launchEth(address quote_, uint96 threshold, bytes32 cause)
        internal
        returns (VaradaToken token, PoolKey memory key)
    {
        token = new VaradaToken("Live", "LIVE", "ipfs://live", makeAddr("creator"), address(this));
        hook.configureToken(address(token), IVaradaLiveHook.LiveFeeConfig(300, 0, 0, 0));
        vault.registerToken(address(token), threshold, cause, RotationPeriod.OneDay, DonationAsset.Eth);
        (address a, address b) =
            address(token) < quote_ ? (address(token), quote_) : (quote_, address(token));
        key = PoolKey(
            Currency.wrap(a), Currency.wrap(b), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook))
        );
        int24 tick = address(token) < quote_ ? int24(-69_060) : int24(69_060);
        PM.initialize(key, TickMath.getSqrtPriceAtTick(tick));
        token.approve(address(liquidityRouter), type(uint256).max);
        if (quote_ == AMZN_ON) {
            vm.prank(address(PM));
            IERC20(AMZN_ON).transfer(address(this), 2e18);
            vm.prank(address(PM));
            IERC20(AMZN_ON).transfer(trader, 2e18);
            IERC20(AMZN_ON).approve(address(liquidityRouter), type(uint256).max);
            vm.prank(trader);
            IERC20(AMZN_ON).approve(address(swapRouter), type(uint256).max);
        }
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tick - 6000,
                tickUpper: tick + 6000,
                liquidityDelta: quote_ == AMZN_ON ? int256(1e19) : int256(1e22),
                salt: 0
            }),
            ""
        );
        token.transfer(trader, 1e24);
    }

    function _usdc(address who) internal view returns (uint256) {
        return IERC20(USDC).balanceOf(who);
    }

    // ------------------------------------------------------------------ WETH-quoted, live

    function test_forkEth_wethQuote_creditsWethThenFlushDonatesUsdc() public {
        _ethInit();
        (VaradaToken t, PoolKey memory k) = _launchEth(WETH, 1_000e18, causeDeployed);
        _buy(k, address(t), 1 ether); // 3% fee = 0.03 WETH, no conversion on the quote side
        assertEq(IERC20(WETH).balanceOf(address(vault)), 0.03 ether, "fee in WETH");
        assertEq(_usdc(address(vault)), 0);
        (uint256 pending,) = vault.pendingOf(address(t), causeDeployed);
        assertEq(pending, 0.027 ether);
        assertEq(vault.platformAccruedEth(), 0.003 ether);

        uint256 before = _usdc(ORG_DEPLOYED_ADDR);
        vm.recordLogs();
        uint256 g = gasleft();
        vault.flush(address(t), causeDeployed);
        emit log_named_uint("fork: ETH flush gas (WETH->USDC + Endaoment donate)", g - gasleft());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 donated;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == ILiveDonationVault.Donated.selector) ++donated;
        }
        assertEq(donated, 1);
        uint256 got = _usdc(ORG_DEPLOYED_ADDR) - before;
        emit log_named_uint("fork: USDC to org for 0.027 WETH", got);
        assertGt(got, 20e6, "0.027 WETH is worth tens of USDC");
        assertEq(vault.totalPendingEth(), 0);
        assertEq(IERC20(WETH).balanceOf(address(vault)), vault.platformAccruedEth());
        assertEq(_usdc(address(vault)), 0);
    }

    function test_forkEth_thresholdPush_inSwapOrDeferred() public {
        _ethInit();
        // Threshold 0: every credit is due. The swap's inline envelope usually cannot afford the
        // conversion, so the push is deferred; either way nothing is lost.
        (VaradaToken t, PoolKey memory k) = _launchEth(WETH, 0, causeDeployed);
        _buy(k, address(t), 1 ether);
        (uint256 pending,) = vault.pendingOf(address(t), causeDeployed);
        uint256 donatedSoFar = _usdc(ORG_DEPLOYED_ADDR);
        emit log_named_uint("fork: pending WETH after threshold-0 swap", pending);
        if (pending != 0) vault.flush(address(t), causeDeployed);
        (pending,) = vault.pendingOf(address(t), causeDeployed);
        assertEq(pending, 0);
        assertGt(_usdc(ORG_DEPLOYED_ADDR), donatedSoFar);
    }

    function test_forkEth_directCreditPushesInSwapWithGas() public {
        _ethInit();
        (VaradaToken t,) = _launchEth(WETH, 0.01 ether, causeDeployed);
        IERC20(WETH).transfer(address(vault), 1 ether);
        uint256 before = _usdc(ORG_DEPLOYED_ADDR);
        uint256 g = gasleft();
        vm.prank(address(hook));
        vault.creditLive{gas: 3_000_000}(address(t), causeDeployed, 1, 1 ether);
        emit log_named_uint("fork: creditLive with ETH push gas", g - gasleft());
        (uint256 pending,) = vault.pendingOf(address(t), causeDeployed);
        assertEq(pending, 0, "pushed");
        assertGt(_usdc(ORG_DEPLOYED_ADDR) - before, 1000e6, "0.9 WETH of USDC");
    }

    // ------------------------------------------------------------------ Ondo quote, USDC pools only

    function test_forkEth_ondoQuote_twoHopsToEth() public {
        _ethInit();
        if (!amznReady) vm.skip(true);
        (VaradaToken t, PoolKey memory k) = _launchEth(AMZN_ON, 1_000e18, causeDeployed);
        uint256 wethBefore = IERC20(WETH).balanceOf(address(vault));
        bool zeroForOne = Currency.unwrap(k.currency0) == AMZN_ON;
        vm.prank(trader);
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -1e17,
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 held = hook.heldRaw(address(t), causeDeployed);
        uint256 got = IERC20(WETH).balanceOf(address(vault)) - wethBefore;
        emit log_named_uint("fork: WETH credited for an AMZNon fee", got);
        if (held == 0) {
            assertGt(got, 0, "converted AMZNon -> USDC -> ETH -> WETH");
            assertEq(_usdc(address(vault)), 0);
        }
        assertEq(address(cons).balance, 0);
        assertEq(IERC20(WETH).balanceOf(address(cons)), 0);
    }
}
