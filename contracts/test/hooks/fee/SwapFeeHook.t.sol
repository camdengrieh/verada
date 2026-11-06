// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {BaseHook} from "../../../src/hooks/base/BaseHook.sol";
import {PoolAdminHook} from "../../../src/hooks/base/PoolAdminHook.sol";
import {SwapFeeExample} from "../../../src/hooks/examples/SwapFeeExample.sol";
import {SwapFeeHook} from "../../../src/hooks/fee/SwapFeeHook.sol";
import {HookTest} from "../utils/HookTest.sol";

// ---------------------------------------------------------------------- harnesses

/// @dev SwapFeeHook with an exemption list, a forced rate, a raised setter cap and a record of
///      the `_onSwapFeeTaken` call.
contract SwapFeeHarness is SwapFeeHook {
    mapping(address => bool) public exempt;
    bool public forceBps;
    uint16 public forcedBps;

    uint256 public taken;
    address public lastSender;
    Currency public lastCurrency;
    uint256 public lastAmount;
    address public lastRecipient;
    bool public lastAsClaims;

    constructor(IPoolManager m) BaseHook(m) {}

    function setExempt(address a, bool e) external {
        exempt[a] = e;
    }

    function setForcedBps(bool on, uint16 bps) external {
        forceBps = on;
        forcedBps = bps;
    }

    function _maxSwapFeeBps() internal pure override returns (uint16) {
        return 10_000;
    }

    function _swapFeeBps(address sender, PoolKey calldata key, SwapParams calldata params)
        internal
        view
        override
        returns (uint16)
    {
        if (exempt[sender]) return 0;
        if (forceBps) return forcedBps;
        return super._swapFeeBps(sender, key, params);
    }

    function _onSwapFeeTaken(
        address sender,
        PoolKey calldata,
        Currency currency,
        uint256 amount,
        address recipient,
        bool asClaims
    ) internal override {
        ++taken;
        lastSender = sender;
        lastCurrency = currency;
        lastAmount = amount;
        lastRecipient = recipient;
        lastAsClaims = asClaims;
    }
}

/// @dev Stand-in for a decaying LP fee feature: asks for an LP fee override that falls linearly
///      from 5% to 0.30% over one hour after deployment, and takes its own 0.5% of the
///      unspecified side as claims to itself. Requires a dynamic-fee pool.
abstract contract MockDecayingFee is PoolAdminHook {
    uint256 internal immutable _decayStart = block.timestamp;
    uint24 internal constant START_FEE = 50_000;
    uint24 internal constant END_FEE = 3000;
    uint256 internal constant DECAY = 1 hours;

    error NotDynamicFee();

    function mockLpFee() public view returns (uint24) {
        uint256 elapsed = block.timestamp - _decayStart;
        if (elapsed >= DECAY) return END_FEE;
        return uint24(END_FEE + (uint256(START_FEE - END_FEE) * (DECAY - elapsed)) / DECAY);
    }

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

    function _beforeInitialize(address s, PoolKey calldata k, uint160 px)
        internal
        virtual
        override
        returns (bytes4 sel)
    {
        sel = super._beforeInitialize(s, k, px);
        if (!LPFeeLibrary.isDynamicFee(k.fee)) revert NotDynamicFee();
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        virtual
        override
        returns (bytes4 sel, BeforeSwapDelta delta, uint24 fee)
    {
        (sel, delta, fee) = super._beforeSwap(s, k, sp, d);
        fee = _mergeLpFeeOverride(fee, mockLpFee() | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function _afterSwap(
        address s,
        PoolKey calldata k,
        SwapParams calldata sp,
        BalanceDelta bd,
        bytes calldata d
    ) internal virtual override returns (bytes4 sel, int128 hookDelta) {
        (sel, hookDelta) = super._afterSwap(s, k, sp, bd, d);
        (Currency c, uint256 amount) = _unspecified(k, sp, bd);
        uint256 own = amount / 200;
        if (own == 0) return (sel, hookDelta);
        poolManager.mint(address(this), c.toId(), own);
        hookDelta += int128(int256(own));
    }
}

/// @dev Rule 6: both orders of the two features, each re-declaring the shared overrides.
contract DecayThenSwapFee is MockDecayingFee, SwapFeeHook {
    constructor(IPoolManager m) BaseHook(m) {}

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(MockDecayingFee, SwapFeeHook)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeInitialize(address s, PoolKey calldata k, uint160 px)
        internal
        override(PoolAdminHook, MockDecayingFee)
        returns (bytes4)
    {
        return super._beforeInitialize(s, k, px);
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        override(BaseHook, MockDecayingFee)
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
    ) internal override(MockDecayingFee, SwapFeeHook) returns (bytes4, int128) {
        return super._afterSwap(s, k, sp, bd, d);
    }
}

contract SwapFeeThenDecay is SwapFeeHook, MockDecayingFee {
    constructor(IPoolManager m) BaseHook(m) {}

    function _hookPermissions(Hooks.Permissions memory p)
        internal
        pure
        override(SwapFeeHook, MockDecayingFee)
        returns (Hooks.Permissions memory)
    {
        return super._hookPermissions(p);
    }

    function _beforeInitialize(address s, PoolKey calldata k, uint160 px)
        internal
        override(PoolAdminHook, MockDecayingFee)
        returns (bytes4)
    {
        return super._beforeInitialize(s, k, px);
    }

    function _beforeSwap(address s, PoolKey calldata k, SwapParams calldata sp, bytes calldata d)
        internal
        override(BaseHook, MockDecayingFee)
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
    ) internal override(SwapFeeHook, MockDecayingFee) returns (bytes4, int128) {
        return super._afterSwap(s, k, sp, bd, d);
    }
}

// ---------------------------------------------------------------------- tests

contract SwapFeeHookTest is HookTest {
    uint160 internal constant FLAGS =
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    uint160 internal constant COMPOSED_FLAGS = FLAGS | Hooks.BEFORE_SWAP_FLAG;

    SwapFeeHook internal hook;
    PoolKey internal poolKey;
    address internal recipient = makeAddr("recipient");

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        hook = SwapFeeHook(
            _deployHook("SwapFeeExample.sol:SwapFeeExample", abi.encode(manager), FLAGS)
        );
        (poolKey,) = initPoolAndAddLiquidity(
            currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1
        );
    }

    // ------------------------------------------------------------ helpers

    struct Swapped {
        int128 pool0; // pool delta from the Swap event (before the hook)
        int128 pool1;
        int128 caller0; // delta the router settled (after the hook)
        int128 caller1;
        uint24 lpFee;
    }

    struct FeeEvent {
        address emitter;
        bytes32 poolId;
        address currency;
        address recipient;
        uint256 amount;
    }

    /// @dev SwapFeeTaken events of the last `_swap`.
    FeeEvent[] internal feeEvents;

    function _swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified)
        internal
        returns (Swapped memory s)
    {
        vm.recordLogs();
        BalanceDelta d = swap(key, zeroForOne, amountSpecified, ZERO_BYTES);
        s.caller0 = d.amount0();
        s.caller1 = d.amount1();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        delete feeEvents;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(manager)
                    && logs[i].topics[0] == IPoolManager.Swap.selector
            ) {
                (s.pool0, s.pool1,,,, s.lpFee) = abi.decode(
                    logs[i].data, (int128, int128, uint160, uint128, int24, uint24)
                );
            }
            if (logs[i].topics[0] == SwapFeeHook.SwapFeeTaken.selector) {
                feeEvents.push(
                    FeeEvent({
                        emitter: logs[i].emitter,
                        poolId: logs[i].topics[1],
                        currency: address(uint160(uint256(logs[i].topics[2]))),
                        recipient: address(uint160(uint256(logs[i].topics[3]))),
                        amount: abi.decode(logs[i].data, (uint256))
                    })
                );
            }
        }
    }

    function _abs(int128 x) internal pure returns (uint256) {
        return x < 0 ? uint256(uint128(-x)) : uint256(uint128(x));
    }

    function _ceilFee(uint256 amount, uint256 bps) internal pure returns (uint256) {
        return (amount * bps + 9999) / 10_000;
    }

    function _claims(address owner, Currency c) internal view returns (uint256) {
        return manager.balanceOf(owner, c.toId());
    }

    /// @dev Asserts that the hook changed only the unspecified side, by exactly `fee`.
    function _checkShape(bool zeroForOne, int256 amountSpecified, uint16 bps, bool asClaims)
        internal
    {
        hook.setSwapFee(poolKey, bps, recipient, asClaims);
        bool exactIn = amountSpecified < 0;
        bool specifiedIs0 = exactIn == zeroForOne;
        Currency unspec = specifiedIs0 ? currency1 : currency0;
        uint256 claimsBefore = _claims(recipient, unspec);
        uint256 tokensBefore = unspec.balanceOf(recipient);

        Swapped memory s = _swap(poolKey, zeroForOne, amountSpecified);

        (int128 poolSpec, int128 poolUnspec, int128 callerSpec, int128 callerUnspec) = specifiedIs0
            ? (s.pool0, s.pool1, s.caller0, s.caller1)
            : (s.pool1, s.pool0, s.caller1, s.caller0);
        assertEq(callerSpec, poolSpec, "specified side untouched");
        uint256 fee = _ceilFee(_abs(poolUnspec), bps);
        assertGt(fee, 0);
        // Exact-in: the trader receives less output. Exact-out: the trader pays more input.
        assertEq(int256(callerUnspec), int256(poolUnspec) - int256(fee), "unspecified minus fee");
        assertEq(exactIn, poolUnspec > 0, "unspecified is output iff exact-in");

        if (asClaims) {
            assertEq(_claims(recipient, unspec) - claimsBefore, fee, "claims to recipient");
            assertEq(unspec.balanceOf(recipient), tokensBefore, "no tokens");
        } else {
            assertEq(unspec.balanceOf(recipient) - tokensBefore, fee, "tokens to recipient");
            assertEq(_claims(recipient, unspec), claimsBefore, "no claims");
        }
        assertEq(_claims(address(hook), unspec), 0, "hook keeps nothing");
        assertEq(unspec.balanceOf(address(hook)), 0, "hook keeps nothing");
    }

    // ------------------------------------------------------------ permissions

    function test_permissions() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertEq(_flags(p), FLAGS);
        assertTrue(p.beforeInitialize && p.afterSwap && p.afterSwapReturnDelta);
        assertFalse(p.beforeSwap || p.beforeSwapReturnDelta || p.afterInitialize);
    }

    function test_deployRejectsWrongAddress() public {
        address wrong = _hookAddress(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);
        vm.expectRevert();
        this.deployAt("SwapFeeExample.sol:SwapFeeExample", abi.encode(manager), wrong);
    }

    function deployAt(string memory what, bytes memory args, address where) external {
        deployCodeTo(what, args, where);
    }

    function test_callbacksOnlyPoolManager() public {
        SwapParams memory sp;
        vm.expectRevert(BaseHook.NotPoolManager.selector);
        hook.afterSwap(address(this), poolKey, sp, BalanceDelta.wrap(0), "");
    }

    // ------------------------------------------------------------ swap shapes

    function test_exactInZeroForOne_tokens() public {
        _checkShape(true, -1e15, 100, false);
    }

    function test_exactInOneForZero_tokens() public {
        _checkShape(false, -1e15, 100, false);
    }

    function test_exactOutZeroForOne_tokens() public {
        _checkShape(true, 1e15, 100, false);
    }

    function test_exactOutOneForZero_tokens() public {
        _checkShape(false, 1e15, 100, false);
    }

    function test_exactInZeroForOne_claims() public {
        _checkShape(true, -1e15, 250, true);
    }

    function test_exactInOneForZero_claims() public {
        _checkShape(false, -1e15, 250, true);
    }

    function test_exactOutZeroForOne_claims() public {
        _checkShape(true, 1e15, 250, true);
    }

    function test_exactOutOneForZero_claims() public {
        _checkShape(false, 1e15, 250, true);
    }

    function test_feeEventAndAccumulation() public {
        hook.setSwapFee(poolKey, 100, recipient, true);
        uint256 total;
        for (uint256 i; i < 3; ++i) {
            Swapped memory s = _swap(poolKey, true, -1e14);
            uint256 fee = _ceilFee(_abs(s.pool1), 100);
            total += fee;
            assertEq(feeEvents.length, 1, "one SwapFeeTaken");
            FeeEvent memory e = feeEvents[0];
            assertEq(e.emitter, address(hook));
            assertEq(e.poolId, PoolId.unwrap(poolKey.toId()));
            assertEq(e.currency, Currency.unwrap(currency1));
            assertEq(e.recipient, recipient);
            assertEq(e.amount, fee);
        }
        assertEq(_claims(recipient, currency1), total);
    }

    function test_hookAsClaimsRecipient() public {
        hook.setSwapFee(poolKey, 100, address(hook), true);
        Swapped memory s = _swap(poolKey, true, -1e15);
        assertEq(_claims(address(hook), currency1), _ceilFee(_abs(s.pool1), 100));
    }

    function test_unconfiguredPoolChargesNothing() public {
        Swapped memory s = _swap(poolKey, true, -1e15);
        assertEq(s.caller0, s.pool0);
        assertEq(s.caller1, s.pool1);
    }

    function test_recipientWithZeroBpsChargesNothing() public {
        hook.setSwapFee(poolKey, 0, recipient, true);
        Swapped memory s = _swap(poolKey, true, -1e15);
        assertEq(s.caller1, s.pool1);
        assertEq(_claims(recipient, currency1), 0);
    }

    function test_zeroUnspecifiedAmountChargesNothing() public {
        hook.setSwapFee(poolKey, 1000, recipient, true);
        Swapped memory s = _swap(poolKey, true, -1); // 1 wei in, 0 out after the LP fee
        assertEq(s.pool1, 0);
        assertEq(s.caller1, 0);
        assertEq(feeEvents.length, 0, "no SwapFeeTaken");
        assertEq(_claims(recipient, currency1), 0);
    }

    function test_feeOffAfterDisable() public {
        hook.setSwapFee(poolKey, 100, recipient, false);
        hook.setSwapFee(poolKey, 0, address(0), false);
        Swapped memory s = _swap(poolKey, false, -1e15);
        assertEq(s.caller0, s.pool0);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_feeMath(uint256 amount, uint16 bps, bool zeroForOne, bool exactIn) public {
        amount = bound(amount, 1e6, 1e15);
        bps = uint16(bound(bps, 1, 1000));
        hook.setSwapFee(poolKey, bps, recipient, true);
        int256 spec = exactIn ? -int256(amount) : int256(amount);
        bool specifiedIs0 = exactIn == zeroForOne;
        Currency unspec = specifiedIs0 ? currency1 : currency0;

        Swapped memory s = _swap(poolKey, zeroForOne, spec);
        (int128 poolUnspec, int128 callerUnspec) =
            specifiedIs0 ? (s.pool1, s.caller1) : (s.pool0, s.caller0);
        uint256 gross = _abs(poolUnspec);
        uint256 fee = _claims(recipient, unspec);

        assertEq(int256(poolUnspec) - int256(callerUnspec), int256(fee));
        assertLe(fee, gross, "fee <= gross");
        assertGe(fee * 10_000, gross * bps, "rounded up");
        assertLt((fee - 1) * 10_000, gross * bps, "by less than one unit");
    }

    // ------------------------------------------------------------ overrides

    function _harness() internal returns (SwapFeeHarness h, PoolKey memory key) {
        h = SwapFeeHarness(
            _deployHook("SwapFeeHook.t.sol:SwapFeeHarness", abi.encode(manager), FLAGS)
        );
        (key,) =
            initPoolAndAddLiquidity(currency0, currency1, IHooks(address(h)), 3000, SQRT_PRICE_1_1);
    }

    function test_exemptionThroughOverride() public {
        (SwapFeeHarness h, PoolKey memory key) = _harness();
        h.setSwapFee(key, 100, recipient, false);
        h.setExempt(address(swapRouter), true);
        Swapped memory s = _swap(key, true, -1e15);
        assertEq(s.caller1, s.pool1, "exempt sender pays nothing");
        assertEq(h.taken(), 0);

        h.setExempt(address(swapRouter), false);
        s = _swap(key, true, -1e15);
        uint256 fee = _ceilFee(_abs(s.pool1), 100);
        assertEq(currency1.balanceOf(recipient), fee);
        assertEq(h.taken(), 1);
        assertEq(h.lastSender(), address(swapRouter));
        assertEq(Currency.unwrap(h.lastCurrency()), Currency.unwrap(currency1));
        assertEq(h.lastAmount(), fee);
        assertEq(h.lastRecipient(), recipient);
        assertFalse(h.lastAsClaims());
    }

    function test_overrideRateWithZeroStoredRate() public {
        (SwapFeeHarness h, PoolKey memory key) = _harness();
        h.setSwapFee(key, 0, recipient, true);
        h.setForcedBps(true, 300);
        Swapped memory s = _swap(key, true, -1e15);
        assertEq(_claims(recipient, currency1), _ceilFee(_abs(s.pool1), 300));
    }

    function test_overrideIgnoredWithoutRecipient() public {
        (SwapFeeHarness h, PoolKey memory key) = _harness();
        h.setForcedBps(true, 300);
        Swapped memory s = _swap(key, true, -1e15);
        assertEq(s.caller1, s.pool1);
        assertEq(h.taken(), 0);
    }

    function test_overrideAboveHundredPercentReverts() public {
        (SwapFeeHarness h, PoolKey memory key) = _harness();
        h.setSwapFee(key, 0, recipient, true);
        h.setForcedBps(true, 10_001);
        vm.expectRevert();
        swap(key, true, -1e15, ZERO_BYTES);
    }

    function test_raisedCapAllowsFullOutput() public {
        (SwapFeeHarness h, PoolKey memory key) = _harness();
        h.setSwapFee(key, 10_000, recipient, true);
        Swapped memory s = _swap(key, true, -1e15);
        assertEq(s.caller1, 0, "trader receives nothing at 100%");
        assertEq(_claims(recipient, currency1), _abs(s.pool1));
    }

    // ------------------------------------------------------------ config

    function test_setSwapFeeStoresAndEmits() public {
        vm.expectEmit(true, false, false, true, address(hook));
        emit SwapFeeHook.SwapFeeSet(poolKey.toId(), 42, recipient, true);
        hook.setSwapFee(poolKey, 42, recipient, true);
        (uint16 bps, bool asClaims, address r) = hook.swapFee(poolKey.toId());
        assertEq(bps, 42);
        assertTrue(asClaims);
        assertEq(r, recipient);
    }

    function test_rejectsFeeAboveMax() public {
        vm.expectRevert(abi.encodeWithSelector(SwapFeeHook.InvalidSwapFee.selector, uint16(1001)));
        hook.setSwapFee(poolKey, 1001, recipient, true);
        hook.setSwapFee(poolKey, 1000, recipient, true);
    }

    function test_harnessRejectsAboveHundredPercent() public {
        (SwapFeeHarness h, PoolKey memory key) = _harness();
        vm.expectRevert(abi.encodeWithSelector(SwapFeeHook.InvalidSwapFee.selector, uint16(10_001)));
        h.setSwapFee(key, 10_001, recipient, true);
    }

    function test_rejectsZeroRecipientWithFee() public {
        vm.expectRevert(
            abi.encodeWithSelector(SwapFeeHook.InvalidFeeRecipient.selector, address(0))
        );
        hook.setSwapFee(poolKey, 1, address(0), true);
        hook.setSwapFee(poolKey, 0, address(0), true); // disabling is fine
    }

    function test_rejectsHookRecipientWithTokens() public {
        vm.expectRevert(
            abi.encodeWithSelector(SwapFeeHook.InvalidFeeRecipient.selector, address(hook))
        );
        hook.setSwapFee(poolKey, 100, address(hook), false);
    }

    function test_onlyPoolAdmin() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, poolKey.toId(), stranger)
        );
        hook.setSwapFee(poolKey, 100, recipient, true);
    }

    function test_rejectsKeyOfOtherHook() public {
        PoolKey memory other = poolKey;
        other.hooks = IHooks(address(0));
        vm.expectRevert(
            abi.encodeWithSelector(PoolAdminHook.NotPoolAdmin.selector, other.toId(), address(this))
        );
        hook.setSwapFee(other, 100, recipient, true);
    }

    function test_adminTransferAndFreeze() public {
        address next = makeAddr("next");
        hook.transferPoolAdmin(poolKey, next);
        vm.expectRevert();
        hook.setSwapFee(poolKey, 100, recipient, true);
        vm.prank(next);
        hook.setSwapFee(poolKey, 100, recipient, true);

        vm.prank(next);
        hook.transferPoolAdmin(poolKey, address(0));
        vm.prank(next);
        vm.expectRevert();
        hook.setSwapFee(poolKey, 0, address(0), true);
        // Frozen config still applies.
        Swapped memory s = _swap(poolKey, true, -1e15);
        assertEq(currency1.balanceOf(recipient), 0);
        assertEq(_claims(recipient, currency1), _ceilFee(_abs(s.pool1), 100));
    }

    // ------------------------------------------------------------ native currency

    function test_nativePoolFeeInEth() public {
        SwapFeeHook h = SwapFeeHook(
            _deployHook("SwapFeeExample.sol:SwapFeeExample", abi.encode(manager), FLAGS)
        );
        vm.deal(address(this), 10 ether);
        (PoolKey memory key,) = initPoolAndAddLiquidityETH(
            CurrencyLibrary.ADDRESS_ZERO,
            currency1,
            IHooks(address(h)),
            3000,
            SQRT_PRICE_1_1,
            1 ether
        );
        h.setSwapFee(key, 200, recipient, false);

        // Exact-in token -> ETH: the fee is ETH, paid as native tokens.
        uint256 ethBefore = recipient.balance;
        Swapped memory s = _swap(key, false, -1e15);
        uint256 fee = _ceilFee(_abs(s.pool0), 200);
        assertEq(recipient.balance - ethBefore, fee);
        assertEq(int256(s.caller0), int256(s.pool0) - int256(fee));

        // Exact-in ETH -> token as claims: the fee is the token.
        h.setSwapFee(key, 200, recipient, true);
        vm.recordLogs();
        BalanceDelta d = swapNativeInput(key, true, -1e15, ZERO_BYTES, 1e15);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        int128 pool1;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IPoolManager.Swap.selector) {
                (, pool1,,,,) =
                    abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
            }
        }
        fee = _ceilFee(_abs(pool1), 200);
        assertEq(_claims(recipient, currency1), fee);
        assertEq(int256(d.amount1()), int256(pool1) - int256(fee));
    }

    // ------------------------------------------------------------ composition

    function _composed(string memory what) internal returns (address h, PoolKey memory key) {
        h = _deployHook(what, abi.encode(manager), COMPOSED_FLAGS);
        (key,) = initPoolAndAddLiquidity(
            currency0, currency1, IHooks(h), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1
        );
        SwapFeeHook(h).setSwapFee(key, 100, recipient, true);
    }

    function _checkComposed(string memory what) internal returns (uint256 out, uint24 lpFee) {
        (address h, PoolKey memory key) = _composed(what);
        assertEq(_flags(BaseHook(h).getHookPermissions()), COMPOSED_FLAGS, "merged flags");

        vm.warp(block.timestamp + 30 minutes);
        uint24 expectedLp = MockDecayingFee(h).mockLpFee();
        assertGt(expectedLp, 3000);
        assertLt(expectedLp, 50_000);

        Swapped memory s = _swap(key, true, -1e15);
        uint256 gross = _abs(s.pool1);
        uint256 swapFeeAmt = _ceilFee(gross, 100);
        uint256 mockAmt = gross / 200;
        assertEq(s.lpFee, expectedLp, "decayed LP fee override applied");
        assertEq(_claims(recipient, currency1), swapFeeAmt, "swap fee");
        assertEq(_claims(h, currency1), mockAmt, "mock feature fee");
        assertEq(uint256(int256(s.caller1)), gross - swapFeeAmt - mockAmt, "deltas summed");
        assertEq(s.caller0, s.pool0);
        return (gross - swapFeeAmt - mockAmt, s.lpFee);
    }

    function test_composesWithDecayingFee() public {
        _checkComposed("SwapFeeHook.t.sol:DecayThenSwapFee");
    }

    function test_compositionOrderDoesNotMatter() public {
        uint256 ts = block.timestamp;
        (uint256 outA, uint24 feeA) = _checkComposed("SwapFeeHook.t.sol:DecayThenSwapFee");
        vm.warp(ts);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        recipient = makeAddr("recipient2");
        (uint256 outB, uint24 feeB) = _checkComposed("SwapFeeHook.t.sol:SwapFeeThenDecay");
        assertEq(outA, outB);
        assertEq(feeA, feeB);
    }

    function test_composedStaticFeePoolCannotInitialize() public {
        address h =
            _deployHook("SwapFeeHook.t.sol:DecayThenSwapFee", abi.encode(manager), COMPOSED_FLAGS);
        vm.expectRevert();
        initPool(currency0, currency1, IHooks(h), 3000, SQRT_PRICE_1_1);
    }
}
