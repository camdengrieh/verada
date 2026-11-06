// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {DeployLive} from "../../script/DeployLive.s.sol";
import {CauseCatalog} from "../../src/CauseCatalog.sol";
import {CauseRegistry} from "../../src/CauseRegistry.sol";
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
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {IVaradaFactory} from "../../src/interfaces/IVaradaFactory.sol";
import {IOutcomeVotingScheme, IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {PollScopeLib} from "../../src/libraries/PollScopeLib.sol";
import {MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {CatalogPublish} from "../utils/CatalogFixture.sol";
import {DonationAsset} from "src/interfaces/IDonationAsset.sol";

interface IWETHLaunch is IERC20 {
    function deposit() external payable;
}

/// @notice Mainnet-fork test of live mode end to end: the DeployLive script deploys and wires the
///         whole system on a fork, then tokens launch through the real factory against WETH and
///         trade through the real PoolManager, converting through the real ETH/USDC pool and
///         donating to real Endaoment orgs. Skipped when ETH_RPC_URL is unset.
contract LiveLaunchForkTest is Test, DeployLive {
    using PoolIdLibrary for PoolKey;

    // Wikimedia Foundation (EIN 200049703): an Endaoment org already deployed on mainnet.
    bytes32 internal constant WIKI_ORG = bytes32("200049703");
    address internal constant WIKI_ADDR = 0xe5F123750FcEa2D82b1441048F1A431FDD3D2Dc1;
    bytes32 internal constant WIKI_CAUSE = keccak256(abi.encode(WIKI_ORG));
    // Synthetic EIN, never deployed: exercises deploy-and-donate.
    bytes32 internal constant FRESH_ORG = bytes32("999000111");
    bytes32 internal constant FRESH_CAUSE = keccak256(abi.encode(FRESH_ORG));

    address internal deployer = makeAddr("deployer");
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");

    Deployment internal d;
    LiveDeployment internal l;
    PoolSwapTest internal swapRouter;
    MockVotingScheme internal mockScheme;
    /// @dev The launch focus pool (both catalogue orgs) and its leaves.
    bytes32[] internal poolOrgs;
    bytes32[] internal poolLeaves;
    address internal freshAddr;
    uint256 internal launches;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

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
        poolOrgs.push(WIKI_ORG);
        poolOrgs.push(FRESH_ORG);
        poolLeaves = CatalogPublish.publish(CauseCatalog(d.causeCatalog), poolOrgs);

        freshAddr = IEndaomentOrgFundFactory(ENDAOMENT_FACTORY).computeOrgAddress(FRESH_ORG);
        CauseRegistry(d.causeRegistry).addCause(WIKI_CAUSE, WIKI_ORG, WIKI_ADDR, "ipfs://wiki");
        CauseRegistry(d.causeRegistry).addCause(FRESH_CAUSE, FRESH_ORG, freshAddr, "ipfs://fresh");

        // WETH settles through the real native ETH/USDC 0.05% pool (unwrap hop).
        PoolKey memory ethUsdc =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 500, 10, IHooks(address(0)));
        assertEq(
            PoolId.unwrap(ethUsdc.toId()),
            0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27,
            "ETH/USDC pool id"
        );
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = ethUsdc;
        QuoteRegistry(d.quoteRegistry)
            .addQuoteAssetWithRoute(WETH, IQuoteRegistry.Kind.Native, route);
        FeeConsolidator(payable(d.feeConsolidator)).seedReferences(route);

        // Plaintext scheme for votes: the Zama scheme needs the relayer, which a fork lacks.
        mockScheme = new MockVotingScheme();
        mockScheme.setGovernor(l.rotationGovernor, true);
        RotationGovernor(l.rotationGovernor).setScheme(IOutcomeVotingScheme(address(mockScheme)));
        vm.stopPrank();

        swapRouter = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        vm.deal(trader, 1000 ether);
        vm.startPrank(trader);
        IWETHLaunch(WETH).deposit{value: 500 ether}();
        IERC20(WETH).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _launch(uint96 threshold, bytes32 cause, RotationPeriod period)
        internal
        returns (address token, PoolKey memory key)
    {
        ++launches;
        IVaradaFactory.DeployParams memory p = IVaradaFactory.DeployParams(
            "Live Fork",
            "LFORK",
            "ipfs://live-fork",
            bytes32(launches),
            300,
            0,
            0,
            -69_000, // about 0.001 WETH per token
            WETH,
            string.concat("live-fork-", vm.toString(launches)),
            bytes32(0),
            CatalogPublish.CATEGORIES,
            CatalogPublish.REGIONS,
            DonationAsset.Usdc
        );
        vm.prank(creator);
        (token,) = VaradaFactory(d.factory)
            .deployLiveToken(p, IVaradaFactory.LiveParams(cause, period, threshold));
        (address a, address b) = token < WETH ? (token, WETH) : (WETH, token);
        key = PoolKey(
            Currency.wrap(a),
            Currency.wrap(b),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            200,
            IHooks(l.liveHook)
        );
    }

    function _buy(PoolKey memory key, address token, uint256 wethIn)
        internal
        returns (Vm.Log[] memory logs, uint256 gasUsed)
    {
        bool zeroForOne = Currency.unwrap(key.currency0) != token;
        vm.recordLogs();
        vm.prank(trader);
        uint256 g = gasleft();
        swapRouter.swap{gas: 1_500_000}(
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
        gasUsed = g - gasleft();
        logs = vm.getRecordedLogs();
    }

    function _has(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic0) return true;
        }
        return false;
    }

    /// @dev Buys until a fee converts. The pool manager must hold enough WETH for the unwrap hop
    ///      to take the fee before the trader's payment settles; until then fees are held.
    function _buyUntilConverted(PoolKey memory key, address token, uint256 wethIn)
        internal
        returns (Vm.Log[] memory logs, uint256 gasUsed)
    {
        for (uint256 i; i < 3; ++i) {
            (logs, gasUsed) = _buy(key, token, wethIn);
            if (!_has(logs, ILiveDonationVault.Credited.selector)) continue;
            return (logs, gasUsed);
        }
        revert("no conversion");
    }

    function _pending(address token, bytes32 cause) internal view returns (uint256 p) {
        (p,) = LiveDonationVault(l.liveVault).pendingOf(token, cause);
    }

    // ------------------------------------------------------------------ tests

    function test_fork_scriptWiresLiveMode() public view {
        assertEq(VaradaFactory(d.factory).liveHook(), l.liveHook);
        assertEq(VaradaFactory(d.factory).liveVault(), l.liveVault);
        assertEq(uint160(l.liveHook) & Hooks.ALL_HOOK_MASK, LIVE_HOOK_FLAGS);
        assertEq(VaradaLiveHook(l.liveHook).usdc(), USDC);
        assertTrue(FeeConsolidator(payable(d.feeConsolidator)).isSource(l.liveHook));
        assertTrue(ZamaVotingScheme(d.votingScheme).isGovernor(l.rotationGovernor));
        assertEq(LiveDonationVault(l.liveVault).hook(), l.liveHook);
        assertEq(RotationGovernor(l.rotationGovernor).vault(), l.liveVault);
    }

    function test_fork_thresholdZero_buyDonatesInTheSwap() public {
        (address token, PoolKey memory key) = _launch(0, WIKI_CAUSE, RotationPeriod.OneDay);
        uint256 before = IERC20(USDC).balanceOf(WIKI_ADDR);
        (Vm.Log[] memory logs, uint256 gasUsed) = _buyUntilConverted(key, token, 1 ether);
        emit log_named_uint("fork: threshold 0, converted and donated buy, gas", gasUsed);
        assertTrue(_has(logs, ILiveDonationVault.Donated.selector), "pushed in the swap");
        assertGt(IERC20(USDC).balanceOf(WIKI_ADDR), before, "org received USDC");
        assertEq(_pending(token, WIKI_CAUSE), 0);

        // Any fee held before the pool manager had WETH converts by retry.
        uint256 held = VaradaLiveHook(l.liveHook).heldRaw(token, WIKI_CAUSE);
        if (held != 0) {
            uint256 mid = IERC20(USDC).balanceOf(WIKI_ADDR);
            VaradaLiveHook(l.liveHook).retryHeld(token, WIKI_CAUSE, held);
            assertGt(IERC20(USDC).balanceOf(WIKI_ADDR), mid);
        }
    }

    function test_fork_thresholdAccruesThenTheCrossingSwapPushes() public {
        (address token, PoolKey memory key) = _launch(20e6, WIKI_CAUSE, RotationPeriod.OneDay);
        _buyUntilConverted(key, token, 0.1 ether);
        uint256 before = IERC20(USDC).balanceOf(WIKI_ADDR);
        bool pushed;
        for (uint256 i; i < 30 && !pushed; ++i) {
            uint256 pendingBefore = _pending(token, WIKI_CAUSE);
            (Vm.Log[] memory logs, uint256 gasUsed) = _buy(key, token, 0.1 ether);
            pushed = _has(logs, ILiveDonationVault.Donated.selector);
            if (pushed) {
                emit log_named_uint("fork: crossing swap, gas", gasUsed);
            } else {
                assertGe(_pending(token, WIKI_CAUSE), pendingBefore, "accrues");
            }
        }
        assertTrue(pushed, "threshold crossed");
        assertEq(_pending(token, WIKI_CAUSE), 0);
        assertGt(IERC20(USDC).balanceOf(WIKI_ADDR), before);
    }

    function test_fork_undeployedOrgDeferredThenFlushDeploys() public {
        assertEq(freshAddr.code.length, 0);
        (address token, PoolKey memory key) = _launch(0, FRESH_CAUSE, RotationPeriod.OneDay);
        (Vm.Log[] memory logs,) = _buyUntilConverted(key, token, 1 ether);
        assertTrue(_has(logs, ILiveDonationVault.DonationDeferred.selector), "deferred");
        uint256 pending = _pending(token, FRESH_CAUSE);
        assertGt(pending, 0);

        LiveDonationVault(l.liveVault).flush(token, FRESH_CAUSE);
        assertGt(freshAddr.code.length, 0, "org deployed");
        assertGt(IERC20(USDC).balanceOf(freshAddr), 0, "org funded");
        assertEq(_pending(token, FRESH_CAUSE), 0);
    }

    function test_fork_rotationWithALateTally() public {
        (address token, PoolKey memory key) =
            _launch(1_000_000e6, WIKI_CAUSE, RotationPeriod.OneHour);
        RotationGovernor gov = RotationGovernor(l.rotationGovernor);
        _buyUntilConverted(key, token, 1 ether); // the trader holds from launch
        // A second holder: the deployment needs two ballots before a poll is decrypted.
        address voter2 = makeAddr("voter2");
        uint256 half = IERC20(token).balanceOf(trader) / 2;
        vm.prank(trader);
        IERC20(token).transfer(voter2, half);

        // Hourly polls weigh holdings over the day before their snapshot: rotation 25 is the
        // first whose hold window starts after launch.
        uint64 r = 25;
        vm.warp(gov.rotationStart(token, r));
        uint256 scope = PollScopeLib.encode(PollScopeLib.KIND_ROTATION, r + 1);
        gov.prepareRound(token, r + 1, CatalogPublish.allDraws(poolOrgs, poolLeaves));
        vm.prank(trader);
        mockScheme.castBallot(address(gov), token, scope, abi.encode(uint8(1))); // FRESH_CAUSE
        vm.prank(voter2);
        mockScheme.castBallot(address(gov), token, scope, abi.encode(uint8(1)));
        (,, uint40 voteEnd,,,,) = gov.roundOf(token, r + 1);
        vm.warp(voteEnd);
        gov.closeRound(token, r + 1);

        vm.warp(gov.rotationStart(token, r + 1) + 5 minutes);
        mockScheme.finalizeFromBallots(address(gov), token, scope);
        gov.finalizeRound(token, r + 1);
        (IRotationGovernor.RoundStatus st,,,,, uint64 effectiveFrom,) = gov.roundOf(token, r + 1);
        assertEq(uint8(st), uint8(IRotationGovernor.RoundStatus.Applied));
        assertEq(effectiveFrom, r + 2);

        uint256 wikiBefore = _pending(token, WIKI_CAUSE);
        _buy(key, token, 0.5 ether);
        assertGt(_pending(token, WIKI_CAUSE), wikiBefore, "rotation r + 1 keeps the prior cause");
        assertEq(_pending(token, FRESH_CAUSE), 0);

        vm.warp(gov.rotationStart(token, r + 2));
        _buy(key, token, 0.5 ether);
        assertGt(_pending(token, FRESH_CAUSE), 0, "rotation r + 2 pays the winner");
    }
}
