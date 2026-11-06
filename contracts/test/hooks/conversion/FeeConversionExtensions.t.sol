// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {BaseHook} from "../../../src/hooks/base/BaseHook.sol";
import {FeeConversionHook} from "../../../src/hooks/conversion/FeeConversionHook.sol";
import {HookTest} from "../utils/HookTest.sol";

// ---------------------------------------------------------------------- harness

/// @dev Stand-in for an external converter: takes the fee currency and pays twice the amount of
///      the target from its own balance.
///      When armed, it first tries to reenter the hook's retry entry point and records the error.
contract ExternalConverter {
    MockERC20 public immutable target;
    uint256 public calls;
    bool public reenter;
    bytes32 internal _bucket;
    Currency internal _currency;
    bytes public reentryError;

    constructor(MockERC20 target_) {
        target = target_;
    }

    function armReentry(bytes32 bucket, Currency currency) external {
        reenter = true;
        _bucket = bucket;
        _currency = currency;
    }

    function convert(uint256 amountIn, address to) external returns (uint256 out) {
        ++calls;
        if (reenter) {
            try ExtensionHarness(msg.sender).retryCustom(_bucket, _currency, 1) {}
            catch (bytes memory e) {
                reentryError = e;
            }
        }
        out = amountIn * 2;
        target.transfer(to, out);
    }
}

/// @dev FeeConversionHook with every extension point instrumented: `_executeConversion` can run
///      the default, revert, return zero or delegate to an external converter; `_onFeeHeld`
///      records its arguments and the held amounts it sees; `_retryHeld` is exposed behind the
///      shared lock (as a concrete hook's own retry entry point would) and, to test its
///      precondition, without it. `receiveFee` is the fee feature stand-in: inside an unlock
///      owned by the caller it mints `amount` of claims to this hook (paid from its own tokens)
///      and calls `_convertOrHold`, optionally leaving a currency synced first.
contract ExtensionHarness is FeeConversionHook {
    enum ExecMode {
        Default,
        Revert,
        Zero,
        External
    }

    error ExecFailed();

    ExecMode public execMode;
    ExternalConverter public converter;
    address public payout;

    uint256 public execCalls;
    bytes32 public lastExecBucket;
    Currency public lastExecCurrency;
    uint256 public lastExecAmount;
    bool public lastExecInSwap;

    uint256 public heldCalls;
    bytes32 public lastHeldBucket;
    Currency public lastHeldCurrency;
    uint256 public lastHeldAmount;
    bytes4 public lastHeldReason;
    uint256 public heldAtCallback;
    uint256 public totalHeldAtCallback;

    constructor(IPoolManager m, Currency target) BaseHook(m) FeeConversionHook(target) {}

    function setExecMode(ExecMode m) external {
        execMode = m;
    }

    function setConverter(ExternalConverter c) external {
        converter = c;
    }

    function setPayout(address p) external {
        payout = p;
    }

    function setRoute(Currency from, PoolKey[] calldata route) external {
        _setConversionRoute(from, route);
    }

    function receiveFee(bytes32 bucket, Currency currency, uint256 amount, Currency syncAfter)
        external
        returns (bool converted, uint256 out)
    {
        poolManager.sync(currency);
        MockERC20(Currency.unwrap(currency)).transfer(address(poolManager), amount);
        poolManager.settle();
        poolManager.mint(address(this), currency.toId(), amount);
        if (Currency.unwrap(syncAfter) != address(0)) poolManager.sync(syncAfter);
        return _convertOrHold(bucket, currency, amount);
    }

    function retryCustom(bytes32 bucket, Currency currency, uint256 amount)
        external
        hookNonReentrant
        returns (uint256)
    {
        return _retryHeld(bucket, currency, amount);
    }

    function retryWithoutLock(bytes32 bucket, Currency currency, uint256 amount)
        external
        returns (uint256)
    {
        return _retryHeld(bucket, currency, amount);
    }

    function _executeConversion(bytes32 bucket, Currency currency, uint256 amount, bool inSwap)
        internal
        override
        returns (uint256)
    {
        ++execCalls;
        lastExecBucket = bucket;
        lastExecCurrency = currency;
        lastExecAmount = amount;
        lastExecInSwap = inSwap;
        if (execMode == ExecMode.Revert) revert ExecFailed();
        if (execMode == ExecMode.Zero) return 0;
        if (execMode == ExecMode.External) {
            // Burn the claims, hand the tokens to the converter, which pays the recipient.
            poolManager.burn(address(this), currency.toId(), amount);
            poolManager.take(currency, address(converter), amount);
            return converter.convert(amount, _conversionRecipient(bucket));
        }
        return super._executeConversion(bucket, currency, amount, inSwap);
    }

    function _settleConverted(bytes32 bucket, uint256 out) internal override {
        if (execMode == ExecMode.External) return; // the converter already paid
        super._settleConverted(bucket, out);
    }

    function _onFeeHeld(bytes32 bucket, Currency currency, uint256 amount, bytes4 reason)
        internal
        override
    {
        ++heldCalls;
        lastHeldBucket = bucket;
        lastHeldCurrency = currency;
        lastHeldAmount = amount;
        lastHeldReason = reason;
        heldAtCallback = heldFees[bucket][currency];
        totalHeldAtCallback = totalHeld[currency];
    }

    function _hopMinOutput(PoolKey memory, bool, uint256, uint160, int24, bool)
        internal
        pure
        override
        returns (uint256)
    {
        return 0;
    }

    function _conversionRecipient(bytes32) internal view override returns (address) {
        return payout;
    }
}

/// @dev Owns the pool manager unlock in which the harness receives a fee, or calls a retry
///      from inside an unlock.
contract UnlockDriver is IUnlockCallback {
    IPoolManager internal immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function feed(
        ExtensionHarness h,
        bytes32 bucket,
        Currency currency,
        uint256 amount,
        Currency syncAfter
    ) external returns (bool converted, uint256 out) {
        bytes memory r = manager.unlock(abi.encode(true, h, bucket, currency, amount, syncAfter));
        return abi.decode(r, (bool, uint256));
    }

    function retryInside(ExtensionHarness h, bytes32 bucket, Currency currency, uint256 amount)
        external
    {
        manager.unlock(abi.encode(false, h, bucket, currency, amount, Currency.wrap(address(0))));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (
            bool isFeed,
            ExtensionHarness h,
            bytes32 bucket,
            Currency currency,
            uint256 amount,
            Currency syncAfter
        ) = abi.decode(data, (bool, ExtensionHarness, bytes32, Currency, uint256, Currency));
        if (isFeed) {
            (bool converted, uint256 out) = h.receiveFee(bucket, currency, amount, syncAfter);
            return abi.encode(converted, out);
        }
        h.retryCustom(bucket, currency, amount);
        return "";
    }
}

// ---------------------------------------------------------------------- tests

/// @notice Direct unit tests of the FeeConversionHook extension points `_executeConversion`,
///         `_onFeeHeld` and `_retryHeld`, without a hooked pool or a swap.
contract FeeConversionExtensionsTest is HookTest {
    uint256 internal constant FEE = 1e18;
    bytes32 internal constant BUCKET = keccak256("bucket");

    ExtensionHarness internal hook;
    UnlockDriver internal driver;
    address internal payout = makeAddr("payout");
    address internal stranger = makeAddr("stranger");

    Currency internal tQ; // fee currency
    Currency internal tT; // conversion target
    PoolKey internal qt; // Q/T hookless route pool

    function setUp() public {
        deployFreshManagerAndRouters();
        tQ = deployMintAndApproveCurrency();
        tT = deployMintAndApproveCurrency();
        hook = ExtensionHarness(
            _deployHook(
                "FeeConversionExtensions.t.sol:ExtensionHarness",
                abi.encode(manager, tT),
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            )
        );
        hook.setPayout(payout);
        driver = new UnlockDriver(manager);
        MockERC20(Currency.unwrap(tQ)).transfer(address(hook), 100 * FEE);
        MockERC20(Currency.unwrap(tT)).transfer(address(hook), 100 * FEE);

        (Currency c0, Currency c1) = Currency.unwrap(tQ) < Currency.unwrap(tT) ? (tQ, tT) : (tT, tQ);
        qt = PoolKey(c0, c1, 500, 10, IHooks(address(0)));
        manager.initialize(qt, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            qt, ModifyLiquidityParams(-1000, 1000, 1e21, 0), ZERO_BYTES
        );
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = qt;
        hook.setRoute(tQ, r);
    }

    // ------------------------------------------------------------------ helpers

    function _feed(Currency c, uint256 amount) internal returns (bool, uint256) {
        return driver.feed(hook, BUCKET, c, amount, Currency.wrap(address(0)));
    }

    function _claims(Currency c) internal view returns (uint256) {
        return manager.balanceOf(address(hook), c.toId());
    }

    function _hold() internal {
        hook.setExecMode(ExtensionHarness.ExecMode.Revert);
        (bool converted,) = _feed(tQ, FEE);
        assertFalse(converted);
        hook.setExecMode(ExtensionHarness.ExecMode.Default);
    }

    // ------------------------------------------------------------------ _executeConversion

    function test_executeConversion_defaultBurnsAndRoutes() public {
        uint256 managerQ = tQ.balanceOf(address(manager));
        (bool converted, uint256 out) = _feed(tQ, FEE);
        assertTrue(converted);
        assertGt(out, (FEE * 99) / 100, "one hop at about 1:1 minus the hop fee");
        assertLt(out, FEE);
        assertEq(tT.balanceOf(payout), out, "default settle takes to the recipient");
        assertEq(_claims(tQ), 0, "claims burned");
        assertEq(hook.totalHeld(tQ), 0);
        assertEq(hook.execCalls(), 1);
        assertEq(hook.lastExecBucket(), BUCKET);
        assertEq(Currency.unwrap(hook.lastExecCurrency()), Currency.unwrap(tQ));
        assertEq(hook.lastExecAmount(), FEE);
        assertTrue(hook.lastExecInSwap(), "convertOrHold runs the in-swap path");
        assertEq(hook.heldCalls(), 0, "no hold");
        // The fee went into the route pool.
        assertEq(tQ.balanceOf(address(manager)) - managerQ, FEE);
    }

    function test_executeConversion_targetCurrencyNeedsNoRoute() public {
        (bool converted, uint256 out) = _feed(tT, FEE);
        assertTrue(converted);
        assertEq(out, FEE, "burn and pay, no hop");
        assertEq(tT.balanceOf(payout), FEE);
        assertEq(_claims(tT), 0);
    }

    function test_executeConversion_revertRollsBackAndHolds() public {
        hook.setExecMode(ExtensionHarness.ExecMode.Revert);
        vm.expectEmit(true, true, false, true, address(hook));
        emit FeeConversionHook.FeeHeld(BUCKET, tQ, FEE, ExtensionHarness.ExecFailed.selector);
        (bool converted, uint256 out) = _feed(tQ, FEE);
        assertFalse(converted);
        assertEq(out, 0);
        assertEq(hook.execCalls(), 0, "state written in the try frame is rolled back");
        assertEq(_claims(tQ), FEE, "claims kept");
        assertEq(hook.heldFees(BUCKET, tQ), FEE);
        assertEq(hook.totalHeld(tQ), FEE);
        assertEq(tT.balanceOf(payout), 0);
    }

    function test_executeConversion_zeroOutputHolds() public {
        hook.setExecMode(ExtensionHarness.ExecMode.Zero);
        (bool converted,) = _feed(tQ, FEE);
        assertFalse(converted);
        assertEq(hook.lastHeldReason(), FeeConversionHook.SlippageExceeded.selector);
        assertEq(_claims(tQ), FEE);
        assertEq(hook.totalHeld(tQ), FEE);
    }

    function test_executeConversion_externalConverterOverride() public {
        ExternalConverter c = new ExternalConverter(MockERC20(Currency.unwrap(tT)));
        MockERC20(Currency.unwrap(tT)).transfer(address(c), 10 * FEE);
        hook.setConverter(c);
        hook.setExecMode(ExtensionHarness.ExecMode.External);

        vm.expectEmit(true, true, false, true, address(hook));
        emit FeeConversionHook.FeeConverted(BUCKET, tQ, FEE, 2 * FEE, true);
        (bool converted, uint256 out) = _feed(tQ, FEE);
        assertTrue(converted);
        assertEq(out, 2 * FEE);
        assertEq(c.calls(), 1);
        assertEq(tQ.balanceOf(address(c)), FEE, "converter got the fee tokens");
        assertEq(tT.balanceOf(payout), 2 * FEE, "converter paid the recipient");
        assertEq(_claims(tQ), 0);
        assertEq(hook.totalHeld(tQ), 0);
    }

    function test_executeConversion_retryPassesInSwapFalse() public {
        _hold();
        uint256 out = hook.retryHeld(BUCKET, tQ, FEE);
        assertGt(out, 0);
        assertEq(hook.execCalls(), 1);
        assertFalse(hook.lastExecInSwap(), "retry bounds");
        assertEq(hook.lastExecAmount(), FEE);
        assertEq(tT.balanceOf(payout), out);
    }

    // ------------------------------------------------------------------ _onFeeHeld

    function test_onFeeHeld_seesUpdatedHeldAmounts() public {
        _hold();
        assertEq(hook.heldCalls(), 1);
        assertEq(hook.lastHeldBucket(), BUCKET);
        assertEq(Currency.unwrap(hook.lastHeldCurrency()), Currency.unwrap(tQ));
        assertEq(hook.lastHeldAmount(), FEE);
        assertEq(hook.lastHeldReason(), ExtensionHarness.ExecFailed.selector);
        assertEq(hook.heldAtCallback(), FEE, "runs after heldFees is raised");
        assertEq(hook.totalHeldAtCallback(), FEE, "runs after totalHeld is raised");

        hook.setExecMode(ExtensionHarness.ExecMode.Revert);
        _feed(tQ, 3);
        assertEq(hook.heldCalls(), 2, "once per hold");
        assertEq(hook.lastHeldAmount(), 3);
        assertEq(hook.heldAtCallback(), FEE + 3);
    }

    function test_onFeeHeld_syncedCurrencyReason() public {
        (bool converted,) = driver.feed(hook, BUCKET, tQ, FEE, tT);
        assertFalse(converted);
        assertEq(hook.heldCalls(), 1);
        assertEq(hook.lastHeldReason(), hook.SYNCED_CURRENCY_PENDING());
        assertEq(hook.execCalls(), 0, "conversion not attempted");
    }

    function test_onFeeHeld_noRouteReason() public {
        Currency other = deployMintAndApproveCurrency();
        MockERC20(Currency.unwrap(other)).transfer(address(hook), FEE);
        (bool converted,) = _feed(other, FEE);
        assertFalse(converted);
        assertEq(hook.lastHeldReason(), FeeConversionHook.InvalidRoute.selector);
        assertEq(Currency.unwrap(hook.lastHeldCurrency()), Currency.unwrap(other));
    }

    function test_onFeeHeld_notCalledOnSuccessOrZeroAmount() public {
        _feed(tQ, FEE);
        assertEq(hook.heldCalls(), 0);
        (bool converted, uint256 out) = _feed(tQ, 0);
        assertFalse(converted);
        assertEq(out, 0);
        assertEq(hook.heldCalls(), 0, "zero amount is a no-op");
    }

    // ------------------------------------------------------------------ _retryHeld

    function test_retryHeld_customEntryPointChunks() public {
        _hold();
        vm.expectEmit(true, true, true, false, address(hook));
        emit FeeConversionHook.HeldFeeRetried(BUCKET, tQ, stranger, FEE / 4, 0);
        vm.prank(stranger);
        uint256 out1 = hook.retryCustom(BUCKET, tQ, FEE / 4);
        assertGt(out1, 0);
        assertEq(hook.heldFees(BUCKET, tQ), FEE - FEE / 4);
        assertEq(hook.totalHeld(tQ), FEE - FEE / 4);
        assertEq(_claims(tQ), FEE - FEE / 4, "burns exactly the retried claims");

        uint256 out2 = hook.retryCustom(BUCKET, tQ, FEE - FEE / 4);
        assertEq(hook.heldFees(BUCKET, tQ), 0);
        assertEq(hook.totalHeld(tQ), 0);
        assertEq(_claims(tQ), 0);
        assertEq(tT.balanceOf(payout), out1 + out2);
    }

    function test_retryHeld_failureRevertsAndKeepsHeld() public {
        _hold();
        hook.setExecMode(ExtensionHarness.ExecMode.Revert);
        vm.expectRevert(ExtensionHarness.ExecFailed.selector);
        hook.retryCustom(BUCKET, tQ, FEE);
        assertEq(hook.heldFees(BUCKET, tQ), FEE, "decrement rolled back");
        assertEq(hook.totalHeld(tQ), FEE);
        assertEq(_claims(tQ), FEE);
    }

    function test_retryHeld_requiresTheLock() public {
        _hold();
        // Precondition of `_retryHeld`: the caller holds LOCK_CALL; otherwise the unlock
        // callback refuses to run.
        vm.expectRevert(FeeConversionHook.UnexpectedUnlock.selector);
        hook.retryWithoutLock(BUCKET, tQ, FEE);
        assertEq(hook.heldFees(BUCKET, tQ), FEE);
    }

    function test_retryHeld_validation() public {
        _hold();
        vm.expectRevert(FeeConversionHook.NothingToRetry.selector);
        hook.retryCustom(BUCKET, tQ, 0);
        vm.expectRevert(
            abi.encodeWithSelector(FeeConversionHook.AmountExceedsHeld.selector, FEE + 1, FEE)
        );
        hook.retryCustom(BUCKET, tQ, FEE + 1);
        vm.expectRevert(abi.encodeWithSelector(FeeConversionHook.AmountExceedsHeld.selector, 1, 0));
        hook.retryCustom(keccak256("other bucket"), tQ, 1);
        vm.expectRevert(FeeConversionHook.PoolManagerBusy.selector);
        driver.retryInside(hook, BUCKET, tQ, FEE);
    }

    function test_retryHeld_reentryFromConversionBlocked() public {
        _hold();
        ExternalConverter c = new ExternalConverter(MockERC20(Currency.unwrap(tT)));
        MockERC20(Currency.unwrap(tT)).transfer(address(c), 10 * FEE);
        hook.setConverter(c);
        hook.setExecMode(ExtensionHarness.ExecMode.External);
        c.armReentry(BUCKET, tQ);

        uint256 out = hook.retryCustom(BUCKET, tQ, FEE / 2);
        assertEq(out, FEE, "outer retry completes");
        assertEq(
            c.reentryError(),
            abi.encodeWithSelector(BaseHook.HookReentered.selector, uint256(2)),
            "nested retry sees LOCK_CALL"
        );
        assertEq(hook.heldFees(BUCKET, tQ), FEE / 2);
    }
}
