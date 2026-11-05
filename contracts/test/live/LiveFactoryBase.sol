// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PositionManager} from "v4-periphery/PositionManager.sol";
import {IPositionDescriptor} from "v4-periphery/interfaces/IPositionDescriptor.sol";
import {IPositionManager} from "v4-periphery/interfaces/IPositionManager.sol";
import {IWETH9} from "v4-periphery/interfaces/external/IWETH9.sol";

import {HookMiner} from "../../script/HookMiner.sol";
import {CauseRegistry} from "../../src/CauseRegistry.sol";
import {EpochGovernor} from "../../src/EpochGovernor.sol";
import {FeeConsolidator, IConsolidatorRegistry} from "../../src/FeeConsolidator.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {LiveDonationVault} from "../../src/LiveDonationVault.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {RotationGovernor} from "../../src/RotationGovernor.sol";
import {TokenProfileRegistry} from "../../src/TokenProfileRegistry.sol";
import {VeradaFactory} from "../../src/VeradaFactory.sol";
import {VeradaHook} from "../../src/VeradaHook.sol";
import {VeradaLpLocker} from "../../src/VeradaLpLocker.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {ICauseRegistry} from "../../src/interfaces/ICauseRegistry.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {ILpLocker} from "../../src/interfaces/ILpLocker.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IVeradaFactory} from "../../src/interfaces/IVeradaFactory.sol";
import {IVeradaHook} from "../../src/interfaces/IVeradaHook.sol";
import {IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {PollScopeLib} from "../../src/libraries/PollScopeLib.sol";
import {MockDistributor, MockOndoToken, MockWETH} from "../consolidator/ConsolidatorMocks.sol";
import {MockEndaomentRegistry, MockOrgFactory} from "../mocks/EndaomentMocks.sol";
import {MockVotingScheme} from "../mocks/GovernanceMocks.sol";
import {LiveBase} from "./LiveBase.sol";
import {LiveUSDC} from "./LiveMocks.sol";

/// @dev Integration fixture: the whole system as the deploy script wires it, with tokens launched
///      through the real VeradaFactory. Real PoolManager, PositionManager and Permit2, real
///      QuoteRegistry, FeeConsolidator, FeeVault, EpochGovernor, mined VeradaHook, VeradaLpLocker
///      and TokenProfileRegistry (weekly mode), plus the real RotationGovernor, LiveDonationVault
///      and mined VeradaLiveHook enabled through `configureLiveMode` (live mode). Endaoment and
///      the voting scheme are mocked (plaintext tallies). Route pools and swap helpers come from
///      LiveBase: quote/USDC, native ETH/USDC (WETH unwraps into it), quote/WETH and ondoB/quote.
abstract contract LiveFactoryBase is LiveBase {
    uint160 internal constant WEEKLY_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    /// @dev namehash("verada.eth")
    bytes32 internal constant PARENT_NODE =
        0x57d91e5a92cd91e5d7f0bc0b6bbcab514531e262e06e38ae9e2d95ef97080e65;
    /// @dev 1.0001^-69000: about 0.001 whole quote per whole token, for an 18-decimal quote.
    int24 internal constant START_TICK = -69_000;

    IPositionManager internal posm;
    TokenProfileRegistry internal profileRegistry;
    EpochGovernor internal epochGov;
    VeradaHook internal weeklyHook;
    VeradaLpLocker internal locker;
    VeradaFactory internal factory;
    uint256 internal launches;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    function _factorySetUp() internal {
        vm.warp(1_700_000_000);
        deployFreshManagerAndRouters();
        vm.deal(address(this), 1e27);

        usdc = new LiveUSDC();
        quote = new MockOndoToken("AAPLon");
        ondoB = new MockOndoToken("TSLAon");
        weth = new MockWETH();
        address permit2 = new DeployPermit2().deployPermit2();
        posm = IPositionManager(
            address(
                new PositionManager(
                    manager,
                    IAllowanceTransfer(permit2),
                    100_000,
                    IPositionDescriptor(address(0)),
                    IWETH9(address(weth))
                )
            )
        );
        registry = new QuoteRegistry(address(this), address(usdc), address(weth));

        endRegistry = new MockEndaomentRegistry(address(usdc), endTreasury);
        endFactory = new MockOrgFactory(endRegistry);
        causes = new CauseRegistry(address(this), IEndaomentOrgFundFactory(address(endFactory)));
        orgA = endFactory.computeOrgAddress(ORG_A);
        orgB = endFactory.computeOrgAddress(ORG_B);
        orgC = endFactory.computeOrgAddress(ORG_C);
        endFactory.deployOrg(ORG_A);
        endFactory.deployOrg(ORG_C);
        causes.addCause(CAUSE_A, ORG_A, orgA, "ipfs://a");
        causes.addCause(CAUSE_B, ORG_B, orgB, "ipfs://b");
        causes.addCause(CAUSE_C, ORG_C, orgC, "ipfs://c");
        scheme = new MockVotingScheme();
        address distributor = address(new MockDistributor());

        // The weekly contracts and the factory reference each other through immutables, so the
        // factory address is fixed ahead of time: profile registry, epoch governor, fee vault,
        // consolidator, weekly hook (CREATE2), locker, factory.
        address factoryAddr = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 6);
        profileRegistry = new TokenProfileRegistry(address(this), factoryAddr, PARENT_NODE);
        epochGov = new EpochGovernor(
            address(this),
            ICauseRegistry(address(causes)),
            IVotingScheme(address(scheme)),
            ITokenProfileRegistry(address(profileRegistry))
        );
        feeVault = new FeeVault(
            address(this),
            factoryAddr,
            treasury,
            IEpochGovernor(address(epochGov)),
            distributor,
            address(usdc)
        );
        cons = new FeeConsolidator(
            address(this),
            manager,
            IConsolidatorRegistry(address(registry)),
            IFeeVault(address(feeVault)),
            address(weth),
            MAX_SLIPPAGE_BPS,
            MAX_DEVIATION_TICKS
        );
        bytes memory weeklyArgs = abi.encode(manager, factoryAddr, address(cons));
        (, bytes32 weeklySalt) =
            HookMiner.find(address(this), WEEKLY_FLAGS, type(VeradaHook).creationCode, weeklyArgs);
        weeklyHook = new VeradaHook{salt: weeklySalt}(manager, factoryAddr, address(cons));
        locker = new VeradaLpLocker(address(posm), IFeeConsolidator(address(cons)), factoryAddr);
        factory = new VeradaFactory(
            manager,
            posm,
            IQuoteRegistry(address(registry)),
            IVeradaHook(address(weeklyHook)),
            ILpLocker(address(locker)),
            IFeeVault(address(feeVault)),
            IEpochGovernor(address(epochGov)),
            ITokenProfileRegistry(address(profileRegistry))
        );
        assertEq(address(factory), factoryAddr, "factory address");

        // Weekly wiring (as in Deploy.s.sol).
        epochGov.setFactory(address(factory));
        feeVault.setConsolidator(address(cons));
        cons.setHook(address(weeklyHook));
        cons.setSource(address(locker), true);
        scheme.setGovernor(address(epochGov), true);

        // Live mode: governor, vault, mined hook, then the one-time factory switch.
        rgov = new RotationGovernor(
            address(this),
            ICauseRegistry(address(causes)),
            ITokenProfileRegistry(address(profileRegistry)),
            address(manager),
            IVotingScheme(address(scheme)),
            _defaultParams()
        );
        scheme.setGovernor(address(rgov), true);
        bytes32[] memory list = new bytes32[](3);
        list[0] = CAUSE_A;
        list[1] = CAUSE_B;
        list[2] = CAUSE_C;
        rgov.setDefaultShortlist(list);
        vault = new LiveDonationVault(
            address(this),
            address(factory),
            treasury,
            ICauseRegistry(address(causes)),
            IEndaomentOrgFundFactory(address(endFactory)),
            IRotationGovernor(address(rgov)),
            manager,
            IFeeConsolidator(address(cons))
        );
        rgov.setVault(address(vault));
        hook = _deployHook(address(factory));
        vault.setHook(address(hook));
        cons.setSource(address(hook), true);
        factory.configureLiveMode(address(hook), address(vault));

        _setupRoutePools();
    }

    // ------------------------------------------------------------------ launches

    function _label(bytes32 salt) internal pure returns (string memory) {
        return string.concat("live-", vm.toString(uint256(salt)));
    }

    /// @dev Launch parameters, built positionally: name, symbol, metadata, salt, base fee,
    ///      launch surcharge start and decay, start tick, quote asset, label, logo.
    function _deployParams(bytes32 salt, address quoteAsset, uint24 surcharge, uint32 decay)
        internal
        pure
        returns (IVeradaFactory.DeployParams memory)
    {
        return IVeradaFactory.DeployParams(
            "Live Frog",
            "LFROG",
            "ipfs://live-frog",
            salt,
            BASE_BPS,
            surcharge,
            decay,
            START_TICK,
            quoteAsset,
            _label(salt),
            bytes32(0)
        );
    }

    function _liveKey(address token, address quoteAsset) internal view returns (PoolKey memory) {
        return _keyWith(token, quoteAsset, address(hook));
    }

    function _keyWith(address token, address quoteAsset, address hooks_)
        internal
        view
        returns (PoolKey memory)
    {
        (Currency c0, Currency c1) = _sorted(token, quoteAsset);
        return
            PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, factory.TICK_SPACING(), IHooks(hooks_));
    }

    /// @dev Launches a live token through the factory as `creator`.
    function _launchLive(
        address quoteAsset,
        uint96 threshold,
        RotationPeriod period,
        bytes32 initialCause
    ) internal returns (VeradaToken token, PoolKey memory key) {
        bytes32 salt = bytes32(++launches);
        vm.prank(creator);
        (address t,) = factory.deployLiveToken(
            _deployParams(salt, quoteAsset, 0, 0),
            IVeradaFactory.LiveParams(initialCause, period, threshold)
        );
        token = VeradaToken(t);
        key = _liveKey(t, quoteAsset);
    }

    /// @dev Gives `who` quote assets (and WETH) and router approvals, including for `token`.
    function _fund(address who, VeradaToken token) internal {
        quote.mint(who, 1e27);
        ondoB.mint(who, 1e27);
        vm.deal(who, 1e24);
        vm.startPrank(who);
        weth.deposit{value: 1e23}();
        quote.approve(address(swapRouter), type(uint256).max);
        ondoB.approve(address(swapRouter), type(uint256).max);
        weth.approve(address(swapRouter), type(uint256).max);
        token.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ governance helpers

    function _rotScope(uint64 target) internal pure returns (uint256) {
        return PollScopeLib.encode(PollScopeLib.KIND_ROTATION, target);
    }

    function _perScope(uint64 id) internal pure returns (uint256) {
        return PollScopeLib.encode(PollScopeLib.KIND_PERIOD, id);
    }

    function _voteRotation(address voter, address token, uint64 target, uint8 choice) internal {
        vm.prank(voter);
        scheme.castBallot(address(rgov), token, _rotScope(target), abi.encode(choice));
    }

    function _votePeriod(address voter, address token, uint64 id, bool support) internal {
        vm.prank(voter);
        scheme.castBallot(address(rgov), token, _perScope(id), abi.encode(uint8(support ? 1 : 0)));
    }

    function _roundEnd(address token, uint64 target) internal view returns (uint40 end) {
        (,, end,,,,) = rgov.roundOf(token, target);
    }

    function _roundStatus(address token, uint64 target)
        internal
        view
        returns (IRotationGovernor.RoundStatus st)
    {
        (st,,,,,,) = rgov.roundOf(token, target);
    }

    function _activeCause(address token) internal view returns (bytes32 c) {
        (c,) = rgov.activeCause(token);
    }

    function _warpToRotation(address token, uint64 n) internal {
        vm.warp(rgov.rotationStart(token, n));
    }
}
