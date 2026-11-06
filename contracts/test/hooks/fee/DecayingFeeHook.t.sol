// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {BaseHook} from "../../../src/hooks/base/BaseHook.sol";
import {PoolAdminHook} from "../../../src/hooks/base/PoolAdminHook.sol";
import {DecayingFeeExample} from "../../../src/hooks/examples/DecayingFeeExample.sol";
import {DecayingFeeHook} from "../../../src/hooks/fee/DecayingFeeHook.sol";
import {LinearDecay} from "../../../src/hooks/libraries/LinearDecay.sol";
import {HookTest} from "../utils/HookTest.sol";

// ---------------------------------------------------------------------- composition stub

/// @dev A second feature: records that its beforeInitialize ran and asks for a 0.30% LP fee.
abstract contract FlatFeeStub is BaseHook {
    uint256 public stubInits;

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeInitialize = true;
        p.beforeSwap = true;
        return p;
    }

    function _beforeInitialize(address s, PoolKey calldata k, uint160 px)
        internal
        virtual
        override
        returns (bytes4 sel)
    {
        sel = super._beforeInitialize(s, k, px);
        ++stubInits;
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        virtual
        override
        returns (bytes4 sel, BeforeSwapDelta delta, uint24 fee)
    {
        (sel, delta, fee) = super._beforeSwap(s, k, sp, d);
        fee = _mergeLpFeeOverride(fee, 3000 | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}

/// @dev DecayingFeeHook composed with the stub (rule 6: shared overrides re-declared).
contract DecayingWithStub is DecayingFeeHook, FlatFeeStub {
    constructor(IPoolManager m) BaseHook(m) {}

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(DecayingFeeHook, FlatFeeStub)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeInitialize(address s, PoolKey calldata k, uint160 px)
        internal
        override(DecayingFeeHook, FlatFeeStub)
        returns (bytes4)
    {
        return super._beforeInitialize(s, k, px);
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        override(DecayingFeeHook, FlatFeeStub)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return super._beforeSwap(s, k, sp, d);
    }
}

/// @dev Exposes the internal setter (the protocol-glue path) without access control.
contract DecayingFeeHarness is DecayingFeeHook {
    constructor(IPoolManager m) BaseHook(m) {}

    function setDecayingFeeInternal(
        PoolId poolId,
        uint24 startFee,
        uint24 endFee,
        uint32 duration,
        uint40 startTime
    ) external {
        _setDecayingFee(poolId, startFee, endFee, duration, startTime);
    }
}

// ---------------------------------------------------------------------- tests

contract DecayingFeeHookTest is HookTest {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG;
    uint24 internal constant DYNAMIC = LPFeeLibrary.DYNAMIC_FEE_FLAG;
    /// @dev Block time set in `setUp`. Tests warp to absolute times derived from it: under the
    ///      IR pipeline a local copy of `block.timestamp` may be re-read after `vm.warp`.
    uint256 internal constant T0 = 1_700_000_000;

    DecayingFeeExample internal hook;
    PoolKey internal poolKey;
    PoolId internal id;

    address internal stranger = makeAddr("stranger");

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        vm.warp(T0);
        hook = DecayingFeeExample(
            _deployHook("DecayingFeeExample.sol:DecayingFeeExample", abi.encode(manager), FLAGS)
        );
        (poolKey, id) = initPoolAndAddLiquidity(
            currency0, currency1, IHooks(address(hook)), DYNAMIC, SQRT_PRICE_1_1
        );
    }

    /// @dev Swaps 0 -> 1 exact input and returns the LP fee from the PoolManager Swap event.
    function _swapFee(PoolKey memory key) internal returns (uint24 lpFee) {
        vm.recordLogs();
        swap(key, true, -1e15, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IPoolManager.Swap.selector) {
                (,,,,, lpFee) =
                    abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                found = true;
            }
        }
        assertTrue(found, "no Swap event");
    }

    function _reference(uint256 s, uint256 e, uint256 d, uint256 st, uint256 t)
        internal
        pure
        returns (uint256)
    {
        if (t < st) return s;
        if (t >= st + d) return e;
        uint256 rem = st + d - t;
        return e + ((s - e) * rem + d - 1) / d;
    }

    // ------------------------------------------------------------ permissions and address

    function test_permissions() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertEq(_flags(p), FLAGS);
        assertEq(hook.poolAdmin(id), address(this));
    }

    function test_constructorRejectsWrongAddress() public {
        address wrong = _hookAddress(Hooks.BEFORE_SWAP_FLAG);
        vm.expectRevert();
        this.deployAt("DecayingFeeExample.sol:DecayingFeeExample", abi.encode(manager), wrong);
    }

    function deployAt(string memory what, bytes memory args, address where) external {
        deployCodeTo(what, args, where);
    }

    // ------------------------------------------------------------ schedule math

    function test_linearDecayValues() public pure {
        // start before the window, exactly start at startTime, end at and after the end.
        assertEq(LinearDecay.value(100, 10, 90, 1000, 999), 100);
        assertEq(LinearDecay.value(100, 10, 90, 1000, 1000), 100);
        assertEq(LinearDecay.value(100, 10, 90, 1000, 1045), 55);
        assertEq(LinearDecay.value(100, 10, 90, 1000, 1090), 10);
        assertEq(LinearDecay.value(100, 10, 90, 1000, 5000), 10);
        // Rounds up: 10 * 2 / 3 = 6.67 -> 7; 1 * 1 / 1000 -> 1.
        assertEq(LinearDecay.value(10, 0, 3, 0, 1), 7);
        assertEq(LinearDecay.value(1, 0, 1000, 0, 999), 1);
        assertEq(LinearDecay.value(1, 0, 1000, 0, 1000), 0);
        // Zero duration is a step at startTime; a flat schedule is constant.
        assertEq(LinearDecay.value(50, 50, 0, 1000, 999), 50);
        assertEq(LinearDecay.value(50, 50, 0, 1000, 1000), 50);
        assertEq(LinearDecay.value(50, 20, 0, 1000, 999), 50);
        assertEq(LinearDecay.value(50, 20, 0, 1000, 1000), 20);
    }

    function test_linearDecayRevertsWhenRising() public {
        vm.expectRevert();
        this.decay(10, 11, 100, 0, 50);
    }

    function decay(uint256 s, uint256 e, uint256 d, uint256 st, uint256 t)
        external
        pure
        returns (uint256)
    {
        return LinearDecay.value(s, e, d, st, t);
    }

    function testFuzz_linearDecayMatchesReference(uint24 s, uint24 e, uint32 d, uint40 st, uint40 t)
        public
        pure
    {
        if (e > s) (s, e) = (e, s);
        uint256 v = LinearDecay.value(s, e, d, st, t);
        assertEq(v, _reference(s, e, d, st, t));
        assertGe(v, e);
        assertLe(v, s);
        // Never below the exact linear value (rounds up), and within 1 of it.
        if (t >= st && uint256(t) < uint256(st) + d) {
            uint256 num = uint256(s - e) * (uint256(st) + d - t);
            assertGe((v - e) * d, num);
            assertLt((v - e) * d, num + d);
        }
    }

    function testFuzz_linearDecayIsMonotonic(uint24 s, uint24 e, uint32 d, uint32 t1, uint32 t2)
        public
        pure
    {
        if (e > s) (s, e) = (e, s);
        if (t1 > t2) (t1, t2) = (t2, t1);
        assertGe(LinearDecay.value(s, e, d, 100, t1), LinearDecay.value(s, e, d, 100, t2));
    }

    // ------------------------------------------------------------ config

    function test_setDecayingFeeStoresAndEmits() public {
        vm.expectEmit(true, true, true, true, address(hook));
        emit DecayingFeeHook.DecayingFeeSet(id, 100_000, 3000, 3600, uint40(T0));
        hook.setDecayingFee(poolKey, 100_000, 3000, 3600, 0);
        (uint24 s, uint24 e, uint32 d, uint40 st, bool set) = hook.decayingFee(id);
        assertEq(s, 100_000);
        assertEq(e, 3000);
        assertEq(d, 3600);
        assertEq(st, T0, "zero start time means now");
        assertTrue(set);
        assertEq(hook.currentFee(id), 100_000);
    }

    function test_setDecayingFeeExplicitStartTimeAndReplace() public {
        uint40 future = uint40(T0 + 100);
        hook.setDecayingFee(poolKey, 50_000, 1000, 1000, future);
        vm.warp(T0 + 99);
        assertEq(hook.currentFee(id), 50_000, "before start");
        vm.warp(T0 + 100 + 500);
        assertEq(hook.currentFee(id), 1000 + 49_000 / 2);

        // Replaced: a flat fee from now on.
        hook.setDecayingFee(poolKey, 7000, 7000, 0, 0);
        assertEq(hook.currentFee(id), 7000);
        assertEq(_swapFee(poolKey), 7000);
    }

    function test_setDecayingFeeBoundariesAreValid() public {
        hook.setDecayingFee(poolKey, uint24(LPFeeLibrary.MAX_LP_FEE), 0, 30 days, 0);
        assertEq(hook.currentFee(id), LPFeeLibrary.MAX_LP_FEE);
        hook.setDecayingFee(poolKey, 0, 0, 0, 0);
        assertEq(hook.currentFee(id), 0);
        assertEq(_swapFee(poolKey), 0, "a zero schedule still overrides");
    }

    function test_revertEndAboveStart() public {
        vm.expectRevert(
            abi.encodeWithSelector(DecayingFeeHook.InvalidDecayingFee.selector, 1000, 1001, 60)
        );
        hook.setDecayingFee(poolKey, 1000, 1001, 60, 0);
    }

    function test_revertStartAboveMax() public {
        uint24 tooHigh = uint24(LPFeeLibrary.MAX_LP_FEE) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(DecayingFeeHook.InvalidDecayingFee.selector, tooHigh, 0, 60)
        );
        hook.setDecayingFee(poolKey, tooHigh, 0, 60, 0);
    }

    function test_revertDurationAboveMax() public {
        uint32 tooLong = 30 days + 1;
        vm.expectRevert(
            abi.encodeWithSelector(DecayingFeeHook.InvalidDecayingFee.selector, 5000, 1000, tooLong)
        );
        hook.setDecayingFee(poolKey, 5000, 1000, tooLong, 0);
    }

    function test_revertZeroDurationWithRange() public {
        vm.expectRevert(
            abi.encodeWithSelector(DecayingFeeHook.InvalidDecayingFee.selector, 5000, 1000, 0)
        );
        hook.setDecayingFee(poolKey, 5000, 1000, 0, 0);
    }

    function test_onlyAdminConfigures() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, stranger));
        hook.setDecayingFee(poolKey, 5000, 1000, 60, 0);
    }

    function test_revertKeyOfAnotherHook() public {
        PoolKey memory other = poolKey;
        other.hooks = IHooks(address(0xBEEF));
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, other.toId(), address(this))
        );
        hook.setDecayingFee(other, 5000, 1000, 60, 0);
    }

    function test_transferredAdminConfigures() public {
        hook.transferPoolAdmin(poolKey, stranger);
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, address(this))
        );
        hook.setDecayingFee(poolKey, 5000, 1000, 60, 0);
        vm.prank(stranger);
        hook.setDecayingFee(poolKey, 5000, 1000, 60, 0);
        assertEq(hook.currentFee(id), 5000);
    }

    function test_frozenAdminKeepsScheduleForever() public {
        hook.setDecayingFee(poolKey, 20_000, 2000, 600, 0);
        hook.transferPoolAdmin(poolKey, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, address(this))
        );
        hook.setDecayingFee(poolKey, 0, 0, 0, 0);
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, address(0)));
        hook.setDecayingFee(poolKey, 0, 0, 0, 0);
        vm.warp(T0 + 600);
        assertEq(_swapFee(poolKey), 2000);
    }

    // ------------------------------------------------------------ pool behaviour

    function test_staticFeePoolCannotInitialize() public {
        PoolKey memory k = PoolKey(currency0, currency1, 3000, 60, IHooks(address(hook)));
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(DecayingFeeHook.NotDynamicFee.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_unsetPoolTradesAtStoredFee() public {
        assertEq(hook.currentFee(id), 0);
        (,,, uint24 storedFee) = manager.getSlot0(id);
        assertEq(_swapFee(poolKey), storedFee);
        assertEq(storedFee, 0);
    }

    function test_swapFeeDecaysOverWindow() public {
        hook.setDecayingFee(poolKey, 100_000, 3000, 3600, 0);
        assertEq(_swapFee(poolKey), 100_000, "t0");

        vm.warp(T0 + 1000);
        // 3000 + ceil(97_000 * 2600 / 3600) = 3000 + ceil(70_055.6) = 73_056
        assertEq(hook.currentFee(id), 73_056);
        assertEq(_swapFee(poolKey), 73_056, "mid window");

        vm.warp(T0 + 1800);
        assertEq(_swapFee(poolKey), 51_500, "half way");

        vm.warp(T0 + 3600);
        assertEq(_swapFee(poolKey), 3000, "end");
        vm.warp(T0 + 365 days);
        assertEq(_swapFee(poolKey), 3000, "long after");
    }

    /// @dev A second pool on the same hook (different tick spacing, so a different id).
    function _secondPool() internal returns (PoolKey memory k2, PoolId id2) {
        (k2, id2) =
            initPool(currency0, currency1, IHooks(address(hook)), DYNAMIC, 10, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(k2, LIQUIDITY_PARAMS, ZERO_BYTES);
    }

    function test_higherFeeCostsTheTrader() public {
        (PoolKey memory k2,) = _secondPool();
        hook.setDecayingFee(poolKey, 500_000, 0, 3600, 0);
        hook.setDecayingFee(k2, 0, 0, 0, 0);
        uint256 b = currency1.balanceOfSelf();
        swap(poolKey, true, -1e15, "");
        uint256 outHigh = currency1.balanceOfSelf() - b;
        b = currency1.balanceOfSelf();
        swap(k2, true, -1e15, "");
        uint256 outFree = currency1.balanceOfSelf() - b;
        // Half the input goes to LPs, so the output is about half.
        assertApproxEqRel(outHigh * 2, outFree, 0.01e18);
    }

    function test_fullFeeBlocksExactOutput() public {
        hook.setDecayingFee(poolKey, uint24(LPFeeLibrary.MAX_LP_FEE), 0, 3600, 0);
        vm.expectRevert();
        swap(poolKey, true, 1e15, "");
    }

    function test_feeIsPerPool() public {
        (PoolKey memory k2, PoolId id2) = _secondPool();
        hook.setDecayingFee(poolKey, 40_000, 40_000, 0, 0);
        assertEq(hook.currentFee(id2), 0);
        assertEq(_swapFee(k2), 0);
        assertEq(_swapFee(poolKey), 40_000);
    }

    function test_callbacksAreOnlyPoolManager() public {
        SwapParams memory sp;
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), poolKey, sp, "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeInitialize(address(this), poolKey, SQRT_PRICE_1_1);
    }

    // ------------------------------------------------------------ composition

    function _deployComposed() internal returns (DecayingWithStub h, PoolKey memory k) {
        h = DecayingWithStub(
            _deployHook("DecayingFeeHook.t.sol:DecayingWithStub", abi.encode(manager), FLAGS)
        );
        (k,) = initPoolAndAddLiquidity(
            currency0, currency1, IHooks(address(h)), DYNAMIC, SQRT_PRICE_1_1
        );
    }

    function test_composedPermissionsAndInitChain() public {
        (DecayingWithStub h, PoolKey memory k) = _deployComposed();
        assertEq(_flags(h.getHookPermissions()), FLAGS);
        assertEq(h.poolAdmin(k.toId()), address(this), "PoolAdminHook ran");
        assertEq(h.stubInits(), 1, "stub ran");

        PoolKey memory s = PoolKey(currency0, currency1, 3000, 60, IHooks(address(h)));
        vm.expectRevert();
        manager.initialize(s, SQRT_PRICE_1_1);
    }

    function test_composedFeeIsMaxOfFeatures() public {
        (DecayingWithStub h, PoolKey memory k) = _deployComposed();
        assertEq(_swapFee(k), 3000, "unset: stub's fee passes through");

        h.setDecayingFee(k, 10_000, 1000, 1000, 0);
        assertEq(_swapFee(k), 10_000, "decay above stub");
        vm.warp(T0 + 500);
        assertEq(_swapFee(k), 5500);
        vm.warp(T0 + 900);
        assertEq(_swapFee(k), 3000, "decay (1900) below stub");
    }

    // ------------------------------------------------------------ internal setter

    function test_internalSetterSkipsAdminCheckButValidates() public {
        DecayingFeeHarness h = DecayingFeeHarness(
            _deployHook("DecayingFeeHook.t.sol:DecayingFeeHarness", abi.encode(manager), FLAGS)
        );
        (PoolKey memory k, PoolId kid) = initPoolAndAddLiquidity(
            currency0, currency1, IHooks(address(h)), DYNAMIC, SQRT_PRICE_1_1
        );

        // No admin check: a stranger writes the schedule; zero start time means now.
        vm.expectEmit(true, true, true, true, address(h));
        emit DecayingFeeHook.DecayingFeeSet(kid, 20_000, 2000, 900, uint40(T0));
        vm.prank(stranger);
        h.setDecayingFeeInternal(kid, 20_000, 2000, 900, 0);
        (uint24 s, uint24 e, uint32 d, uint40 st, bool set) = h.decayingFee(kid);
        assertEq(s, 20_000);
        assertEq(e, 2000);
        assertEq(d, 900);
        assertEq(st, T0);
        assertTrue(set);
        assertEq(_swapFee(k), 20_000, "applied in swaps");

        // Same validation as the external setter.
        vm.expectRevert(
            abi.encodeWithSelector(DecayingFeeHook.InvalidDecayingFee.selector, 1000, 2000, 10)
        );
        h.setDecayingFeeInternal(kid, 1000, 2000, 10, 0);
        vm.expectRevert(
            abi.encodeWithSelector(DecayingFeeHook.InvalidDecayingFee.selector, 2000, 1000, 0)
        );
        h.setDecayingFeeInternal(kid, 2000, 1000, 0, 0);
        uint24 tooHigh = uint24(LPFeeLibrary.MAX_LP_FEE + 1);
        vm.expectRevert(
            abi.encodeWithSelector(DecayingFeeHook.InvalidDecayingFee.selector, tooHigh, 0, 10)
        );
        h.setDecayingFeeInternal(kid, tooHigh, 0, 10, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                DecayingFeeHook.InvalidDecayingFee.selector, 2000, 1000, 30 days + 1
            )
        );
        h.setDecayingFeeInternal(kid, 2000, 1000, 30 days + 1, 0);

        // The external setter still needs the admin.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, kid, stranger));
        h.setDecayingFee(k, 0, 0, 0, 0);
    }
}
