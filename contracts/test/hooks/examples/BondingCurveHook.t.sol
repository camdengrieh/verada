// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {BaseHook} from "../../../src/hooks/base/BaseHook.sol";
import {PoolAdminHook} from "../../../src/hooks/base/PoolAdminHook.sol";
import {BondingCurveHook} from "../../../src/hooks/examples/BondingCurveHook.sol";
import {HookTest} from "../utils/HookTest.sol";

// ---------------------------------------------------------------------- composition stubs

/// @dev Stub feature: counts swaps and initializations, asks for an LP fee override (which the
///      curve makes irrelevant) and contributes `afterInitialize` to the merged permissions.
abstract contract SwapCounter is BaseHook {
    uint256 public swapsSeen;
    uint256 public initsSeen;

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeSwap = true;
        p.afterInitialize = true;
        return p;
    }

    function _afterInitialize(address s, PoolKey calldata k, uint160 px, int24 t)
        internal
        virtual
        override
        returns (bytes4 sel)
    {
        sel = super._afterInitialize(s, k, px, t);
        initsSeen++;
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        virtual
        override
        returns (bytes4 sel, BeforeSwapDelta delta, uint24 fee)
    {
        (sel, delta, fee) = super._beforeSwap(s, k, sp, d);
        swapsSeen++;
        fee = _mergeLpFeeOverride(fee, 3000 | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}

/// @dev Test-only concrete: the curve plus the stub feature in one hook (rule 6 re-declarations).
contract CountedBondingCurve is BondingCurveHook, SwapCounter {
    constructor(IPoolManager m) BondingCurveHook(m) {}

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(BondingCurveHook, SwapCounter)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeInitialize(address s, PoolKey calldata k, uint160 px)
        internal
        override(BaseHook, PoolAdminHook)
        returns (bytes4)
    {
        return super._beforeInitialize(s, k, px);
    }

    function _beforeAddLiquidity(
        address s,
        PoolKey calldata k,
        ModifyLiquidityParams calldata p,
        bytes calldata d
    ) internal override(BaseHook, BondingCurveHook) returns (bytes4) {
        return super._beforeAddLiquidity(s, k, p, d);
    }

    function _afterInitialize(address s, PoolKey calldata k, uint160 px, int24 t)
        internal
        override(BaseHook, SwapCounter)
        returns (bytes4)
    {
        return super._afterInitialize(s, k, px, t);
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        override(BondingCurveHook, SwapCounter)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return super._beforeSwap(s, k, sp, d);
    }
}

// ---------------------------------------------------------------------- tests

contract BondingCurveHookTest is HookTest {
    using StateLibrary for IPoolManager;

    uint160 internal constant CURVE_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG
        | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG;

    uint128 internal constant VIRTUAL_QUOTE = 30 ether;
    uint128 internal constant GRADUATION = 50 ether;
    uint256 internal constant SUPPLY = 1_000_000_000 ether;

    BondingCurveHook internal hook;
    PoolKey internal poolKey;
    PoolId internal id;
    Currency internal token; // currency0
    Currency internal quote; // currency1

    address internal alice = makeAddr("alice");

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        token = currency0;
        quote = currency1;
        hook = BondingCurveHook(
            _deployHook("BondingCurveHook.sol:BondingCurveHook", abi.encode(manager), CURVE_FLAGS)
        );
        (poolKey, id) = initPool(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
        MockERC20(Currency.unwrap(token)).approve(address(hook), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _ready() internal {
        hook.configureCurve(poolKey, true, VIRTUAL_QUOTE, GRADUATION);
        hook.seed(poolKey, SUPPLY);
    }

    /// @dev Exact-input buy (quote in, token out) on the main pool.
    function _buy(uint256 quoteIn) internal {
        swap(poolKey, false, -int256(quoteIn), ZERO_BYTES);
    }

    /// @dev Exact-input sell (token in, quote out) on the main pool.
    function _sell(uint256 tokenIn) internal {
        swap(poolKey, true, -int256(tokenIn), ZERO_BYTES);
    }

    function _curve()
        internal
        view
        returns (uint128 virtualQuote, uint128 tokenReserve, uint128 quoteReserve, bool graduated)
    {
        bool tokenIs0;
        uint128 graduationQuote;
        (tokenIs0, virtualQuote, tokenReserve, quoteReserve, graduationQuote, graduated) =
            hook.curves(id);
    }

    function _k() internal view returns (uint256) {
        (uint128 v, uint128 t, uint128 q,) = _curve();
        return (uint256(v) + q) * t;
    }

    function _assertClaimsMatchReserves() internal view {
        (, uint128 t, uint128 q,) = _curve();
        assertEq(manager.balanceOf(address(hook), token.toId()), t, "token claims");
        assertEq(manager.balanceOf(address(hook), quote.toId()), q, "quote claims");
    }

    function _expectSwapRevert(bytes memory reason) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                reason,
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
    }

    // ------------------------------------------------------------------ permissions

    function test_permissions() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertEq(_flags(p), CURVE_FLAGS);
        assertTrue(p.beforeInitialize && p.beforeAddLiquidity && p.beforeSwap);
        assertTrue(p.beforeSwapReturnDelta);
        assertFalse(p.afterSwap || p.afterSwapReturnDelta || p.beforeRemoveLiquidity);
    }

    function test_deploy_wrongFlags_reverts() public {
        address at = _hookAddress(CURVE_FLAGS | Hooks.AFTER_SWAP_FLAG);
        vm.expectRevert();
        deployCodeTo("BondingCurveHook.sol:BondingCurveHook", abi.encode(manager), at);
    }

    function test_poolAdmin_isInitializer() public view {
        assertEq(hook.poolAdmin(id), address(this));
    }

    // ------------------------------------------------------------------ configure

    function test_configureCurve() public {
        vm.expectEmit(true, false, false, true, address(hook));
        emit BondingCurveHook.CurveConfigured(id, true, VIRTUAL_QUOTE, GRADUATION);
        hook.configureCurve(poolKey, true, VIRTUAL_QUOTE, GRADUATION);
        (bool tokenIs0, uint128 v, uint128 t, uint128 q, uint128 g, bool grad) = hook.curves(id);
        assertTrue(tokenIs0);
        assertEq(v, VIRTUAL_QUOTE);
        assertEq(t, 0);
        assertEq(q, 0);
        assertEq(g, GRADUATION);
        assertFalse(grad);
    }

    function test_configureCurve_onlyAdmin() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, alice));
        hook.configureCurve(poolKey, true, VIRTUAL_QUOTE, GRADUATION);
    }

    function test_configureCurve_once() public {
        hook.configureCurve(poolKey, true, VIRTUAL_QUOTE, GRADUATION);
        vm.expectRevert(BondingCurveHook.CurveAlreadyConfigured.selector);
        hook.configureCurve(poolKey, false, VIRTUAL_QUOTE, GRADUATION);
    }

    function test_configureCurve_invalid() public {
        vm.expectRevert(BondingCurveHook.InvalidCurve.selector);
        hook.configureCurve(poolKey, true, 0, GRADUATION);
        vm.expectRevert(BondingCurveHook.InvalidCurve.selector);
        hook.configureCurve(poolKey, true, VIRTUAL_QUOTE, 0);
    }

    function test_configureCurve_nativeTokenRejected() public {
        (PoolKey memory nk,) = initPool(
            CurrencyLibrary.ADDRESS_ZERO, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1
        );
        vm.expectRevert(BondingCurveHook.InvalidCurve.selector);
        hook.configureCurve(nk, true, VIRTUAL_QUOTE, GRADUATION);
    }

    function test_configureCurve_frozenAdmin() public {
        hook.transferPoolAdmin(poolKey, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, address(this))
        );
        hook.configureCurve(poolKey, true, VIRTUAL_QUOTE, GRADUATION);
    }

    // ------------------------------------------------------------------ seed

    function test_seed() public {
        hook.configureCurve(poolKey, true, VIRTUAL_QUOTE, GRADUATION);
        uint256 before = token.balanceOfSelf();
        vm.expectEmit(true, false, false, true, address(hook));
        emit BondingCurveHook.CurveSeeded(id, SUPPLY);
        hook.seed(poolKey, SUPPLY);
        assertEq(before - token.balanceOfSelf(), SUPPLY);
        (, uint128 t,,) = _curve();
        assertEq(t, SUPPLY);
        _assertClaimsMatchReserves();
        // topping up before the first buy is allowed
        hook.seed(poolKey, 1 ether);
        (, t,,) = _curve();
        assertEq(t, SUPPLY + 1 ether);
        _assertClaimsMatchReserves();
    }

    function test_seed_reverts() public {
        vm.expectRevert(BondingCurveHook.CurveNotReady.selector);
        hook.seed(poolKey, SUPPLY);

        hook.configureCurve(poolKey, true, VIRTUAL_QUOTE, GRADUATION);
        vm.expectRevert(BondingCurveHook.SeedingClosed.selector);
        hook.seed(poolKey, 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, alice));
        hook.seed(poolKey, SUPPLY);

        hook.seed(poolKey, SUPPLY);
        _buy(1 ether);
        vm.expectRevert(BondingCurveHook.SeedingClosed.selector);
        hook.seed(poolKey, 1 ether);
    }

    function test_unlockCallback_guarded() public {
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(token, address(this), 1));
        vm.prank(address(manager));
        vm.expectRevert(BondingCurveHook.UnexpectedCallback.selector);
        hook.unlockCallback(abi.encode(token, address(this), 1));
    }

    // ------------------------------------------------------------------ swaps

    function test_buy_matchesFormula() public {
        _ready();
        uint256 quoteIn = 3 ether;
        uint256 expected = SUPPLY * quoteIn / (uint256(VIRTUAL_QUOTE) + quoteIn);
        assertEq(hook.quoteBuy(id, quoteIn), expected);
        uint256 t0 = token.balanceOfSelf();
        uint256 q0 = quote.balanceOfSelf();

        vm.expectEmit(true, true, false, true, address(hook));
        emit BondingCurveHook.CurveSwap(id, address(swapRouter), true, quoteIn, expected);
        _buy(quoteIn);

        assertEq(token.balanceOfSelf() - t0, expected, "token out");
        assertEq(q0 - quote.balanceOfSelf(), quoteIn, "quote in");
        (, uint128 t, uint128 q, bool grad) = _curve();
        assertEq(t, SUPPLY - expected);
        assertEq(q, quoteIn);
        assertFalse(grad);
        _assertClaimsMatchReserves();
        // the pool's own liquidity is never touched
        assertEq(manager.getLiquidity(id), 0);
    }

    function test_sell_matchesFormula() public {
        _ready();
        _buy(10 ether);
        uint256 tokenIn = 100_000_000 ether;
        (uint128 v, uint128 t, uint128 q,) = _curve();
        uint256 expected = (uint256(v) + q) * tokenIn / (uint256(t) + tokenIn);
        assertEq(hook.quoteSell(id, tokenIn), expected);
        uint256 q0 = quote.balanceOfSelf();

        vm.expectEmit(true, true, false, true, address(hook));
        emit BondingCurveHook.CurveSwap(id, address(swapRouter), false, tokenIn, expected);
        _sell(tokenIn);

        assertEq(quote.balanceOfSelf() - q0, expected);
        _assertClaimsMatchReserves();
    }

    function test_sell_beyondQuoteReserve_reverts() public {
        _ready();
        _expectSwapRevert(abi.encodeWithSelector(BondingCurveHook.InsufficientReserve.selector));
        _sell(1 ether);
    }

    function test_exactOutput_reverts() public {
        _ready();
        _expectSwapRevert(abi.encodeWithSelector(BondingCurveHook.ExactOutputNotSupported.selector));
        swap(poolKey, false, int256(1 ether), ZERO_BYTES);
    }

    function test_notReady_reverts() public {
        _expectSwapRevert(abi.encodeWithSelector(BondingCurveHook.CurveNotReady.selector));
        _buy(1 ether);
        hook.configureCurve(poolKey, true, VIRTUAL_QUOTE, GRADUATION);
        _expectSwapRevert(abi.encodeWithSelector(BondingCurveHook.CurveNotReady.selector));
        _buy(1 ether);
    }

    function test_addLiquidity_reverts() public {
        _ready();
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(BondingCurveHook.LiquidityNotAllowed.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        modifyLiquidityRouter.modifyLiquidity(poolKey, LIQUIDITY_PARAMS, ZERO_BYTES);
    }

    // ------------------------------------------------------------------ graduation

    function test_graduation() public {
        _ready();
        _buy(GRADUATION - 1);
        (,,, bool grad) = _curve();
        assertFalse(grad);

        vm.expectRevert(BondingCurveHook.CurveNotGraduated.selector);
        hook.withdrawAfterGraduation(poolKey, alice);

        vm.expectEmit(true, false, false, true, address(hook));
        emit BondingCurveHook.Graduated(id, GRADUATION);
        _buy(1);
        (,,, grad) = _curve();
        assertTrue(grad);

        _expectSwapRevert(abi.encodeWithSelector(BondingCurveHook.CurveGraduated.selector));
        _buy(1 ether);
        _expectSwapRevert(abi.encodeWithSelector(BondingCurveHook.CurveGraduated.selector));
        _sell(1 ether);

        vm.expectRevert(BondingCurveHook.CurveGraduated.selector);
        hook.seed(poolKey, 1 ether);
    }

    function test_withdrawAfterGraduation() public {
        _ready();
        _buy(GRADUATION + 7);
        (, uint128 t, uint128 q,) = _curve();

        vm.expectRevert(BondingCurveHook.InvalidRecipient.selector);
        hook.withdrawAfterGraduation(poolKey, address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, alice));
        hook.withdrawAfterGraduation(poolKey, alice);

        vm.expectEmit(true, true, false, true, address(hook));
        emit BondingCurveHook.CurveWithdrawn(id, alice, t, q);
        hook.withdrawAfterGraduation(poolKey, alice);

        assertEq(manager.balanceOf(alice, token.toId()), t);
        assertEq(manager.balanceOf(alice, quote.toId()), q);
        assertEq(q, GRADUATION + 7);
        _assertClaimsMatchReserves(); // both zero now
        (, t, q,) = _curve();
        assertEq(t, 0);
        assertEq(q, 0);
    }

    // ------------------------------------------------------------------ native quote

    function test_nativeQuote_buyAndSell() public {
        // currency0 = native quote, currency1 = curve token
        (PoolKey memory nk, PoolId nid) = initPool(
            CurrencyLibrary.ADDRESS_ZERO, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1
        );
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        hook.configureCurve(nk, false, 2 ether, 100 ether);
        hook.seed(nk, SUPPLY);

        uint256 expected = hook.quoteBuy(nid, 1 ether);
        uint256 t0 = currency1.balanceOfSelf();
        uint256 e0 = address(this).balance;
        swapNativeInput(nk, true, -1 ether, ZERO_BYTES, 1 ether);
        assertEq(currency1.balanceOfSelf() - t0, expected);
        assertEq(e0 - address(this).balance, 1 ether);
        assertEq(manager.balanceOf(address(hook), CurrencyLibrary.ADDRESS_ZERO.toId()), 1 ether);

        uint256 back = hook.quoteSell(nid, expected);
        swapNativeInput(nk, false, -int256(expected), ZERO_BYTES, 0);
        assertEq(address(this).balance, e0 - 1 ether + back);
        assertLe(back, 1 ether);
        (,,, uint128 q,,) = hook.curves(nid);
        assertEq(manager.balanceOf(address(hook), CurrencyLibrary.ADDRESS_ZERO.toId()), q);
        assertEq(manager.balanceOf(address(hook), currency1.toId()), SUPPLY);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_buy_formulaAndK(uint256 quoteIn) public {
        quoteIn = bound(quoteIn, 1, GRADUATION - 1);
        _ready();
        uint256 kBefore = _k();
        uint256 expected = SUPPLY * quoteIn / (uint256(VIRTUAL_QUOTE) + quoteIn);
        uint256 t0 = token.balanceOfSelf();
        _buy(quoteIn);
        assertEq(token.balanceOfSelf() - t0, expected);
        assertGe(_k(), kBefore, "k decreased");
        _assertClaimsMatchReserves();
    }

    function testFuzz_roundTrip_neverProfits(uint256 quoteIn, uint256 preBuy) public {
        preBuy = bound(preBuy, 0, GRADUATION / 2);
        quoteIn = bound(quoteIn, 1, GRADUATION / 2 - 1);
        _ready();
        if (preBuy != 0) _buy(preBuy);

        uint256 t0 = token.balanceOfSelf();
        uint256 q0 = quote.balanceOfSelf();
        _buy(quoteIn);
        uint256 got = token.balanceOfSelf() - t0;
        if (got != 0) _sell(got);
        assertLe(quote.balanceOfSelf(), q0, "round trip profited");
        assertEq(token.balanceOfSelf(), t0);
        _assertClaimsMatchReserves();
    }

    function testFuzz_sequence_kNeverDecreases(uint256 seed) public {
        _ready();
        uint256 k = _k();
        for (uint256 i; i < 12; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            (,, uint128 q, bool grad) = _curve();
            if (grad) break;
            if (seed % 3 != 0 || q == 0) {
                _buy(bound(seed >> 8, 1, 8 ether));
            } else {
                uint256 held = token.balanceOfSelf();
                uint256 sellAmt = bound(seed >> 8, 1, SUPPLY / 10);
                if (hook.quoteSell(id, sellAmt) > q || sellAmt > held) continue;
                _sell(sellAmt);
            }
            uint256 k2 = _k();
            assertGe(k2, k, "k decreased");
            k = k2;
            _assertClaimsMatchReserves();
        }
    }

    // ------------------------------------------------------------------ composition

    function test_composition_withStubFeature() public {
        uint160 flags = CURVE_FLAGS | Hooks.AFTER_INITIALIZE_FLAG;
        CountedBondingCurve c = CountedBondingCurve(
            _deployHook("BondingCurveHook.t.sol:CountedBondingCurve", abi.encode(manager), flags)
        );
        assertEq(_flags(c.getHookPermissions()), flags, "merged permissions");

        (PoolKey memory ck, PoolId cid) =
            initPool(currency0, currency1, IHooks(address(c)), 3000, SQRT_PRICE_1_1);
        assertEq(c.initsSeen(), 1, "stub afterInitialize ran");
        assertEq(c.poolAdmin(cid), address(this), "admin beforeInitialize ran");

        MockERC20(Currency.unwrap(currency0)).approve(address(c), type(uint256).max);
        c.configureCurve(ck, true, VIRTUAL_QUOTE, GRADUATION);
        c.seed(ck, SUPPLY);

        uint256 expected = c.quoteBuy(cid, 2 ether);
        uint256 t0 = currency0.balanceOfSelf();
        swap(ck, false, -2 ether, ZERO_BYTES);
        assertEq(currency0.balanceOfSelf() - t0, expected, "curve ran");
        assertEq(c.swapsSeen(), 1, "stub beforeSwap ran");
        assertEq(manager.balanceOf(address(c), currency1.toId()), 2 ether);
    }
}
