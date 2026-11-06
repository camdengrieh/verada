// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {VaradaToken} from "../../src/VaradaToken.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {ConsolidatorBase} from "../consolidator/ConsolidatorBase.sol";
import {LiveBase} from "./LiveBase.sol";
import {AdversarialOrg, ClaimsSource, SyncingRouter} from "./LiveMocks.sol";

/// @dev Gas of the live swap path, measured with cold storage (`vm.cool`) to approximate a fresh
///      transaction. Values are call gas from this test contract (no 21k intrinsic cost). Logged
///      with `log_named_uint` and checked against the hook and vault budgets; nothing is written
///      to disk.
contract LiveGasTest is LiveBase {
    uint96 internal constant NO_PUSH = 1_000_000e6;

    function setUp() public {
        _liveSetUp();
    }

    function _cold(address token) internal {
        vm.cool(address(manager));
        vm.cool(address(hook));
        vm.cool(address(cons));
        vm.cool(address(registry));
        vm.cool(address(rgov));
        vm.cool(address(vault));
        vm.cool(address(usdc));
        vm.cool(address(quote));
        vm.cool(address(ondoB));
        vm.cool(address(weth));
        vm.cool(token);
        vm.cool(orgA);
        vm.cool(orgB);
        vm.cool(address(endRegistry));
        vm.cool(address(endFactory));
        vm.cool(address(causes));
        vm.cool(address(swapRouter));
    }

    function _buyGas(PoolKey memory key, address token, uint256 quoteIn)
        internal
        returns (uint256 used)
    {
        bool zeroForOne = _quoteIs0(key, token);
        SwapParams memory p = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(quoteIn),
            sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
        PoolSwapTest.TestSettings memory ts =
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        _cold(token);
        vm.prank(trader);
        uint256 g = gasleft();
        swapRouter.swap(key, p, ts, ZERO_BYTES);
        used = g - gasleft();
    }

    function _token(address quoteAsset, uint96 threshold, bytes32 cause)
        internal
        returns (VaradaToken t, PoolKey memory k)
    {
        (t, k) = _launchFull(quoteAsset, threshold, RotationPeriod.OneHour, 0, 0, cause);
        _fundTrader(trader, t);
    }

    // ------------------------------------------------------------------ swap path

    function test_gas_swapPath() public {
        (VaradaToken t, PoolKey memory k) = _token(address(quote), NO_PUSH, CAUSE_A);

        emit log_named_uint("live no fee (dust)", _buyGas(k, address(t), 1));
        uint256 firstBucket = _buyGas(k, address(t), 1e18);
        emit log_named_uint("live threshold>0 below, 1 hop, first bucket", firstBucket);
        uint256 below = _buyGas(k, address(t), 1e18);
        emit log_named_uint("live threshold>0 below, 1 hop, steady", below);

        (VaradaToken t2, PoolKey memory k2) = _token(address(quote), 5e6, CAUSE_A);
        _buyGas(k2, address(t2), 1e18);
        uint256 crossing = _buyGas(k2, address(t2), 1e18);
        emit log_named_uint("live threshold>0 crossing swap (push)", crossing);

        (VaradaToken t3, PoolKey memory k3) = _token(address(quote), 0, CAUSE_A);
        _buyGas(k3, address(t3), 1e18);
        uint256 push = _buyGas(k3, address(t3), 1e18);
        emit log_named_uint("live threshold 0 (push every swap), 1 hop", push);

        (VaradaToken t4, PoolKey memory k4) = _token(address(quote), 0, CAUSE_B);
        _buyGas(k4, address(t4), 1e18);
        uint256 deferred = _buyGas(k4, address(t4), 1e18);
        emit log_named_uint("live threshold 0, undeployed org (deferred, backoff)", deferred);

        cons.setSource(address(hook), false);
        uint256 heldEarly = _buyGas(k, address(t), 1e18);
        emit log_named_uint("live conversion fails (consolidator refuses)", heldEarly);
        cons.setSource(address(hook), true);
        cons.setReference(quoteUsdcKey, _spotTick(quoteUsdcKey) + 5000);
        uint256 heldGuard = _buyGas(k, address(t), 1e18);
        emit log_named_uint("live conversion fails (deviation guard)", heldGuard);

        assertLt(below, crossing);
        assertLt(heldGuard, below);
    }

    function test_gas_routes() public {
        (VaradaToken tw, PoolKey memory kw) = _token(address(weth), NO_PUSH, CAUSE_A);
        _buyGas(kw, address(tw), 1e17);
        emit log_named_uint("live WETH quote (unwrap hop), below", _buyGas(kw, address(tw), 1e17));

        (VaradaToken tb, PoolKey memory kb) = _token(address(ondoB), NO_PUSH, CAUSE_A);
        _buyGas(kb, address(tb), 1e18);
        uint256 three = _buyGas(kb, address(tb), 1e18);
        emit log_named_uint("live 3-hop route (ondoB, unwrap), below", three);

        (VaradaToken tb0, PoolKey memory kb0) = _token(address(ondoB), 0, CAUSE_A);
        _buyGas(kb0, address(tb0), 1e18);
        uint256 threePush = _buyGas(kb0, address(tb0), 1e18);
        emit log_named_uint("live 3-hop route, threshold 0 (push)", threePush);
    }

    function test_gas_syncedSkip() public {
        (VaradaToken t, PoolKey memory k) = _token(address(quote), NO_PUSH, CAUSE_A);
        SyncingRouter router = new SyncingRouter(manager);
        vm.prank(trader);
        quote.approve(address(router), type(uint256).max);
        bool zeroForOne = _quoteIs0(k, address(t));
        SwapParams memory p = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -1e18,
            sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
        _cold(address(t));
        vm.prank(trader);
        uint256 g = gasleft();
        router.swap(k, p, Currency.wrap(address(usdc)));
        emit log_named_uint("live synced-currency skip (held)", g - gasleft());
    }

    // ------------------------------------------------------------------ budgets

    /// @dev The in-swap budget covers the heaviest conversion (three hops with the unwrap), the
    ///      credit and a push that burns its whole cap; the push budget covers a real push.
    function test_gas_budgets() public {
        ClaimsSource src = new ClaimsSource(manager, IFeeConsolidator(address(cons)));
        cons.setSource(address(src), true);
        ondoB.mint(address(src), 1e21);
        src.deposit(address(ondoB), 1e21);
        quote.mint(address(src), 1e21);
        src.deposit(address(quote), 1e21);

        _cold(address(0));
        src.convert(address(quote), 1e18, address(vault), true);
        uint256 one = src.lastConvertGas();
        _cold(address(0));
        src.convert(address(ondoB), 1e18, address(vault), true);
        uint256 three = src.lastConvertGas();
        emit log_named_uint("convertClaims 1 hop", one);
        emit log_named_uint("convertClaims 3 hops + unwrap", three);

        // Push: one credit then `executePush` alone, cold.
        address tok = makeAddr("tok");
        vault.registerToken(tok, NO_PUSH, CAUSE_A, RotationPeriod.OneHour);
        usdc.mint(address(vault), 100e6);
        vm.prank(address(hook));
        vault.creditLive(tok, CAUSE_A, 0, 100e6);
        _cold(tok);
        vm.prank(address(vault));
        uint256 g = gasleft();
        vault.executePush(tok, CAUSE_A, 90e6);
        uint256 pushGas = g - gasleft();
        emit log_named_uint("executePush (deployed org)", pushGas);

        // Credit without push, cold (first bucket).
        address tok2 = makeAddr("tok2");
        vault.registerToken(tok2, NO_PUSH, CAUSE_A, RotationPeriod.OneHour);
        usdc.mint(address(vault), 10e6);
        _cold(tok2);
        vm.prank(address(hook));
        g = gasleft();
        vault.creditLive(tok2, CAUSE_A, 0, 10e6);
        uint256 creditGas = g - gasleft();
        emit log_named_uint("creditLive without push (first bucket)", creditGas);

        uint256 worstInline = three + creditGas + vault.PUSH_GAS_BUDGET() + 30_000;
        emit log_named_uint("worst in-swap conversion estimate", worstInline);
        emit log_named_uint("INLINE_GAS_BUDGET", hook.INLINE_GAS_BUDGET());
        emit log_named_uint("PUSH_GAS_BUDGET", vault.PUSH_GAS_BUDGET());
        emit log_named_uint("LIVE_GAS_REQUIRED", hook.LIVE_GAS_REQUIRED());
        assertLe(pushGas * 125 / 100, vault.PUSH_GAS_BUDGET(), "push budget >= 1.25x");
        assertLe(worstInline, hook.INLINE_GAS_BUDGET(), "inline budget covers the worst case");
    }

    /// @dev At the smallest gas limit that passes, a push that burns its whole cap still leaves
    ///      the swap enough gas to finish (the trader never pays for a hostile org with a revert).
    function test_gas_minimumLimit_survivesHostileOrg() public {
        (VaradaToken t, PoolKey memory k) = _token(address(ondoB), 0, CAUSE_A);
        _buyGas(k, address(t), 1e18);
        bool zeroForOne = _quoteIs0(k, address(t));
        bytes memory call = abi.encodeCall(
            PoolSwapTest.swap,
            (
                k,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -1e18,
                    sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ZERO_BYTES
            )
        );
        uint256 lo = 600_000;
        uint256 hi = 3_000_000;
        uint256 snap = vm.snapshotState();
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            vm.prank(trader);
            (bool ok,) = address(swapRouter).call{gas: mid}(call);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        emit log_named_uint("minimum gas limit, 3-hop route with push", hi);
        AdversarialOrg org = _makeAdversarial(orgA);
        org.configure(AdversarialOrg.Mode.BurnGas, address(0), address(0), bytes32(0));
        vm.prank(trader);
        (bool ok2,) = address(swapRouter).call{gas: hi}(call);
        assertTrue(ok2, "hostile org cannot make the swap run out of gas");
    }
}

/// @dev Weekly-mode baseline: the same kind of swap through the weekly VaradaHook.
contract WeeklyGasBaselineTest is ConsolidatorBase {
    function setUp() public {
        _baseSetUp();
        _setupPools(0, 0);
    }

    function test_gas_weeklyBaseline() public {
        bool zeroForOne = Currency.unwrap(tokenKey.currency0) == address(quote);
        SwapParams memory p = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -1e18,
            sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
        PoolSwapTest.TestSettings memory ts =
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        swapRouter.swap(tokenKey, p, ts, ZERO_BYTES);
        vm.warp(block.timestamp + 10 minutes);
        vm.cool(address(manager));
        vm.cool(address(hook));
        vm.cool(address(quote));
        vm.cool(address(meme));
        vm.cool(address(swapRouter));
        uint256 g = gasleft();
        swapRouter.swap(tokenKey, p, ts, ZERO_BYTES);
        emit log_named_uint("weekly VaradaHook swap (no surcharge)", g - gasleft());
    }
}
