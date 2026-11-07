// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {FeeConsolidator, IConsolidatorRegistry} from "../../src/FeeConsolidator.sol";
import {FeeConsolidatorV3} from "../../src/FeeConsolidatorV3.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "../../src/interfaces/external/IUniswapV3.sol";
import {V3RouteLib} from "../../src/libraries/V3RouteLib.sol";
import {MockDistributor, MockERC20, MockGovernor} from "../consolidator/ConsolidatorMocks.sol";
import {ClaimsSource} from "../live/LiveMocks.sol";

interface IPoolLiq {
    function liquidity() external view returns (uint128);
}

/// @dev Pulls a swap through a real v3 pool to move its price (sandwich stand-in).
contract V3Pusher {
    function push(address pool, bool zeroForOne, int256 amount) external {
        IUniswapV3Pool(pool)
            .swap(
                address(this),
                zeroForOne,
                amount,
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
                ""
            );
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        // The test funds this contract with the input token beforehand.
        (address t0, address t1) = (_token0(msg.sender), _token1(msg.sender));
        if (a0 > 0) IERC20(t0).transfer(msg.sender, uint256(a0));
        if (a1 > 0) IERC20(t1).transfer(msg.sender, uint256(a1));
    }

    function _token0(address pool) private view returns (address) {
        (, bytes memory d) = pool.staticcall(abi.encodeWithSignature("token0()"));
        return abi.decode(d, (address));
    }

    function _token1(address pool) private view returns (address) {
        (, bytes memory d) = pool.staticcall(abi.encodeWithSignature("token1()"));
        return abi.decode(d, (address));
    }
}

/// @dev `FeeConsolidatorV3` against real Uniswap v3 pools on a mainnet fork: Ondo stock tokens
///      (AAPLon, SLVon) and WBTC converted to real USDC. Skipped without `ETH_RPC_URL`.
contract ConsolidatorV3ForkTest is Test {
    using StateLibrary for IPoolManager;

    IPoolManager internal constant PM = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    IUniswapV3Factory internal constant V3F =
        IUniswapV3Factory(0x1F98431c8aD98523631AE4a59f267346ea31F984);
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant WBTC = 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599;
    address internal constant SLV_ON = 0xF3e4872e6a4cF365888D93b6146a2bAA7348F1A4;
    address internal constant AAPL_ON = 0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c;

    QuoteRegistry internal registry;
    FeeVault internal vault;
    FeeConsolidatorV3 internal cons;
    MockERC20 internal meme;
    address internal locker = makeAddr("locker");

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        meme = new MockERC20("MEME", 18);
        registry = new QuoteRegistry(address(this), USDC, WETH);
        vault = new FeeVault(
            address(this),
            address(this),
            makeAddr("treasury"),
            IEpochGovernor(address(new MockGovernor())),
            address(new MockDistributor()),
            USDC
        );
        cons = new FeeConsolidatorV3(
            address(this),
            PM,
            IConsolidatorRegistry(address(registry)),
            IFeeVault(address(vault)),
            WETH,
            300,
            1500,
            V3F
        );
        vault.setConsolidator(address(cons));
        // This test contract plays the hook (it registers the pool) and the fee source.
        cons.setHook(address(this));
        cons.setSource(locker, true);
        vault.registerToken(address(meme));
    }

    // ------------------------------------------------------------------ helpers

    function _route(address asset, uint24 fee) internal returns (PoolKey memory k) {
        k = V3RouteLib.hop(asset, USDC, fee);
        address pool = V3F.getPool(Currency.unwrap(k.currency0), Currency.unwrap(k.currency1), fee);
        require(pool != address(0) && IPoolLiq(pool).liquidity() > 0, "no v3 liquidity");
    }

    function _registerQuote(address asset, IQuoteRegistry.Kind kind, PoolKey[] memory route)
        internal
    {
        registry.addQuoteAssetWithRoute(asset, kind, route);
        cons.seedReferences(route);
        (address a, address b) = address(meme) < asset ? (address(meme), asset) : (asset, address(meme));
        cons.registerPool(
            address(meme), PoolKey(Currency.wrap(a), Currency.wrap(b), 0x800000, 200, IHooks(address(0)))
        );
    }

    function _give(address token, address to, uint256 amount) internal {
        if (token == WBTC || token == USDC) {
            deal(token, to, IERC20(token).balanceOf(to) + amount);
        } else {
            // Ondo tokens: take them from the pool manager (a real transfer).
            vm.prank(address(PM));
            IERC20(token).transfer(to, amount);
        }
    }

    function _deliver(address token, uint256 amount) internal returns (uint256 gasUsed) {
        _give(token, address(cons), amount);
        vm.prank(locker);
        uint256 g = gasleft();
        cons.consolidate(address(meme), token, amount);
        gasUsed = g - gasleft();
    }

    function _spotUsdc(PoolKey memory k, address asset, uint256 amount) internal view returns (uint256) {
        address pool = V3F.getPool(Currency.unwrap(k.currency0), Currency.unwrap(k.currency1), k.fee);
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        return asset == Currency.unwrap(k.currency0)
            ? FullMath.mulDiv(FullMath.mulDiv(amount, sqrtP, 1 << 96), sqrtP, 1 << 96)
            : FullMath.mulDiv(FullMath.mulDiv(amount, 1 << 96, sqrtP), 1 << 96, sqrtP);
    }

    function _lastFailureSel(Vm.Log[] memory logs) internal pure returns (bytes4 sel, bool found) {
        bytes32 topic0 = keccak256("ConsolidationFailed(address,address,uint256,bytes)");
        for (uint256 i = logs.length; i > 0; --i) {
            if (logs[i - 1].topics[0] == topic0) {
                (, bytes memory reason) = abi.decode(logs[i - 1].data, (uint256, bytes));
                if (reason.length >= 4) {
                    assembly {
                        sel := mload(add(reason, 32))
                    }
                }
                return (sel, true);
            }
        }
    }

    // ------------------------------------------------------------------ Ondo stocks

    function _ondoV3(address ondo, uint24 fee, uint256 amount) internal {
        PoolKey memory k = _route(ondo, fee);
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = k;
        _registerQuote(ondo, IQuoteRegistry.Kind.Ondo, r);

        uint256 spot = _spotUsdc(k, ondo, amount);
        uint256 gasUsed = _deliver(ondo, amount);
        uint256 got = IERC20(USDC).balanceOf(address(vault));
        emit log_named_uint("amount in (raw)", amount);
        emit log_named_uint("spot value (USDC, 6 dec)", spot);
        emit log_named_uint("received (USDC, 6 dec)", got);
        emit log_named_uint("gas: consolidate Ondo -> USDC via real v3 pool", gasUsed);
        assertGt(got, 0);
        assertEq(cons.heldFees(address(meme), ondo), 0, "consolidated");
        assertEq(IERC20(ondo).balanceOf(address(cons)), 0);
        assertEq(IERC20(USDC).balanceOf(address(cons)), 0);
        // Pool fee plus impact, inside slippage (3%) + hop fee.
        assertGt(got, (spot * (10_000 - 300 - fee / 100)) / 10_000);
        assertLe(got, spot);
        assertEq(vault.totalTracked(), got);
    }

    function test_fork_aaplOn_toUsdc_viaV3() public {
        _ondoV3(AAPL_ON, 10_000, 1e17);
    }

    function test_fork_slvOn_toUsdc_viaV3() public {
        _ondoV3(SLV_ON, 10_000, 1e17);
    }

    // ------------------------------------------------------------------ WBTC

    function test_fork_wbtc_toUsdc_directV3() public {
        PoolKey memory k = _route(WBTC, 3000);
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = k;
        _registerQuote(WBTC, IQuoteRegistry.Kind.Native, r);
        uint256 amount = 1e6; // 0.01 WBTC
        uint256 spot = _spotUsdc(k, WBTC, amount);
        uint256 gasUsed = _deliver(WBTC, amount);
        uint256 got = IERC20(USDC).balanceOf(address(vault));
        emit log_named_uint("spot value (USDC, 6 dec)", spot);
        emit log_named_uint("received (USDC, 6 dec)", got);
        emit log_named_uint("gas: consolidate WBTC -> USDC via real v3 pool", gasUsed);
        assertGt(got, (spot * 9600) / 10_000);
        assertLe(got, spot);
        assertEq(cons.heldFees(address(meme), WBTC), 0);
    }

    function test_fork_wbtc_twoV3Hops_viaWeth() public {
        PoolKey[] memory r = new PoolKey[](2);
        r[0] = V3RouteLib.hop(WBTC, WETH, 500);
        r[1] = V3RouteLib.hop(WETH, USDC, 500);
        _registerQuote(WBTC, IQuoteRegistry.Kind.Native, r);
        uint256 amount = 1e6;
        uint256 gasUsed = _deliver(WBTC, amount);
        uint256 got = IERC20(USDC).balanceOf(address(vault));
        emit log_named_uint("received (USDC, 6 dec)", got);
        emit log_named_uint("gas: consolidate WBTC -> WETH -> USDC (two v3 hops)", gasUsed);
        assertGt(got, 0);
        assertEq(IERC20(WETH).balanceOf(address(cons)), 0);
        assertEq(cons.heldFees(address(meme), WBTC), 0);
        // Same value as the direct pool within a few percent.
        uint256 direct = _spotUsdc(V3RouteLib.hop(WBTC, USDC, 3000), WBTC, amount);
        assertApproxEqRel(got, direct, 0.03e18);
    }

    function test_fork_wbtc_manipulatedPoolHeldNotSwapped() public {
        PoolKey memory k = _route(WBTC, 3000);
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = k;
        _registerQuote(WBTC, IQuoteRegistry.Kind.Native, r);

        // A trader pushes the pool far from the seeded reference, then the fee arrives.
        address pool = V3F.getPool(WBTC, USDC, 3000);
        V3Pusher pusher = new V3Pusher();
        deal(USDC, address(pusher), 2_000_000_000e6);
        pusher.push(pool, USDC < WBTC, int256(1_000_000_000e6));

        vm.recordLogs();
        _deliver(WBTC, 1e6);
        (bytes4 sel, bool found) = _lastFailureSel(vm.getRecordedLogs());
        assertTrue(found, "expected a held fee");
        assertEq(sel, FeeConsolidator.PriceDeviation.selector);
        assertEq(cons.heldFees(address(meme), WBTC), 1e6);
        assertEq(IERC20(WBTC).balanceOf(address(cons)), 1e6);
    }

    // ------------------------------------------------------------------ inline claims path

    function test_fork_claimsConvertedThroughRealV3() public {
        PoolKey memory k = _route(AAPL_ON, 10_000);
        PoolKey[] memory r = new PoolKey[](1);
        r[0] = k;
        registry.addQuoteAssetWithRoute(AAPL_ON, IQuoteRegistry.Kind.Ondo, r);
        cons.seedReferences(r);

        ClaimsSource src = new ClaimsSource(PM, IFeeConsolidator(address(cons)));
        cons.setSource(address(src), true);
        _give(AAPL_ON, address(src), 1e17);
        src.deposit(AAPL_ON, 1e17);

        address to = makeAddr("to");
        uint256 spot = _spotUsdc(k, AAPL_ON, 1e17);
        uint256 out = src.convert(AAPL_ON, 1e17, to, true);
        emit log_named_uint("gas: convertClaims Ondo -> USDC via real v3 pool", src.lastConvertGas());
        assertEq(IERC20(USDC).balanceOf(to), out);
        assertGt(out, (spot * 9600) / 10_000);
        assertEq(IERC20(AAPL_ON).balanceOf(address(cons)), 0);
    }
}
