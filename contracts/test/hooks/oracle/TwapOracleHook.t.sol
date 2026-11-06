// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {BaseHook} from "../../../src/hooks/base/BaseHook.sol";
import {TwapOracleExample} from "../../../src/hooks/examples/TwapOracleExample.sol";
import {ITwapOracle} from "../../../src/hooks/interfaces/ITwapOracle.sol";
import {TwapOracleHook} from "../../../src/hooks/oracle/TwapOracleHook.sol";
import {HookTest} from "../utils/HookTest.sol";

// ---------------------------------------------------------------------- harnesses

/// @dev Oracle with a configurable interval and capacity, plus the rounding helper exposed.
contract OracleHarness is TwapOracleHook {
    constructor(IPoolManager m, uint32 interval, uint16 capacity)
        BaseHook(m)
        TwapOracleHook(interval, capacity)
    {}

    function floorDiv(int256 a, int256 b) external pure returns (int24) {
        return _floorDiv(a, b);
    }
}

/// @dev Skips the address check so the config check can be reached with a plain `new`.
contract UncheckedOracleHarness is TwapOracleHook {
    constructor(IPoolManager m, uint32 interval, uint16 capacity)
        BaseHook(m)
        TwapOracleHook(interval, capacity)
    {}

    function _validateHookAddress(Hooks.Permissions memory) internal view override {}
}

/// @dev Stub fee feature: asks for a 0.40% LP fee override in beforeSwap and counts its calls.
abstract contract StubFeeFeature is BaseHook {
    uint24 internal constant STUB_FEE = 4000;
    uint256 public stubFeeCalls;

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeSwap = true;
        return p;
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        virtual
        override
        returns (bytes4 sel, BeforeSwapDelta delta, uint24 fee)
    {
        (sel, delta, fee) = super._beforeSwap(s, k, sp, d);
        ++stubFeeCalls;
        fee = _mergeLpFeeOverride(fee, STUB_FEE | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}

/// @dev Oracle first, then the fee feature (rule 6 re-declarations).
contract OracleThenFee is TwapOracleHook, StubFeeFeature {
    constructor(IPoolManager m) BaseHook(m) TwapOracleHook(60, 8) {}

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(TwapOracleHook, StubFeeFeature)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _afterInitialize(address s, PoolKey calldata k, uint160 sp, int24 t)
        internal
        override(BaseHook, TwapOracleHook)
        returns (bytes4)
    {
        return super._afterInitialize(s, k, sp, t);
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        override(TwapOracleHook, StubFeeFeature)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return super._beforeSwap(s, k, sp, d);
    }
}

/// @dev Fee feature first, then the oracle.
contract FeeThenOracle is StubFeeFeature, TwapOracleHook {
    constructor(IPoolManager m) BaseHook(m) TwapOracleHook(60, 8) {}

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(StubFeeFeature, TwapOracleHook)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _afterInitialize(address s, PoolKey calldata k, uint160 sp, int24 t)
        internal
        override(BaseHook, TwapOracleHook)
        returns (bytes4)
    {
        return super._afterInitialize(s, k, sp, t);
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        override(StubFeeFeature, TwapOracleHook)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return super._beforeSwap(s, k, sp, d);
    }
}

// ---------------------------------------------------------------------- tests

contract TwapOracleHookTest is HookTest {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint160 internal constant ORACLE_FLAGS = Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG;
    uint256 internal constant T0 = 1_000_000;

    ModifyLiquidityParams internal fullRange = ModifyLiquidityParams({
        tickLower: TickMath.minUsableTick(60),
        tickUpper: TickMath.maxUsableTick(60),
        liquidityDelta: 1e24,
        salt: 0
    });

    ITwapOracle internal oracle;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        vm.warp(T0);
        oracle = ITwapOracle(
            _deployHook(
                "TwapOracleExample.sol:TwapOracleExample", abi.encode(manager), ORACLE_FLAGS
            )
        );
    }

    // ------------------------------------------------------------------ helpers

    function _pool(address hook, uint24 fee, int24 tick)
        internal
        returns (PoolKey memory k, PoolId id)
    {
        (k, id) = initPool(
            currency0, currency1, IHooks(hook), fee, TickMath.getSqrtPriceAtTick(tick)
        );
        modifyLiquidityRouter.modifyLiquidity(k, fullRange, ZERO_BYTES);
    }

    function _pool(int24 tick) internal returns (PoolKey memory k, PoolId id) {
        return _pool(address(oracle), 3000, tick);
    }

    function _tick(PoolId id) internal view returns (int24 t) {
        (, t,,) = manager.getSlot0(id);
    }

    /// @dev Swaps until the price reaches exactly `target` and returns the tick slot0 reports.
    function _swapTo(PoolKey memory k, int24 target) internal returns (int24) {
        int24 current = _tick(k.toId());
        if (current == target) return current;
        bool zeroForOne = target < current;
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -1e30,
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(target)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        return _tick(k.toId());
    }

    /// @dev Reference floor division, written differently from the hook's.
    function _refFloor(int256 a, int256 b) internal pure returns (int256) {
        if (a >= 0) return a / b;
        return -((-a + b - 1) / b);
    }

    // ------------------------------------------------------------------ permissions & config

    function test_permissions() public view {
        Hooks.Permissions memory p = BaseHook(address(oracle)).getHookPermissions();
        assertTrue(p.afterInitialize && p.beforeSwap);
        assertEq(_flags(p), ORACLE_FLAGS);
        assertEq(TwapOracleHook(address(oracle)).observationInterval(), 5 minutes);
        assertEq(TwapOracleHook(address(oracle)).observationCapacity(), 24);
    }

    function test_constructor_revertsOnWrongAddress() public {
        vm.expectRevert();
        new TwapOracleExample(manager);
    }

    function test_constructor_revertsInvalidConfig() public {
        vm.expectRevert(TwapOracleHook.InvalidOracleConfig.selector);
        new UncheckedOracleHarness(manager, 0, 24);
        vm.expectRevert(TwapOracleHook.InvalidOracleConfig.selector);
        new UncheckedOracleHarness(manager, 60, 1);
        vm.expectRevert(TwapOracleHook.InvalidOracleConfig.selector);
        new UncheckedOracleHarness(manager, 60, 0);
        UncheckedOracleHarness ok = new UncheckedOracleHarness(manager, 1, 2);
        assertEq(ok.observationCapacity(), 2);
    }

    function test_callbacks_onlyPoolManager() public {
        PoolKey memory k;
        SwapParams memory sp;
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        BaseHook(address(oracle)).beforeSwap(address(this), k, sp, "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        BaseHook(address(oracle)).afterInitialize(address(this), k, 0, 0);
    }

    function test_unusedCallbacks_notImplemented() public {
        PoolKey memory k;
        SwapParams memory sp;
        vm.prank(address(manager));
        vm.expectRevert(BaseHook.HookNotImplemented.selector);
        BaseHook(address(oracle)).afterSwap(address(this), k, sp, toBalanceDelta(0, 0), "");
    }

    // ------------------------------------------------------------------ seeding

    function test_afterInitialize_seedsCheckpoint() public {
        (, PoolId id) = _pool(-1234);
        assertEq(oracle.observationCount(id), 1);
        (uint40 ts, int56 cum) = oracle.observation(id, 0);
        assertEq(ts, T0);
        assertEq(cum, 0);
        (ts, cum) = oracle.observation(id, 1);
        assertEq(ts, 0);
        assertEq(cum, 0);
    }

    function test_constantTick_noSwaps() public {
        (, PoolId id) = _pool(-1234);
        vm.warp(T0 + 600);
        (bool ok, int24 avg, uint32 span) = oracle.twapTick(id, 300);
        assertTrue(ok);
        assertEq(avg, -1234);
        assertEq(span, 600);
    }

    // ------------------------------------------------------------------ math

    /// @dev Ticks 500 (100s), -250 (250s), -1000 (60s), 42 (333s); checkpoint at T0+350.
    function test_handComputedAverage() public {
        (PoolKey memory k, PoolId id) = _pool(500);
        assertEq(_tick(id), 500);

        vm.warp(T0 + 100);
        assertEq(_swapTo(k, -250), -250);
        assertEq(oracle.observationCount(id), 1); // 100s < 5 minutes: no checkpoint

        vm.warp(T0 + 350);
        assertEq(_swapTo(k, -1000), -1000);
        assertEq(oracle.observationCount(id), 2);
        (uint40 ts, int56 cum) = oracle.observation(id, 1);
        assertEq(ts, T0 + 350);
        assertEq(cum, 500 * 100 - 250 * 250); // -12_500

        vm.warp(T0 + 410);
        assertEq(_swapTo(k, 42), 42);
        assertEq(oracle.observationCount(id), 2); // 60s since the last checkpoint

        vm.warp(T0 + 743);
        // cumNow = -12_500 - 1000 * 60 + 42 * 333 = -58_514

        (bool ok, int24 avg, uint32 span) = oracle.twapTick(id, 700);
        assertTrue(ok);
        assertEq(span, 743);
        assertEq(avg, -79); // -58_514 / 743 = -78.75 -> -79

        (ok, avg, span) = oracle.twapTick(id, 393);
        assertTrue(ok);
        assertEq(span, 393);
        assertEq(avg, -118); // -46_014 / 393 = -117.08 -> -118

        (ok, avg, span) = oracle.twapTick(id, 50);
        assertTrue(ok);
        assertEq(span, 393); // newest checkpoint at least 50s old is still T0+350

        (ok,,) = oracle.twapTick(id, 744);
        assertFalse(ok);
    }

    function test_roundsTowardNegativeInfinity() public {
        (PoolKey memory k, PoolId id) = _pool(13);
        vm.warp(T0 + 1);
        assertEq(_swapTo(k, -7), -7);
        vm.warp(T0 + 3);
        // (13 * 1 - 7 * 2) / 3 = -1/3 -> -1 (truncation would give 0)
        (bool ok, int24 avg, uint32 span) = oracle.twapTick(id, 3);
        assertTrue(ok);
        assertEq(span, 3);
        assertEq(avg, -1);

        // a positive average truncates down too: (-7 * 1 + 13 * 2) / 3 = 6.33 -> 6
        (k, id) = _pool(address(oracle), 500, -7);
        vm.warp(T0 + 4);
        assertEq(_swapTo(k, 13), 13);
        vm.warp(T0 + 6);
        (ok, avg,) = oracle.twapTick(id, 3);
        assertTrue(ok);
        assertEq(avg, 6);
    }

    function testFuzz_floorDiv(int256 a, uint256 b) public {
        OracleHarness h = OracleHarness(
            _deployHook(
                "TwapOracleHook.t.sol:OracleHarness", abi.encode(manager, 60, 4), ORACLE_FLAGS
            )
        );
        b = bound(b, 1, type(uint40).max);
        // numerators the hook can produce: |tick| * elapsed
        a = bound(a, -int256(uint256(887_272) * b), int256(uint256(887_272) * b));
        assertEq(int256(h.floorDiv(a, int256(b))), _refFloor(a, int256(b)));
    }

    function testFuzz_twoPeriodAverage(int24 t0, int24 t1, uint32 dt0, uint32 dt1) public {
        t0 = int24(bound(t0, -50_000, 50_000));
        t1 = int24(bound(t1, -50_000, 50_000));
        dt0 = uint32(bound(dt0, 1, 30 days));
        dt1 = uint32(bound(dt1, 1, 30 days));

        (PoolKey memory k, PoolId id) = _pool(t0);
        int24 start = _tick(id);
        vm.warp(T0 + dt0);
        int24 held = _swapTo(k, t1);
        vm.warp(T0 + uint256(dt0) + dt1);

        uint32 total = dt0 + dt1;
        (bool ok, int24 avg, uint32 span) = oracle.twapTick(id, total);
        assertTrue(ok);
        assertEq(span, total);
        int256 num = int256(start) * int256(uint256(dt0)) + int256(held) * int256(uint256(dt1));
        assertEq(int256(avg), _refFloor(num, int256(uint256(total))));
        assertGe(avg, start < held ? start : held);
        assertLe(avg, start < held ? held : start);
    }

    // ------------------------------------------------------------------ manipulation

    function test_sameBlockSwapsDoNotMoveAverage() public {
        (PoolKey memory k, PoolId id) = _pool(-600);
        vm.warp(T0 + 900);
        (bool ok, int24 before, uint32 span) = oracle.twapTick(id, 900);
        assertTrue(ok);
        assertEq(before, -600);
        assertEq(span, 900);

        _swapTo(k, 40_000);
        _swapTo(k, -40_000);
        _swapTo(k, 25_000);
        (bool ok2, int24 afterSwaps, uint32 span2) = oracle.twapTick(id, 900);
        assertTrue(ok2);
        assertEq(afterSwaps, before);
        assertEq(span2, span);

        // one block later the manipulated tick weighs 1 second of 901
        vm.warp(T0 + 901);
        (, int24 later,) = oracle.twapTick(id, 900);
        assertEq(int256(later), _refFloor(int256(-600) * 900 + 25_000, 901));
    }

    // ------------------------------------------------------------------ ring buffer

    function test_ringBufferWraps() public {
        OracleHarness h = OracleHarness(
            _deployHook(
                "TwapOracleHook.t.sol:OracleHarness", abi.encode(manager, 10, 3), ORACLE_FLAGS
            )
        );
        (PoolKey memory k, PoolId id) = _pool(address(h), 3000, 0);

        int24[5] memory ticks = [int24(-100), int24(200), int24(-300), int24(400), int24(-500)];
        // swaps every 5s: a checkpoint lands only every 10s
        for (uint256 i; i < 10; ++i) {
            vm.warp(T0 + 5 * (i + 1));
            _swapTo(k, ticks[i % 5]);
        }
        // checkpoints at T0, +10, +20, +30, +40, +50; the last 3 are kept
        assertEq(h.observationCount(id), 3);
        (uint40 ts0,) = h.observation(id, 0);
        (uint40 ts1,) = h.observation(id, 1);
        (uint40 ts2, int56 cum2) = h.observation(id, 2);
        assertEq(ts0, T0 + 30);
        assertEq(ts1, T0 + 40);
        assertEq(ts2, T0 + 50);
        (uint40 ts3,) = h.observation(id, 3);
        assertEq(ts3, 0);

        // cumulative at +50: tick held over [5i, 5i+5) is ticks[(i-1) % 5] (0 before the first swap)
        int256 expected;
        for (uint256 i; i < 10; ++i) {
            int256 t = i == 0 ? int256(0) : int256(ticks[(i - 1) % 5]);
            expected += t * 5;
        }
        assertEq(int256(cum2), expected);

        vm.warp(T0 + 55);
        (bool ok,, uint32 span) = h.twapTick(id, 25);
        assertTrue(ok);
        assertEq(span, 25); // checkpoint at +30
        (ok,,) = h.twapTick(id, 26); // would need +29 or older: overwritten
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ not ok

    function test_notOk_cases() public {
        // unknown pool
        (bool ok, int24 avg, uint32 span) = oracle.twapTick(PoolId.wrap(bytes32(uint256(1))), 60);
        assertFalse(ok);
        assertEq(avg, 0);
        assertEq(span, 0);
        assertEq(oracle.observationCount(PoolId.wrap(bytes32(uint256(1)))), 0);

        (, PoolId id) = _pool(77);
        // same block as initialization
        (ok,,) = oracle.twapTick(id, 1);
        assertFalse(ok);

        vm.warp(T0 + 120);
        // zero window
        (ok,,) = oracle.twapTick(id, 0);
        assertFalse(ok);
        // history too short
        (ok,,) = oracle.twapTick(id, 121);
        assertFalse(ok);
        // window longer than the chain's age
        (ok,,) = oracle.twapTick(id, uint32(T0 + 1));
        assertFalse(ok);
        // exactly the age works
        (ok, avg, span) = oracle.twapTick(id, 120);
        assertTrue(ok);
        assertEq(avg, 77);
        assertEq(span, 120);
    }

    function test_poolOfOtherHook_unknown() public {
        (PoolKey memory k, PoolId id) = _pool(address(0), 3000, 10);
        vm.warp(T0 + 600);
        _swapTo(k, 20);
        assertEq(oracle.observationCount(id), 0);
        (bool ok,,) = oracle.twapTick(id, 60);
        assertFalse(ok);
    }

    function test_poolsAreIndependent() public {
        (PoolKey memory a, PoolId ida) = _pool(address(oracle), 3000, 100);
        (, PoolId idb) = _pool(address(oracle), 500, -100);
        vm.warp(T0 + 400);
        _swapTo(a, 900);
        assertEq(oracle.observationCount(ida), 2);
        assertEq(oracle.observationCount(idb), 1);
        vm.warp(T0 + 800);
        (, int24 avgA,) = oracle.twapTick(ida, 800);
        (, int24 avgB,) = oracle.twapTick(idb, 800);
        assertEq(avgA, 500); // (100 * 400 + 900 * 400) / 800
        assertEq(avgB, -100);
    }

    // ------------------------------------------------------------------ composition

    function _checkComposed(string memory what) internal {
        address h = _deployHook(what, abi.encode(manager), ORACLE_FLAGS);
        Hooks.Permissions memory p = BaseHook(h).getHookPermissions();
        assertEq(_flags(p), ORACLE_FLAGS);

        (PoolKey memory k, PoolId id) = _pool(h, LPFeeLibrary.DYNAMIC_FEE_FLAG, -2000);
        assertEq(ITwapOracle(h).observationCount(id), 1);

        vm.warp(T0 + 60);
        vm.recordLogs();
        int24 held = _swapTo(k, 3000);
        uint24 fee = _swapFee();
        assertEq(fee, 4000); // the stub fee feature ran and its override applied
        assertEq(StubFeeFeature(h).stubFeeCalls(), 1);
        assertEq(ITwapOracle(h).observationCount(id), 2); // the oracle ran too

        vm.warp(T0 + 180);
        (bool ok, int24 avg, uint32 span) = ITwapOracle(h).twapTick(id, 180);
        assertTrue(ok);
        assertEq(span, 180);
        assertEq(int256(avg), _refFloor(int256(-2000) * 60 + int256(held) * 120, 180));
    }

    function _swapFee() internal view returns (uint24 fee) {
        bytes32 topic = IPoolManager.Swap.selector;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic) {
                (,,,,, fee) =
                    abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
            }
        }
    }

    function test_composed_oracleThenFee() public {
        _checkComposed("TwapOracleHook.t.sol:OracleThenFee");
    }

    function test_composed_feeThenOracle() public {
        _checkComposed("TwapOracleHook.t.sol:FeeThenOracle");
    }
}
