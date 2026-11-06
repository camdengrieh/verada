// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CurrencySettler} from "@uniswap/v4-core/test/utils/CurrencySettler.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {LiquidityGateHook} from "../../../src/hooks/access/LiquidityGateHook.sol";
import {BaseHook} from "../../../src/hooks/base/BaseHook.sol";
import {PoolAdminHook} from "../../../src/hooks/base/PoolAdminHook.sol";
import {LiquidityGateExample} from "../../../src/hooks/examples/LiquidityGateExample.sol";
import {HookTest} from "../utils/HookTest.sol";

/// @dev Minimal liquidity locker: it calls `PoolManager.modifyLiquidity` itself (so it is the
///      `sender` the gate sees), can add a position and collect its fees, and has no way to
///      remove liquidity.
contract Locker is IUnlockCallback {
    using CurrencySettler for Currency;

    IPoolManager public immutable manager;

    constructor(IPoolManager m) {
        manager = m;
    }

    function add(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint256 liquidity)
        external
    {
        manager.unlock(
            abi.encode(
                key, ModifyLiquidityParams(tickLower, tickUpper, int256(liquidity), bytes32(0))
            )
        );
    }

    function collect(PoolKey calldata key, int24 tickLower, int24 tickUpper) external {
        manager.unlock(abi.encode(key, ModifyLiquidityParams(tickLower, tickUpper, 0, bytes32(0))));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager));
        (PoolKey memory key, ModifyLiquidityParams memory params) =
            abi.decode(data, (PoolKey, ModifyLiquidityParams));
        (BalanceDelta delta,) = manager.modifyLiquidity(key, params, "");
        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return "";
    }

    function _settle(Currency c, int128 d) internal {
        if (d < 0) c.settle(manager, address(this), uint256(uint128(-d)), false);
        if (d > 0) c.take(manager, address(this), uint256(uint128(d)), false);
    }
}

contract LiquidityGateHookTest is HookTest {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;

    LiquidityGateExample internal gate;
    PoolId internal id;
    address internal router;

    event LiquidityGateSet(PoolId indexed poolId, bool gateAdd, bool gateRemove);
    event LiquidityProviderSet(PoolId indexed poolId, address indexed account, bool allowed);

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        gate = LiquidityGateExample(
            _deployHook(
                "LiquidityGateExample.sol:LiquidityGateExample",
                abi.encode(manager, address(this)),
                FLAGS
            )
        );
        gate.setPoolInitializer(address(this), true);
        (key, id) = initPool(currency0, currency1, gate, 3000, SQRT_PRICE_1_1);
        router = address(modifyLiquidityRouter);
    }

    function _notAllowed(bytes4 callback, address sender) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(gate),
            callback,
            abi.encodeWithSelector(LiquidityGateHook.LiquidityNotAllowed.selector, id, sender),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _add() internal {
        modifyLiquidityRouter.modifyLiquidity(key, LIQUIDITY_PARAMS, ZERO_BYTES);
    }

    function _remove() internal {
        modifyLiquidityRouter.modifyLiquidity(key, REMOVE_LIQUIDITY_PARAMS, ZERO_BYTES);
    }

    // ------------------------------------------------------------ permissions and defaults

    function test_permissions() public view {
        assertEq(_flags(gate.getHookPermissions()), FLAGS);
        assertEq(gate.poolAdmin(id), address(this)); // initializer is the pool admin
    }

    function test_gatesOffByDefault() public {
        (bool gateAdd, bool gateRemove) = gate.liquidityGate(id);
        assertFalse(gateAdd || gateRemove);
        _add();
        _remove();
    }

    function test_callbacksArePoolManagerOnly() public {
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        gate.beforeAddLiquidity(router, key, LIQUIDITY_PARAMS, "");
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        gate.beforeRemoveLiquidity(router, key, REMOVE_LIQUIDITY_PARAMS, "");
    }

    /// @dev Regression: a stranger who initializes a key first must not become its admin.
    function test_initialize_strangerRejected() public {
        address squatter = makeAddr("squatter");
        PoolKey memory k = PoolKey(currency0, currency1, 500, 10, gate);
        vm.prank(squatter);
        vm.expectRevert(_initGateRevert(address(gate), squatter));
        manager.initialize(k, SQRT_PRICE_1_1);
        assertEq(gate.poolAdmin(k.toId()), address(0));
    }

    function test_setPoolInitializer_onlyOwner() public {
        address squatter = makeAddr("squatter");
        vm.prank(squatter);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, squatter)
        );
        gate.setPoolInitializer(squatter, true);
    }

    // ------------------------------------------------------------ config

    function test_setGateAndProviderEmit() public {
        vm.expectEmit(true, false, false, true, address(gate));
        emit LiquidityGateSet(id, true, false);
        gate.setLiquidityGate(key, true, false);
        (bool gateAdd, bool gateRemove) = gate.liquidityGate(id);
        assertTrue(gateAdd);
        assertFalse(gateRemove);

        vm.expectEmit(true, true, false, true, address(gate));
        emit LiquidityProviderSet(id, router, true);
        gate.setLiquidityProvider(key, router, true);
        assertTrue(gate.isLiquidityProvider(id, router));
    }

    function test_onlyPoolAdminConfigures() public {
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, stranger));
        gate.setLiquidityGate(key, true, true);
        vm.expectRevert(abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, stranger));
        gate.setLiquidityProvider(key, stranger, true);
        vm.stopPrank();
    }

    function test_configRejectsForeignHookKey() public {
        PoolKey memory foreign = key;
        foreign.hooks = IHooks(address(0xBEEF));
        PoolId foreignId = foreign.toId();
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, foreignId, address(this))
        );
        gate.setLiquidityGate(foreign, true, true);
    }

    function test_transferredAdminConfigures() public {
        address next = makeAddr("next");
        gate.transferPoolAdmin(key, next);
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, address(this))
        );
        gate.setLiquidityGate(key, true, true);
        vm.prank(next);
        gate.setLiquidityGate(key, true, true);
        (bool gateAdd, bool gateRemove) = gate.liquidityGate(id);
        assertTrue(gateAdd && gateRemove);
    }

    // ------------------------------------------------------------ gating

    function test_addGatedRemoveOpen() public {
        _add(); // position to remove later
        gate.setLiquidityGate(key, true, false);
        vm.expectRevert(_notAllowed(IHooks.beforeAddLiquidity.selector, router));
        _add();
        _remove(); // removal side is open

        gate.setLiquidityProvider(key, router, true);
        _add();
    }

    function test_removeGatedAddOpen() public {
        gate.setLiquidityGate(key, false, true);
        _add();
        vm.expectRevert(_notAllowed(IHooks.beforeRemoveLiquidity.selector, router));
        _remove();

        gate.setLiquidityProvider(key, router, true);
        _remove();
    }

    function test_removeGateAlsoGatesFeeCollection() public {
        _add();
        gate.setLiquidityGate(key, false, true);
        ModifyLiquidityParams memory collect = LIQUIDITY_PARAMS;
        collect.liquidityDelta = 0;
        vm.expectRevert(_notAllowed(IHooks.beforeRemoveLiquidity.selector, router));
        modifyLiquidityRouter.modifyLiquidity(key, collect, ZERO_BYTES);
    }

    function test_revokedProviderIsBlocked() public {
        gate.setLiquidityGate(key, true, true);
        gate.setLiquidityProvider(key, router, true);
        _add();
        gate.setLiquidityProvider(key, router, false);
        vm.expectRevert(_notAllowed(IHooks.beforeRemoveLiquidity.selector, router));
        _remove();
    }

    function test_gateIsPerPool() public {
        gate.setLiquidityGate(key, true, true);
        (PoolKey memory other,) = initPool(currency0, currency1, gate, 500, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(other, LIQUIDITY_PARAMS, ZERO_BYTES);
        modifyLiquidityRouter.modifyLiquidity(other, REMOVE_LIQUIDITY_PARAMS, ZERO_BYTES);
    }

    function testFuzz_gateOutcome(bool gateAdd, bool gateRemove, bool allowed) public {
        gate.setLiquidityGate(key, gateAdd, gateRemove);
        gate.setLiquidityProvider(key, router, allowed);

        if (gateAdd && !allowed) {
            vm.expectRevert(_notAllowed(IHooks.beforeAddLiquidity.selector, router));
            _add();
            return;
        }
        _add();
        if (gateRemove && !allowed) {
            vm.expectRevert(_notAllowed(IHooks.beforeRemoveLiquidity.selector, router));
        }
        _remove();
    }

    // ------------------------------------------------------------ renounce and the locked recipe

    function test_renouncedAdminFreezesGate() public {
        gate.setLiquidityGate(key, true, true);
        gate.transferPoolAdmin(key, address(0));
        assertEq(gate.poolAdmin(id), address(0));

        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, address(this))
        );
        gate.setLiquidityGate(key, false, false);
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, address(this))
        );
        gate.setLiquidityProvider(key, router, true);
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, address(0)));
        gate.setLiquidityGate(key, false, false);

        vm.expectRevert(_notAllowed(IHooks.beforeAddLiquidity.selector, router));
        _add();
    }

    function test_lockedLiquidityRecipe() public {
        Locker locker = new Locker(manager);
        IERC20Minimal(Currency.unwrap(currency0)).transfer(address(locker), 10e18);
        IERC20Minimal(Currency.unwrap(currency1)).transfer(address(locker), 10e18);

        // 1. gate both sides, allow only the locker
        gate.setLiquidityGate(key, true, true);
        gate.setLiquidityProvider(key, address(locker), true);
        // 2. the locker adds the position
        locker.add(key, -120, 120, 1e18);
        assertEq(_lockedLiquidity(address(locker)), 1e18);
        // 3. the admin renounces
        gate.transferPoolAdmin(key, address(0));

        // nobody else can remove (or add), and nobody can change the gate
        vm.expectRevert(_notAllowed(IHooks.beforeRemoveLiquidity.selector, router));
        _remove();
        vm.expectRevert(_notAllowed(IHooks.beforeAddLiquidity.selector, router));
        _add();
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, address(this))
        );
        gate.setLiquidityGate(key, false, false);
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, id, address(this))
        );
        gate.setLiquidityProvider(key, router, true);

        // trading works and the locker (which has no remove path) still collects its fees
        swap(key, true, -1e15, ZERO_BYTES);
        uint256 before0 = currency0.balanceOf(address(locker));
        locker.collect(key, -120, 120);
        assertGt(currency0.balanceOf(address(locker)), before0);
        assertEq(_lockedLiquidity(address(locker)), 1e18);
    }

    function _lockedLiquidity(address owner) internal view returns (uint128 liquidity) {
        (liquidity,,) = manager.getPositionInfo(id, owner, -120, 120, bytes32(0));
    }
}
