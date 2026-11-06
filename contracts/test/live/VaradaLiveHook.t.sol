// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {FeeConsolidator} from "../../src/FeeConsolidator.sol";
import {VaradaLiveHook} from "../../src/VaradaLiveHook.sol";
import {VaradaToken} from "../../src/VaradaToken.sol";
import {
    FeeConversionHook as FeeConversionHookEvents
} from "../../src/hooks/conversion/FeeConversionHook.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {ILiveDonationVault} from "../../src/interfaces/ILiveDonationVault.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {IVaradaHook} from "../../src/interfaces/IVaradaHook.sol";
import {IVaradaLiveHook} from "../../src/interfaces/IVaradaLiveHook.sol";
import {FeeScheduleLib} from "../../src/libraries/FeeScheduleLib.sol";
import {LiveBase} from "./LiveBase.sol";
import {SyncingRouter} from "./LiveMocks.sol";

contract VaradaLiveHookTest is LiveBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint96 internal constant NO_PUSH = 1_000_000e6;

    VaradaToken internal token;
    PoolKey internal liveKey;

    function setUp() public {
        _liveSetUp();
        (token, liveKey) = _launchDefault(address(quote), NO_PUSH);
        _fundTrader(trader, token);
    }

    // ------------------------------------------------------------------ helpers

    function _hookErr(bytes4 callback, bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSignature(
            "WrappedError(address,bytes4,bytes,bytes)",
            address(hook),
            callback,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    /// @dev Selector of the hook's own revert inside a WrappedError (or the raw selector).
    function _innerSelector(bytes memory ret) internal pure returns (bytes4 sel) {
        bytes4 outer;
        assembly {
            outer := mload(add(ret, 32))
        }
        if (outer != bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)"))) return outer;
        bytes memory body = new bytes(ret.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = ret[i + 4];
        }
        (,, bytes memory reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
        assembly {
            sel := mload(add(reason, 32))
        }
    }

    function _swapRaw(PoolKey memory k, bool zeroForOne, int256 amount, uint160 limit, uint256 gas)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(trader);
        (ok, ret) = address(swapRouter).call{gas: gas}(
            abi.encodeCall(
                PoolSwapTest.swap,
                (
                    k,
                    SwapParams({
                        zeroForOne: zeroForOne, amountSpecified: amount, sqrtPriceLimitX96: limit
                    }),
                    PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                    ZERO_BYTES
                )
            )
        );
    }

    function _assertFullyConverted() internal view {
        assertEq(_claims(address(hook), address(quote)), 0, "hook holds no claims");
        assertEq(hook.totalHeld(Currency.wrap(address(quote))), 0, "nothing held");
        assertEq(
            usdc.balanceOf(address(vault)),
            vault.platformAccrued() + vault.totalPending(),
            "vault backed exactly"
        );
    }

    // ------------------------------------------------------------------ deployment

    function test_permissionsAndAddress() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize && p.beforeSwap && p.afterSwap);
        assertTrue(p.beforeSwapReturnDelta && p.afterSwapReturnDelta);
        assertFalse(p.afterInitialize || p.beforeAddLiquidity || p.afterDonate);
        assertTrue(p.beforeDonate, "donations refused");
        assertEq(uint160(address(hook)) & uint160((1 << 14) - 1), LIVE_FLAGS);
        assertEq(hook.vault(), address(vault));
        assertEq(hook.usdc(), address(usdc));
        assertEq(address(hook.quoteRegistry()), address(registry));
        assertTrue(manager.isOperator(address(hook), address(cons)));
        assertEq(
            hook.LIVE_GAS_REQUIRED(),
            hook.PRE_TRY_GAS() + (hook.INLINE_GAS_BUDGET() * 64) / 63 + hook.FALLBACK_RESERVE()
        );
    }

    function test_constructor_rejectsSettlementMismatch() public {
        // A vault whose USDC differs from the consolidator's settlement asset.
        address fakeVault = makeAddr("fakeVault");
        vm.mockCall(fakeVault, abi.encodeWithSignature("usdc()"), abi.encode(address(quote)));
        vm.expectRevert(IVaradaLiveHook.SettlementMismatch.selector);
        new VaradaLiveHook(
            manager,
            address(this),
            IFeeConsolidator(address(cons)),
            IRotationGovernor(address(rgov)),
            ILiveDonationVault(fakeVault)
        );
    }

    function test_constructor_rejectsZeroAddress() public {
        vm.expectRevert(IVaradaLiveHook.ZeroAddress.selector);
        new VaradaLiveHook(
            manager,
            address(0),
            IFeeConsolidator(address(cons)),
            IRotationGovernor(address(rgov)),
            ILiveDonationVault(address(vault))
        );
    }

    // ------------------------------------------------------------------ configuration

    function test_configureToken_selectorEqualsWeeklyHook() public pure {
        assertEq(IVaradaLiveHook.configureToken.selector, IVaradaHook.configureToken.selector);
    }

    function test_configureToken_storesAndDefaultsLaunch() public {
        address t = makeAddr("t");
        vm.expectEmit(address(hook));
        emit IVaradaLiveHook.TokenConfigured(t, 250, 4000, 600, uint40(block.timestamp));
        hook.configureToken(t, IVaradaLiveHook.LiveFeeConfig(250, 4000, 600, 0));
        IVaradaLiveHook.LiveFeeConfig memory c = hook.feeConfig(t);
        assertEq(c.baseFeeBps, 250);
        assertEq(c.launchSurchargeBps, 4000);
        assertEq(c.surchargeDecaySeconds, 600);
        assertEq(c.launchTimestamp, block.timestamp);
        assertTrue(hook.configured(t));
        assertFalse(hook.poolInitialized(t));
        assertEq(hook.currentFeeBps(t), 4250);
    }

    function test_configureToken_factoryOnlyAndOnce() public {
        address t = makeAddr("t");
        vm.prank(trader);
        vm.expectRevert(IVaradaLiveHook.NotFactory.selector);
        hook.configureToken(t, IVaradaLiveHook.LiveFeeConfig(300, 0, 0, 0));
        hook.configureToken(t, IVaradaLiveHook.LiveFeeConfig(300, 0, 0, 0));
        vm.expectRevert(abi.encodeWithSelector(IVaradaLiveHook.AlreadyConfigured.selector, t));
        hook.configureToken(t, IVaradaLiveHook.LiveFeeConfig(300, 0, 0, 0));
    }

    function test_configureToken_validatesBounds() public {
        address t = makeAddr("t");
        vm.expectRevert(abi.encodeWithSelector(FeeScheduleLib.InvalidFee.selector, 99));
        hook.configureToken(t, IVaradaLiveHook.LiveFeeConfig(99, 0, 0, 0));
        vm.expectRevert(abi.encodeWithSelector(FeeScheduleLib.InvalidFee.selector, 501));
        hook.configureToken(t, IVaradaLiveHook.LiveFeeConfig(501, 0, 0, 0));
        vm.expectRevert(
            abi.encodeWithSelector(FeeScheduleLib.InvalidLaunchSurcharge.selector, 8001, 60)
        );
        hook.configureToken(t, IVaradaLiveHook.LiveFeeConfig(300, 8001, 60, 0));
        vm.expectRevert(
            abi.encodeWithSelector(FeeScheduleLib.InvalidLaunchSurcharge.selector, 100, 0)
        );
        hook.configureToken(t, IVaradaLiveHook.LiveFeeConfig(300, 100, 0, 0));
        vm.expectRevert(
            abi.encodeWithSelector(FeeScheduleLib.InvalidLaunchSurcharge.selector, 100, 86_401)
        );
        hook.configureToken(t, IVaradaLiveHook.LiveFeeConfig(300, 100, 86_401, 0));
    }

    function test_currentFeeBps_revertsForUnknownToken() public {
        address t = makeAddr("t");
        vm.expectRevert(abi.encodeWithSelector(IVaradaLiveHook.TokenNotConfigured.selector, t));
        hook.currentFeeBps(t);
    }

    // ------------------------------------------------------------------ beforeInitialize

    function test_beforeInitialize_recordsPool() public view {
        assertTrue(hook.poolInitialized(address(token)));
        assertEq(hook.quoteOf(address(token)), address(quote));
    }

    function _freshConfigured() internal returns (VaradaToken t) {
        t = new VaradaToken("X", "X", "ipfs://x", creator, address(this));
        hook.configureToken(address(t), IVaradaLiveHook.LiveFeeConfig(BASE_BPS, 0, 0, 0));
    }

    function _keyFor(address t, address q, uint24 fee, int24 spacing)
        internal
        view
        returns (PoolKey memory k)
    {
        (Currency c0, Currency c1) = _sorted(t, q);
        k = PoolKey(c0, c1, fee, spacing, IHooks(address(hook)));
    }

    function test_beforeInitialize_rejectsSecondPool() public {
        PoolKey memory k2 =
            _keyFor(address(token), address(quote), LPFeeLibrary.DYNAMIC_FEE_FLAG, 120);
        vm.expectRevert(
            _hookErr(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IVaradaLiveHook.InvalidPool.selector)
            )
        );
        manager.initialize(k2, TickMath.getSqrtPriceAtTick(0));
    }

    function test_beforeInitialize_rejectsStaticFee() public {
        VaradaToken t = _freshConfigured();
        vault.registerToken(address(t), 0, CAUSE_A, RotationPeriod.OneHour);
        PoolKey memory k2 = _keyFor(address(t), address(quote), 3000, 60);
        vm.expectRevert(
            _hookErr(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IVaradaLiveHook.InvalidPool.selector)
            )
        );
        manager.initialize(k2, TickMath.getSqrtPriceAtTick(0));
    }

    function test_beforeInitialize_rejectsNonFactorySender() public {
        VaradaToken t = _freshConfigured();
        vault.registerToken(address(t), 0, CAUSE_A, RotationPeriod.OneHour);
        PoolKey memory k2 = _keyFor(address(t), address(quote), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60);
        vm.prank(trader);
        vm.expectRevert(
            _hookErr(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IVaradaLiveHook.InvalidPool.selector)
            )
        );
        manager.initialize(k2, TickMath.getSqrtPriceAtTick(0));
    }

    function test_beforeInitialize_rejectsUsdcQuote() public {
        VaradaToken t = _freshConfigured();
        vault.registerToken(address(t), 0, CAUSE_A, RotationPeriod.OneHour);
        PoolKey memory k2 = _keyFor(address(t), address(usdc), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60);
        vm.expectRevert(
            _hookErr(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IVaradaLiveHook.QuoteNotRoutable.selector, address(usdc))
            )
        );
        manager.initialize(k2, TickMath.getSqrtPriceAtTick(0));
    }

    function test_beforeInitialize_rejectsUnroutableQuote() public {
        VaradaToken t = _freshConfigured();
        vault.registerToken(address(t), 0, CAUSE_A, RotationPeriod.OneHour);
        address other = address(new VaradaToken("Q", "Q", "", creator, address(this)));
        PoolKey memory k2 = _keyFor(address(t), other, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60);
        vm.expectRevert(
            _hookErr(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IVaradaLiveHook.QuoteNotRoutable.selector, other)
            )
        );
        manager.initialize(k2, TickMath.getSqrtPriceAtTick(0));
    }

    function test_beforeInitialize_rejectsUnregisteredToken() public {
        VaradaToken t = _freshConfigured();
        PoolKey memory k2 = _keyFor(address(t), address(quote), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60);
        vm.expectRevert(
            _hookErr(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IVaradaLiveHook.TokenNotRegistered.selector, address(t))
            )
        );
        manager.initialize(k2, TickMath.getSqrtPriceAtTick(0));
    }

    function test_beforeInitialize_rejectsUnconfiguredPair() public {
        PoolKey memory k2 =
            _keyFor(address(quote), address(ondoB), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60);
        vm.expectRevert(
            _hookErr(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IVaradaLiveHook.InvalidPool.selector)
            )
        );
        manager.initialize(k2, TickMath.getSqrtPriceAtTick(0));
    }

    // ------------------------------------------------------------------ fee model

    function test_exactInBuy_feeOutOfInput() public {
        uint256 a = 1e18;
        uint256 f = FeeScheduleLib.feeOnGross(a, BASE_BPS);
        vm.recordLogs();
        BalanceDelta d = _buyExactIn(liveKey, address(token), a);
        (bool found, bytes32 cause, uint64 rot, uint256 q, uint256 out, bool conv, bytes4 fail) =
            _lastFeeTaken(vm.getRecordedLogs());
        assertTrue(found && conv);
        assertEq(fail, bytes4(0));
        assertEq(cause, CAUSE_A);
        assertEq(rot, 0);
        assertEq(q, f, "fee on gross input");
        int128 quoteDelta = _quoteIs0(liveKey, address(token)) ? d.amount0() : d.amount1();
        assertEq(quoteDelta, -int128(int256(a)), "trader pays exactly A");
        assertGt(out, 0);
        _assertFullyConverted();
        (uint256 pending,) = vault.pendingOf(address(token), CAUSE_A);
        assertEq(pending, out - (out * 1000) / 10_000);
    }

    function test_exactOutSell_feeOnTopOfOutput() public {
        uint256 a = 1e17;
        uint256 f = FeeScheduleLib.feeGrossUp(a, BASE_BPS);
        vm.recordLogs();
        BalanceDelta d = _sellExactOut(liveKey, address(token), a);
        (,,, uint256 q,, bool conv,) = _lastFeeTaken(vm.getRecordedLogs());
        assertTrue(conv);
        assertEq(q, f);
        int128 quoteDelta = _quoteIs0(liveKey, address(token)) ? d.amount0() : d.amount1();
        assertEq(quoteDelta, int128(int256(a)), "trader receives exactly A");
        assertEq(f, FeeScheduleLib.feeOnGross(a + f, BASE_BPS), "fee is b of the gross output");
        _assertFullyConverted();
    }

    function test_exactInSell_feeOutOfOutput() public {
        vm.recordLogs();
        BalanceDelta d = _sellExactIn(liveKey, address(token), 1e20);
        (,,, uint256 q,, bool conv,) = _lastFeeTaken(vm.getRecordedLogs());
        assertTrue(conv);
        int128 quoteDelta = _quoteIs0(liveKey, address(token)) ? d.amount0() : d.amount1();
        uint256 received = uint256(uint128(quoteDelta));
        assertEq(q, FeeScheduleLib.feeOnGross(received + q, BASE_BPS), "fee is b of gross output");
        _assertFullyConverted();
    }

    function test_exactOutBuy_feeOnTopOfInput() public {
        vm.recordLogs();
        BalanceDelta d = _buyExactOut(liveKey, address(token), 1e20);
        (,,, uint256 q,, bool conv,) = _lastFeeTaken(vm.getRecordedLogs());
        assertTrue(conv);
        int128 quoteDelta = _quoteIs0(liveKey, address(token)) ? d.amount0() : d.amount1();
        uint256 paid = uint256(uint128(-quoteDelta));
        assertEq(q, FeeScheduleLib.feeGrossUp(paid - q, BASE_BPS), "gross-up of pool input");
        assertEq(q, FeeScheduleLib.feeOnGross(paid, BASE_BPS), "b of the gross input");
        int128 tokenDelta = _quoteIs0(liveKey, address(token)) ? d.amount1() : d.amount0();
        assertEq(tokenDelta, int128(1e20), "trader receives exactly the token amount");
        _assertFullyConverted();
    }

    function test_lpFeeIsZero_positionAccruesNothing() public {
        _buyExactIn(liveKey, address(token), 1e18);
        _sellExactIn(liveKey, address(token), 1e20);
        _buyExactOut(liveKey, address(token), 1e20);
        _sellExactOut(liveKey, address(token), 1e16);
        (uint256 g0, uint256 g1) = manager.getFeeGrowthGlobals(liveKey.toId());
        assertEq(g0, 0);
        assertEq(g1, 0);
    }

    function test_launchSurcharge_decaysInFee() public {
        (VaradaToken t2, PoolKey memory k2) =
            _launch(address(quote), NO_PUSH, RotationPeriod.OneHour, 6000, 1000);
        _fundTrader(trader, t2);
        assertEq(hook.currentFeeBps(address(t2)), 6300);
        vm.warp(block.timestamp + 500);
        uint256 b = hook.currentFeeBps(address(t2));
        assertEq(b, 300 + 3000);
        vm.recordLogs();
        _buyExactIn(k2, address(t2), 1e18);
        (,,, uint256 q,,,) = _lastFeeTaken(vm.getRecordedLogs());
        assertEq(q, FeeScheduleLib.feeOnGross(1e18, b));
        vm.warp(block.timestamp + 500);
        assertEq(hook.currentFeeBps(address(t2)), 300);
    }

    function test_maxSurcharge_exactOutStillWorks() public {
        (VaradaToken t2, PoolKey memory k2) =
            _launch(address(quote), NO_PUSH, RotationPeriod.OneHour, 8000, 3600);
        _fundTrader(trader, t2);
        assertEq(hook.currentFeeBps(address(t2)), 8300);
        vm.recordLogs();
        BalanceDelta d = _sellExactOut(k2, address(t2), 1e16);
        (,,, uint256 q,,,) = _lastFeeTaken(vm.getRecordedLogs());
        assertEq(q, FeeScheduleLib.feeGrossUp(1e16, 8300));
        int128 quoteDelta = _quoteIs0(k2, address(t2)) ? d.amount0() : d.amount1();
        assertEq(quoteDelta, int128(1e16));
    }

    function test_dustExactInBuy_feeZeroWhenItWouldTakeAll() public {
        vm.recordLogs();
        _buyExactIn(liveKey, address(token), 1);
        (bool found,,,,,,) = _lastFeeTaken(vm.getRecordedLogs());
        assertFalse(found, "no fee event when f == 0");
        assertEq(_claims(address(hook), address(quote)), 0);
    }

    function test_partialFillReverts() public {
        // Exact-in buy limited just past the current price: the pool fills only part.
        bool zeroForOne = _quoteIs0(liveKey, address(token));
        (uint160 sqrtP,,,) = manager.getSlot0(liveKey.toId());
        uint160 limit = zeroForOne ? sqrtP - sqrtP / 10_000 : sqrtP + sqrtP / 10_000;
        (bool ok, bytes memory ret) = _swapRaw(liveKey, zeroForOne, -1e24, limit, 30_000_000);
        assertFalse(ok);
        assertEq(_innerSelector(ret), IVaradaLiveHook.PartialFillNotSupported.selector);
    }

    function test_insufficientGas_reverts_belowRequirement() public {
        bool zeroForOne = _quoteIs0(liveKey, address(token));
        uint160 limit = zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT;
        (bool ok, bytes memory ret) = _swapRaw(liveKey, zeroForOne, -1e18, limit, 700_000);
        assertFalse(ok);
        assertEq(_innerSelector(ret), IVaradaLiveHook.InsufficientGas.selector);
    }

    function test_insufficientGas_boundary() public {
        bool zeroForOne = _quoteIs0(liveKey, address(token));
        uint160 limit = zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT;
        // Smallest gas limit that passes, by bisection.
        uint256 lo = 700_000;
        uint256 hi = 3_000_000;
        uint256 snap = vm.snapshotState();
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,) = _swapRaw(liveKey, zeroForOne, -1e18, limit, mid);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        (bool okLo, bytes memory retLo) = _swapRaw(liveKey, zeroForOne, -1e18, limit, lo);
        assertFalse(okLo);
        assertEq(_innerSelector(retLo), IVaradaLiveHook.InsufficientGas.selector, "just below");
        vm.revertToState(snap);
        (bool okHi,) = _swapRaw(liveKey, zeroForOne, -1e18, limit, hi);
        assertTrue(okHi, "just above");
        emit log_named_uint("minimum trader gas limit (1-hop, converted)", hi);
    }

    function test_syncedCurrency_holdsInsteadOfConverting() public {
        SyncingRouter router = new SyncingRouter(manager);
        vm.prank(trader);
        quote.approve(address(router), type(uint256).max);
        bool zeroForOne = _quoteIs0(liveKey, address(token));
        vm.recordLogs();
        vm.prank(trader);
        router.swap(
            liveKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -1e18,
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            Currency.wrap(address(usdc))
        );
        (, bytes32 cause,, uint256 q,, bool conv, bytes4 fail) = _lastFeeTaken(vm.getRecordedLogs());
        assertFalse(conv);
        assertEq(fail, hook.SYNCED_CURRENCY_PENDING());
        assertEq(hook.heldRaw(address(token), cause), q);
        assertEq(_claims(address(hook), address(quote)), q);
    }

    function test_swapReentered_onNestedLivePoolSwap() public {
        // A live-pool swap made while the hook is mid-swap (lock set) reverts.
        // Two beforeSwap calls without the afterSwap in between: the transient lock is still set.
        SwapParams memory p = SwapParams({
            zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });
        vm.startPrank(address(manager));
        hook.beforeSwap(address(this), liveKey, p, "");
        vm.expectRevert(IVaradaLiveHook.SwapReentered.selector);
        hook.beforeSwap(address(this), liveKey, p, "");
        vm.stopPrank();
    }

    function test_callbacks_onlyPoolManager() public {
        SwapParams memory p = SwapParams({
            zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });
        vm.expectRevert(IVaradaLiveHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), liveKey, p, "");
        vm.expectRevert(IVaradaLiveHook.NotPoolManager.selector);
        hook.afterSwap(address(this), liveKey, p, BalanceDelta.wrap(0), "");
        vm.expectRevert(IVaradaLiveHook.NotPoolManager.selector);
        hook.beforeInitialize(address(this), liveKey, 1);
    }

    function test_inlineConvert_onlySelf() public {
        vm.expectRevert(IVaradaLiveHook.NotSelf.selector);
        hook.inlineConvert(address(token), CAUSE_A, 0, address(quote), 1);
    }

    function test_unlockCallback_requiresRetryLock() public {
        vm.prank(address(manager));
        vm.expectRevert(IVaradaLiveHook.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(address(token), CAUSE_A, address(quote), uint256(1)));
        vm.expectRevert(IVaradaLiveHook.NotPoolManager.selector);
        hook.unlockCallback("");
    }

    function test_unusedCallbacks_revert() public {
        // Every callback is pool-manager only (BaseHook), including the unused ones.
        vm.expectRevert(IVaradaLiveHook.NotPoolManager.selector);
        hook.afterInitialize(address(0), liveKey, 0, 0);
        vm.expectRevert(IVaradaLiveHook.NotPoolManager.selector);
        hook.beforeDonate(address(0), liveKey, 0, 0, "");
        vm.startPrank(address(manager));
        vm.expectRevert(IVaradaLiveHook.HookNotImplemented.selector);
        hook.afterInitialize(address(0), liveKey, 0, 0);
        vm.expectRevert(IVaradaLiveHook.DonateNotAllowed.selector);
        hook.beforeDonate(address(0), liveKey, 0, 0, "");
        vm.stopPrank();
    }

    /// @dev Audit regression: `PoolManager.donate` to a live pool used to accrue fee growth to
    ///      the locked position, which the LP locker can never collect for a live token (its
    ///      forward to the consolidator reverts `UnknownToken`), locking the donation for good.
    ///      The hook now refuses every donation.
    function test_donate_toLivePool_reverts() public {
        // Move price into the locked range first (any buy does), as the scenario requires.
        _buyExactIn(liveKey, address(token), 1e18);
        IERC20(address(quote)).approve(address(donateRouter), type(uint256).max);
        IERC20(address(token)).approve(address(donateRouter), type(uint256).max);
        bool quoteIs0 = _quoteIs0(liveKey, address(token));
        uint256 a0 = quoteIs0 ? 1e18 : 0;
        uint256 a1 = quoteIs0 ? 0 : 1e18;
        vm.expectRevert(
            _hookErr(
                IHooks.beforeDonate.selector,
                abi.encodeWithSelector(IVaradaLiveHook.DonateNotAllowed.selector)
            )
        );
        donateRouter.donate(liveKey, a0, a1, "");
    }

    // ------------------------------------------------------------------ holds and retries

    /// @dev Takes one fee while the consolidator refuses the hook, so it is held.
    function _holdOne(uint256 quoteIn) internal returns (uint256 f) {
        cons.setSource(address(hook), false);
        vm.recordLogs();
        _buyExactIn(liveKey, address(token), quoteIn);
        bool conv;
        bytes4 fail;
        (,,, f,, conv, fail) = _lastFeeTaken(vm.getRecordedLogs());
        assertFalse(conv);
        assertEq(fail, IFeeConsolidator.NotAuthorized.selector);
        cons.setSource(address(hook), true);
    }

    function test_heldFee_attributedAndBacked() public {
        uint256 f = _holdOne(1e18);
        assertEq(hook.heldRaw(address(token), CAUSE_A), f);
        assertEq(hook.totalHeld(Currency.wrap(address(quote))), f);
        assertEq(_claims(address(hook), address(quote)), f, "H1: claims back the hold");
    }

    function test_retryHeld_full() public {
        uint256 f = _holdOne(1e18);
        vm.recordLogs();
        uint256 out = hook.retryHeld(address(token), CAUSE_A, f);
        assertGt(out, 0);
        assertEq(hook.heldRaw(address(token), CAUSE_A), 0);
        assertEq(_claims(address(hook), address(quote)), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, ILiveDonationVault.Credited.selector), 1);
        (uint256 pending,) = vault.pendingOf(address(token), CAUSE_A);
        assertEq(pending, out - (out * 1000) / 10_000);
    }

    function test_retryHeld_partialAndBounds() public {
        uint256 f = _holdOne(1e18);
        hook.retryHeld(address(token), CAUSE_A, f / 3);
        assertEq(hook.heldRaw(address(token), CAUSE_A), f - f / 3);
        assertEq(_claims(address(hook), address(quote)), f - f / 3);
        vm.expectRevert(
            abi.encodeWithSelector(IVaradaLiveHook.AmountExceedsHeld.selector, f, f - f / 3)
        );
        hook.retryHeld(address(token), CAUSE_A, f);
        vm.expectRevert(IVaradaLiveHook.NothingHeld.selector);
        hook.retryHeld(address(token), CAUSE_A, 0);
    }

    function test_retryHeld_failureRevertsWithRouteReason() public {
        uint256 f = _holdOne(1e18);
        cons.setMaxDeviationTicks(0);
        // Push spot away from the reference so the guard trips.
        _swapAs(
            address(this),
            quoteUsdcKey,
            Currency.unwrap(quoteUsdcKey.currency0) != address(usdc),
            -1e21
        );
        vm.expectPartialRevert(FeeConsolidator.PriceDeviation.selector);
        hook.retryHeld(address(token), CAUSE_A, f);
        assertEq(hook.heldRaw(address(token), CAUSE_A), f, "unchanged");
    }

    function test_retryHeld_creditsOriginalCauseAfterRotation() public {
        uint256 f = _holdOne(1e18);
        // Rotate to cause C through a vote.
        _rotateTo(address(token), CAUSE_C);
        (bytes32 nowCause,) = rgov.activeCause(address(token));
        assertEq(nowCause, CAUSE_C);
        hook.retryHeld(address(token), CAUSE_A, f);
        (uint256 pendingA,) = vault.pendingOf(address(token), CAUSE_A);
        (uint256 pendingC,) = vault.pendingOf(address(token), CAUSE_C);
        assertGt(pendingA, 0);
        assertEq(pendingC, 0);
    }

    function test_retryHeld_rejectsInsideUnlock() public {
        uint256 f = _holdOne(1e18);
        // A retry from inside another unlock is refused.
        RetryFromUnlock r = new RetryFromUnlock(manager, hook);
        vm.expectRevert(IVaradaLiveHook.PoolManagerBusy.selector);
        r.run(address(token), CAUSE_A, f);
    }

    // ------------------------------------------------------------------ composition

    function _bucket(address t, bytes32 cause) internal pure returns (bytes32) {
        return keccak256(abi.encode(t, cause));
    }

    /// @dev The bundled hook's ABI is served unchanged through `IVaradaLiveHook`, including
    ///      `totalHeld(address)`, which is `FeeConversionHook.totalHeld(Currency)`.
    function test_composition_interfaceAbi() public {
        uint256 f = _holdOne(1e18);
        IVaradaLiveHook i = IVaradaLiveHook(address(hook));
        assertEq(i.totalHeld(address(quote)), f);
        assertEq(i.heldRaw(address(token), CAUSE_A), f);
        assertEq(i.quoteOf(address(token)), address(quote));
        assertTrue(i.configured(address(token)));
        assertTrue(i.poolInitialized(address(token)));
        assertEq(i.vault(), address(vault));
        assertEq(i.currentFeeBps(address(token)), hook.currentFeeBps(address(token)));
        assertEq(i.feeConfig(address(token)).baseFeeBps, BASE_BPS);
        assertGt(i.retryHeld(address(token), CAUSE_A, f), 0);
        assertEq(i.totalHeld(address(quote)), 0);
    }

    /// @dev Generic views agree with the Varada views: the bucket of a hold is
    ///      `keccak256(token, cause)`, the target is USDC and the gas requirement is the live one.
    function test_composition_genericViews() public {
        uint256 f = _holdOne(1e18);
        assertEq(hook.heldFees(_bucket(address(token), CAUSE_A), Currency.wrap(address(quote))), f);
        assertEq(Currency.unwrap(hook.conversionTarget()), address(usdc));
        assertEq(hook.conversionGasRequired(), hook.LIVE_GAS_REQUIRED() - hook.PRE_TRY_GAS());
        assertEq(
            hook.conversionRoute(Currency.wrap(address(quote))).length, 0, "routes: consolidator"
        );
        assertFalse(hook.isPoolInitializer(address(this)), "gate rule is factory-only");
    }

    /// @dev A hold reports the generic `FeeHeld` and the Varada `FeeTaken` with the same reason.
    function test_composition_holdEmitsBothEvents() public {
        cons.setSource(address(hook), false);
        vm.recordLogs();
        _buyExactIn(liveKey, address(token), 1e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, FeeConversionHookEvents.FeeHeld.selector), 1);
        (,,, uint256 f,, bool conv, bytes4 fail) = _lastFeeTaken(logs);
        assertFalse(conv);
        assertEq(fail, IFeeConsolidator.NotAuthorized.selector);
        assertEq(hook.heldRaw(address(token), CAUSE_A), f);
    }

    /// @dev The bucket-keyed retry of `FeeConversionHook` carries no Varada context (token,
    ///      cause), so it reverts and the hold is unchanged. Retries go through
    ///      `retryHeld(token, causeId, amount)`.
    function test_composition_bucketRetryReverts() public {
        uint256 f = _holdOne(1e18);
        bytes32 bucket = _bucket(address(token), CAUSE_A);
        vm.expectRevert(IVaradaLiveHook.NotPoolManager.selector);
        hook.retryHeld(bucket, Currency.wrap(address(quote)), f);
        assertEq(hook.heldRaw(address(token), CAUSE_A), f, "unchanged");
        assertEq(_claims(address(hook), address(quote)), f);
    }

    function test_composition_convertInline_onlySelf() public {
        vm.expectRevert(IVaradaLiveHook.NotSelf.selector);
        hook.convertInline(bytes32(0), Currency.wrap(address(quote)), 1);
    }

    /// @dev Retry inside a swap of this hook (lock held) reverts `Busy`.
    function test_composition_retryDuringSwapLockIsBusy() public {
        uint256 f = _holdOne(1e18);
        SwapParams memory p = SwapParams({
            zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });
        vm.prank(address(manager));
        hook.beforeSwap(address(this), liveKey, p, "");
        vm.expectRevert(IVaradaLiveHook.Busy.selector);
        hook.retryHeld(address(token), CAUSE_A, f);
    }

    /// @dev Votes cause `target` in for the next rotation, then warps into it.
    function _rotateTo(address t, bytes32 target) internal {
        // Vote in the first rotation whose hold window starts after launch (the trader holds
        // from launch).
        uint256 s0 = rgov.rotationStart(t, 0);
        uint256 len = rgov.rotationStart(t, 1) - s0;
        uint256 lookback = len < 1 days ? 1 days : len;
        uint64 c = 1;
        while (rgov.rotationStart(t, c) < s0 + lookback + 1) ++c;
        vm.warp(rgov.rotationStart(t, c) + 1);
        uint64 tgt = _ensureRound(t);
        uint8 choice = target == CAUSE_A ? 0 : target == CAUSE_B ? 1 : 2;
        vm.prank(trader);
        scheme.castBallot(address(rgov), t, (uint256(1) << 248) | tgt, abi.encode(choice));
        (,, uint40 voteEnd,,,,) = rgov.roundOf(t, tgt);
        vm.warp(voteEnd);
        rgov.closeRound(t, tgt);
        scheme.finalizeFromBallots(address(rgov), t, (uint256(1) << 248) | tgt);
        rgov.finalizeRound(t, tgt);
        vm.warp(rgov.rotationStart(t, tgt));
    }
}

/// @dev Calls `retryHeld` while holding its own pool manager unlock.
contract RetryFromUnlock {
    IPoolManager internal immutable manager;
    VaradaLiveHook internal immutable hook;

    constructor(IPoolManager m, VaradaLiveHook h) {
        manager = m;
        hook = h;
    }

    function run(address token, bytes32 cause, uint256 amount) external {
        manager.unlock(abi.encode(token, cause, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (address token, bytes32 cause, uint256 amount) =
            abi.decode(data, (address, bytes32, uint256));
        hook.retryHeld(token, cause, amount);
        return "";
    }
}
