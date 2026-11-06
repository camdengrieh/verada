// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {AddQuoteAssets} from "../../script/AddQuoteAssets.s.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {CauseCatalog} from "../../src/CauseCatalog.sol";
import {FeeConsolidator} from "../../src/FeeConsolidator.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {VaradaFactory} from "../../src/VaradaFactory.sol";
import {VaradaLpLocker} from "../../src/VaradaLpLocker.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IVaradaFactory} from "../../src/interfaces/IVaradaFactory.sol";
import {CatalogPublish} from "../utils/CatalogFixture.sol";

/// @notice Mainnet-fork proof that more quote assets need only registry configuration. The
///         `AddQuoteAssets` script registers the curated set against a freshly deployed system;
///         then tokens launch against crypto assets that are neither WETH nor Ondo (direct and
///         through-ETH routes), trade, and their fees consolidate to USDC through the real pools.
///         Skipped when ETH_RPC_URL is unset.
contract QuoteAssetsForkTest is Test, Deploy {
    address internal constant WBTC_ = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address internal constant CBBTC_ = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant WSTETH_ = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address internal constant LINK_ = 0x514910771AF9Ca656af840dff83E8264EcF986CA;
    address internal constant UNI_ = 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984;
    address internal constant AAVE_ = 0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9;

    address internal deployer = makeAddr("deployer");
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");

    Deployment internal d;
    AddQuoteAssets internal script;
    PoolSwapTest internal swapRouter;
    uint256 internal launches;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        vm.startBroadcast(deployer);
        d = deploy(
            Config({owner: owner, platformTreasury: treasury, siteSwarmRef: bytes32(0)}), deployer
        );
        vm.stopBroadcast();

        // The script contract stands in for the owner: it becomes the registry's and the
        // consolidator's owner, as a keystore signer would be when running the script.
        script = new AddQuoteAssets();
        vm.startPrank(owner);
        QuoteRegistry(d.quoteRegistry).acceptOwnership();
        QuoteRegistry(d.quoteRegistry).transferOwnership(address(script));
        FeeConsolidator(payable(d.feeConsolidator)).acceptOwnership();
        FeeConsolidator(payable(d.feeConsolidator)).transferOwnership(address(script));
        CauseCatalog(d.causeCatalog).acceptOwnership();
        bytes32[] memory orgs = new bytes32[](2);
        orgs[0] = bytes32("200049703");
        orgs[1] = bytes32("999000111");
        CatalogPublish.publish(CauseCatalog(d.causeCatalog), orgs);
        vm.stopPrank();
        vm.startPrank(address(script));
        QuoteRegistry(d.quoteRegistry).acceptOwnership();
        FeeConsolidator(payable(d.feeConsolidator)).acceptOwnership();
        vm.stopPrank();

        swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));
    }

    function _register(string memory symbol) internal {
        AddQuoteAssets.Planned[] memory all = script.plan();
        for (uint256 i; i < all.length; ++i) {
            if (keccak256(bytes(all[i].symbol)) != keccak256(bytes(symbol))) continue;
            script.applyOne(
                QuoteRegistry(d.quoteRegistry), FeeConsolidator(payable(d.feeConsolidator)), all[i]
            );
            return;
        }
        revert("symbol not in plan");
    }

    /// @dev All curated assets register: pools exist on the fork, routes connect and end in USDC.
    function test_fork_curatedSetRegisters() public {
        AddQuoteAssets.Planned[] memory all = script.plan();
        QuoteRegistry registry = QuoteRegistry(d.quoteRegistry);
        for (uint256 i; i < all.length; ++i) {
            script.applyOne(registry, FeeConsolidator(payable(d.feeConsolidator)), all[i]);
            assertTrue(registry.isAllowed(all[i].asset), all[i].symbol);
            assertEq(registry.routeLength(all[i].asset), all[i].route.length, all[i].symbol);
            assertLe(registry.routeLength(all[i].asset), 3);
        }
        assertEq(registry.quoteAssetCount(), all.length);
        assertEq(uint8(registry.getQuoteAsset(WBTC_).kind), uint8(IQuoteRegistry.Kind.Native));
        assertEq(registry.getQuoteAsset(WBTC_).decimals, 8);
    }

    function test_fork_launchTradeConsolidate_WBTC() public {
        _register("WBTC");
        _launchTradeConsolidate(WBTC_, 0.003e8);
    }

    function test_fork_launchTradeConsolidate_cbBTC() public {
        _register("cbBTC");
        _launchTradeConsolidate(CBBTC_, 0.003e8);
    }

    function test_fork_launchTradeConsolidate_UNI() public {
        _register("UNI");
        _launchTradeConsolidate(UNI_, 30e18);
    }

    function test_fork_launchTradeConsolidate_AAVE() public {
        _register("AAVE");
        _launchTradeConsolidate(AAVE_, 1.5e18);
    }

    /// @dev Two-hop route through native ETH: asset -> ETH -> USDC.
    function test_fork_launchTradeConsolidate_wstETH() public {
        _register("wstETH");
        _launchTradeConsolidate(WSTETH_, 0.07e18);
    }

    function test_fork_launchTradeConsolidate_LINK() public {
        _register("LINK");
        _launchTradeConsolidate(LINK_, 20e18);
    }

    function _launchTradeConsolidate(address quote, uint256 spend) internal {
        IVaradaFactory.DeployParams memory p = IVaradaFactory.DeployParams({
            name: "Quote Fork",
            symbol: "QFORK",
            metadataURI: "bzz://1111111111111111111111111111111111111111111111111111111111111111",
            salt: bytes32(++launches),
            baseFeeBps: 300,
            sniperFeeStartBps: 0,
            sniperDecaySeconds: 0,
            startTick: -230_200,
            quoteAsset: quote,
            label: string.concat("quote-fork-", vm.toString(launches)),
            logoRef: bytes32(0),
            categoryMask: CatalogPublish.CATEGORIES,
            regionMask: CatalogPublish.REGIONS
        });
        vm.prank(creator);
        (address token,) = VaradaFactory(d.factory).deployToken(p);
        assertEq(VaradaFactory(d.factory).quoteAssetOf(token), quote);

        (address c0, address c1) = token < quote ? (token, quote) : (quote, token);
        PoolKey memory key =
            PoolKey(Currency.wrap(c0), Currency.wrap(c1), 0x800000, 200, IHooks(d.hook));
        bool quoteIsCurrency0 = c0 == quote;

        // Trade: buy the token with the quote asset.
        deal(quote, trader, spend);
        vm.startPrank(trader);
        _safeApprove(quote, address(swapRouter));
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: quoteIsCurrency0,
                amountSpecified: -int256(spend),
                sqrtPriceLimitX96: quoteIsCurrency0
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        assertGt(IERC20(token).balanceOf(trader), 0, "bought the token");

        // Consolidate: the locker collects the pool's fees; the quote asset converts to USDC
        // through the route and the vault splits it.
        vm.warp(block.timestamp + 1 days);
        FeeVault vault = FeeVault(d.feeVault);
        uint256 trackedBefore = vault.totalTracked();
        (uint256 a0, uint256 a1) = VaradaLpLocker(d.lpLocker).collectFees(token);
        uint256 collected = quoteIsCurrency0 ? a0 : a1;
        assertApproxEqRel(collected, (spend * 300) / 10_000, 0.01e18, "3% of the input");

        FeeConsolidator cons = FeeConsolidator(payable(d.feeConsolidator));
        assertEq(cons.heldFees(token, quote), 0, "nothing held");
        assertEq(IERC20(quote).balanceOf(d.feeConsolidator), 0, "consolidator keeps no quote");
        uint256 usdc = vault.totalTracked() - trackedBefore;
        assertGt(usdc, 0, "fees consolidated into USDC");
        assertEq(IERC20(USDC).balanceOf(d.feeVault), vault.totalTracked(), "vault holds USDC only");
        // The platform's 10% share is real USDC.
        assertApproxEqAbs(vault.platformAccrued(), (usdc * 1000) / 10_000, 2);
    }

    /// @dev USDT-style tokens return nothing from approve.
    function _safeApprove(address token, address spender) internal {
        (bool ok,) =
            token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, type(uint256).max));
        require(ok, "approve failed");
    }
}
