// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {BaseHook} from "../../../src/hooks/base/BaseHook.sol";
import {FeeConversionHook} from "../../../src/hooks/conversion/FeeConversionHook.sol";
import {HookTest} from "../utils/HookTest.sol";

// ---------------------------------------------------------------------- test features

/// @dev Stand-in for `SwapFeeHook` (DESIGN.md section 2) until it lands: 1% (rounded up) of the
///      unspecified side, minted to this hook as ERC-6909 claims, then `_onSwapFeeTaken`.
abstract contract MockSwapFee is BaseHook {
    uint256 internal constant MOCK_FEE_BPS = 100;

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        virtual
        override
        returns (Hooks.Permissions memory)
    {
        p = super._hookPermissions(p);
        p.afterSwap = true;
        p.afterSwapReturnDelta = true;
        return p;
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal virtual override returns (bytes4 sel, int128 hookDelta) {
        (sel, hookDelta) = super._afterSwap(sender, key, params, delta, hookData);
        (Currency c, uint256 gross) = _unspecified(key, params, delta);
        uint256 fee = (gross * MOCK_FEE_BPS + 9999) / 10_000;
        if (fee == 0) return (sel, hookDelta);
        poolManager.mint(address(this), c.toId(), fee);
        hookDelta += int128(int256(fee));
        _onSwapFeeTaken(sender, key, c, fee, address(this), true);
    }

    function _onSwapFeeTaken(address, PoolKey calldata, Currency, uint256, address, bool)
        internal
        virtual {}
}

/// @dev Counts its callbacks, to prove every feature of the chain runs once per swap.
abstract contract SwapCounter is BaseHook {
    uint256 public beforeSwaps;
    uint256 public afterSwaps;

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

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        virtual
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        ++beforeSwaps;
        return super._beforeSwap(s, k, sp, d);
    }

    function _afterSwap(
        address s,
        PoolKey calldata k,
        SwapParams calldata sp,
        BalanceDelta bd,
        bytes calldata d
    ) internal virtual override returns (bytes4 sel, int128 hookDelta) {
        (sel, hookDelta) = super._afterSwap(s, k, sp, bd, d);
        ++afterSwaps;
    }
}

/// @dev Code reached during a conversion (through `_onFeeConverted`).
contract ReentryProbe {
    enum Mode {
        None,
        Retry,
        Swap,
        Revert
    }

    IPoolManager public immutable manager;
    Mode public mode;
    FeeConversionHook public hook;
    PoolKey internal _swapKey;
    bytes32 public bucket;
    Currency public currency;
    bytes public lastError;
    uint256 public pokes;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function arm(Mode m, FeeConversionHook h, PoolKey memory k, bytes32 b, Currency c) external {
        mode = m;
        hook = h;
        _swapKey = k;
        bucket = b;
        currency = c;
        delete lastError;
    }

    function poke() external {
        ++pokes;
        if (mode == Mode.Retry) {
            try hook.retryHeld(bucket, currency, 1) {}
            catch (bytes memory e) {
                lastError = e;
            }
        } else if (mode == Mode.Swap) {
            manager.swap(
                _swapKey,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -1000,
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                ""
            );
        } else if (mode == Mode.Revert) {
            revert("probe");
        }
    }
}

/// @dev Test concrete: a counter, the fee stand-in and the conversion, composed by rule 6. The
///      guard is a per-hop reference tick with in-swap and retry bounds (open setters: test
///      only).
contract ConvertingTestHook is SwapCounter, MockSwapFee, FeeConversionHook {
    struct Guard {
        bool set;
        int24 referenceTick;
        uint24 inSwapDeviationTicks;
        uint16 inSwapSlippageBps;
        uint24 retryDeviationTicks;
        uint16 retrySlippageBps;
    }

    error GuardNotSet();

    mapping(PoolId => Guard) public guards;
    address public payout;
    ReentryProbe public probe;

    constructor(IPoolManager m, Currency target) BaseHook(m) FeeConversionHook(target) {}

    function setRoute(Currency from, PoolKey[] calldata route) external {
        _setConversionRoute(from, route);
    }

    function clearRoute(Currency from) external {
        _clearConversionRoute(from);
    }

    function setGuard(PoolKey calldata hop, Guard calldata g) external {
        guards[hop.toId()] = g;
    }

    function setPayout(address p) external {
        payout = p;
    }

    function setProbe(ReentryProbe p) external {
        probe = p;
    }

    function convertOrHoldOutsideSwap(bytes32 b, Currency c, uint256 a) external {
        _convertOrHold(b, c, a);
    }

    function _onSwapFeeTaken(
        address sender,
        PoolKey calldata key,
        Currency currency,
        uint256 amount,
        address recipient,
        bool asClaims
    ) internal override {
        super._onSwapFeeTaken(sender, key, currency, amount, recipient, asClaims);
        if (recipient == address(this) && asClaims) {
            _convertOrHold(PoolId.unwrap(key.toId()), currency, amount);
        }
    }

    function _hopMinOutput(
        PoolKey memory hop,
        bool zeroForOne,
        uint256 amountIn,
        uint160 sqrtPriceX96,
        int24 spotTick,
        bool inSwap
    ) internal view override returns (uint256) {
        Guard memory g = guards[hop.toId()];
        if (!g.set) revert GuardNotSet();
        ReferenceGuard memory r = ReferenceGuard(
            g.referenceTick,
            inSwap ? g.inSwapDeviationTicks : g.retryDeviationTicks,
            inSwap ? g.inSwapSlippageBps : g.retrySlippageBps,
            _hopSwapFeePips(hop, zeroForOne)
        );
        return _minOutFromReference(amountIn, zeroForOne, sqrtPriceX96, spotTick, r);
    }

    function _conversionRecipient(bytes32) internal view override returns (address) {
        return payout;
    }

    function _onFeeConverted(bytes32 b, Currency c, uint256 i, uint256 o, bool s)
        internal
        override
    {
        super._onFeeConverted(b, c, i, o, s);
        if (address(probe) != address(0)) probe.poke();
    }

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(SwapCounter, MockSwapFee, FeeConversionHook)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _afterSwap(
        address s,
        PoolKey calldata k,
        SwapParams calldata sp,
        BalanceDelta bd,
        bytes calldata d
    ) internal override(BaseHook, SwapCounter, MockSwapFee) returns (bytes4, int128) {
        return super._afterSwap(s, k, sp, bd, d);
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        override(BaseHook, SwapCounter)
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return super._beforeSwap(s, k, sp, d);
    }

    function _usesSwapLock() internal pure override(BaseHook, FeeConversionHook) returns (bool) {
        return super._usesSwapLock();
    }
}

/// @dev The feature on its own: no fee feeds it, so it only holds the swap lock. Exposes the
///      guard math.
contract BareConversionHook is FeeConversionHook {
    constructor(IPoolManager m, Currency target) BaseHook(m) FeeConversionHook(target) {}

    function minOutFromReference(
        uint256 amountIn,
        bool zeroForOne,
        uint160 sqrtSpot,
        int24 spotTick,
        int24 referenceTick,
        uint256 maxDeviationTicks,
        uint256 maxSlippageBps,
        uint256 hopFeePips
    ) external pure returns (uint256) {
        return _minOutFromReference(
            amountIn,
            zeroForOne,
            sqrtSpot,
            spotTick,
            referenceTick,
            maxDeviationTicks,
            maxSlippageBps,
            hopFeePips
        );
    }

    function quoteAtPrice(uint256 amountIn, uint160 sqrtPriceX96, bool zeroForOne)
        external
        pure
        returns (uint256)
    {
        return _quoteAtPrice(amountIn, sqrtPriceX96, zeroForOne);
    }

    function gasRequired() external pure returns (uint256 pre, uint256 budget, uint256 reserve) {
        return (_conversionPreTryGas(), _conversionGasBudget(), _conversionFallbackReserve());
    }

    function _hopMinOutput(PoolKey memory, bool, uint256, uint160, int24, bool)
        internal
        pure
        override
        returns (uint256)
    {
        return type(uint256).max; // no guard: every conversion fails and is held
    }

    function _conversionRecipient(bytes32) internal pure override returns (address) {
        return address(0);
    }
}

/// @dev Syncs the input currency, swaps, then pays and settles: the swap runs while a currency
///      is synced on the pool manager.
contract SyncedSwapRouter is IUnlockCallback {
    IPoolManager internal immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function swapExactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn) external {
        manager.unlock(abi.encode(msg.sender, key, zeroForOne, amountIn));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (address payer, PoolKey memory key, bool zeroForOne, uint256 amountIn) =
            abi.decode(data, (address, PoolKey, bool, uint256));
        (Currency cin, Currency cout) =
            zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        manager.sync(cin);
        BalanceDelta d = manager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        MockERC20(Currency.unwrap(cin)).transferFrom(payer, address(manager), amountIn);
        manager.settle();
        int128 out = zeroForOne ? d.amount1() : d.amount0();
        manager.take(cout, payer, uint256(uint128(out)));
        return "";
    }
}

/// @dev Calls `retryHeld` from inside its own pool manager unlock.
contract RetryInUnlock is IUnlockCallback {
    IPoolManager internal immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function run(FeeConversionHook hook, bytes32 b, Currency c, uint256 a) external {
        manager.unlock(abi.encode(hook, b, c, a));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (FeeConversionHook hook, bytes32 b, Currency c, uint256 a) =
            abi.decode(data, (FeeConversionHook, bytes32, Currency, uint256));
        hook.retryHeld(b, c, a);
        return "";
    }
}

// ---------------------------------------------------------------------- tests

contract FeeConversionHookTest is HookTest {
    using StateLibrary for IPoolManager;

    uint256 internal constant SWAP_IN = 1e18;
    uint128 internal constant ROUTE_LIQUIDITY = 1e21;

    ConvertingTestHook internal hook;
    ReentryProbe internal probe;
    address internal payout = makeAddr("payout");

    Currency internal tX; // traded token
    Currency internal tQ; // fee currency (quote of the hook pool)
    Currency internal tM; // middle hop
    Currency internal tT; // conversion target

    PoolKey internal hookPool; // X/Q with the hook
    PoolKey internal hookPoolT; // X/T with the hook (fee already in the target)
    PoolKey internal qt; // Q/T hookless
    PoolKey internal qm; // Q/M hookless
    PoolKey internal mt; // M/T hookless
    bytes32 internal bucket;

    function setUp() public {
        deployFreshManagerAndRouters();
        tX = deployMintAndApproveCurrency();
        tQ = deployMintAndApproveCurrency();
        tM = deployMintAndApproveCurrency();
        tT = deployMintAndApproveCurrency();

        hook = ConvertingTestHook(
            _deployHook(
                "FeeConversionHook.t.sol:ConvertingTestHook",
                abi.encode(manager, tT),
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            )
        );
        probe = new ReentryProbe(manager);
        hook.setPayout(payout);

        hookPool = _pool(tX, tQ, 3000, 60, IHooks(address(hook)), 1e21);
        hookPoolT = _pool(tX, tT, 3000, 60, IHooks(address(hook)), 1e21);
        qt = _pool(tQ, tT, 500, 10, IHooks(address(0)), ROUTE_LIQUIDITY);
        qm = _pool(tQ, tM, 500, 10, IHooks(address(0)), ROUTE_LIQUIDITY);
        mt = _pool(tM, tT, 500, 10, IHooks(address(0)), ROUTE_LIQUIDITY);
        bucket = PoolId.unwrap(hookPool.toId());

        _guard(qt);
        _guard(qm);
        _guard(mt);
        _route1(tQ, qt);
    }

    // ------------------------------------------------------------------ helpers

    function _sorted(Currency a, Currency b) internal pure returns (Currency, Currency) {
        return Currency.unwrap(a) < Currency.unwrap(b) ? (a, b) : (b, a);
    }

    function _pool(
        Currency a,
        Currency b,
        uint24 fee,
        int24 spacing,
        IHooks hooks,
        uint128 liquidity
    ) internal returns (PoolKey memory k) {
        (Currency c0, Currency c1) = _sorted(a, b);
        k = PoolKey(c0, c1, fee, spacing, hooks);
        manager.initialize(k, SQRT_PRICE_1_1);
        int24 range = spacing * 100;
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams(-range, range, int256(uint256(liquidity)), 0), ""
        );
    }

    function _guard(PoolKey memory k) internal {
        hook.setGuard(k, ConvertingTestHook.Guard(true, 0, 100, 100, 2000, 500));
    }

    function _route1(Currency from, PoolKey memory a) internal {
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = a;
        hook.setRoute(from, r);
    }

    function _route2(Currency from, PoolKey memory a, PoolKey memory b) internal {
        PoolKey[] memory r = new PoolKey[](2);
        r[0] = a;
        r[1] = b;
        hook.setRoute(from, r);
    }

    /// @dev Exact-input swap on `k` selling `sell`.
    function _swapSell(PoolKey memory k, Currency sell, uint256 amountIn)
        internal
        returns (BalanceDelta)
    {
        return swap(k, sell == k.currency0, -int256(amountIn), "");
    }

    /// @dev Sells X for Q on the hook pool: the fee is in Q (the unspecified output).
    function _tradeForFee() internal returns (BalanceDelta) {
        return _swapSell(hookPool, tX, SWAP_IN);
    }

    function _bal(Currency c, address who) internal view returns (uint256) {
        return c.balanceOf(who);
    }

    function _claims(Currency c) internal view returns (uint256) {
        return manager.balanceOf(address(hook), c.toId());
    }

    function _assertInvariant(Currency c) internal view {
        assertEq(_claims(c), hook.totalHeld(c), "claims == totalHeld");
    }

    function _tick(PoolKey memory k) internal view returns (int24 t) {
        (, t,,) = manager.getSlot0(k.toId());
    }

    /// @dev Moves `k`'s price by selling `amount` of `sell`.
    function _push(PoolKey memory k, Currency sell, uint256 amount) internal {
        _swapSell(k, sell, amount);
    }

    /// @dev Swap that holds its fee (route pool pushed out of the in-swap band).
    function _holdOneFee() internal returns (uint256 held) {
        _push(qt, tQ, 1e19);
        _tradeForFee();
        held = hook.heldFees(bucket, tQ);
        assertGt(held, 0, "held");
    }

    // ------------------------------------------------------------------ permissions

    function test_permissions_bareFeature() public {
        BareConversionHook bare = BareConversionHook(
            _deployHook(
                "FeeConversionHook.t.sol:BareConversionHook",
                abi.encode(manager, tT),
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            )
        );
        Hooks.Permissions memory p = bare.getHookPermissions();
        assertEq(_flags(p), Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        assertEq(Currency.unwrap(bare.conversionTarget()), Currency.unwrap(tT));
        assertEq(bare.MAX_ROUTE_HOPS(), 3);

        // Neutral on its own: a swap goes through and moves nothing to the hook.
        PoolKey memory k = _pool(tX, tQ, 3000, 60, IHooks(address(bare)), 1e21);
        _swapSell(k, tX, SWAP_IN);
        assertEq(manager.balanceOf(address(bare), tQ.toId()), 0);
    }

    function test_permissions_wrongAddressReverts() public {
        address at = _hookAddress(Hooks.AFTER_SWAP_FLAG);
        vm.expectRevert();
        deployCodeTo("FeeConversionHook.t.sol:BareConversionHook", abi.encode(manager, tT), at);
    }

    function test_permissions_composedMergesFlags() public view {
        assertEq(
            _flags(hook.getHookPermissions()),
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
    }

    function test_gasRequired_default() public {
        BareConversionHook bare = BareConversionHook(
            _deployHook(
                "FeeConversionHook.t.sol:BareConversionHook",
                abi.encode(manager, tT),
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            )
        );
        (uint256 pre, uint256 budget, uint256 reserve) = bare.gasRequired();
        assertEq(bare.conversionGasRequired(), pre + budget * 64 / 63 + reserve);
        assertEq(bare.conversionGasRequired(), 770_317);
    }

    // ------------------------------------------------------------------ in-swap conversion

    function test_inSwap_convertsOneHop() public {
        uint256 before = _bal(tT, payout);
        vm.expectEmit(true, true, false, false, address(hook));
        emit FeeConversionHook.FeeConverted(bucket, tQ, 0, 0, true);
        _tradeForFee();

        uint256 got = _bal(tT, payout) - before;
        assertGt(got, 0, "paid");
        assertEq(hook.heldFees(bucket, tQ), 0);
        assertEq(hook.totalHeld(tQ), 0);
        _assertInvariant(tQ);
        _assertInvariant(tT);
        // Every feature in the chain ran exactly once.
        assertEq(hook.beforeSwaps(), 1);
        assertEq(hook.afterSwaps(), 1);
    }

    function test_inSwap_convertsTwoHops() public {
        _route2(tQ, qm, mt);
        PoolKey[] memory r = hook.conversionRoute(tQ);
        assertEq(r.length, 2);

        uint256 before = _bal(tT, payout);
        _tradeForFee();
        uint256 got = _bal(tT, payout) - before;
        assertGt(got, 0);
        assertEq(hook.totalHeld(tQ), 0);
        _assertInvariant(tQ);
        assertEq(manager.balanceOf(address(hook), tM.toId()), 0);
    }

    function test_inSwap_outputMatchesHopPrice() public {
        vm.recordLogs();
        _tradeForFee();
        (uint256 amountIn, uint256 amountOut, bool inSwap) = _lastConverted();
        assertTrue(inSwap);
        assertEq(_bal(tT, payout), amountOut, "payout == amountOut");
        // 1:1 route pool with a 5 bps fee and deep liquidity: out is just under the input.
        assertLe(amountOut, amountIn);
        assertGe(amountOut, (amountIn * 9994) / 10_000);
    }

    function test_inSwap_feeInTargetPaysWithoutRoute() public {
        uint256 before = _bal(tT, payout);
        _swapSell(hookPoolT, tX, SWAP_IN);
        uint256 got = _bal(tT, payout) - before;
        assertGt(got, 0);
        _assertInvariant(tT);
    }

    // ------------------------------------------------------------------ held paths

    function test_held_pushedRoutePool() public {
        _push(qt, tQ, 1e19);
        int24 spot = _tick(qt);
        assertTrue(spot < -100 || spot > 100, "pushed");

        uint256 fee = _expectedFee();
        vm.expectEmit(true, true, false, true, address(hook));
        emit FeeConversionHook.FeeHeld(bucket, tQ, fee, FeeConversionHook.PriceDeviation.selector);
        _tradeForFee();
        assertEq(hook.heldFees(bucket, tQ), hook.totalHeld(tQ));
        assertEq(_bal(tT, payout), 0);
        _assertInvariant(tQ);
    }

    function test_held_syncedCurrency() public {
        SyncedSwapRouter r = new SyncedSwapRouter(manager);
        MockERC20(Currency.unwrap(tX)).approve(address(r), type(uint256).max);

        vm.recordLogs();
        r.swapExactIn(hookPool, tX == hookPool.currency0, SWAP_IN);
        assertGt(hook.heldFees(bucket, tQ), 0);
        assertEq(_bal(tT, payout), 0);
        _assertInvariant(tQ);
        assertEq(_lastHeldReason(), hook.SYNCED_CURRENCY_PENDING());
    }

    function test_held_noRoute() public {
        // Selling Q for X: the fee is in X, which has no route.
        _swapSell(hookPool, tQ, SWAP_IN);
        assertGt(hook.heldFees(bucket, tX), 0);
        _assertInvariant(tX);
    }

    function test_held_clearedRoute() public {
        hook.clearRoute(tQ);
        assertEq(hook.conversionRoute(tQ).length, 0);
        vm.recordLogs();
        _tradeForFee();
        assertGt(hook.heldFees(bucket, tQ), 0);
        assertEq(_lastHeldReason(), FeeConversionHook.InvalidRoute.selector);
    }

    function test_held_slippageExceeded() public {
        hook.setGuard(qt, ConvertingTestHook.Guard(true, 0, 100, 0, 100, 0));
        vm.recordLogs();
        _tradeForFee();
        assertGt(hook.heldFees(bucket, tQ), 0);
        assertEq(_lastHeldReason(), FeeConversionHook.SlippageExceeded.selector);
        _assertInvariant(tQ);
    }

    function test_held_partialFill() public {
        // A thin route pool runs out of liquidity before the fee is consumed.
        PoolKey memory thin = _pool(tQ, tT, 3000, 60, IHooks(address(0)), 1e12);
        hook.setGuard(thin, ConvertingTestHook.Guard(true, 0, 100_000, 2000, 100_000, 2000));
        _route1(tQ, thin);
        vm.recordLogs();
        _tradeForFee();
        assertGt(hook.heldFees(bucket, tQ), 0);
        assertEq(_lastHeldReason(), FeeConversionHook.PartialFill.selector);
        _assertInvariant(tQ);
    }

    function test_held_guardNotSet() public {
        hook.setGuard(qt, ConvertingTestHook.Guard(false, 0, 0, 0, 0, 0));
        vm.recordLogs();
        _tradeForFee();
        assertEq(_lastHeldReason(), ConvertingTestHook.GuardNotSet.selector);
    }

    function test_held_zeroRecipient() public {
        hook.setPayout(address(0));
        vm.recordLogs();
        _tradeForFee();
        assertGt(hook.heldFees(bucket, tQ), 0);
        assertEq(_lastHeldReason(), FeeConversionHook.ZeroConversionRecipient.selector);
    }

    function test_held_callbackReverts() public {
        hook.setProbe(probe);
        probe.arm(ReentryProbe.Mode.Revert, hook, hookPool, bucket, tQ);
        _tradeForFee();
        assertGt(hook.heldFees(bucket, tQ), 0);
        assertEq(_bal(tT, payout), 0, "payout rolled back");
        _assertInvariant(tQ);
    }

    function test_held_nestedSwapOnHookPool() public {
        hook.setProbe(probe);
        probe.arm(ReentryProbe.Mode.Swap, hook, hookPool, bucket, tQ);
        vm.recordLogs();
        _tradeForFee();
        // The nested swap hit the swap lock (wrapped by the pool manager): the fee is held.
        assertGt(hook.heldFees(bucket, tQ), 0);
        assertEq(_lastHeldReason(), CustomRevert.WrappedError.selector);
        _assertInvariant(tQ);
    }

    function test_inSwap_callbackRunsOnce() public {
        hook.setProbe(probe);
        probe.arm(ReentryProbe.Mode.None, hook, hookPool, bucket, tQ);
        _tradeForFee();
        assertEq(hook.totalHeld(tQ), 0);
        assertEq(probe.pokes(), 1);
    }

    // ------------------------------------------------------------------ gas

    function test_revert_insufficientGas() public {
        uint256 required = hook.conversionGasRequired();
        bytes memory err;
        try swapRouter.swap{gas: 600_000}(
            hookPool,
            SwapParams({
                zeroForOne: tX == hookPool.currency0,
                amountSpecified: -int256(SWAP_IN),
                sqrtPriceLimitX96: tX == hookPool.currency0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            fail();
        } catch (bytes memory e) {
            err = e;
        }
        // WrappedError(address hook, bytes4 selector, bytes reason, bytes details)
        assertEq(bytes4(err), CustomRevert.WrappedError.selector);
        (address target, bytes4 sel, bytes memory reason,) =
            abi.decode(_tail(err), (address, bytes4, bytes, bytes));
        assertEq(target, address(hook));
        assertEq(sel, IHooks.afterSwap.selector);
        assertEq(bytes4(reason), FeeConversionHook.InsufficientGas.selector);
        (uint256 req,) = abi.decode(_tail(reason), (uint256, uint256));
        assertEq(req, required);
    }

    function test_insufficientGas_notRaisedWithoutFee() public {
        // Zero amount: nothing to do, no gas check (the fee feature calls with its fee only).
        hook.convertOrHoldOutsideSwap{gas: 100_000}(bucket, tQ, 0);
    }

    // ------------------------------------------------------------------ retry

    function test_retry_full() public {
        uint256 held = _holdOneFee();
        // The retry bounds are wider than the in-swap bounds, so the pushed pool is accepted.
        address caller = makeAddr("anyone");
        vm.expectEmit(true, true, true, false, address(hook));
        emit FeeConversionHook.HeldFeeRetried(bucket, tQ, caller, held, 0);
        vm.prank(caller);
        uint256 out = hook.retryHeld(bucket, tQ, held);

        assertGt(out, 0);
        assertEq(_bal(tT, payout), out);
        assertEq(hook.heldFees(bucket, tQ), 0);
        assertEq(hook.totalHeld(tQ), 0);
        _assertInvariant(tQ);
    }

    function test_retry_chunked() public {
        uint256 held = _holdOneFee();
        uint256 first = held / 3;
        uint256 out1 = hook.retryHeld(bucket, tQ, first);
        assertEq(hook.heldFees(bucket, tQ), held - first);
        _assertInvariant(tQ);
        uint256 out2 = hook.retryHeld(bucket, tQ, held - first);
        assertEq(hook.heldFees(bucket, tQ), 0);
        assertEq(_bal(tT, payout), out1 + out2);
        _assertInvariant(tQ);
    }

    function test_retry_failureKeepsHeld() public {
        uint256 held = _holdOneFee();
        // Push further, beyond the retry band too: the retry reverts and nothing changes.
        _push(qt, tQ, 2e20);
        vm.expectRevert();
        hook.retryHeld(bucket, tQ, held);
        assertEq(hook.heldFees(bucket, tQ), held);
        _assertInvariant(tQ);
    }

    function test_retry_revert_zeroAmount() public {
        vm.expectRevert(FeeConversionHook.NothingToRetry.selector);
        hook.retryHeld(bucket, tQ, 0);
    }

    function test_retry_revert_exceedsHeld() public {
        uint256 held = _holdOneFee();
        vm.expectRevert(
            abi.encodeWithSelector(FeeConversionHook.AmountExceedsHeld.selector, held + 1, held)
        );
        hook.retryHeld(bucket, tQ, held + 1);
    }

    function test_retry_revert_poolManagerBusy() public {
        uint256 held = _holdOneFee();
        RetryInUnlock r = new RetryInUnlock(manager);
        vm.expectRevert(FeeConversionHook.PoolManagerBusy.selector);
        r.run(hook, bucket, tQ, held);
    }

    function test_retry_insideSwapReverts() public {
        _holdOneFee();
        _push(qt, tT, 1e19); // restore the route pool so the next in-swap conversion runs
        hook.setProbe(probe);
        probe.arm(ReentryProbe.Mode.Retry, hook, hookPool, bucket, tQ);
        uint256 held = hook.heldFees(bucket, tQ);

        _tradeForFee();
        assertEq(
            probe.lastError(),
            abi.encodeWithSelector(BaseHook.HookReentered.selector, uint256(1)),
            "swap lock"
        );
        assertEq(hook.heldFees(bucket, tQ), held, "nothing retried");
        _assertInvariant(tQ);
    }

    function test_retry_nestedReverts() public {
        uint256 held = _holdOneFee();
        hook.setProbe(probe);
        probe.arm(ReentryProbe.Mode.Retry, hook, hookPool, bucket, tQ);

        hook.retryHeld(bucket, tQ, held / 2);
        assertEq(
            probe.lastError(),
            abi.encodeWithSelector(BaseHook.HookReentered.selector, uint256(2)),
            "call lock"
        );
        assertEq(hook.heldFees(bucket, tQ), held - held / 2);
        _assertInvariant(tQ);
    }

    // ------------------------------------------------------------------ entry point guards

    function test_revert_convertInlineNotSelf() public {
        vm.expectRevert(FeeConversionHook.NotSelf.selector);
        hook.convertInline(bucket, tQ, 1);
    }

    function test_revert_unlockCallbackNotPoolManager() public {
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.unlockCallback(abi.encode(bucket, tQ, uint256(1)));
    }

    function test_revert_unlockCallbackWrongLock() public {
        vm.prank(address(manager));
        vm.expectRevert(FeeConversionHook.UnexpectedUnlock.selector);
        hook.unlockCallback(abi.encode(bucket, tQ, uint256(1)));
    }

    // ------------------------------------------------------------------ route config

    function test_route_set() public {
        vm.expectEmit(true, false, false, true, address(hook));
        emit FeeConversionHook.ConversionRouteSet(tQ, 2);
        _route2(tQ, qm, mt);
        PoolKey[] memory r = hook.conversionRoute(tQ);
        assertEq(PoolId.unwrap(r[0].toId()), PoolId.unwrap(qm.toId()));
        assertEq(PoolId.unwrap(r[1].toId()), PoolId.unwrap(mt.toId()));
        // Replacing shortens it.
        _route1(tQ, qt);
        assertEq(hook.conversionRoute(tQ).length, 1);
    }

    function test_route_revert_empty() public {
        PoolKey[] memory r = new PoolKey[](0);
        vm.expectRevert(FeeConversionHook.InvalidRoute.selector);
        hook.setRoute(tQ, r);
    }

    function test_route_revert_tooLong() public {
        PoolKey[] memory r = new PoolKey[](4);
        r[0] = qm;
        r[1] = mt;
        r[2] = qt;
        r[3] = qt;
        vm.expectRevert(FeeConversionHook.InvalidRoute.selector);
        hook.setRoute(tQ, r);
    }

    function test_route_threeHopsAccepted() public {
        // Q -> T -> Q -> T: contiguous and ends at the target.
        PoolKey[] memory r = new PoolKey[](3);
        r[0] = qt;
        r[1] = qt;
        r[2] = qt;
        hook.setRoute(tQ, r);
        assertEq(hook.conversionRoute(tQ).length, 3);
    }

    function test_route_revert_hooked() public {
        vm.expectRevert(FeeConversionHook.InvalidRoute.selector);
        _route1(tQ, hookPool);
    }

    function test_route_revert_notContiguous() public {
        vm.expectRevert(FeeConversionHook.InvalidRoute.selector);
        _route2(tQ, qm, qt);
    }

    function test_route_revert_doesNotStartAtFrom() public {
        vm.expectRevert(FeeConversionHook.InvalidRoute.selector);
        _route1(tX, qt);
    }

    function test_route_revert_doesNotEndAtTarget() public {
        vm.expectRevert(FeeConversionHook.InvalidRoute.selector);
        _route1(tQ, qm);
    }

    function test_route_revert_fromIsTarget() public {
        vm.expectRevert(FeeConversionHook.InvalidRoute.selector);
        _route1(tT, qt);
    }

    // ------------------------------------------------------------------ native target

    function test_native_targetPaysEth() public {
        ConvertingTestHook nh = ConvertingTestHook(
            _deployHook(
                "FeeConversionHook.t.sol:ConvertingTestHook",
                abi.encode(manager, CurrencyLibrary.ADDRESS_ZERO),
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            )
        );
        address ethPayout = makeAddr("ethPayout");
        nh.setPayout(ethPayout);

        PoolKey memory pool = _pool(tX, tQ, 3000, 60, IHooks(address(nh)), 1e21);
        PoolKey memory ethQ = PoolKey(CurrencyLibrary.ADDRESS_ZERO, tQ, 500, 10, IHooks(address(0)));
        manager.initialize(ethQ, SQRT_PRICE_1_1);
        vm.deal(address(this), 1e24);
        modifyLiquidityRouter.modifyLiquidity{value: 1e22}(
            ethQ, ModifyLiquidityParams(-1000, 1000, 1e21, 0), ""
        );
        nh.setGuard(ethQ, ConvertingTestHook.Guard(true, 0, 100, 100, 2000, 500));
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = ethQ;
        nh.setRoute(tQ, r);

        _swapSell(pool, tX, SWAP_IN);
        assertGt(ethPayout.balance, 0);
        assertEq(manager.balanceOf(address(nh), tQ.toId()), nh.totalHeld(tQ));
        assertEq(nh.totalHeld(tQ), 0);
    }

    // ------------------------------------------------------------------ fuzz

    /// @dev Any trade size and any push of the route pool: the trader's swap succeeds, the fee
    ///      is either converted or held in full, and claims always equal the held total.
    function testFuzz_swapNeverRevertsAndInvariantHolds(uint256 amountIn, uint256 push, bool up)
        public
    {
        amountIn = bound(amountIn, 1e9, 1e19);
        push = bound(push, 0, 5e19);
        if (push != 0) _push(qt, up ? tQ : tT, push);

        uint256 heldBefore = hook.totalHeld(tQ);
        uint256 paidBefore = _bal(tT, payout);
        _swapSell(hookPool, tX, amountIn);
        bool held = hook.totalHeld(tQ) > heldBefore;
        bool paid = _bal(tT, payout) > paidBefore;
        assertTrue(held != paid, "converted xor held");
        _assertInvariant(tQ);
    }

    function testFuzz_minOutFromReference(
        uint256 amountIn,
        bool zeroForOne,
        int24 spotTick,
        int24 referenceTick,
        uint256 dev,
        uint256 slip,
        uint256 feePips
    ) public {
        BareConversionHook bare = BareConversionHook(
            _deployHook(
                "FeeConversionHook.t.sol:BareConversionHook",
                abi.encode(manager, tT),
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            )
        );
        amountIn = bound(amountIn, 0, type(uint128).max);
        spotTick = int24(bound(spotTick, -400_000, 400_000));
        referenceTick = int24(bound(referenceTick, -400_000, 400_000));
        dev = bound(dev, 0, 20_000);
        slip = bound(slip, 0, 2000);
        feePips = bound(feePips, 0, 100_000);
        uint160 sqrtSpot = TickMath.getSqrtPriceAtTick(spotTick);

        int256 diff = int256(spotTick) - int256(referenceTick);
        if (uint256(diff < 0 ? -diff : diff) > dev) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    FeeConversionHook.PriceDeviation.selector, spotTick, referenceTick
                )
            );
            bare.minOutFromReference(
                amountIn, zeroForOne, sqrtSpot, spotTick, referenceTick, dev, slip, feePips
            );
            return;
        }
        uint256 minOut = bare.minOutFromReference(
            amountIn, zeroForOne, sqrtSpot, spotTick, referenceTick, dev, slip, feePips
        );
        uint256 qs = _refQuote(amountIn, sqrtSpot, zeroForOne);
        uint256 qr = _refQuote(amountIn, TickMath.getSqrtPriceAtTick(referenceTick), zeroForOne);
        uint256 best = qs > qr ? qs : qr;
        uint256 tol = slip + (feePips + 99) / 100;
        assertEq(minOut, best * (10_000 - tol) / 10_000);
        assertLe(minOut, best);
    }

    function testFuzz_quoteAtTickZeroIsIdentity(uint256 amountIn, bool zeroForOne) public {
        BareConversionHook bare = BareConversionHook(
            _deployHook(
                "FeeConversionHook.t.sol:BareConversionHook",
                abi.encode(manager, tT),
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            )
        );
        amountIn = bound(amountIn, 0, type(uint128).max);
        assertEq(bare.quoteAtPrice(amountIn, SQRT_PRICE_1_1, zeroForOne), amountIn);
    }

    function test_minOutFromReference_fullTolerance() public {
        BareConversionHook bare = BareConversionHook(
            _deployHook(
                "FeeConversionHook.t.sol:BareConversionHook",
                abi.encode(manager, tT),
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            )
        );
        assertEq(bare.minOutFromReference(1e18, true, SQRT_PRICE_1_1, 0, 0, 0, 9999, 100), 0);
        // Spot pushed below the reference inside the band: the reference price sets the floor.
        uint160 low = TickMath.getSqrtPriceAtTick(-50);
        uint256 m = bare.minOutFromReference(1e18, true, low, -50, 0, 100, 0, 0);
        assertEq(m, 1e18);
    }

    // ------------------------------------------------------------------ utils

    function _refQuote(uint256 a, uint160 s, bool zeroForOne) internal pure returns (uint256) {
        return zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(a, s, 1 << 96), s, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(a, 1 << 96, s), 1 << 96, s);
    }

    function _expectedFee() internal returns (uint256 fee) {
        // Quote the gross output of the trade with a snapshot, then derive the 1% fee.
        uint256 snap = vm.snapshotState();
        hook.setPayout(payout);
        BalanceDelta d = _tradeForFee();
        uint256 net = uint256(uint128(tQ == hookPool.currency0 ? d.amount0() : d.amount1()));
        fee = hook.totalHeld(tQ);
        // In the pushed state the fee is held; `net + fee` is the gross.
        assertEq(fee, ((net + fee) * 100 + 9999) / 10_000);
        vm.revertToState(snap);
    }

    function _lastHeldReason() internal view returns (bytes4 reason) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = FeeConversionHook.FeeHeld.selector;
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(hook) && l.topics[0] == topic) {
                (, reason) = abi.decode(l.data, (uint256, bytes4));
                return reason;
            }
        }
        revert("no FeeHeld");
    }

    function _lastConverted()
        internal
        view
        returns (uint256 amountIn, uint256 amountOut, bool inSwap)
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = FeeConversionHook.FeeConverted.selector;
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(hook) && l.topics[0] == topic) {
                return abi.decode(l.data, (uint256, uint256, bool));
            }
        }
        revert("no FeeConverted");
    }

    function _tail(bytes memory b) internal pure returns (bytes memory t) {
        t = new bytes(b.length - 4);
        for (uint256 i; i < t.length; ++i) {
            t[i] = b[i + 4];
        }
    }
}
