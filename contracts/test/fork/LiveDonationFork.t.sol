// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";

import {HookMiner} from "../../script/HookMiner.sol";
import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {FeeConsolidator, IConsolidatorRegistry} from "../../src/FeeConsolidator.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {LiveDonationVault} from "../../src/LiveDonationVault.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {RotationGovernor} from "../../src/RotationGovernor.sol";
import {VeradaLiveHook} from "../../src/VeradaLiveHook.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {ICauseRegistry} from "../../src/interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {ILiveDonationVault} from "../../src/interfaces/ILiveDonationVault.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IVeradaLiveHook} from "../../src/interfaces/IVeradaLiveHook.sol";
import {IOutcomeVotingScheme, IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {PollScopeLib} from "../../src/libraries/PollScopeLib.sol";
import {MockDistributor, MockGovernor} from "../consolidator/ConsolidatorMocks.sol";
import {MockProfileRegistryLite, MockVotingScheme} from "../mocks/GovernanceMocks.sol";

interface IWETH9Live is IERC20 {
    function deposit() external payable;
}

/// @notice Mainnet-fork test of live-donation mode against the real PoolManager, USDC, WETH and
///         Endaoment. This contract plays the factory (configure, register, initialize). Skipped
///         when ETH_RPC_URL is unset.
contract LiveDonationForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager internal constant PM = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant AMZN_ON = 0xbb8774FB97436d23d74C1b882E8E9A69322cFD31;
    address internal constant ENDAOMENT_FACTORY = 0x10fD9348136dCea154F752fe0B6dB45Fc298A589;

    // Wikimedia Foundation (EIN 200049703): deployed on mainnet.
    bytes32 internal constant ORG_DEPLOYED = bytes32("200049703");
    address internal constant ORG_DEPLOYED_ADDR = 0xe5F123750FcEa2D82b1441048F1A431FDD3D2Dc1;
    // Synthetic EIN, never deployed: exercises deploy-and-donate.
    bytes32 internal constant ORG_FRESH = bytes32("999000111");

    uint160 internal constant LIVE_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.BEFORE_DONATE_FLAG;

    IEndaomentOrgFundFactory internal eFactory = IEndaomentOrgFundFactory(ENDAOMENT_FACTORY);
    QuoteRegistry internal registry;
    FeeConsolidator internal cons;
    CauseRegistry internal causes;
    MockVotingScheme internal scheme;
    RotationGovernor internal gov;
    LiveDonationVault internal vault;
    VeradaLiveHook internal hook;
    PoolModifyLiquidityTest internal liquidityRouter;
    PoolSwapTest internal swapRouter;

    bytes32 internal causeDeployed = keccak256("wikimedia-foundation");
    bytes32 internal causeFresh = keccak256("fresh-org");
    address internal trader = makeAddr("trader");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        registry = new QuoteRegistry(address(this), USDC, WETH);
        FeeVault feeVault = new FeeVault(
            address(this),
            address(this),
            treasury,
            IEpochGovernor(address(new MockGovernor())),
            address(new MockDistributor()),
            USDC
        );
        cons = new FeeConsolidator(
            address(this),
            PM,
            IConsolidatorRegistry(address(registry)),
            IFeeVault(address(feeVault)),
            WETH,
            300,
            1500
        );
        feeVault.setConsolidator(address(cons));

        causes = new CauseRegistry(address(this), eFactory);
        causes.addCause(causeDeployed, ORG_DEPLOYED, ORG_DEPLOYED_ADDR, "wikimedia-foundation");
        causes.addCause(causeFresh, ORG_FRESH, eFactory.computeOrgAddress(ORG_FRESH), "fresh");

        scheme = new MockVotingScheme();
        gov = new RotationGovernor(
            address(this),
            ICauseRegistry(address(causes)),
            ITokenProfileRegistry(address(new MockProfileRegistryLite())),
            address(PM),
            IOutcomeVotingScheme(address(scheme)),
            IRotationGovernor.Params(24 hours, 3 days, 7 days, 1000, 50)
        );
        scheme.setGovernor(address(gov), true);
        bytes32[] memory shortlist = new bytes32[](2);
        shortlist[0] = causeDeployed;
        shortlist[1] = causeFresh;
        gov.setDefaultShortlist(shortlist);

        vault = new LiveDonationVault(
            address(this),
            address(this),
            treasury,
            ICauseRegistry(address(causes)),
            eFactory,
            IRotationGovernor(address(gov)),
            PM,
            IFeeConsolidator(address(cons))
        );
        gov.setVault(address(vault));
        bytes memory args = abi.encode(PM, address(this), cons, gov, vault);
        (, bytes32 salt) =
            HookMiner.find(address(this), LIVE_FLAGS, type(VeradaLiveHook).creationCode, args);
        hook = new VeradaLiveHook{salt: salt}(
            PM,
            address(this),
            IFeeConsolidator(address(cons)),
            IRotationGovernor(address(gov)),
            ILiveDonationVault(address(vault))
        );
        vault.setHook(address(hook));
        cons.setSource(address(hook), true);

        // WETH settles through the native ETH/USDC 0.05% pool (unwrap hop).
        PoolKey memory ethUsdc =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 500, 10, IHooks(address(0)));
        assertEq(
            PoolId.unwrap(ethUsdc.toId()),
            0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27,
            "ETH/USDC pool id"
        );
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = ethUsdc;
        registry.addQuoteAssetWithRoute(WETH, IQuoteRegistry.Kind.Native, route);
        cons.seedReferences(route);

        liquidityRouter = new PoolModifyLiquidityTest(PM);
        swapRouter = new PoolSwapTest(PM);
        vm.deal(address(this), 1000 ether);
        vm.deal(trader, 1000 ether);
        IWETH9Live(WETH).deposit{value: 500 ether}();
        IERC20(WETH).approve(address(liquidityRouter), type(uint256).max);
        vm.startPrank(trader);
        IWETH9Live(WETH).deposit{value: 500 ether}();
        IERC20(WETH).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    function _launch(uint96 threshold, bytes32 cause, RotationPeriod period)
        internal
        returns (VeradaToken token, PoolKey memory key)
    {
        token = new VeradaToken("Live", "LIVE", "ipfs://live", makeAddr("creator"), address(this));
        hook.configureToken(address(token), IVeradaLiveHook.LiveFeeConfig(300, 0, 0, 0));
        vault.registerToken(address(token), threshold, cause, period);
        (address a, address b) =
            address(token) < WETH ? (address(token), WETH) : (WETH, address(token));
        key = PoolKey(
            Currency.wrap(a),
            Currency.wrap(b),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            60,
            IHooks(address(hook))
        );
        int24 tick = address(token) < WETH ? int24(-69_060) : int24(69_060);
        PM.initialize(key, TickMath.getSqrtPriceAtTick(tick));
        token.approve(address(liquidityRouter), type(uint256).max);
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tick - 6000, tickUpper: tick + 6000, liquidityDelta: 1e22, salt: 0
            }),
            ""
        );
        token.transfer(trader, 1e24);
    }

    function _buy(PoolKey memory key, address token, uint256 wethIn)
        internal
        returns (uint256 gas)
    {
        bool zeroForOne = Currency.unwrap(key.currency0) != token;
        vm.prank(trader);
        uint256 g = gasleft();
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
        gas = g - gasleft();
    }

    function test_fork_thresholdZero_deployedOrgReceivesInSameTx() public {
        (VeradaToken t, PoolKey memory k) = _launch(0, causeDeployed, RotationPeriod.OneDay);
        uint256 before = IERC20(USDC).balanceOf(ORG_DEPLOYED_ADDR);
        vm.recordLogs();
        uint256 gas = _buy(k, address(t), 1 ether);
        emit log_named_uint("fork: live WETH buy, threshold 0 (push)", gas);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 donations;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == ILiveDonationVault.Donated.selector) ++donations;
        }
        assertEq(donations, 1, "pushed inside the swap");
        assertGt(IERC20(USDC).balanceOf(ORG_DEPLOYED_ADDR), before, "org credited in the same tx");
        assertEq(vault.totalPending(), 0);
        assertGt(vault.platformAccrued(), 0);
    }

    function test_fork_thresholdAccruesThenCrossingPushes() public {
        (VeradaToken t, PoolKey memory k) = _launch(100e6, causeDeployed, RotationPeriod.OneDay);
        emit log_named_uint("fork: live WETH buy, below threshold", _buy(k, address(t), 1 ether));
        (uint256 p1,) = vault.pendingOf(address(t), causeDeployed);
        assertGt(p1, 0);
        uint256 before = IERC20(USDC).balanceOf(ORG_DEPLOYED_ADDR);
        uint256 i;
        while (true) {
            _buy(k, address(t), 1 ether);
            (uint256 p,) = vault.pendingOf(address(t), causeDeployed);
            if (p == 0) break;
            require(++i < 10, "never crossed");
        }
        assertGt(IERC20(USDC).balanceOf(ORG_DEPLOYED_ADDR), before);
    }

    function test_fork_undeployedOrgDeferredThenFlushDeploys() public {
        (VeradaToken t, PoolKey memory k) = _launch(0, causeFresh, RotationPeriod.OneDay);
        address org = eFactory.computeOrgAddress(ORG_FRESH);
        _buy(k, address(t), 1 ether);
        (uint256 pending, uint40 retryAt) = vault.pendingOf(address(t), causeFresh);
        assertGt(pending, 0, "kept for the cause");
        assertGt(retryAt, 0, "backoff");
        assertEq(org.code.length, 0, "never deployed inside a swap");
        vault.flush(address(t), causeFresh);
        assertGt(org.code.length, 0, "deployed by flush");
        assertGt(IERC20(USDC).balanceOf(org), 0);
    }

    function test_fork_rotationWithLateTally() public {
        (VeradaToken t, PoolKey memory k) =
            _launch(1_000_000e6, causeDeployed, RotationPeriod.OneHour);
        address voter = makeAddr("voter");
        t.transfer(voter, 1e24);
        // Hourly polls weigh holdings over the day before their snapshot: rotation 25 is the
        // first whose hold window starts after launch.
        uint64 r = 25;
        vm.warp(gov.rotationStart(address(t), r) + 60);
        uint256 scope = PollScopeLib.encode(PollScopeLib.KIND_ROTATION, r + 1);
        vm.prank(voter);
        scheme.castBallot(address(gov), address(t), scope, abi.encode(uint8(1)));
        (,, uint40 voteEnd,,,,) = gov.roundOf(address(t), r + 1);
        vm.warp(voteEnd);
        gov.closeRound(address(t), r + 1);
        scheme.finalizeFromBallots(address(gov), address(t), scope);
        vm.warp(gov.rotationStart(address(t), r + 1) + 60); // the tally arrives late
        gov.finalizeRound(address(t), r + 1);

        _buy(k, address(t), 1 ether); // rotation r + 1: still the first cause
        (uint256 pDeployed,) = vault.pendingOf(address(t), causeDeployed);
        assertGt(pDeployed, 0);
        vm.warp(gov.rotationStart(address(t), r + 2));
        _buy(k, address(t), 1 ether); // rotation r + 2: the winner
        (uint256 pFresh,) = vault.pendingOf(address(t), causeFresh);
        assertGt(pFresh, 0);
        (uint256 pDeployedAfter,) = vault.pendingOf(address(t), causeDeployed);
        assertEq(pDeployedAfter, pDeployed, "earlier credit stays with its cause");
    }

    function test_fork_ondoQuote() public {
        PoolKey memory amzn =
            PoolKey(Currency.wrap(AMZN_ON), Currency.wrap(USDC), 10_000, 100, IHooks(address(0)));
        if (AMZN_ON > USDC) {
            amzn = PoolKey(
                Currency.wrap(USDC), Currency.wrap(AMZN_ON), 10_000, 100, IHooks(address(0))
            );
        }
        if (PM.getLiquidity(amzn.toId()) == 0) vm.skip(true);
        PoolKey[] memory route = new PoolKey[](1);
        route[0] = amzn;
        registry.addQuoteAssetWithRoute(AMZN_ON, IQuoteRegistry.Kind.Ondo, route);
        cons.seedReferences(route);

        VeradaToken token =
            new VeradaToken("Live", "LIVE", "ipfs://live", makeAddr("creator"), address(this));
        hook.configureToken(address(token), IVeradaLiveHook.LiveFeeConfig(300, 0, 0, 0));
        vault.registerToken(address(token), 0, causeDeployed, RotationPeriod.OneDay);
        (address a, address b) =
            address(token) < AMZN_ON ? (address(token), AMZN_ON) : (AMZN_ON, address(token));
        PoolKey memory key = PoolKey(
            Currency.wrap(a),
            Currency.wrap(b),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            60,
            IHooks(address(hook))
        );
        int24 tick = address(token) < AMZN_ON ? int24(-69_060) : int24(69_060);
        PM.initialize(key, TickMath.getSqrtPriceAtTick(tick));
        // Ondo tokens from the pool manager's own balance (a real transfer).
        vm.prank(address(PM));
        IERC20(AMZN_ON).transfer(address(this), 2e18);
        vm.prank(address(PM));
        IERC20(AMZN_ON).transfer(trader, 2e18);
        IERC20(AMZN_ON).approve(address(liquidityRouter), type(uint256).max);
        token.approve(address(liquidityRouter), type(uint256).max);
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tick - 6000, tickUpper: tick + 6000, liquidityDelta: 1e19, salt: 0
            }),
            ""
        );
        vm.prank(trader);
        IERC20(AMZN_ON).approve(address(swapRouter), type(uint256).max);
        uint256 before = IERC20(USDC).balanceOf(ORG_DEPLOYED_ADDR);
        bool zeroForOne = Currency.unwrap(key.currency0) == AMZN_ON;
        vm.prank(trader);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -1e17,
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 held = hook.heldRaw(address(token), causeDeployed);
        if (held == 0) assertGt(IERC20(USDC).balanceOf(ORG_DEPLOYED_ADDR), before);
        assertEq(
            PM.balanceOf(address(hook), Currency.wrap(AMZN_ON).toId()), hook.totalHeld(AMZN_ON)
        );
    }
}
