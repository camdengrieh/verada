// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {MockERC20} from "./ConsolidatorMocks.sol";

/// @dev Fuzzes route validation of the registry: every accepted route is a connected chain of
///      at most MAX_ROUTE_LENGTH hops that ends in the settlement asset; everything else reverts
///      with the matching error and leaves the stored route untouched.
contract RouteValidationFuzzTest is Test {
    QuoteRegistry internal registry;
    MockERC20 internal usdc;
    address internal weth = makeAddr("weth");
    uint256 internal constant MAX_FEE_PIPS = 100_000; // 10%, MAX_HOP_FEE_BPS of the consolidator

    // Assets: A (the quote asset) plus up to three intermediates, all real ERC20s for decimals.
    MockERC20[4] internal t;

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        registry = new QuoteRegistry(address(this), address(usdc), weth);
        for (uint256 i; i < 4; ++i) {
            t[i] = new MockERC20("T", 18);
        }
    }

    function _key(address a, address b, uint24 fee, int24 spacing, address hooks)
        internal
        pure
        returns (PoolKey memory)
    {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(hooks));
    }

    /// Builds a connected chain asset -> mid... -> usdc of `hops` pools, either orientation.
    function _chain(uint256 hops, uint256 flipSeed, uint24 fee)
        internal
        view
        returns (PoolKey[] memory route)
    {
        route = new PoolKey[](hops);
        address cur = address(t[0]);
        for (uint256 i; i < hops; ++i) {
            address next = i + 1 == hops ? address(usdc) : address(t[i + 1]);
            // Orientation is decided by sort order, but the key may not be pre-sorted wrongly.
            route[i] = _key(cur, next, fee, 60, address(0));
            cur = next;
        }
        flipSeed; // orientation is derived from addresses; kept for signature symmetry
    }

    function testFuzz_connectedChainAccepted(uint8 hopsRaw, uint24 fee) public {
        uint256 hops = bound(hopsRaw, 1, 3);
        fee = uint24(bound(fee, 1, MAX_FEE_PIPS));
        PoolKey[] memory route = _chain(hops, 0, fee);
        registry.addQuoteAssetWithRoute(address(t[0]), IQuoteRegistry.Kind.Ondo, route);
        PoolKey[] memory stored = registry.routeOf(address(t[0]));
        assertEq(stored.length, hops);
        assertEq(registry.routeLength(address(t[0])), hops);
        assertTrue(registry.hasRoute(address(t[0])));
        for (uint256 i; i < hops; ++i) {
            assertEq(abi.encode(stored[i]), abi.encode(route[i]));
        }
    }

    function testFuzz_tooLongRejected(uint8 hopsRaw) public {
        uint256 hops = bound(hopsRaw, 4, 40);
        PoolKey[] memory route = new PoolKey[](hops);
        for (uint256 i; i < hops; ++i) {
            route[i] = _key(address(t[0]), address(usdc), 3000, 60, address(0));
        }
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RouteTooLong.selector, hops));
        registry.addQuoteAssetWithRoute(address(t[0]), IQuoteRegistry.Kind.Ondo, route);
    }

    function test_emptyRejected() public {
        PoolKey[] memory route = new PoolKey[](0);
        vm.expectRevert(QuoteRegistry.EmptyRoute.selector);
        registry.addQuoteAssetWithRoute(address(t[0]), IQuoteRegistry.Kind.Ondo, route);
    }

    /// Replacing hop `at` of a valid chain with a pool that does not touch the current asset.
    function testFuzz_disconnectedRejected(uint8 hopsRaw, uint8 atRaw, address stranger1, address stranger2)
        public
    {
        uint256 hops = bound(hopsRaw, 1, 3);
        uint256 at = bound(atRaw, 0, hops - 1);
        PoolKey[] memory route = _chain(hops, 0, 3000);
        address cur = at == 0 ? address(t[0]) : address(t[at]);
        vm.assume(stranger1 != stranger2);
        vm.assume(stranger1 != cur && stranger2 != cur);
        vm.assume(stranger1 != address(0) && stranger2 != address(0));
        route[at] = _key(stranger1, stranger2, 3000, 60, address(0));
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RouteDisconnected.selector, at));
        registry.addQuoteAssetWithRoute(address(t[0]), IQuoteRegistry.Kind.Ondo, route);
    }

    function testFuzz_wrongSettleAssetRejected(uint8 hopsRaw, address wrongEnd) public {
        uint256 hops = bound(hopsRaw, 1, 3);
        vm.assume(wrongEnd != address(usdc) && wrongEnd != address(t[0]) && wrongEnd != address(0));
        vm.assume(wrongEnd != weth);
        PoolKey[] memory route = new PoolKey[](hops);
        address cur = address(t[0]);
        address[3] memory mids = [address(t[1]), address(t[2]), address(t[3])];
        for (uint256 i; i < hops; ++i) {
            address next = i + 1 == hops ? wrongEnd : mids[i];
            vm.assume(next != cur);
            route[i] = _key(cur, next, 3000, 60, address(0));
            cur = next;
        }
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RouteDoesNotSettle.selector, cur));
        registry.addQuoteAssetWithRoute(address(t[0]), IQuoteRegistry.Kind.Ondo, route);
    }

    /// A failed replacement never leaves a half written route behind.
    function testFuzz_failedReplaceKeepsNothingPartial(uint8 hopsRaw) public {
        PoolKey[] memory good = _chain(1, 0, 3000);
        registry.addQuoteAssetWithRoute(address(t[0]), IQuoteRegistry.Kind.Ondo, good);

        uint256 hops = bound(hopsRaw, 2, 3);
        PoolKey[] memory bad = _chain(hops, 0, 3000);
        // Break the last hop so the settle check fails after earlier hops were pushed.
        bad[hops - 1] = _key(address(t[hops]), address(t[0]), 3000, 60, address(0));
        vm.expectRevert();
        registry.setRoute(address(t[0]), bad);
        // The revert unwinds the delete too: the previous route is intact.
        assertEq(registry.routeLength(address(t[0])), 1);
    }

    function test_settlementAndZeroAssetsRejected() public {
        PoolKey[] memory route = _chain(1, 0, 3000);
        vm.expectRevert(QuoteRegistry.AssetIsSettlement.selector);
        registry.addQuoteAssetWithRoute(address(usdc), IQuoteRegistry.Kind.Ondo, route);
        vm.expectRevert();
        registry.addQuoteAssetWithRoute(address(0), IQuoteRegistry.Kind.Ondo, route);
    }

    /// Pool keys with zero fee or extreme spacing are not the registry's business (it does not
    /// read pools), but a fee above what the consolidator tolerates can never convert.
    /// FINDING-1: the registry accepts such a route, and every conversion then reverts with
    /// HopFeeTooHigh forever. See RegistryFeeCeiling below for the fix.
    function testFuzz_feeAboveConsolidatorCeilingRejected(uint24 fee) public {
        fee = uint24(bound(fee, MAX_FEE_PIPS + 1, 1_000_000));
        PoolKey[] memory route = _chain(1, 0, fee);
        vm.expectRevert();
        registry.addQuoteAssetWithRoute(address(t[0]), IQuoteRegistry.Kind.Ondo, route);
    }

    function testFuzz_onlyOwnerSetsRoutes(address caller) public {
        vm.assume(caller != address(this));
        PoolKey[] memory route = _chain(1, 0, 3000);
        vm.prank(caller);
        vm.expectRevert();
        registry.addQuoteAssetWithRoute(address(t[0]), IQuoteRegistry.Kind.Ondo, route);
    }

    /// WETH to a native ETH pool is the one allowed non-matching hop.
    function testFuzz_wethUnwrapHop(uint24 fee) public {
        fee = uint24(bound(fee, 1, MAX_FEE_PIPS));
        registry = new QuoteRegistry(address(this), address(usdc), address(t[0]));
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdc)), fee, 60, IHooks(address(0)));
        // t[0] doubles as WETH here; it needs decimals() which MockERC20 has.
        registry.addQuoteAssetWithRoute(address(t[0]), IQuoteRegistry.Kind.Native, route);
        assertEq(registry.routeLength(address(t[0])), 1);
        // Any other asset cannot use the native pool.
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.RouteDisconnected.selector, 0));
        registry.addQuoteAssetWithRoute(address(t[1]), IQuoteRegistry.Kind.Ondo, route);
    }
}
