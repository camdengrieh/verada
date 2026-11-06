// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {LiquidityGateHook} from "../../../src/hooks/access/LiquidityGateHook.sol";
import {PoolInitGateHook} from "../../../src/hooks/access/PoolInitGateHook.sol";
import {BaseHook} from "../../../src/hooks/base/BaseHook.sol";
import {PoolAdminHook} from "../../../src/hooks/base/PoolAdminHook.sol";
import {PoolInitGateExample} from "../../../src/hooks/examples/PoolInitGateExample.sol";
import {HookTest} from "../utils/HookTest.sol";

// ---------------------------------------------------------------------- harnesses

/// @dev Pool key rule override: every pool must pair `quote` with a token, one pool per token.
///      The rule reads state in `_validatePoolKey` (view) and records it after `super` in
///      `_beforeInitialize`, the documented pattern for stateful rules.
contract QuoteRuleGate is PoolInitGateHook {
    Currency public immutable quote;
    mapping(Currency token => bool) public hasPool;

    constructor(IPoolManager m, Currency quote_) BaseHook(m) {
        quote = quote_;
    }

    function setPoolInitializer(address account, bool allowed) external {
        _setPoolInitializer(account, allowed);
    }

    function _token(PoolKey calldata key) internal view returns (Currency) {
        return key.currency0 == quote ? key.currency1 : key.currency0;
    }

    function _validatePoolKey(PoolKey calldata key, uint160) internal view override {
        if (!(key.currency0 == quote) && !(key.currency1 == quote)) revert InvalidPoolKey();
        if (hasPool[_token(key)]) revert InvalidPoolKey();
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        override
        returns (bytes4 selector)
    {
        selector = super._beforeInitialize(sender, key, sqrtPriceX96);
        hasPool[_token(key)] = true;
    }
}

/// @dev Both access gates in one concrete hook (test only). Linearization:
///      BothGatesHook, LiquidityGateHook, PoolAdminHook, PoolInitGateHook, BaseHook, so in
///      `beforeInitialize` the initializer check runs before the pool admin is recorded.
contract BothGatesHook is PoolInitGateHook, LiquidityGateHook {
    /// @dev Test-only open admin: the initializer becomes the pool admin.
    function _initialPoolAdmin(address s, PoolKey calldata)
        internal
        pure
        override
        returns (address)
    {
        return s;
    }

    constructor(IPoolManager m) BaseHook(m) {}

    function setPoolInitializer(address account, bool allowed) external {
        _setPoolInitializer(account, allowed);
    }

    // rule 6: re-declare every internal function two or more bases define.

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(PoolInitGateHook, LiquidityGateHook)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        override(PoolInitGateHook, PoolAdminHook)
        returns (bytes4)
    {
        return super._beforeInitialize(sender, key, sqrtPriceX96);
    }

    function _beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) internal override(BaseHook, LiquidityGateHook) returns (bytes4) {
        return super._beforeAddLiquidity(sender, key, params, hookData);
    }

    function _beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) internal override(BaseHook, LiquidityGateHook) returns (bytes4) {
        return super._beforeRemoveLiquidity(sender, key, params, hookData);
    }
}

/// @dev Calls `PoolManager.initialize` itself, so it is the `sender` the gate sees.
contract Initializer {
    function initialize(IPoolManager m, PoolKey calldata key, uint160 sqrtPriceX96) external {
        m.initialize(key, sqrtPriceX96);
    }
}

// ---------------------------------------------------------------------- tests

contract PoolInitGateHookTest is HookTest {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG;
    uint160 internal constant BOTH_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG
        | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;

    address internal owner = makeAddr("owner");
    PoolInitGateExample internal gate;

    event PoolInitializerSet(address indexed account, bool allowed);
    event PoolAdminChanged(
        PoolId indexed poolId, address indexed previousAdmin, address indexed newAdmin
    );

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        gate = PoolInitGateExample(
            _deployHook(
                "PoolInitGateExample.sol:PoolInitGateExample", abi.encode(manager, owner), FLAGS
            )
        );
    }

    function _key(IHooks hook, uint24 fee) internal view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, fee, 60, hook);
    }

    function _wrapped(address hook, bytes memory reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            hook,
            IHooks.beforeInitialize.selector,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _notAllowed(address hook, address sender) internal pure returns (bytes memory) {
        return _wrapped(
            hook, abi.encodeWithSelector(PoolInitGateHook.InitializerNotAllowed.selector, sender)
        );
    }

    // ------------------------------------------------------------ permissions and config

    function test_permissionsAreBeforeInitializeOnly() public view {
        Hooks.Permissions memory p = gate.getHookPermissions();
        assertEq(_flags(p), FLAGS);
        assertEq(gate.owner(), owner);
    }

    function test_ownerSetsInitializer() public {
        vm.expectEmit(true, false, false, true, address(gate));
        emit PoolInitializerSet(address(this), true);
        vm.prank(owner);
        gate.setPoolInitializer(address(this), true);
        assertTrue(gate.isPoolInitializer(address(this)));

        vm.expectEmit(true, false, false, true, address(gate));
        emit PoolInitializerSet(address(this), false);
        vm.prank(owner);
        gate.setPoolInitializer(address(this), false);
        assertFalse(gate.isPoolInitializer(address(this)));
    }

    function test_nonOwnerCannotSetInitializer() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        gate.setPoolInitializer(address(this), true);
    }

    // ------------------------------------------------------------ initializer gate

    function test_noInitializerByDefault() public {
        PoolKey memory k = _key(gate, 3000);
        vm.expectRevert(_notAllowed(address(gate), address(this)));
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_allowedInitializerCreatesPool() public {
        vm.prank(owner);
        gate.setPoolInitializer(address(this), true);
        PoolKey memory k = _key(gate, 3000);
        manager.initialize(k, SQRT_PRICE_1_1);
        (uint160 px,,,) = manager.getSlot0(k.toId());
        assertEq(px, SQRT_PRICE_1_1);
        // the pool works as a normal pool afterwards
        modifyLiquidityRouter.modifyLiquidity(k, LIQUIDITY_PARAMS, ZERO_BYTES);
        swap(k, true, -1e15, ZERO_BYTES);
    }

    function test_revokedInitializerReverts() public {
        vm.startPrank(owner);
        gate.setPoolInitializer(address(this), true);
        gate.setPoolInitializer(address(this), false);
        vm.stopPrank();
        PoolKey memory k = _key(gate, 3000);
        vm.expectRevert(_notAllowed(address(gate), address(this)));
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_senderIsCallerOfInitialize() public {
        Initializer factory = new Initializer();
        vm.prank(owner);
        gate.setPoolInitializer(address(factory), true);

        // the allowed contract creates the pool ...
        factory.initialize(manager, _key(gate, 3000), SQRT_PRICE_1_1);
        // ... but its own caller may not call the pool manager directly
        PoolKey memory k = _key(gate, 500);
        vm.expectRevert(_notAllowed(address(gate), address(this)));
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function testFuzz_gateMatchesAllowlist(address sender, bool allowed) public {
        vm.prank(owner);
        gate.setPoolInitializer(sender, allowed);
        PoolKey memory k = _key(gate, 3000);
        vm.prank(address(manager));
        if (allowed) {
            assertEq(
                gate.beforeInitialize(sender, k, SQRT_PRICE_1_1), IHooks.beforeInitialize.selector
            );
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(PoolInitGateHook.InitializerNotAllowed.selector, sender)
            );
            gate.beforeInitialize(sender, k, SQRT_PRICE_1_1);
        }
    }

    function test_callbackIsPoolManagerOnly() public {
        PoolKey memory k = _key(gate, 3000);
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        gate.beforeInitialize(address(this), k, SQRT_PRICE_1_1);
    }

    // ------------------------------------------------------------ pool key rule

    function _quoteGate() internal returns (QuoteRuleGate g) {
        g = QuoteRuleGate(
            _deployHook(
                "PoolInitGateHook.t.sol:QuoteRuleGate", abi.encode(manager, currency1), FLAGS
            )
        );
        g.setPoolInitializer(address(this), true);
    }

    function test_keyRuleAcceptsQuotePool() public {
        QuoteRuleGate g = _quoteGate();
        manager.initialize(_key(g, 3000), SQRT_PRICE_1_1);
        assertTrue(g.hasPool(currency0));
    }

    function test_keyRuleRejectsPoolWithoutQuote() public {
        QuoteRuleGate g = _quoteGate();
        // native / currency0: no quote currency on either side
        PoolKey memory k = PoolKey(Currency.wrap(address(0)), currency0, 3000, 60, g);
        vm.expectRevert(
            _wrapped(address(g), abi.encodeWithSelector(PoolInitGateHook.InvalidPoolKey.selector))
        );
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_keyRuleOnePoolPerToken() public {
        QuoteRuleGate g = _quoteGate();
        manager.initialize(_key(g, 3000), SQRT_PRICE_1_1);
        PoolKey memory second = _key(g, 500); // same token, another fee tier
        vm.expectRevert(
            _wrapped(address(g), abi.encodeWithSelector(PoolInitGateHook.InvalidPoolKey.selector))
        );
        manager.initialize(second, SQRT_PRICE_1_1);
    }

    function test_initializerCheckRunsBeforeKeyRule() public {
        QuoteRuleGate g = _quoteGate();
        g.setPoolInitializer(address(this), false);
        PoolKey memory k = PoolKey(Currency.wrap(address(0)), currency0, 3000, 60, g);
        vm.expectRevert(_notAllowed(address(g), address(this)));
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    // ------------------------------------------------------------ composition with LiquidityGateHook

    function _bothGates() internal returns (BothGatesHook h) {
        h = BothGatesHook(
            _deployHook("PoolInitGateHook.t.sol:BothGatesHook", abi.encode(manager), BOTH_FLAGS)
        );
    }

    function test_composedPermissionsAreMerged() public {
        BothGatesHook h = _bothGates();
        Hooks.Permissions memory p = h.getHookPermissions();
        assertEq(_flags(p), BOTH_FLAGS);
    }

    function test_composedDisallowedInitializerRecordsNoAdmin() public {
        BothGatesHook h = _bothGates();
        PoolKey memory k = _key(h, 3000);
        vm.expectRevert(_notAllowed(address(h), address(this)));
        manager.initialize(k, SQRT_PRICE_1_1);
        assertEq(h.poolAdmin(k.toId()), address(0));
    }

    function test_composedBothInitializeLogicsRun() public {
        BothGatesHook h = _bothGates();
        h.setPoolInitializer(address(this), true);
        PoolKey memory k = _key(h, 3000);

        vm.expectEmit(true, true, true, true, address(h));
        emit PoolAdminChanged(k.toId(), address(0), address(this));
        manager.initialize(k, SQRT_PRICE_1_1);
        assertEq(h.poolAdmin(k.toId()), address(this)); // PoolAdminHook ran after the init gate

        // the liquidity gate works on the composed hook
        h.setLiquidityGate(k, true, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(h),
                IHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(
                    LiquidityGateHook.LiquidityNotAllowed.selector,
                    k.toId(),
                    address(modifyLiquidityRouter)
                ),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        modifyLiquidityRouter.modifyLiquidity(k, LIQUIDITY_PARAMS, ZERO_BYTES);
        h.setLiquidityProvider(k, address(modifyLiquidityRouter), true);
        modifyLiquidityRouter.modifyLiquidity(k, LIQUIDITY_PARAMS, ZERO_BYTES);
    }
}
