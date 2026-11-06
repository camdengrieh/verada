// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {FeeConversionHook} from "../../../src/hooks/conversion/FeeConversionHook.sol";
import {ConvertingSwapFeeExample} from "../../../src/hooks/examples/ConvertingSwapFeeExample.sol";
import {HookTest} from "../utils/HookTest.sol";

contract ConvertingSwapFeeExampleTest is HookTest {
    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    ConvertingSwapFeeExample internal hook;
    address internal owner = makeAddr("owner");
    address internal payout = makeAddr("payout");
    address internal stranger = makeAddr("stranger");

    Currency internal tX;
    Currency internal tQ;
    Currency internal tT;
    PoolKey internal pool; // X/Q with the hook
    PoolKey internal qt; // Q/T hookless route
    bytes32 internal bucket;

    function setUp() public {
        deployFreshManagerAndRouters();
        tX = deployMintAndApproveCurrency();
        tQ = deployMintAndApproveCurrency();
        tT = deployMintAndApproveCurrency();

        hook = ConvertingSwapFeeExample(
            _deployHook(
                "ConvertingSwapFeeExample.sol:ConvertingSwapFeeExample",
                abi.encode(manager, tT, owner, payout),
                FLAGS
            )
        );
        vm.prank(owner);
        hook.setPoolInitializer(address(this), true);

        pool = _pool(tX, tQ, 3000, 60, IHooks(address(hook)));
        qt = _pool(tQ, tT, 500, 10, IHooks(address(0)));
        bucket = PoolId.unwrap(pool.toId());

        // This test initialized the pool, so it is the pool admin.
        hook.setSwapFee(pool, 100, address(hook), true);

        PoolKey[] memory r = new PoolKey[](1);
        r[0] = qt;
        vm.startPrank(owner);
        hook.setConversionRoute(tQ, r);
        hook.setHopGuard(qt, 0, 100, 100, 2000, 500);
        vm.stopPrank();
    }

    function _pool(Currency a, Currency b, uint24 fee, int24 spacing, IHooks hooks)
        internal
        returns (PoolKey memory k)
    {
        (Currency c0, Currency c1) = Currency.unwrap(a) < Currency.unwrap(b) ? (a, b) : (b, a);
        k = PoolKey(c0, c1, fee, spacing, hooks);
        manager.initialize(k, SQRT_PRICE_1_1);
        int24 range = spacing * 100;
        modifyLiquidityRouter.modifyLiquidity(k, ModifyLiquidityParams(-range, range, 1e21, 0), "");
    }

    function _sellX(uint256 amountIn) internal {
        swap(pool, tX == pool.currency0, -int256(amountIn), "");
    }

    function _claims(Currency c) internal view returns (uint256) {
        return manager.balanceOf(address(hook), c.toId());
    }

    function test_permissions() public view {
        assertEq(_flags(hook.getHookPermissions()), FLAGS);
        assertEq(hook.owner(), owner);
        assertEq(hook.payout(), payout);
    }

    function test_swapFeeConvertedInSwap() public {
        _sellX(1e18);
        assertGt(tT.balanceOf(payout), 0);
        assertEq(hook.totalHeld(tQ), 0);
        assertEq(_claims(tQ), 0);
    }

    function test_heldThenRetried() public {
        swap(qt, tQ == qt.currency0, -1e19, ""); // push the route pool out of the in-swap band
        _sellX(1e18);
        uint256 held = hook.heldFees(bucket, tQ);
        assertGt(held, 0);
        assertEq(_claims(tQ), hook.totalHeld(tQ));
        assertEq(tT.balanceOf(payout), 0);

        vm.prank(stranger);
        uint256 out = hook.retryHeld(bucket, tQ, held);
        assertEq(tT.balanceOf(payout), out);
        assertEq(_claims(tQ), 0);
        assertEq(hook.totalHeld(tQ), 0);
    }

    function test_otherRecipientNotConverted() public {
        hook.setSwapFee(pool, 100, stranger, true);
        _sellX(1e18);
        assertGt(manager.balanceOf(stranger, tQ.toId()), 0);
        assertEq(tT.balanceOf(payout), 0);
        assertEq(_claims(tQ), 0);
    }

    function test_tokenFeesNotConverted() public {
        hook.setSwapFee(pool, 100, stranger, false);
        _sellX(1e18);
        assertGt(tQ.balanceOf(stranger), 0);
        assertEq(tT.balanceOf(payout), 0);
    }

    function test_missingGuardHolds() public {
        PoolKey memory qt2 = _pool(tQ, tT, 3000, 60, IHooks(address(0)));
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = qt2;
        vm.prank(owner);
        hook.setConversionRoute(tQ, r);
        _sellX(1e18);
        assertGt(hook.heldFees(bucket, tQ), 0);
    }

    /// @dev Regression: a stranger who initializes a key first must not become its admin.
    function test_initialize_strangerRejected() public {
        address squatter = makeAddr("squatter");
        PoolKey memory k = PoolKey(pool.currency0, pool.currency1, 500, 10, IHooks(address(hook)));
        vm.prank(squatter);
        vm.expectRevert(_initGateRevert(address(hook), squatter));
        manager.initialize(k, SQRT_PRICE_1_1);
        assertEq(hook.poolAdmin(k.toId()), address(0));

        vm.prank(squatter);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, squatter)
        );
        hook.setPoolInitializer(squatter, true);
    }

    function test_onlyOwner() public {
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = qt;
        bytes memory err =
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.startPrank(stranger);
        vm.expectRevert(err);
        hook.setConversionRoute(tQ, r);
        vm.expectRevert(err);
        hook.clearConversionRoute(tQ);
        vm.expectRevert(err);
        hook.setHopGuard(qt, 0, 1, 1, 1, 1);
        vm.expectRevert(err);
        hook.setPayout(stranger);
        vm.stopPrank();
    }

    function test_revert_invalidGuard() public {
        vm.startPrank(owner);
        vm.expectRevert(ConvertingSwapFeeExample.InvalidHopGuard.selector);
        hook.setHopGuard(qt, 0, 100, 2001, 100, 100);
        vm.expectRevert(ConvertingSwapFeeExample.InvalidHopGuard.selector);
        hook.setHopGuard(qt, 0, 100, 100, 100, 2001);
        vm.expectRevert(ConvertingSwapFeeExample.InvalidHopGuard.selector);
        hook.setHopGuard(qt, TickMath.MAX_TICK + 1, 100, 100, 100, 100);
        vm.expectRevert(ConvertingSwapFeeExample.InvalidHopGuard.selector);
        hook.setHopGuard(qt, 0, uint24(TickMath.MAX_TICK) + 1, 100, 100, 100);
        vm.stopPrank();
    }

    function test_revert_zeroPayout() public {
        vm.prank(owner);
        vm.expectRevert(ConvertingSwapFeeExample.ZeroPayout.selector);
        hook.setPayout(address(0));
    }

    function test_clearRouteHolds() public {
        vm.prank(owner);
        hook.clearConversionRoute(tQ);
        _sellX(1e18);
        assertGt(hook.heldFees(bucket, tQ), 0);
        assertEq(_claims(tQ), hook.totalHeld(tQ));
    }

    function test_payoutChange() public {
        address p2 = makeAddr("p2");
        vm.prank(owner);
        hook.setPayout(p2);
        _sellX(1e18);
        assertGt(tT.balanceOf(p2), 0);
        assertEq(tT.balanceOf(payout), 0);
    }

    function test_retryUsesWiderBand() public {
        swap(qt, tQ == qt.currency0, -1e19, "");
        _sellX(1e18);
        uint256 held = hook.heldFees(bucket, tQ);
        // Narrow the retry band below the pushed distance: the retry reverts and keeps the hold.
        vm.prank(owner);
        hook.setHopGuard(qt, 0, 100, 100, 100, 500);
        vm.expectRevert();
        hook.retryHeld(bucket, tQ, held);
        assertEq(hook.heldFees(bucket, tQ), held);
        assertEq(FeeConversionHook(address(hook)).totalHeld(tQ), held);
    }
}
