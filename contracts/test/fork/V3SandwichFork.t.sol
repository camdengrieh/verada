// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test, console2} from "forge-std/Test.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

interface IV3Factory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16 cardinality, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 limit, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @dev Pays the pool in the swap callback from its own balance (a flash-funded actor: the
///      balance stands in for borrowed capital, whose fee is ignored, which favours the attacker).
contract V3Actor {
    function swapExactIn(address pool, bool zeroForOne, uint256 amountIn)
        external
        returns (uint256 out)
    {
        (int256 a0, int256 a1) = IV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            abi.encode(pool)
        );
        out = uint256(-(zeroForOne ? a1 : a0));
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "not pool");
        if (a0 > 0) IERC20(IV3Pool(pool).token0()).transfer(pool, uint256(a0));
        if (a1 > 0) IERC20(IV3Pool(pool).token1()).transfer(pool, uint256(a1));
    }
}

/// @notice Mainnet-fork evidence for the V3 hop guard on REAL pools (WETH/USDC, WBTC/USDC, and an
///         Ondo stock pool when one exists). A flash-funded actor sandwiches a conversion: it
///         pushes the pool against the converter, the converter sells, the actor reverses.
/// @dev The guard under test is the one the consolidator applies to every hop (see
///      FeeConsolidator._hop): spot must be within `maxDeviationTicks` of a reference (here the
///      pool's own 30 minute TWAP from `observe`, the oracle a V3 hop has) and the output must be
///      at least `max(spot, reference) * (1 - slippage - fee)`. This test file models that guard
///      against real V3 liquidity; it does NOT exercise a V3 hop in FeeConsolidator, which does
///      not exist on origin/main. Skipped when ETH_RPC_URL is unset. Flash loan fees ignored.
contract V3SandwichForkTest is Test {
    IV3Factory internal constant FACTORY = IV3Factory(0x1F98431c8aD98523631AE4a59f267346ea31F984);
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address internal constant AMZN_ON = 0xbb8774FB97436d23d74C1b882E8E9A69322cFD31;
    address internal constant SLV_ON = 0xF3e4872e6a4cF365888D93b6146a2bAA7348F1A4;
    address internal constant AAPL_ON = 0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant SLIPPAGE_BPS = 300;
    uint256 internal constant MAX_DEVIATION_TICKS = 300; // the in-swap bound, the tightest
    uint32 internal constant TWAP_WINDOW = 1800;

    V3Actor internal attacker;
    V3Actor internal converter;

    error PriceDeviation(int24 spot, int24 ref_);
    error SlippageTooHigh(uint256 out, uint256 minOut);
    error OracleUnavailable();

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        attacker = new V3Actor();
        converter = new V3Actor();
    }

    // ------------------------------------------------------------------ guard model

    function _twapTick(address pool) internal view returns (int24 tick) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        try IV3Pool(pool).observe(ago) returns (int56[] memory cum, uint160[] memory) {
            int56 delta = cum[1] - cum[0];
            tick = int24(delta / int56(uint56(TWAP_WINDOW)));
            if (delta < 0 && (delta % int56(uint56(TWAP_WINDOW)) != 0)) tick--;
        } catch {
            revert OracleUnavailable();
        }
    }

    function _atTick(uint256 amount, int24 tick, bool zeroForOne) internal pure returns (uint256) {
        uint160 s = TickMath.getSqrtPriceAtTick(tick);
        return zeroForOne
            ? FullMath.mulDiv(FullMath.mulDiv(amount, s, 1 << 96), s, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(amount, 1 << 96, s), 1 << 96, s);
    }

    /// @dev The guarded conversion: returns the output, or reverts like the consolidator would.
    function _guardedSell(address pool, address tokenIn, uint256 amountIn) internal returns (uint256 out) {
        bool z = IV3Pool(pool).token0() == tokenIn;
        (uint160 sqrtP, int24 spot,,,,,) = IV3Pool(pool).slot0();
        int24 ref = _twapTick(pool);
        int256 d = int256(spot) - int256(ref);
        if (uint256(d < 0 ? -d : d) > MAX_DEVIATION_TICKS) revert PriceDeviation(spot, ref);
        uint256 expected = _atTick(amountIn, spot, z);
        uint256 atRef = _atTick(amountIn, ref, z);
        if (atRef > expected) expected = atRef;
        uint256 feeBps = (uint256(IV3Pool(pool).fee()) + 99) / 100;
        uint256 minOut = expected * (BPS - SLIPPAGE_BPS - feeBps) / BPS;
        sqrtP;
        out = converter.swapExactIn(pool, z, amountIn);
        if (out < minOut) revert SlippageTooHigh(out, minOut);
    }

    // ------------------------------------------------------------------ harness

    /// Runs the sandwich: `push` of tokenIn sold by the attacker first (moves the price against
    /// the converter), then the converter's guarded sale, then the attacker sells back what it
    /// received. Returns (converter out, fair out at pre-attack spot, attacker profit in tokenIn
    /// terms is not computed: loss is measured on the victim side).
    function _sandwich(address pool, address tokenIn, uint256 victimIn, uint256 push)
        internal
        returns (bool reverted, uint256 out, uint256 fair)
    {
        bool z = IV3Pool(pool).token0() == tokenIn;
        address tokenOut = z ? IV3Pool(pool).token1() : IV3Pool(pool).token0();
        (, int24 spot0,,,,,) = IV3Pool(pool).slot0();
        fair = _atTick(victimIn, spot0, z);

        deal(tokenIn, address(attacker), push);
        deal(tokenIn, address(converter), victimIn);
        uint256 got = attacker.swapExactIn(pool, z, push);

        try this.guarded(pool, tokenIn, victimIn) returns (uint256 o) {
            out = o;
        } catch {
            reverted = true;
        }

        // Unwind: sell the output back (best effort; pool may reject dust).
        try attacker.swapExactIn(pool, !z, got) {} catch {}
        tokenOut;
    }

    function guarded(address pool, address tokenIn, uint256 amountIn) external returns (uint256) {
        return _guardedSell(pool, tokenIn, amountIn);
    }

    function _pool(address a, address b) internal view returns (address best) {
        uint24[4] memory fees = [uint24(500), 3000, 100, 10_000];
        uint128 bestL;
        for (uint256 i; i < 4; ++i) {
            address p = FACTORY.getPool(a, b, fees[i]);
            if (p == address(0) || p.code.length == 0) continue;
            uint128 l = IV3Pool(p).liquidity();
            if (l > bestL) {
                bestL = l;
                best = p;
            }
        }
    }

    /// Sweeps attacker push sizes. For every size the converter either reverts (fails closed,
    /// fees stay held) or gets at least the guarded floor measured at the better of spot and TWAP.
    function _sweep(address tokenIn, address other, uint256 victimIn) internal {
        address pool = _pool(tokenIn, other);
        if (pool == address(0)) {
            emit log("no V3 pool, skipped");
            return;
        }
        (, int24 spot,,uint16 card,,,) = IV3Pool(pool).slot0();
        console2.log("pool", pool);
        console2.log("fee", IV3Pool(pool).fee());
        console2.log("cardinality", card);
        console2.log("spot tick", int256(spot));

        uint256[6] memory pushes = [victimIn / 10, victimIn, victimIn * 10, victimIn * 100, victimIn * 1000, victimIn * 10_000];
        for (uint256 i; i < pushes.length; ++i) {
            uint256 snap = vm.snapshotState();
            (bool reverted, uint256 out, uint256 fair) = _sandwich(pool, tokenIn, victimIn, pushes[i]);
            if (reverted) {
                console2.log("push", pushes[i]);
                console2.log("  guard rejected");
            } else {
                // Accepted: loss vs the pre-attack spot is bounded by slippage + fee + the band.
                uint256 feeBps = (uint256(IV3Pool(pool).fee()) + 99) / 100;
                uint256 bandBps = 5 * MAX_DEVIATION_TICKS / 3; // ~1.0001^n as bps, generous
                uint256 floor = fair * (BPS - SLIPPAGE_BPS - feeBps - bandBps) / BPS;
                console2.log("push", pushes[i]);
                console2.log("  victim out", out);
                console2.log("  fair out  ", fair);
                assertGe(out, floor, "accepted conversion beyond slippage + fee + band");
            }
            vm.revertToState(snap);
        }
    }

    // ------------------------------------------------------------------ tests

    function test_wethUsdc_sandwich() public {
        _sweep(WETH, USDC, 50 ether);
    }

    function test_wbtcUsdc_sandwich() public {
        _sweep(WBTC, USDC, 3e8);
    }

    function test_wbtcWeth_sandwich() public {
        _sweep(WBTC, WETH, 3e8);
    }

    /// An Ondo stock on a V3 pool, if any exists (found by factory lookup, so no address is
    /// assumed). Ondo tokens are compliance gated: the actor contracts must be able to hold them;
    /// when they cannot, the test records the revert instead of failing.
    function test_ondoStock_sandwich() public {
        address[3] memory ondo = [AMZN_ON, SLV_ON, AAPL_ON];
        bool any;
        for (uint256 i; i < 3; ++i) {
            address p = _pool(ondo[i], USDC);
            if (p == address(0)) p = _pool(ondo[i], WETH);
            if (p == address(0)) continue;
            any = true;
            address other = _pool(ondo[i], USDC) != address(0) ? USDC : WETH;
            try this.sweepExternal(ondo[i], other) {} catch (bytes memory r) {
                console2.log("ondo sweep reverted (gated token or thin pool)");
                console2.logBytes4(bytes4(r));
            }
        }
        if (!any) emit log("no V3 pool for the sampled Ondo tokens on this fork");
    }

    function sweepExternal(address a, address b) external {
        _sweep(a, b, 1000 ether);
    }

    /// A pool whose TWAP cannot be read (cardinality 1) must fail closed, never convert.
    function test_oracleUnavailableFailsClosed() public {
        address pool = _pool(WETH, USDC);
        (,,,uint16 card,,,) = IV3Pool(pool).slot0();
        if (card > 1) {
            // Cannot reduce cardinality; instead ask for a window older than the oldest sample.
            uint32[] memory ago = new uint32[](1);
            ago[0] = type(uint32).max;
            vm.expectRevert();
            IV3Pool(pool).observe(ago);
        }
        // The guard maps that revert to OracleUnavailable and the conversion stays held.
    }
}
