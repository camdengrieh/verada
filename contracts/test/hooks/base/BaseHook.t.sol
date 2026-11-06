// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {BaseHook} from "../../../src/hooks/base/BaseHook.sol";
import {PoolAdminHook} from "../../../src/hooks/base/PoolAdminHook.sol";
import {HookTest} from "../utils/HookTest.sol";

// ---------------------------------------------------------------------- test features

/// @dev Records the order in which feature logic runs.
abstract contract Traced is BaseHook {
    uint256[] internal _trace;

    function trace() external view returns (uint256[] memory) {
        return _trace;
    }

    function clearTrace() external {
        delete _trace;
    }
}

/// @dev Takes 1% of the unspecified side in afterSwap and asks for a 0.30% LP fee.
abstract contract OnePercentFee is Traced {
    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeSwap = true;
        p.afterSwap = true;
        p.afterSwapReturnDelta = true;
        return p;
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        virtual
        override
        returns (bytes4 sel, BeforeSwapDelta delta, uint24 fee)
    {
        (sel, delta, fee) = super._beforeSwap(s, k, sp, d);
        _trace.push(1);
        fee = _mergeLpFeeOverride(fee, 3000 | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function _afterSwap(
        address s,
        PoolKey calldata k,
        SwapParams calldata sp,
        BalanceDelta bd,
        bytes calldata d
    ) internal virtual override returns (bytes4 sel, int128 hookDelta) {
        (sel, hookDelta) = super._afterSwap(s, k, sp, bd, d);
        _trace.push(11);
        (Currency c, uint256 amount) = _unspecified(k, sp, bd);
        uint256 fee = amount / 100;
        poolManager.take(c, address(this), fee);
        hookDelta += int128(int256(fee));
    }
}

/// @dev Takes 2% of the unspecified side in afterSwap and asks for a 0.50% LP fee.
abstract contract TwoPercentFee is Traced {
    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeSwap = true;
        p.afterSwap = true;
        p.afterSwapReturnDelta = true;
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
        _trace.push(20);
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        virtual
        override
        returns (bytes4 sel, BeforeSwapDelta delta, uint24 fee)
    {
        (sel, delta, fee) = super._beforeSwap(s, k, sp, d);
        _trace.push(2);
        fee = _mergeLpFeeOverride(fee, 5000 | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function _afterSwap(
        address s,
        PoolKey calldata k,
        SwapParams calldata sp,
        BalanceDelta bd,
        bytes calldata d
    ) internal virtual override returns (bytes4 sel, int128 hookDelta) {
        (sel, hookDelta) = super._afterSwap(s, k, sp, bd, d);
        _trace.push(12);
        (Currency c, uint256 amount) = _unspecified(k, sp, bd);
        uint256 fee = amount / 50;
        poolManager.take(c, address(this), fee);
        hookDelta += int128(int256(fee));
    }
}

/// @dev Turns the swap span lock on.
abstract contract SwapLocked is BaseHook {
    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.beforeSwap = true;
        p.afterSwap = true;
        return p;
    }

    function _usesSwapLock() internal pure virtual override returns (bool) {
        return true;
    }

    function lockState() external view returns (uint256) {
        return _hookLockState();
    }

    /// @dev Guarded entry point that tries to re-enter itself.
    function guarded(bool reenter) external hookNonReentrant returns (uint256 state) {
        state = _hookLockState();
        if (reenter) this.guarded(false);
    }
}

// ---------------------------------------------------------------------- concrete hooks

/// @dev Features listed in order 1 then 2.
contract OneThenTwo is OnePercentFee, TwoPercentFee {
    constructor(IPoolManager m) BaseHook(m) {}

    function _afterInitialize(address s, PoolKey calldata k, uint160 px, int24 t)
        internal
        override(BaseHook, TwoPercentFee)
        returns (bytes4)
    {
        return super._afterInitialize(s, k, px, t);
    }

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(OnePercentFee, TwoPercentFee)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        override(OnePercentFee, TwoPercentFee)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return super._beforeSwap(s, k, sp, d);
    }

    function _afterSwap(
        address s,
        PoolKey calldata k,
        SwapParams calldata sp,
        BalanceDelta bd,
        bytes calldata d
    ) internal override(OnePercentFee, TwoPercentFee) returns (bytes4, int128) {
        return super._afterSwap(s, k, sp, bd, d);
    }
}

/// @dev Features listed in order 2 then 1.
contract TwoThenOne is TwoPercentFee, OnePercentFee {
    constructor(IPoolManager m) BaseHook(m) {}

    function _afterInitialize(address s, PoolKey calldata k, uint160 px, int24 t)
        internal
        override(BaseHook, TwoPercentFee)
        returns (bytes4)
    {
        return super._afterInitialize(s, k, px, t);
    }

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(OnePercentFee, TwoPercentFee)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        override(OnePercentFee, TwoPercentFee)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return super._beforeSwap(s, k, sp, d);
    }

    function _afterSwap(
        address s,
        PoolKey calldata k,
        SwapParams calldata sp,
        BalanceDelta bd,
        bytes calldata d
    ) internal override(OnePercentFee, TwoPercentFee) returns (bytes4, int128) {
        return super._afterSwap(s, k, sp, bd, d);
    }
}

/// @dev No features: every callback is unimplemented.
contract EmptyHook is BaseHook {
    constructor(IPoolManager m) BaseHook(m) {}
}

contract LockedHook is SwapLocked {
    constructor(IPoolManager m) BaseHook(m) {}
}

/// @dev Enables the swap lock without the swap callbacks (must not deploy).
contract BadLockHook is BaseHook {
    constructor(IPoolManager m) BaseHook(m) {}

    function _usesSwapLock() internal pure override returns (bool) {
        return true;
    }
}

contract AdminHook is PoolAdminHook {
    uint256 public value;

    constructor(IPoolManager m) BaseHook(m) {}

    function setValue(PoolKey calldata key, uint256 v) external onlyPoolAdmin(key) {
        value = v;
    }
}

/// @dev Exposes the merge helpers.
contract MergeHarness is BaseHook {
    constructor(IPoolManager m) BaseHook(m) {}

    function mergeFee(uint24 a, uint24 b) external pure returns (uint24) {
        return _mergeLpFeeOverride(a, b);
    }

    function addDelta(BeforeSwapDelta a, BeforeSwapDelta b)
        external
        pure
        returns (BeforeSwapDelta)
    {
        return _addBeforeSwapDelta(a, b);
    }
}

// ---------------------------------------------------------------------- tests

contract BaseHookTest is HookTest {
    uint24 internal constant FLAG = LPFeeLibrary.OVERRIDE_FEE_FLAG;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
    }

    function _swapFlags() internal pure returns (uint160) {
        return Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_INITIALIZE_FLAG;
    }

    // ------------------------------------------------------------ permissions and address

    function test_permissionsAreMergedAcrossFeatures() public {
        address h = _deployHook("BaseHook.t.sol:OneThenTwo", abi.encode(manager), _swapFlags());
        Hooks.Permissions memory p = BaseHook(h).getHookPermissions();
        assertTrue(p.beforeSwap && p.afterSwap && p.afterSwapReturnDelta && p.afterInitialize);
        assertFalse(p.beforeInitialize || p.beforeAddLiquidity || p.beforeDonate);
        assertEq(_flags(p), _swapFlags());
    }

    function test_constructorRejectsAddressWithoutFlags() public {
        address wrong = _hookAddress(Hooks.BEFORE_SWAP_FLAG);
        vm.expectRevert();
        this.deployAt("BaseHook.t.sol:OneThenTwo", abi.encode(manager), wrong);
    }

    function test_constructorRejectsExtraFlags() public {
        address wrong = _hookAddress(_swapFlags() | Hooks.BEFORE_DONATE_FLAG);
        vm.expectRevert();
        this.deployAt("BaseHook.t.sol:OneThenTwo", abi.encode(manager), wrong);
    }

    function test_constructorRejectsZeroPoolManager() public {
        address h = _hookAddress(0);
        vm.expectRevert();
        this.deployAt("BaseHook.t.sol:EmptyHook", abi.encode(address(0)), h);
    }

    function test_swapLockWithoutSwapCallbacksReverts() public {
        address h = _hookAddress(0);
        vm.expectRevert();
        this.deployAt("BaseHook.t.sol:BadLockHook", abi.encode(manager), h);
    }

    function deployAt(string memory what, bytes memory args, address where) external {
        deployCodeTo(what, args, where);
    }

    // ------------------------------------------------------------ access and roots

    function test_callbacksAreOnlyPoolManager() public {
        address h = _deployHook("BaseHook.t.sol:OneThenTwo", abi.encode(manager), _swapFlags());
        PoolKey memory k;
        SwapParams memory sp;
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        BaseHook(h).beforeSwap(address(this), k, sp, "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        BaseHook(h).afterInitialize(address(this), k, 0, 0);
    }

    function test_unflaggedCallbackRevertsHookNotImplemented() public {
        address h = _deployHook("BaseHook.t.sol:EmptyHook", abi.encode(manager), 0);
        PoolKey memory k;
        SwapParams memory sp;
        vm.startPrank(address(manager));
        vm.expectRevert(BaseHook.HookNotImplemented.selector);
        BaseHook(h).beforeSwap(address(this), k, sp, "");
        vm.expectRevert(BaseHook.HookNotImplemented.selector);
        BaseHook(h).afterSwap(address(this), k, sp, BalanceDelta.wrap(0), "");
        vm.expectRevert(BaseHook.HookNotImplemented.selector);
        BaseHook(h).beforeInitialize(address(this), k, 0);
        vm.expectRevert(BaseHook.HookNotImplemented.selector);
        BaseHook(h).beforeDonate(address(this), k, 0, 0, "");
        vm.stopPrank();
    }

    function test_flaggedRootReturnsNeutral() public {
        address h = _deployHook(
            "BaseHook.t.sol:LockedHook",
            abi.encode(manager),
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        PoolKey memory k;
        SwapParams memory sp;
        vm.startPrank(address(manager));
        (bytes4 sel, BeforeSwapDelta d, uint24 fee) =
            BaseHook(h).beforeSwap(address(this), k, sp, "");
        assertEq(sel, IHooks.beforeSwap.selector);
        assertEq(BeforeSwapDelta.unwrap(d), 0);
        assertEq(fee, 0);
        (bytes4 sel2, int128 hd) =
            BaseHook(h).afterSwap(address(this), k, sp, BalanceDelta.wrap(0), "");
        assertEq(sel2, IHooks.afterSwap.selector);
        assertEq(hd, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ composition on a real pool

    function _swapThrough(string memory what)
        internal
        returns (address h, uint256 out, uint24 lpFee)
    {
        h = _deployHook(what, abi.encode(manager), _swapFlags());
        (key,) = initPoolAndAddLiquidity(
            currency0, currency1, IHooks(h), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1
        );
        assertEq(Traced(h).trace().length, 1); // afterInitialize ran
        Traced(h).clearTrace();

        uint256 before1 = currency1.balanceOfSelf();
        vm.recordLogs();
        swap(key, true, -1e15, ""); // exact input 0 -> 1
        Vm.Log[] memory logs = vm.getRecordedLogs();
        out = currency1.balanceOfSelf() - before1;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IPoolManager.Swap.selector) {
                (,,,,, lpFee) =
                    abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
            }
        }
    }

    function test_afterSwapDeltasAreSummed() public {
        (address h, uint256 out, uint24 lpFee) = _swapThrough("BaseHook.t.sol:OneThenTwo");
        uint256 taken = currency1.balanceOf(h);
        // 1% + 2% of the same gross output, not compounded.
        uint256 gross = out + taken;
        assertEq(taken, gross / 100 + gross / 50);
        assertEq(lpFee, 5000, "higher override wins");
    }

    function test_featureLogicRunsInListOrder() public {
        (address h,,) = _swapThrough("BaseHook.t.sol:OneThenTwo");
        uint256[] memory t = Traced(h).trace();
        assertEq(t.length, 4);
        assertEq(t[0], 1);
        assertEq(t[1], 2);
        assertEq(t[2], 11);
        assertEq(t[3], 12);

        (address h2,,) = _swapThrough("BaseHook.t.sol:TwoThenOne");
        t = Traced(h2).trace();
        assertEq(t[0], 2);
        assertEq(t[1], 1);
        assertEq(t[2], 12);
        assertEq(t[3], 11);
    }

    function test_resultDoesNotDependOnOrder() public {
        (, uint256 outA, uint24 feeA) = _swapThrough("BaseHook.t.sol:OneThenTwo");
        // Fresh manager so the second pool starts from the same state.
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        (, uint256 outB, uint24 feeB) = _swapThrough("BaseHook.t.sol:TwoThenOne");
        assertEq(outA, outB);
        assertEq(feeA, feeB);
    }

    // ------------------------------------------------------------ merge helpers

    function test_mergeLpFeeOverride() public {
        MergeHarness m =
            MergeHarness(_deployHook("BaseHook.t.sol:MergeHarness", abi.encode(manager), 0));
        assertEq(m.mergeFee(0, 0), 0);
        assertEq(m.mergeFee(3000 | FLAG, 0), 3000 | FLAG, "no flag never replaces");
        assertEq(m.mergeFee(3000 | FLAG, 9000), 3000 | FLAG, "no flag never replaces");
        assertEq(m.mergeFee(0, 3000 | FLAG), 3000 | FLAG);
        assertEq(m.mergeFee(3000 | FLAG, 5000 | FLAG), 5000 | FLAG);
        assertEq(m.mergeFee(5000 | FLAG, 3000 | FLAG), 5000 | FLAG);
        assertEq(m.mergeFee(FLAG, 1 | FLAG), 1 | FLAG, "zero override is an override");
    }

    function testFuzz_mergeLpFeeOverrideCommutes(uint24 a, uint24 b) public {
        MergeHarness m =
            MergeHarness(_deployHook("BaseHook.t.sol:MergeHarness", abi.encode(manager), 0));
        uint24 ab = m.mergeFee(a, b);
        uint24 ba = m.mergeFee(b, a);
        if ((a & FLAG != 0) && (b & FLAG != 0)) {
            assertEq(ab & LPFeeLibrary.REMOVE_OVERRIDE_MASK, ba & LPFeeLibrary.REMOVE_OVERRIDE_MASK);
        } else if ((a & FLAG != 0) || (b & FLAG != 0)) {
            assertEq(ab, ba);
        }
    }

    function test_addBeforeSwapDelta() public {
        MergeHarness m =
            MergeHarness(_deployHook("BaseHook.t.sol:MergeHarness", abi.encode(manager), 0));
        BeforeSwapDelta s = m.addDelta(toBeforeSwapDelta(5, -3), toBeforeSwapDelta(-2, 10));
        assertEq(BeforeSwapDeltaLibrary.getSpecifiedDelta(s), 3);
        assertEq(BeforeSwapDeltaLibrary.getUnspecifiedDelta(s), 7);
        vm.expectRevert();
        m.addDelta(toBeforeSwapDelta(type(int128).max, 0), toBeforeSwapDelta(1, 0));
    }

    // ------------------------------------------------------------ lock

    function test_swapLockBlocksNestedSwapAndClears() public {
        LockedHook h = LockedHook(
            _deployHook(
                "BaseHook.t.sol:LockedHook",
                abi.encode(manager),
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            )
        );
        PoolKey memory k;
        SwapParams memory sp;
        vm.startPrank(address(manager));
        h.beforeSwap(address(this), k, sp, "");
        assertEq(h.lockState(), 1);
        vm.expectRevert(abi.encodeWithSelector(BaseHook.HookReentered.selector, 1));
        h.beforeSwap(address(this), k, sp, "");
        h.afterSwap(address(this), k, sp, BalanceDelta.wrap(0), "");
        assertEq(h.lockState(), 0);
        vm.stopPrank();
    }

    function test_callLockBlocksSwapsAndReentry() public {
        LockedHook h = LockedHook(
            _deployHook(
                "BaseHook.t.sol:LockedHook",
                abi.encode(manager),
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            )
        );
        assertEq(h.guarded(false), 2);
        assertEq(h.lockState(), 0);
        vm.expectRevert(abi.encodeWithSelector(BaseHook.HookReentered.selector, 2));
        h.guarded(true);
    }

    function test_swapLockOnRealPool() public {
        LockedHook h = LockedHook(
            _deployHook(
                "BaseHook.t.sol:LockedHook",
                abi.encode(manager),
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            )
        );
        (key,) =
            initPoolAndAddLiquidity(currency0, currency1, IHooks(address(h)), 3000, SQRT_PRICE_1_1);
        swap(key, true, -1e15, "");
        swap(key, false, -1e15, "");
        assertEq(h.lockState(), 0);
    }

    // ------------------------------------------------------------ pool admin

    function test_poolAdminIsInitializer() public {
        AdminHook h = AdminHook(
            _deployHook(
                "BaseHook.t.sol:AdminHook", abi.encode(manager), Hooks.BEFORE_INITIALIZE_FLAG
            )
        );
        PoolKey memory k = PoolKey(currency0, currency1, 3000, 60, IHooks(address(h)));
        address lp = makeAddr("lp");
        vm.prank(lp);
        manager.initialize(k, SQRT_PRICE_1_1);
        PoolId id = k.toId();
        assertEq(h.poolAdmin(id), lp);

        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, address(this))
        );
        h.setValue(k, 1);

        vm.prank(lp);
        h.setValue(k, 7);
        assertEq(h.value(), 7);

        address next = makeAddr("next");
        vm.prank(lp);
        h.transferPoolAdmin(k, next);
        assertEq(h.poolAdmin(id), next);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, lp));
        h.setValue(k, 8);

        vm.prank(next);
        h.transferPoolAdmin(k, address(0));
        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, next));
        h.setValue(k, 9);
    }

    function test_poolAdminRejectsForeignKey() public {
        AdminHook h = AdminHook(
            _deployHook(
                "BaseHook.t.sol:AdminHook", abi.encode(manager), Hooks.BEFORE_INITIALIZE_FLAG
            )
        );
        PoolKey memory k = PoolKey(currency0, currency1, 3000, 60, IHooks(address(0)));
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, k.toId(), address(this))
        );
        h.setValue(k, 1);
    }
}
