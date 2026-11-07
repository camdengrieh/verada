// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {PositionManager} from "v4-periphery/PositionManager.sol";

import {DeployLive} from "../../script/DeployLive.s.sol";
import {CatalogBallotBuilder} from "../../src/CatalogBallotBuilder.sol";
import {CauseCatalog} from "../../src/CauseCatalog.sol";
import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {CuratorRegistry} from "../../src/CuratorRegistry.sol";
import {EpochGovernor} from "../../src/EpochGovernor.sol";
import {FeeConsolidator} from "../../src/FeeConsolidator.sol";
import {LiveDonationVault} from "../../src/LiveDonationVault.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {RotationGovernor} from "../../src/RotationGovernor.sol";
import {VaradaFactory} from "../../src/VaradaFactory.sol";
import {VaradaLiveHook} from "../../src/VaradaLiveHook.sol";
import {VaradaToken} from "../../src/VaradaToken.sol";
import {ZamaVotingScheme} from "../../src/governance/ZamaVotingScheme.sol";
import {ILiveDonationVault} from "../../src/interfaces/ILiveDonationVault.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {IVaradaFactory} from "../../src/interfaces/IVaradaFactory.sol";
import {MockWETH} from "../consolidator/ConsolidatorMocks.sol";
import {MockEndaomentRegistry, MockOrgFactory} from "../mocks/EndaomentMocks.sol";
import {CatalogPublish} from "../utils/CatalogFixture.sol";
import {LiveUSDC} from "./LiveMocks.sol";
import {DonationAsset} from "src/interfaces/IDonationAsset.sol";

/// @dev Runs the DeployLive script without an RPC: chain id 1, with local stand-ins placed at the
///      mainnet addresses the script checks (a real PoolManager, PositionManager and Permit2;
///      USDC, WETH and the Endaoment factory are mocks). Verifies the wiring and ownership
///      hand-over, then launches a live token through the deployed factory and swaps.
contract DeployLiveScriptTest is Test, DeployLive {
    /// @dev Runtime code of the deterministic deployment proxy, used if the EVM lacks it.
    bytes internal constant CREATE2_PROXY_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
    bytes32 internal constant ORG_ID = bytes32("200049703");
    bytes32 internal constant CAUSE = keccak256("wikimedia-foundation");
    bytes32 internal constant CAUSE_2 = keccak256("second-cause");

    address internal deployer = makeAddr("deployer");
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");

    Deployment internal d;
    LiveDeployment internal l;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal liquidityRouter;
    address internal org;

    /// @dev Refunds of unused ETH from the liquidity router.
    receive() external payable {}

    function setUp() public {
        vm.chainId(1);
        vm.warp(1_700_000_000);
        _placeAt(type(PoolManager).creationCode, abi.encode(address(this)), POOL_MANAGER);
        address permit2 = new DeployPermit2().deployPermit2();
        _placeAt(type(LiveUSDC).creationCode, "", USDC);
        _placeAt(type(MockWETH).creationCode, "", WETH);
        _placeAt(
            type(PositionManager).creationCode,
            abi.encode(POOL_MANAGER, permit2, uint256(100_000), address(0), WETH),
            POSITION_MANAGER
        );
        MockEndaomentRegistry endRegistry =
            new MockEndaomentRegistry(USDC, makeAddr("endaomentTreasury"));
        _placeAt(
            type(MockOrgFactory).creationCode, abi.encode(address(endRegistry)), ENDAOMENT_FACTORY
        );
        if (CREATE2_DEPLOYER.code.length == 0) vm.etch(CREATE2_DEPLOYER, CREATE2_PROXY_CODE);

        vm.startBroadcast(deployer);
        (d, l) = deployWithLive(
            Config({owner: owner, platformTreasury: treasury, siteSwarmRef: bytes32(0)}), deployer
        );
        vm.stopBroadcast();

        address[11] memory owned = [
            d.causeRegistry,
            d.epochGovernor,
            d.donationDistributor,
            d.feeVault,
            d.quoteRegistry,
            d.feeConsolidator,
            d.profileRegistry,
            d.votingScheme,
            d.takeoverGovernor,
            l.rotationGovernor,
            l.liveVault
        ];
        vm.startPrank(owner);
        for (uint256 i; i < owned.length; ++i) {
            Ownable2Step(owned[i]).acceptOwnership();
        }
        // Launches need a catalogue version that gives the launch focus at least two entries.
        CauseCatalog(d.causeCatalog).acceptOwnership();
        bytes32[] memory catalogOrgs = new bytes32[](2);
        catalogOrgs[0] = bytes32("catalog-org-1");
        catalogOrgs[1] = bytes32("catalog-org-2");
        CatalogPublish.publish(CauseCatalog(d.causeCatalog), catalogOrgs);
        vm.stopPrank();

        // A native ETH/USDC route pool for WETH, with liquidity, and the owner's setup.
        swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        liquidityRouter = new PoolModifyLiquidityTest(IPoolManager(POOL_MANAGER));
        PoolKey memory ethUsdc =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 500, 10, IHooks(address(0)));
        int24 ethTick = -196_260; // about 3000 USDC per ETH (raw USDC units per wei)
        IPoolManager(POOL_MANAGER).initialize(ethUsdc, TickMath.getSqrtPriceAtTick(ethTick));
        LiveUSDC(USDC).mint(address(this), 1e30);
        IERC20(USDC).approve(address(liquidityRouter), type(uint256).max);
        vm.deal(address(this), 1e26);
        liquidityRouter.modifyLiquidity{value: 1e25}(
            ethUsdc,
            ModifyLiquidityParams({
                tickLower: ethTick - 6000, tickUpper: ethTick + 6000, liquidityDelta: 1e18, salt: 0
            }),
            ""
        );

        org = MockOrgFactory(ENDAOMENT_FACTORY).deployOrg(ORG_ID);
        vm.startPrank(owner);
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = ethUsdc;
        QuoteRegistry(d.quoteRegistry)
            .addQuoteAssetWithRoute(WETH, IQuoteRegistry.Kind.Native, route);
        FeeConsolidator(payable(d.feeConsolidator)).seedReferences(route);
        CauseRegistry(d.causeRegistry).addCause(CAUSE, ORG_ID, org, "ipfs://cause");
        bytes32 org2 = bytes32("873024488");
        CauseRegistry(d.causeRegistry)
            .addCause(CAUSE_2, org2, MockOrgFactory(ENDAOMENT_FACTORY).computeOrgAddress(org2), "");
        vm.stopPrank();

        vm.deal(trader, 1e22);
        vm.startPrank(trader);
        MockWETH(payable(WETH)).deposit{value: 1e21}();
        IERC20(WETH).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    function test_script_wiresLiveMode() public view {
        VaradaFactory factory = VaradaFactory(d.factory);
        assertEq(factory.liveHook(), l.liveHook);
        assertEq(factory.liveVault(), l.liveVault);
        assertEq(factory.deployer(), deployer);
        assertTrue(l.liveHook != d.hook, "separate hooks");

        uint160 flags = uint160(l.liveHook) & Hooks.ALL_HOOK_MASK;
        assertEq(flags, LIVE_HOOK_FLAGS, "mined flags");
        VaradaLiveHook hook = VaradaLiveHook(l.liveHook);
        assertEq(hook.factory(), d.factory);
        assertEq(address(hook.consolidator()), d.feeConsolidator);
        assertEq(address(hook.rotationGovernor()), l.rotationGovernor);
        assertEq(hook.vault(), l.liveVault);
        assertEq(hook.usdc(), USDC);

        assertTrue(FeeConsolidator(payable(d.feeConsolidator)).isSource(l.liveHook));
        assertTrue(ZamaVotingScheme(d.votingScheme).isGovernor(l.rotationGovernor));
        assertTrue(ZamaVotingScheme(d.votingScheme).isGovernor(d.epochGovernor), "weekly kept");
        assertEq(RotationGovernor(l.rotationGovernor).vault(), l.liveVault);
        assertEq(RotationGovernor(l.rotationGovernor).minVoters(), 2, "outcome needs two ballots");
        // Only ballots of at least 0.01% of the supply count toward those two ballots; the
        // weekly governor's tally polls do no counting.
        assertEq(
            ZamaVotingScheme(d.votingScheme).minCountedWeightOf(l.rotationGovernor), 10_000_000
        );
        assertEq(ZamaVotingScheme(d.votingScheme).minCountedWeightOf(d.epochGovernor), 0);
        assertEq(ZamaVotingScheme(d.votingScheme).minCountedWeightOf(d.takeoverGovernor), 0);
        // Ballots come from the weekly catalogue and curator registry; winners are materialized.
        assertEq(RotationGovernor(l.rotationGovernor).catalog(), d.causeCatalog);
        assertEq(address(RotationGovernor(l.rotationGovernor).curators()), d.curatorRegistry);
        assertTrue(CauseRegistry(d.causeRegistry).isMaterializer(l.rotationGovernor));
        assertEq(LiveDonationVault(l.liveVault).hook(), l.liveHook);
        assertEq(LiveDonationVault(l.liveVault).factory(), d.factory);
        assertEq(LiveDonationVault(l.liveVault).platformTreasury(), treasury);
        assertEq(LiveDonationVault(l.liveVault).usdc(), USDC);
        assertEq(RotationGovernor(l.rotationGovernor).owner(), owner);
        assertEq(LiveDonationVault(l.liveVault).owner(), owner);
        assertEq(FeeConsolidator(payable(d.feeConsolidator)).owner(), owner);
    }

    function test_script_wiresCurationClock() public view {
        CatalogBallotBuilder b = RotationGovernor(l.rotationGovernor).ballotBuilder();
        EpochGovernor eg = EpochGovernor(d.epochGovernor);
        assertEq(address(CuratorRegistry(d.curatorRegistry).governor()), d.epochGovernor);
        assertEq(address(b.curators()), d.curatorRegistry);
        assertEq(uint256(b.curationZero()), eg.epochZeroStart());
        assertEq(uint256(b.curationLength()), eg.epochLength());
        assertEq(b.CURATION_GRACE(), eg.curationGrace());
        // Weekly-or-longer rounds get the full 6h grace; short rounds a third of the vote window.
        assertEq(b.curationGraceEnd(1000, 1000 + 7 days), 1000 + 6 hours);
        assertEq(b.curationGraceEnd(1000, 1000 + 45 minutes), 1000 + 15 minutes);
    }

    function test_script_liveAndWeeklyLaunches() public {
        VaradaFactory factory = VaradaFactory(d.factory);
        IVaradaFactory.DeployParams memory p = IVaradaFactory.DeployParams(
            "Live",
            "LIVE",
            "ipfs://live",
            bytes32(uint256(1)),
            300,
            0,
            0,
            -69_000,
            WETH,
            "live-one",
            bytes32(0),
            CatalogPublish.CATEGORIES,
            CatalogPublish.REGIONS,
            DonationAsset.Usdc
        );
        vm.prank(creator);
        (address token,) =
            factory.deployLiveToken(p, IVaradaFactory.LiveParams(CAUSE, RotationPeriod.OneDay, 0));
        PoolKey memory key = _key(token, l.liveHook);

        VaradaLiveHook hook = VaradaLiveHook(l.liveHook);

        // This pool manager holds no WETH before the first buy settles, so the unwrap hop cannot
        // take the fee inside that swap: the fee is held (the trade goes through) ...
        _buy(key, token, 1e18);
        assertGt(VaradaToken(token).balanceOf(trader), 0);
        uint256 held = hook.heldRaw(token, CAUSE);
        assertEq(held, 3e16, "first fee held");
        assertEq(IERC20(USDC).balanceOf(org), 0);

        // ... and once the pool holds WETH, the next buy converts and donates in the swap.
        vm.recordLogs();
        _buy(key, token, 1e18);
        assertTrue(_emitted(vm.getRecordedLogs(), ILiveDonationVault.Donated.selector));
        uint256 orgAfterSwap = IERC20(USDC).balanceOf(org);
        assertGt(orgAfterSwap, 0, "donated in the swap");
        assertEq(hook.heldRaw(token, CAUSE), held, "second fee converted");

        // The held fee converts by retry, credited to the same cause.
        hook.retryHeld(token, CAUSE, held);
        assertEq(hook.heldRaw(token, CAUSE), 0);
        assertGt(IERC20(USDC).balanceOf(org), orgAfterSwap);
        assertEq(LiveDonationVault(l.liveVault).totalPending(), 0);

        // Weekly launches still work on the same factory.
        p.salt = bytes32(uint256(2));
        p.label = "weekly-one";
        vm.prank(creator);
        (address weekly,) = factory.deployToken(p);
        _buy(_key(weekly, d.hook), weekly, 1e18);
        assertGt(VaradaToken(weekly).balanceOf(trader), 0);
    }

    function _emitted(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic0) return true;
        }
        return false;
    }

    /// @dev Runs `creation` with `args` at `where` (so immutables and storage refer to `where`)
    ///      and leaves the resulting runtime code there.
    function _placeAt(bytes memory creation, bytes memory args, address where) internal {
        vm.etch(where, abi.encodePacked(creation, args));
        (bool ok, bytes memory runtime) = where.call("");
        require(ok, "constructor failed");
        vm.etch(where, runtime);
    }

    function _key(address token, address hook) internal pure returns (PoolKey memory) {
        (address a, address b) = token < WETH ? (token, WETH) : (WETH, token);
        return PoolKey(
            Currency.wrap(a), Currency.wrap(b), LPFeeLibrary.DYNAMIC_FEE_FLAG, 200, IHooks(hook)
        );
    }

    function _buy(PoolKey memory key, address token, uint256 wethIn) internal {
        bool zeroForOne = Currency.unwrap(key.currency0) != token;
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(wethIn),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}
