// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {V3RouteLib} from "../../src/libraries/V3RouteLib.sol";
import {MockERC20, MockOndoToken, MockWETH} from "./ConsolidatorMocks.sol";

/// @dev Route validation for Uniswap v3 hops (tick spacing zero) in `QuoteRegistry`.
contract QuoteRegistryV3Test is Test {
    QuoteRegistry internal registry;
    MockERC20 internal usdc;
    MockWETH internal weth;
    MockOndoToken internal ondo;
    MockERC20 internal wbtc;

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        weth = new MockWETH();
        ondo = new MockOndoToken("AAPLon");
        wbtc = new MockERC20("WBTC", 8);
        registry = new QuoteRegistry(address(this), address(usdc), address(weth));
    }

    function _route1(PoolKey memory k) internal pure returns (PoolKey[] memory r) {
        r = new PoolKey[](1);
        r[0] = k;
    }

    function test_acceptsV3HopAndStoresIt() public {
        PoolKey[] memory r = _route1(V3RouteLib.hop(address(ondo), address(usdc), 500));
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, r);
        PoolKey[] memory stored = registry.routeOf(address(ondo));
        assertEq(stored.length, 1);
        assertTrue(V3RouteLib.isValidV3(stored[0]));
        assertEq(stored[0].fee, 500);
    }

    function test_mixedV4ThenV3() public {
        // ondo -(v4, static 0.3%)-> wbtc -(v3 0.05%)-> usdc
        (address a, address b) =
            address(ondo) < address(wbtc) ? (address(ondo), address(wbtc)) : (address(wbtc), address(ondo));
        PoolKey memory v4 = PoolKey(Currency.wrap(a), Currency.wrap(b), 3000, 60, IHooks(address(0)));
        PoolKey[] memory r = new PoolKey[](2);
        r[0] = v4;
        r[1] = V3RouteLib.hop(address(wbtc), address(usdc), 500);
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, r);
        assertEq(registry.routeLength(address(ondo)), 2);
    }

    function test_rejectsBadFeeTier() public {
        PoolKey memory k = V3RouteLib.hop(address(ondo), address(usdc), 2500);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.InvalidV3Hop.selector, 0));
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, _route1(k));
    }

    function test_rejectsHookedV3Hop() public {
        PoolKey memory k = V3RouteLib.hop(address(ondo), address(usdc), 500);
        k.hooks = IHooks(address(0xbeef));
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.InvalidV3Hop.selector, 0));
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, _route1(k));
    }

    function test_rejectsUnsortedAndNativeV3Hop() public {
        PoolKey memory k = V3RouteLib.hop(address(ondo), address(usdc), 500);
        (k.currency0, k.currency1) = (k.currency1, k.currency0);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.InvalidV3Hop.selector, 0));
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, _route1(k));

        PoolKey memory n = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(address(usdc)), 500, 0, IHooks(address(0))
        );
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.InvalidV3Hop.selector, 0));
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, _route1(n));
    }

    function test_v3HopMustConnectAndSettle() public {
        PoolKey memory off = V3RouteLib.hop(address(wbtc), address(usdc), 500);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RouteDisconnected.selector, 0));
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, _route1(off));

        PoolKey memory notSettle = V3RouteLib.hop(address(ondo), address(wbtc), 500);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RouteDoesNotSettle.selector, address(wbtc)));
        registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, _route1(notSettle));
    }

    function test_v3HopFromWethDoesNotUnwrap() public {
        // WETH -> USDC through v3 uses WETH directly (the unwrap special case is for v4 native).
        PoolKey[] memory r = _route1(V3RouteLib.hop(address(weth), address(usdc), 500));
        registry.addQuoteAssetWithRoute(address(weth), IQuoteRegistry.Kind.Native, r);
        assertTrue(registry.hasRoute(address(weth)));
    }

    /// @dev Any fee, hooks, order and spacing: accepted iff the hop is a well formed v3 hop or a
    ///      non-zero spacing v4 hop that connects; the zero spacing marker is never accepted
    ///      malformed.
    function testFuzz_routeValidation(uint24 fee, int24 spacing, address hooks, bool swapOrder)
        public
    {
        PoolKey memory k = V3RouteLib.hop(address(ondo), address(usdc), fee);
        k.tickSpacing = spacing;
        k.hooks = IHooks(hooks);
        if (swapOrder) (k.currency0, k.currency1) = (k.currency1, k.currency0);

        bool wellFormedV3 = spacing == 0 && hooks == address(0) && !swapOrder
            && (fee == 100 || fee == 500 || fee == 3000 || fee == 10_000);
        assertEq(V3RouteLib.isValidV3(k), wellFormedV3 || false);

        try registry.addQuoteAssetWithRoute(address(ondo), IQuoteRegistry.Kind.Ondo, _route1(k)) {
            // Accepted: either a valid v3 hop or a (connected, settling) v4 hop.
            assertTrue(wellFormedV3 || spacing != 0);
        } catch {
            // Rejected: never for a well formed v3 hop.
            assertFalse(wellFormedV3);
        }
    }
}
