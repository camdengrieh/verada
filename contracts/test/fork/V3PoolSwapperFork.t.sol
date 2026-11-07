// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test, console2} from "forge-std/Test.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";

import {V3PoolSwapper} from "../../src/community/V3PoolSwapper.sol";
import {IV3PoolSwapper} from "../../src/interfaces/IV3PoolSwapper.sol";

interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function factory() external view returns (address);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool);
}

interface IV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

/// @dev Stands in for FeeConsolidator: holds the fee, approves the swapper for the exact amount,
///      calls it, and resets the approval.
contract FeeHolder {
    function convert(
        V3PoolSwapper s,
        address factory,
        address tin,
        address tout,
        uint24 fee,
        uint256 amount,
        uint256 minOut
    ) external returns (uint256 spent, uint256 got) {
        IERC20(tin).approve(address(s), amount);
        (spent, got) =
            s.swapExactIn(factory, tin, tout, fee, amount, minOut, 0, address(this), block.timestamp);
        IERC20(tin).approve(address(s), 0);
    }
}

/// @notice Mainnet fork: converts real Ondo fees to USDC through the community factory's pools
///         and the canonical v3 pool with the swapper, using each factory's own init code hash.
///         Skipped when ETH_RPC_URL is unset.
contract V3PoolSwapperForkTest is Test {
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant CANON = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address constant COMMUNITY = 0x00a38533c68327aBE0Cc265436e036066E2D6B38;
    bytes32 constant CANON_HASH =
        0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;

    address constant TSLA_POOL = 0xF2006D44339E5C2c479d450a97884d4E20D028AD; // community 2%
    address constant META_POOL = 0x6692291A3d1bA9532C9d3Df049d4c7c058F796e2; // community
    address constant SPY_POOL = 0x5638bbDE046EC2EFC7C8f3fd8DC5A9A1016f7EEB; // canonical

    V3PoolSwapper internal swapper;
    FeeHolder internal holder;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        address[] memory f = new address[](2);
        bytes32[] memory h = new bytes32[](2);
        f[0] = CANON;
        h[0] = CANON_HASH;
        f[1] = COMMUNITY;
        h[1] = CANON_HASH; // asserted below: the community factory is unmodified
        swapper = new V3PoolSwapper(f, h);
        holder = new FeeHolder();
    }

    function _factoryOf(address pool) internal view returns (address) {
        return IV3Pool(pool).factory();
    }

    // ------------------------------------------------------------------ init code hash

    function test_fork_communityPoolsMatchCanonicalInitCodeHash() public view {
        address[3] memory pools = [TSLA_POOL, META_POOL, SPY_POOL];
        for (uint256 i; i < 3; ++i) {
            IV3Pool p = IV3Pool(pools[i]);
            address fac = p.factory();
            assertTrue(swapper.isAllowedFactory(fac), "factory not allowlisted");
            assertEq(IV3Factory(fac).getPool(p.token0(), p.token1(), p.fee()), pools[i]);
            assertEq(swapper.poolOf(fac, p.token0(), p.token1(), p.fee()), pools[i], "hash");
            // Argument order does not matter.
            assertEq(swapper.poolOf(fac, p.token1(), p.token0(), p.fee()), pools[i]);
        }
        assertEq(IV3Pool(TSLA_POOL).factory(), COMMUNITY);
        assertEq(IV3Pool(SPY_POOL).factory(), CANON);
    }

    // ------------------------------------------------------------------ real conversions

    /// @dev Takes `bps` of the pool's Ondo balance as the fee to convert, from the pool itself.
    function _fund(address pool, uint256 bps) internal returns (address ondo, uint256 amount) {
        IV3Pool p = IV3Pool(pool);
        ondo = p.token0() == USDC ? p.token1() : p.token0();
        amount = IERC20(ondo).balanceOf(pool) * bps / 10_000;
        vm.prank(pool);
        IERC20(ondo).transfer(address(holder), amount);
    }

    /// @dev Output of `amountIn` at spot, before fee and impact.
    function _spotOut(address pool, address ondo, uint256 amountIn) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IV3Pool(pool).slot0();
        uint256 ratioX192 = uint256(sqrtP) * uint256(sqrtP); // token1 per token0, X192
        bool ondoIs0 = IV3Pool(pool).token0() == ondo;
        return ondoIs0
            ? FullMath.mulDiv(amountIn, ratioX192, 1 << 192)
            : FullMath.mulDiv(amountIn, 1 << 192, ratioX192);
    }

    function _convert(address pool, uint256 bps) internal returns (uint256 spent, uint256 got) {
        (address ondo, uint256 amount) = _fund(pool, bps);
        address fac = _factoryOf(pool);
        uint24 fee = IV3Pool(pool).fee();
        uint256 expected = _spotOut(pool, ondo, amount);
        // Tolerance: pool fee plus 1% for price impact at this size.
        uint256 minOut = expected * (1_000_000 - fee - 10_000) / 1_000_000;
        uint256 usdcBefore = IERC20(USDC).balanceOf(address(holder));

        uint256 g = gasleft();
        (spent, got) = holder.convert(swapper, fac, ondo, USDC, fee, amount, minOut);
        g -= gasleft();

        assertEq(spent, amount, "partial fill");
        assertEq(IERC20(USDC).balanceOf(address(holder)) - usdcBefore, got);
        assertGe(got, minOut);
        assertLe(got, expected, "cannot beat spot");
        // Leaves nothing behind.
        assertEq(IERC20(ondo).balanceOf(address(swapper)), 0);
        assertEq(IERC20(USDC).balanceOf(address(swapper)), 0);
        assertEq(IERC20(ondo).balanceOf(address(holder)), 0);
        assertEq(IERC20(ondo).allowance(address(holder), address(swapper)), 0);
        console2.log("gas (approve+swap+reset), pool fee", g, fee);
        console2.log("in / out(usdc 6dp)", amount, got);
    }

    function test_fork_convertTSLAonFeesToUsdcThroughCommunityPool() public {
        _convert(TSLA_POOL, 100); // 1% of the pool's TSLAon
    }

    function test_fork_convertMETAonFeesToUsdcThroughCommunityPool() public {
        _convert(META_POOL, 100);
    }

    function test_fork_convertSPYonFeesToUsdcThroughCanonicalPool() public {
        _convert(SPY_POOL, 100);
    }

    function test_fork_userSwapsDirectlyWithOwnApproval() public {
        address user = makeAddr("user");
        IV3Pool p = IV3Pool(TSLA_POOL);
        address ondo = p.token0() == USDC ? p.token1() : p.token0();
        uint256 amount = IERC20(ondo).balanceOf(TSLA_POOL) / 200;
        vm.prank(TSLA_POOL);
        IERC20(ondo).transfer(user, amount);

        vm.startPrank(user);
        IERC20(ondo).approve(address(swapper), amount);
        (uint256 spent, uint256 got) = swapper.swapExactIn(
            COMMUNITY, ondo, USDC, p.fee(), amount, 1, 0, user, block.timestamp
        );
        vm.stopPrank();
        assertEq(spent, amount);
        assertEq(IERC20(USDC).balanceOf(user), got);
        assertGt(got, 0);
    }

    // ------------------------------------------------------------------ limits and guards

    function test_fork_slippageMinOutReverts() public {
        (address ondo, uint256 amount) = _fund(TSLA_POOL, 100);
        uint256 expected = _spotOut(TSLA_POOL, ondo, amount);
        uint24 fee = IV3Pool(TSLA_POOL).fee();
        // Asking for the full spot amount cannot be met after the 2% pool fee.
        vm.expectPartialRevert(IV3PoolSwapper.TooLittleReceived.selector);
        holder.convert(swapper, COMMUNITY, ondo, USDC, fee, amount, expected);
    }

    function test_fork_priceLimitMakesPartialFillAndPullsOnlyWhatIsSpent() public {
        (address ondo, uint256 amount) = _fund(TSLA_POOL, 1_000); // 10% of the pool: moves price
        (uint160 sqrtP,,,,,,) = IV3Pool(TSLA_POOL).slot0();
        bool zeroForOne = ondo < USDC;
        // Limit 0.1% from spot in the swap direction.
        uint160 limit = zeroForOne
            ? uint160(uint256(sqrtP) * 9_995 / 10_000)
            : uint160(uint256(sqrtP) * 10_005 / 10_000);
        vm.startPrank(address(holder));
        IERC20(ondo).approve(address(swapper), amount);
        (uint256 spent, uint256 got) = swapper.swapExactIn(
            COMMUNITY, ondo, USDC, IV3Pool(TSLA_POOL).fee(), amount, 1, limit, address(holder), block.timestamp
        );
        vm.stopPrank();
        assertGt(spent, 0);
        assertLt(spent, amount, "limit should stop the swap early");
        assertEq(IERC20(ondo).balanceOf(address(holder)), amount - spent, "unspent stays with payer");
        assertEq(IERC20(ondo).balanceOf(address(swapper)), 0);
        assertGt(got, 0);
    }

    function test_fork_deadlineReverts() public {
        (address ondo, uint256 amount) = _fund(TSLA_POOL, 10);
        uint24 fee = IV3Pool(TSLA_POOL).fee();
        uint256 past = block.timestamp - 1;
        vm.startPrank(address(holder));
        IERC20(ondo).approve(address(swapper), amount);
        vm.expectRevert(abi.encodeWithSelector(IV3PoolSwapper.DeadlinePassed.selector, past));
        swapper.swapExactIn(COMMUNITY, ondo, USDC, fee, amount, 1, 0, address(holder), past);
        vm.stopPrank();
    }

    function test_fork_wrongFeeTierHasNoPool() public {
        (address ondo, uint256 amount) = _fund(TSLA_POOL, 10);
        // A tier the factory never created for this pair resolves to an address without code.
        uint24 fee = 7;
        address pool = swapper.poolOf(COMMUNITY, ondo, USDC, fee);
        vm.expectRevert(abi.encodeWithSelector(IV3PoolSwapper.PoolMissing.selector, pool));
        holder.convert(swapper, COMMUNITY, ondo, USDC, fee, amount, 0);
    }

    function test_fork_pausedOrBlockedTokenRevertsWithoutLeavingBalances() public {
        (address ondo, uint256 amount) = _fund(TSLA_POOL, 10);
        // Real Ondo behaviour is covered in ConsolidatorFork; here a blocked payer is simulated
        // by the compliance contract rejecting the transfer.
        address compliance = _compliance(ondo);
        assertTrue(compliance != address(0), "no compliance");
        vm.mockCallRevert(compliance, bytes(""), "blocked");
        uint24 fee = IV3Pool(TSLA_POOL).fee();
        vm.expectRevert();
        holder.convert(swapper, COMMUNITY, ondo, USDC, fee, amount, 0);
        vm.clearMockedCalls();
        assertEq(IERC20(ondo).balanceOf(address(holder)), amount);
        assertEq(IERC20(ondo).balanceOf(address(swapper)), 0);
    }

    function _compliance(address ondo) internal view returns (address c) {
        (bool ok, bytes memory ret) = ondo.staticcall(abi.encodeWithSignature("compliance()"));
        if (ok && ret.length == 32) c = abi.decode(ret, (address));
    }
}
