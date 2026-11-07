// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {FeeConsolidator, IConsolidatorRegistry} from "../../src/FeeConsolidator.sol";
import {FeeConsolidatorV3} from "../../src/FeeConsolidatorV3.sol";
import {VaradaToken} from "../../src/VaradaToken.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {IUniswapV3Factory} from "../../src/interfaces/external/IUniswapV3.sol";
import {V3RouteLib} from "../../src/libraries/V3RouteLib.sol";
import {MockV3Factory, MockV3Pool} from "../consolidator/V3Mocks.sol";
import {LiveBase} from "./LiveBase.sol";
import {ClaimsSource} from "./LiveMocks.sol";

/// @dev The live-donation hook converting its fee inline through a Uniswap v3 hop (mock pool):
///      the swap never reverts for a conversion failure, and the conversion is credited when it
///      works. Gas is compared with the same conversion through the v4 route.
contract LiveV3RouteTest is LiveBase {
    MockV3Factory internal v3f;
    MockV3Pool internal v3Pool;
    VaradaToken internal token;
    PoolKey internal liveKey;
    int24 internal qt;

    function setUp() public {
        _liveSetUp();
        qt = _orientedTick(address(quote), address(usdc), QUOTE_TICK);
        v3Pool = v3f.create(address(quote), address(usdc), 3000, qt);
        usdc.mint(address(v3Pool), 1e30);
        quote.mint(address(v3Pool), 1e30);
        _useV3Route();

        (token, liveKey) = _launchDefault(address(quote), 0); // threshold 0: push every swap
        _fundTrader(trader, token);
    }

    function _deployConsolidator() internal override returns (FeeConsolidator) {
        v3f = new MockV3Factory();
        return new FeeConsolidatorV3(
            address(this),
            manager,
            IConsolidatorRegistry(address(registry)),
            IFeeVault(address(feeVault)),
            address(weth),
            MAX_SLIPPAGE_BPS,
            MAX_DEVIATION_TICKS,
            IUniswapV3Factory(address(v3f))
        );
    }

    function _useV3Route() internal {
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = V3RouteLib.hop(address(quote), address(usdc), 3000);
        registry.setRoute(address(quote), r);
        cons.seedReferences(r);
    }

    function _useV4Route() internal {
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = quoteUsdcKey;
        registry.setRoute(address(quote), r);
    }

    function _buyAndRead() internal returns (bool converted, uint256 out, uint256 fee, uint256 gasUsed) {
        vm.recordLogs();
        uint256 g = gasleft();
        _buyExactIn(liveKey, address(token), 1e18);
        gasUsed = g - gasleft();
        bool found;
        (found,,, fee, out, converted,) = _lastFeeTaken(vm.getRecordedLogs());
        assertTrue(found);
    }

    function test_inlineConversionThroughV3() public {
        (bool converted, uint256 out, uint256 fee,) = _buyAndRead();
        assertTrue(converted);
        assertGt(out, 0);
        assertEq(fee, 3e16); // 3% base fee of 1 quote
        assertEq(v3Pool.swaps(), 1);
        assertEq(hook.heldRaw(address(token), CAUSE_A), 0);
        assertEq(usdc.balanceOf(address(cons)), 0);
        assertEq(quote.balanceOf(address(cons)), 0);
    }

    function test_badPriceHoldsAndSwapSucceeds() public {
        v3Pool.setShave(1000);
        (bool converted,, uint256 fee,) = _buyAndRead();
        assertFalse(converted);
        assertEq(hook.heldRaw(address(token), CAUSE_A), fee);
        assertEq(v3Pool.swaps(), 0); // the pool swap ran inside the failed attempt and was undone
    }

    function test_deviationHoldsAndSwapSucceeds() public {
        v3Pool.setTick(qt + 5000);
        (bool converted,, uint256 fee,) = _buyAndRead();
        assertFalse(converted);
        assertEq(hook.heldRaw(address(token), CAUSE_A), fee);
        assertEq(v3Pool.swaps(), 0);
    }

    function test_partialFillHoldsAndSwapSucceeds() public {
        v3Pool.setFill(5000);
        (bool converted,, uint256 fee,) = _buyAndRead();
        assertFalse(converted);
        assertEq(hook.heldRaw(address(token), CAUSE_A), fee);
    }

    function test_poolRemovedHoldsAndSwapSucceeds() public {
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = V3RouteLib.hop(address(quote), address(usdc), 500); // no pool
        registry.setRoute(address(quote), r);
        cons.setReference(r[0], qt);
        (bool converted,, uint256 fee,) = _buyAndRead();
        assertFalse(converted);
        assertEq(hook.heldRaw(address(token), CAUSE_A), fee);
    }

    function test_heldFeeIsRetriedAfterRecovery() public {
        v3Pool.setShave(1000);
        _buyAndRead();
        uint256 held = hook.heldRaw(address(token), CAUSE_A);
        assertGt(held, 0);
        v3Pool.setShave(0);
        uint256 out = hook.retryHeld(address(token), CAUSE_A, held);
        assertGt(out, 0);
        assertEq(hook.heldRaw(address(token), CAUSE_A), 0);
    }

    function test_gasV3VersusV4() public {
        uint256 snap = vm.snapshotState();
        (bool c3,,, uint256 gas3) = _buyAndRead();
        vm.revertToState(snap);
        _useV4Route();
        (bool c4,,, uint256 gas4) = _buyAndRead();
        assertTrue(c3 && c4);
        emit log_named_uint("gas: live swap with inline conversion, v3 route", gas3);
        emit log_named_uint("gas: live swap with inline conversion, v4 route", gas4);
    }

    function test_claimsGasV3VersusV4() public {
        ClaimsSource src = new ClaimsSource(manager, IFeeConsolidator(address(cons)));
        cons.setSource(address(src), true);
        quote.mint(address(src), 2e18);
        src.deposit(address(quote), 2e18);
        address to = makeAddr("to");
        src.convert(address(quote), 1e18, to, true);
        uint256 gas3 = src.lastConvertGas();
        _useV4Route();
        src.convert(address(quote), 1e18, to, true);
        uint256 gas4 = src.lastConvertGas();
        emit log_named_uint("gas: convertClaims one hop, v3", gas3);
        emit log_named_uint("gas: convertClaims one hop, v4", gas4);
        assertGt(usdc.balanceOf(to), 0);
    }
}
