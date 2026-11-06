// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {HookMiner} from "../../../script/HookMiner.sol";
import {LiquidityGateHook} from "../../../src/hooks/access/LiquidityGateHook.sol";
import {PoolInitGateHook} from "../../../src/hooks/access/PoolInitGateHook.sol";
import {BaseHook} from "../../../src/hooks/base/BaseHook.sol";
import {PoolAdminHook} from "../../../src/hooks/base/PoolAdminHook.sol";
import {LaunchpadHook} from "../../../src/hooks/examples/LaunchpadHook.sol";
import {DecayingFeeHook} from "../../../src/hooks/fee/DecayingFeeHook.sol";
import {SwapFeeHook} from "../../../src/hooks/fee/SwapFeeHook.sol";
import {TwapOracleHook} from "../../../src/hooks/oracle/TwapOracleHook.sol";
import {HookTest} from "../utils/HookTest.sol";

// ---------------------------------------------------------------------- test-only contracts

/// @dev Stand-in for a launch locker: adds a position through its own unlock and has no way to
///      remove it.
contract LaunchLocker is IUnlockCallback {
    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function lock(PoolKey memory key, int24 tickLower, int24 tickUpper, uint256 liquidity)
        external
    {
        manager.unlock(abi.encode(key, tickLower, tickUpper, liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "not manager");
        (PoolKey memory key, int24 lower, int24 upper, uint256 liquidity) =
            abi.decode(data, (PoolKey, int24, int24, uint256));
        (BalanceDelta delta,) = manager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lower,
                tickUpper: upper,
                liquidityDelta: int256(liquidity),
                salt: bytes32(0)
            }),
            ""
        );
        _pay(key.currency0, delta.amount0());
        _pay(key.currency1, delta.amount1());
        return "";
    }

    function _pay(Currency currency, int128 amount) private {
        if (amount >= 0) return;
        manager.sync(currency);
        MockERC20(Currency.unwrap(currency)).transfer(address(manager), uint128(-amount));
        manager.settle();
    }
}

/// @dev The same composition as `LaunchpadHook` with the two fee features in the opposite
///      order. Every observable result must match (the fee merge is commutative, the hook fee
///      is computed from the pool's own delta).
contract LaunchpadHookFeesSwapped is
    PoolInitGateHook,
    LiquidityGateHook,
    TwapOracleHook,
    SwapFeeHook,
    DecayingFeeHook,
    Ownable
{
    constructor(IPoolManager manager, address owner_)
        BaseHook(manager)
        TwapOracleHook(5 minutes, 24)
        Ownable(owner_)
    {}

    function setPoolInitializer(address account, bool allowed) external onlyOwner {
        _setPoolInitializer(account, allowed);
    }

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(PoolInitGateHook, LiquidityGateHook, TwapOracleHook, SwapFeeHook, DecayingFeeHook)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        override(BaseHook, PoolAdminHook, PoolInitGateHook, DecayingFeeHook)
        returns (bytes4)
    {
        return super._beforeInitialize(sender, key, sqrtPriceX96);
    }

    function _afterInitialize(
        address sender,
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        int24 tick
    ) internal override(BaseHook, TwapOracleHook) returns (bytes4) {
        return super._afterInitialize(sender, key, sqrtPriceX96, tick);
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

    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    )
        internal
        override(BaseHook, TwapOracleHook, DecayingFeeHook)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return super._beforeSwap(sender, key, params, hookData);
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal override(BaseHook, SwapFeeHook) returns (bytes4, int128) {
        return super._afterSwap(sender, key, params, delta, hookData);
    }
}

/// @dev A stub feature that asks for a constant LP fee floor, to show the max merge of two LP
///      fee overrides on top of a finished composition.
abstract contract LpFeeFloorStub is BaseHook {
    uint24 internal constant FLOOR_FEE = 20_000;

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        virtual
        override
        returns (bytes4 sel, BeforeSwapDelta delta, uint24 fee)
    {
        (sel, delta, fee) = super._beforeSwap(s, k, sp, d);
        fee = _mergeLpFeeOverride(fee, FLOOR_FEE | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}

/// @dev `LaunchpadHook` extended by one more feature: a concrete hook is itself composable.
///      `LpFeeFloorStub` opens a second path to `BaseHook`, so every callback is re-declared
///      again (rule 6); only `_beforeSwap` names the stub.
contract FlooredLaunchpadHook is LaunchpadHook, LpFeeFloorStub {
    constructor(IPoolManager manager, address owner_) LaunchpadHook(manager, owner_) {}

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(BaseHook, LaunchpadHook)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        internal
        override(BaseHook, LaunchpadHook)
        returns (bytes4)
    {
        return super._beforeInitialize(sender, key, sqrtPriceX96);
    }

    function _afterInitialize(
        address sender,
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        int24 tick
    ) internal override(BaseHook, LaunchpadHook) returns (bytes4) {
        return super._afterInitialize(sender, key, sqrtPriceX96, tick);
    }

    function _beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) internal override(BaseHook, LaunchpadHook) returns (bytes4) {
        return super._beforeAddLiquidity(sender, key, params, hookData);
    }

    function _beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) internal override(BaseHook, LaunchpadHook) returns (bytes4) {
        return super._beforeRemoveLiquidity(sender, key, params, hookData);
    }

    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) internal override(LaunchpadHook, LpFeeFloorStub) returns (bytes4, BeforeSwapDelta, uint24) {
        return super._beforeSwap(sender, key, params, hookData);
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal override(BaseHook, LaunchpadHook) returns (bytes4, int128) {
        return super._afterSwap(sender, key, params, delta, hookData);
    }
}

// ---------------------------------------------------------------------- tests

/// @dev Shared launch-flow tests; each concrete test contract picks the hook artifact.
abstract contract LaunchpadHookTestBase is HookTest {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG
        | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
        | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    uint24 internal constant START_FEE = 50_000; // 5%
    uint24 internal constant END_FEE = 10_000; // 1%
    uint32 internal constant DECAY = 1 hours;
    uint16 internal constant HOOK_FEE_BPS = 100; // 1%
    int24 internal constant SPACING = 60;
    int24 internal constant LOWER = 60;
    int24 internal constant UPPER = 887_220;
    uint256 internal constant LAUNCH_LIQUIDITY = 100e18;

    LaunchpadHook internal hook;
    LaunchLocker internal locker;
    PoolKey internal launchKey;
    PoolId internal launchId;
    uint256 internal launchTime;

    address internal owner = makeAddr("owner");
    address internal factory = makeAddr("factory");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");

    /// @dev "File.sol:Contract" of the hook under test.
    function _artifact() internal pure virtual returns (string memory);

    function setUp() public virtual {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        hook = LaunchpadHook(_deployHook(_artifact(), abi.encode(manager, owner), FLAGS));
        locker = new LaunchLocker(manager);
        MockERC20(Currency.unwrap(currency0)).transfer(address(locker), 1000e18);
        launchKey = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, SPACING, hook);
        launchId = launchKey.toId();
    }

    // -------------------------------------------------------------- helpers

    /// @dev The full launch: owner allows the factory; the factory creates and configures the
    ///      pool, the locker adds single-sided liquidity in currency0, the factory renounces.
    function _launch() internal {
        _launch(false);
    }

    function _launch(bool asClaims) internal {
        vm.prank(owner);
        hook.setPoolInitializer(factory, true);

        vm.startPrank(factory);
        manager.initialize(launchKey, SQRT_PRICE_1_1);
        hook.setDecayingFee(launchKey, START_FEE, END_FEE, DECAY, 0);
        hook.setSwapFee(launchKey, HOOK_FEE_BPS, recipient, asClaims);
        hook.setLiquidityGate(launchKey, true, true);
        hook.setLiquidityProvider(launchKey, address(locker), true);
        vm.stopPrank();

        locker.lock(launchKey, LOWER, UPPER, LAUNCH_LIQUIDITY);

        vm.prank(factory);
        hook.transferPoolAdmin(launchKey, address(0));
        launchTime = block.timestamp;
    }

    /// @dev Swaps through the router and returns the pool's own amounts and LP fee from the
    ///      pool manager's `Swap` event.
    function _swap(bool zeroForOne, int256 amountSpecified)
        internal
        returns (int128 a0, int128 a1, uint24 lpFee)
    {
        vm.recordLogs();
        swap(launchKey, zeroForOne, amountSpecified, ZERO_BYTES);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(manager)
                    && logs[i].topics[0] == IPoolManager.Swap.selector
            ) {
                (a0, a1,,,, lpFee) = abi.decode(
                    logs[i].data, (int128, int128, uint160, uint128, int24, uint24)
                );
                found = true;
            }
        }
        assertTrue(found, "no Swap event");
    }

    function _abs(int128 x) internal pure returns (uint256) {
        return x < 0 ? uint256(uint128(-x)) : uint256(uint128(x));
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// @dev Reference decay formula from the DecayingFeeHook spec.
    function _expectedLpFee(uint256 elapsed) internal pure returns (uint24) {
        if (elapsed >= DECAY) return END_FEE;
        uint256 remaining = DECAY - elapsed;
        return uint24(END_FEE + _ceilDiv(uint256(START_FEE - END_FEE) * remaining, DECAY));
    }

    function _balance(Currency c, address who) internal view returns (uint256) {
        return c.balanceOf(who);
    }

    function _tick() internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(launchId);
    }

    function _wrapped(bytes4 callback, bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            callback,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    // -------------------------------------------------------------- (1) permissions

    function test_permissions_mergedFlagSet() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize);
        assertTrue(p.afterInitialize);
        assertTrue(p.beforeAddLiquidity);
        assertFalse(p.afterAddLiquidity);
        assertTrue(p.beforeRemoveLiquidity);
        assertFalse(p.afterRemoveLiquidity);
        assertTrue(p.beforeSwap);
        assertTrue(p.afterSwap);
        assertFalse(p.beforeDonate);
        assertFalse(p.afterDonate);
        assertFalse(p.beforeSwapReturnDelta);
        assertTrue(p.afterSwapReturnDelta);
        assertFalse(p.afterAddLiquidityReturnDelta);
        assertFalse(p.afterRemoveLiquidityReturnDelta);
        assertEq(_flags(p), FLAGS);
        assertEq(uint160(address(hook)) & ALL_HOOK_MASK, FLAGS);
    }

    function test_constructor_revertsAtWrongAddress() public {
        // Every flag set but one: the address no longer encodes the merged permissions.
        address wrong = _hookAddress(FLAGS & ~Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        bytes memory code = abi.encodePacked(vm.getCode(_artifact()), abi.encode(manager, owner));
        vm.etch(wrong, code);
        (bool ok, bytes memory ret) = wrong.call("");
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, wrong));
    }

    function test_constructor_minedSaltDeploys() public {
        bytes memory creation = vm.getCode(_artifact());
        bytes memory args = abi.encode(manager, owner);
        (address predicted, bytes32 salt) = HookMiner.find(address(this), FLAGS, creation, args);
        bytes memory initCode = abi.encodePacked(creation, args);
        address deployed;
        assembly ("memory-safe") {
            deployed := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        assertEq(deployed, predicted);
        assertEq(LaunchpadHook(deployed).owner(), owner);
    }

    // -------------------------------------------------------------- (2) launch flow

    function test_launch_flow() public {
        _launch();
        assertEq(hook.poolAdmin(launchId), address(0), "admin renounced");
        assertTrue(hook.isPoolInitializer(factory));
        (uint128 liquidity,,) =
            manager.getPositionInfo(launchId, address(locker), LOWER, UPPER, bytes32(0));
        assertEq(liquidity, LAUNCH_LIQUIDITY, "locked position");
        // Single-sided: the position is entirely above the price, so it holds only currency0.
        assertLt(_tick(), LOWER);
        assertEq(manager.getLiquidity(launchId), 0);
        assertEq(hook.currentFee(launchId), START_FEE);
    }

    function test_launch_adminIsTheFactoryBeforeRenounce() public {
        vm.prank(owner);
        hook.setPoolInitializer(factory, true);
        vm.prank(factory);
        manager.initialize(launchKey, SQRT_PRICE_1_1);
        assertEq(hook.poolAdmin(launchId), factory);
    }

    function test_launch_staticFeePoolReverts() public {
        vm.prank(owner);
        hook.setPoolInitializer(factory, true);
        PoolKey memory k = PoolKey(currency0, currency1, 3000, SPACING, hook);
        vm.prank(factory);
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(DecayingFeeHook.NotDynamicFee.selector)
            )
        );
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_setPoolInitializer_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        hook.setPoolInitializer(stranger, true);
    }

    // -------------------------------------------------------------- (3) swaps

    function test_swap_launchFeeDecaysInSwapEvent() public virtual {
        _launch();
        (,, uint24 fee) = _swap(false, -1e18);
        assertEq(fee, START_FEE, "t0");

        vm.warp(launchTime + DECAY / 2);
        (,, fee) = _swap(false, -1e18);
        assertEq(fee, _expectedLpFee(DECAY / 2), "mid");
        assertEq(fee, 30_000);

        vm.warp(launchTime + DECAY + 1);
        (,, fee) = _swap(true, -1e17);
        assertEq(fee, END_FEE, "after");
    }

    function test_swap_hookFeeExactInBuy() public {
        _launch();
        uint256 r0 = _balance(currency0, recipient);
        uint256 t0 = _balance(currency0, address(this));
        uint256 t1 = _balance(currency1, address(this));

        (int128 a0, int128 a1,) = _swap(false, -1e18);

        // Exact-in buy: the unspecified currency is currency0 (the output).
        uint256 fee = _ceilDiv(_abs(a0) * HOOK_FEE_BPS, 10_000);
        assertGt(fee, 0);
        assertEq(_balance(currency0, recipient) - r0, fee, "recipient");
        assertEq(_balance(currency0, address(this)) - t0, _abs(a0) - fee, "trader out");
        assertEq(t1 - _balance(currency1, address(this)), _abs(a1), "trader in");
        assertEq(_balance(currency1, recipient), 0);
    }

    /// @dev Token settlement, exact-out buy after an earlier buy: the fee is on the input side,
    ///      so it is paid as claims even though the manager now holds currency1.
    function test_swap_hookFeeExactOutBuy() public {
        _launch();
        _swap(false, -1e18);
        uint256 r1 = _balance(currency1, recipient);
        uint256 t0 = _balance(currency0, address(this));
        uint256 t1 = _balance(currency1, address(this));

        (int128 a0, int128 a1,) = _swap(false, 1e17);

        // Exact-out buy: the unspecified currency is currency1 (the input).
        uint256 fee = _ceilDiv(_abs(a1) * HOOK_FEE_BPS, 10_000);
        assertEq(manager.balanceOf(recipient, currency1.toId()), fee, "recipient claims");
        assertEq(_balance(currency1, recipient), r1, "no tokens");
        assertEq(t1 - _balance(currency1, address(this)), _abs(a1) + fee, "trader in");
        assertEq(_balance(currency0, address(this)) - t0, _abs(a0), "trader out");
    }

    /// @dev Claims settlement mints instead of transferring, so it also works for the first
    ///      exact-output buy of a fresh single-sided pool (the manager holds no currency1 yet).
    function test_swap_hookFeeAsClaimsExactOutOnFreshPool() public {
        _launch(true);
        assertEq(currency1.balanceOf(address(manager)), 0);
        (, int128 a1,) = _swap(false, 1e17);
        uint256 fee = _ceilDiv(_abs(a1) * HOOK_FEE_BPS, 10_000);
        assertGt(fee, 0);
        assertEq(manager.balanceOf(recipient, currency1.toId()), fee, "claims");
        assertEq(_balance(currency1, recipient), 0, "no tokens");
    }

    /// @dev Token settlement on the first exact-output buy of a fresh single-sided pool: the fee
    ///      is in currency1, which the manager does not hold yet, so it is minted as claims
    ///      instead of taken (taking it would revert). The swap succeeds.
    function test_swap_hookFeeAsTokensExactOutOnFreshPoolPaysClaims() public {
        _launch(false);
        assertEq(currency1.balanceOf(address(manager)), 0);
        uint256 t1 = _balance(currency1, address(this));
        (, int128 a1,) = _swap(false, 1e17);
        uint256 fee = _ceilDiv(_abs(a1) * HOOK_FEE_BPS, 10_000);
        assertGt(fee, 0);
        assertEq(manager.balanceOf(recipient, currency1.toId()), fee, "claims");
        assertEq(_balance(currency1, recipient), 0, "no tokens");
        assertEq(t1 - _balance(currency1, address(this)), _abs(a1) + fee, "trader in");
        assertEq(currency1.balanceOf(address(manager)), _abs(a1) + fee, "claims backed");
    }

    /// @dev Token settlement on the first exact-input buy of a fresh pool: the fee is in the
    ///      output (currency0, held by the manager as launch liquidity) and paid as tokens.
    function test_swap_hookFeeAsTokensExactInOnFreshPoolPaysTokens() public {
        _launch(false);
        assertEq(currency1.balanceOf(address(manager)), 0);
        (int128 a0,,) = _swap(false, -1e17);
        uint256 fee = _ceilDiv(_abs(a0) * HOOK_FEE_BPS, 10_000);
        assertGt(fee, 0);
        assertEq(_balance(currency0, recipient), fee, "tokens");
        assertEq(manager.balanceOf(recipient, currency0.toId()), 0, "no claims");
    }

    function test_swap_hookFeeExactInSell() public {
        _launch();
        _swap(false, -2e18);
        uint256 r1 = _balance(currency1, recipient);
        (, int128 a1,) = _swap(true, -1e17);
        assertEq(_balance(currency1, recipient) - r1, _ceilDiv(_abs(a1) * HOOK_FEE_BPS, 10_000));
    }

    function test_swap_twapAvailableAfterWindow() public {
        _launch();
        uint32 window = 30 minutes;
        (bool ok,,) = hook.twapTick(launchId, window);
        assertFalse(ok, "no history yet");

        vm.warp(launchTime + 10 minutes);
        _swap(false, -1e18);
        int24 t1 = _tick();
        assertGt(t1, 0);

        vm.warp(launchTime + 20 minutes);
        (ok,,) = hook.twapTick(launchId, window);
        assertFalse(ok, "history shorter than the window");

        vm.warp(launchTime + 35 minutes);
        uint32 span;
        int24 avg;
        (ok, avg, span) = hook.twapTick(launchId, window);
        assertTrue(ok, "available");
        assertEq(span, 35 minutes);
        // Tick 0 held for 10 minutes, then t1 for 25 minutes.
        assertEq(avg, int24((int256(t1) * 25 minutes) / int256(uint256(35 minutes))));
        assertGt(hook.observationCount(launchId), 1);
    }

    /// @dev Fuzz the buy size and the time of the swap: the LP fee follows the reference decay
    ///      and the hook fee is exactly ceil(output * bps / 10_000).
    function testFuzz_swap_feesFollowSchedule(uint256 amountIn, uint256 elapsed) public virtual {
        amountIn = bound(amountIn, 1e6, 5e18);
        elapsed = bound(elapsed, 0, 2 * DECAY);
        _launch();
        vm.warp(launchTime + elapsed);
        uint256 r0 = _balance(currency0, recipient);
        (int128 a0,, uint24 lpFee) = _swap(false, -int256(amountIn));
        assertEq(lpFee, _expectedLpFee(elapsed), "lp fee");
        uint256 fee = _ceilDiv(_abs(a0) * HOOK_FEE_BPS, 10_000);
        assertEq(_balance(currency0, recipient) - r0, fee, "hook fee");
        assertLe(fee, _abs(a0));
    }

    // -------------------------------------------------------------- (4) gates and freeze

    function test_removeLiquidity_blocked() public {
        _launch();
        ModifyLiquidityParams memory remove = ModifyLiquidityParams({
            tickLower: LOWER, tickUpper: UPPER, liquidityDelta: -1, salt: bytes32(0)
        });
        vm.expectRevert(
            _wrapped(
                IHooks.beforeRemoveLiquidity.selector,
                abi.encodeWithSelector(
                    LiquidityGateHook.LiquidityNotAllowed.selector,
                    launchId,
                    address(modifyLiquidityRouter)
                )
            )
        );
        modifyLiquidityRouter.modifyLiquidity(launchKey, remove, ZERO_BYTES);
    }

    function test_addLiquidity_blockedForOthers() public {
        _launch();
        ModifyLiquidityParams memory add = ModifyLiquidityParams({
            tickLower: LOWER, tickUpper: UPPER, liquidityDelta: 1e18, salt: bytes32(0)
        });
        vm.expectRevert(
            _wrapped(
                IHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(
                    LiquidityGateHook.LiquidityNotAllowed.selector,
                    launchId,
                    address(modifyLiquidityRouter)
                )
            )
        );
        modifyLiquidityRouter.modifyLiquidity(launchKey, add, ZERO_BYTES);
    }

    function test_initialize_foreignInitializerBlocked() public {
        _launch();
        PoolKey memory k =
            PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, SPACING * 2, hook);
        vm.prank(stranger);
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(PoolInitGateHook.InitializerNotAllowed.selector, stranger)
            )
        );
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_initialize_disallowedFactoryBlocked() public {
        _launch();
        vm.prank(owner);
        hook.setPoolInitializer(factory, false);
        PoolKey memory k =
            PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, SPACING * 2, hook);
        vm.prank(factory);
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(PoolInitGateHook.InitializerNotAllowed.selector, factory)
            )
        );
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_config_frozenAfterRenounce() public {
        _launch();
        address[3] memory callers = [factory, owner, stranger];
        for (uint256 i; i < callers.length; ++i) {
            bytes memory err =
                abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, launchId, callers[i]);
            vm.startPrank(callers[i]);
            vm.expectRevert(err);
            hook.setDecayingFee(launchKey, 0, 0, 0, 0);
            vm.expectRevert(err);
            hook.setSwapFee(launchKey, 0, address(0), false);
            vm.expectRevert(err);
            hook.setLiquidityGate(launchKey, false, false);
            vm.expectRevert(err);
            hook.setLiquidityProvider(launchKey, callers[i], true);
            vm.expectRevert(err);
            hook.transferPoolAdmin(launchKey, callers[i]);
            vm.stopPrank();
        }
    }

    function test_config_onlyAdminBeforeRenounce() public {
        vm.prank(owner);
        hook.setPoolInitializer(factory, true);
        vm.prank(factory);
        manager.initialize(launchKey, SQRT_PRICE_1_1);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, launchId, owner)
        );
        hook.setSwapFee(launchKey, HOOK_FEE_BPS, owner, false);
    }

    function test_callbacks_onlyPoolManager() public {
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.beforeInitialize(address(this), launchKey, SQRT_PRICE_1_1);
    }
}

contract LaunchpadHookTest is LaunchpadHookTestBase {
    function _artifact() internal pure override returns (string memory) {
        return "LaunchpadHook.sol:LaunchpadHook";
    }
}

/// @dev (5) The fee features in the other inheritance order give identical results.
contract LaunchpadHookFeesSwappedTest is LaunchpadHookTestBase {
    function _artifact() internal pure override returns (string memory) {
        return "LaunchpadHook.t.sol:LaunchpadHookFeesSwapped";
    }
}

/// @dev Max merge of two LP fee overrides on top of the composition: the launch fee while it is
///      above the floor, then the floor.
contract FlooredLaunchpadHookTest is LaunchpadHookTestBase {
    function _artifact() internal pure override returns (string memory) {
        return "LaunchpadHook.t.sol:FlooredLaunchpadHook";
    }

    function _expectedFlooredFee(uint256 elapsed) internal pure returns (uint24) {
        uint24 f = _expectedLpFee(elapsed);
        return f > 20_000 ? f : 20_000;
    }

    function test_swap_maxMergeWithFloor() public {
        _launch();
        (,, uint24 fee) = _swap(false, -1e18);
        assertEq(fee, START_FEE);
        vm.warp(launchTime + DECAY + 1);
        (,, fee) = _swap(false, -1e18);
        assertEq(fee, 20_000, "floor wins over the decayed fee");
    }

    /// @dev Overrides the inherited schedule test: past the point where the decay drops below
    ///      the floor, the floor is the fee.
    function test_swap_launchFeeDecaysInSwapEvent() public override {
        _launch();
        vm.warp(launchTime + (DECAY * 3) / 4);
        (,, uint24 fee) = _swap(false, -1e18);
        assertEq(fee, 20_000);
    }

    function testFuzz_swap_feesFollowSchedule(uint256 amountIn, uint256 elapsed) public override {
        amountIn = bound(amountIn, 1e6, 5e18);
        elapsed = bound(elapsed, 0, 2 * DECAY);
        _launch();
        vm.warp(launchTime + elapsed);
        (,, uint24 lpFee) = _swap(false, -int256(amountIn));
        assertEq(lpFee, _expectedFlooredFee(elapsed));
    }
}
