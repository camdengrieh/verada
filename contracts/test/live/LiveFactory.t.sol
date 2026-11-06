// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

import {FeeConsolidator} from "../../src/FeeConsolidator.sol";
import {VeradaFactory} from "../../src/VeradaFactory.sol";
import {VeradaToken} from "../../src/VeradaToken.sol";
import {IEpochGovernor} from "../../src/interfaces/IEpochGovernor.sol";
import {IFeeVault} from "../../src/interfaces/IFeeVault.sol";
import {ILiveDonationVault} from "../../src/interfaces/ILiveDonationVault.sol";
import {ILpLocker} from "../../src/interfaces/ILpLocker.sol";
import {IQuoteRegistry} from "../../src/interfaces/IQuoteRegistry.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {IVeradaFactory} from "../../src/interfaces/IVeradaFactory.sol";
import {IVeradaHook} from "../../src/interfaces/IVeradaHook.sol";
import {IVeradaLiveHook} from "../../src/interfaces/IVeradaLiveHook.sol";
import {EndaomentDonateLib} from "../../src/libraries/EndaomentDonateLib.sol";
import {LiveFactoryBase} from "./LiveFactoryBase.sol";
import {AdversarialOrg} from "./LiveMocks.sol";

/// @dev Live-donation launches through the real VeradaFactory and swaps through the real
///      PoolManager: launch mode selection and its guards, weekly mode unchanged, in-swap donation
///      at threshold 0 and above, rotations across boundaries, a period-change vote, no-vote and
///      late-tally outcomes, and failed conversions and donations that never revert the trade.
contract LiveFactoryTest is LiveFactoryBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant ENDAOMENT_FEE_BPS = 150;

    function setUp() public {
        _factorySetUp();
    }

    // ------------------------------------------------------------------ helpers

    function _share(uint256 out) internal pure returns (uint256) {
        return out - (out * 1000) / 10_000;
    }

    function _net(uint256 amount) internal pure returns (uint256) {
        return amount - (amount * ENDAOMENT_FEE_BPS) / 10_000;
    }

    function _pending(address token, bytes32 cause) internal view returns (uint256 p) {
        (p,) = vault.pendingOf(token, cause);
    }

    /// @dev Buys `quoteIn` exact-in as `who` and returns the decoded `FeeTaken` and all logs.
    function _buyLogged(address who, PoolKey memory key, address token, uint256 quoteIn)
        internal
        returns (
            bytes32 cause,
            uint64 rotation,
            uint256 f,
            uint256 out,
            bool converted,
            Vm.Log[] memory logs
        )
    {
        vm.recordLogs();
        _swapAs(who, key, _quoteIs0(key, token), -int256(quoteIn));
        logs = vm.getRecordedLogs();
        bool found;
        (found, cause, rotation, f, out, converted,) = _lastFeeTaken(logs);
        assertTrue(found, "fee taken");
    }

    function _deferReason(Vm.Log[] memory logs) internal pure returns (bool found, bytes4 r) {
        bytes32 topic0 = ILiveDonationVault.DonationDeferred.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic0) {
                (, r) = abi.decode(logs[i].data, (uint256, bytes4));
                return (true, r);
            }
        }
    }

    /// @dev Votes `choice` for `target` with alice, then closes, tallies and finalizes on time.
    function _rotateTo(address token, uint64 target, uint8 choice) internal {
        _voteRotation(alice, token, target, choice);
        vm.warp(_roundEnd(token, target));
        rgov.closeRound(token, target);
        scheme.finalizeFromBallots(address(rgov), token, _rotScope(target));
        rgov.finalizeRound(token, target);
        assertEq(uint8(_roundStatus(token, target)), uint8(IRotationGovernor.RoundStatus.Applied));
    }

    /// @dev A second factory with the same wiring that never had live mode configured.
    function _bareFactory() internal returns (VeradaFactory f) {
        f = new VeradaFactory(
            manager,
            posm,
            IQuoteRegistry(address(registry)),
            IVeradaHook(address(weeklyHook)),
            ILpLocker(address(locker)),
            IFeeVault(address(feeVault)),
            IEpochGovernor(address(epochGov)),
            ITokenProfileRegistry(address(profileRegistry))
        );
    }

    // ------------------------------------------------------------------ launch mode

    function test_deployLiveToken_registersEverything() public {
        IVeradaFactory.DeployParams memory p =
            _deployParams(bytes32(uint256(77)), address(quote), 2000, 600);
        address predicted = factory.predictTokenAddress(creator, p);
        PoolKey memory key = _liveKey(predicted, address(quote));
        uint256 nextId = posm.nextTokenId();

        vm.expectEmit(true, true, false, true, address(vault));
        emit ILiveDonationVault.LiveTokenRegistered(
            predicted, 25e6, CAUSE_B, RotationPeriod.TwelveHours
        );
        vm.expectEmit(true, true, false, true, address(factory));
        emit IVeradaFactory.TokenCreated(
            predicted,
            creator,
            PoolId.unwrap(key.toId()),
            address(hook),
            nextId,
            BASE_BPS,
            p.metadataURI
        );
        vm.prank(creator);
        (address token, uint256 id) = factory.deployLiveToken(
            p, IVeradaFactory.LiveParams(CAUSE_B, RotationPeriod.TwelveHours, 25e6)
        );
        assertEq(token, predicted, "predicted");
        assertEq(id, nextId, "position id");

        // Live hook: configured from the launch parameters, pool registered with the quote.
        IVeradaLiveHook.LiveFeeConfig memory cfg = hook.feeConfig(token);
        assertEq(cfg.baseFeeBps, BASE_BPS);
        assertEq(cfg.launchSurchargeBps, 2000);
        assertEq(cfg.surchargeDecaySeconds, 600);
        assertEq(cfg.launchTimestamp, block.timestamp);
        assertEq(hook.currentFeeBps(token), BASE_BPS + 2000);
        assertTrue(hook.poolInitialized(token));
        assertEq(hook.quoteOf(token), address(quote));

        // Vault and governor: threshold, initial cause, period, anchored at launch.
        (bool registered, uint96 threshold) = vault.configOf(token);
        assertTrue(registered);
        assertEq(threshold, 25e6);
        assertTrue(rgov.isRegistered(token));
        (bytes32 cause, uint64 rotation) = rgov.activeCause(token);
        assertEq(cause, CAUSE_B);
        assertEq(rotation, 0);
        (RotationPeriod period, bool pendingChange,,) = rgov.periodOf(token);
        assertEq(uint8(period), uint8(RotationPeriod.TwelveHours));
        assertFalse(pendingChange);
        assertEq(rgov.rotationStart(token, 1), block.timestamp + 12 hours);

        // Weekly components untouched.
        assertFalse(feeVault.isRegistered(token), "fee vault");
        assertFalse(epochGov.isRegistered(token), "epoch governor");
        assertEq(weeklyHook.feeConfig(token).launchTimestamp, 0, "weekly hook");

        // Same launch invariants as weekly mode.
        VeradaToken t = VeradaToken(token);
        assertEq(IERC721(address(posm)).ownerOf(id), address(locker));
        assertEq(locker.lpTokenIdOf(token), id);
        assertTrue(factory.isVeradaToken(token));
        assertEq(factory.quoteAssetOf(token), address(quote));
        assertEq(factory.tokenCount(), 1);
        assertEq(t.balanceOf(address(factory)), 0, "factory keeps nothing");
        assertEq(t.balanceOf(address(manager)), t.totalSupply(), "pool holds supply");
        assertEq(profileRegistry.controllerOf(token), creator);
        assertEq(profileRegistry.labelOf(token), p.label);
        assertGt(posm.getPositionLiquidity(id), 0);

        // The pool exists only under the live hook.
        (uint160 sqrtLive, int24 tick,,) = manager.getSlot0(key.toId());
        assertGt(sqrtLive, 0);
        assertEq(tick, _quoteIs0(key, token) ? -START_TICK : START_TICK);
        PoolKey memory weeklyKey = _keyWith(token, address(quote), address(weeklyHook));
        (uint160 sqrtWeekly,,,) = manager.getSlot0(weeklyKey.toId());
        assertEq(sqrtWeekly, 0);
    }

    /// @dev WETH-quoted launches in both currency orders: buys convert through the unwrap hop.
    function test_deployLiveToken_wethBothOrders() public {
        bool[2] memory seen;
        for (uint256 i = 1; i < 64 && !(seen[0] && seen[1]); ++i) {
            IVeradaFactory.DeployParams memory p =
                _deployParams(bytes32(i + 1000), address(weth), 0, 0);
            bool isC0 = factory.predictTokenAddress(creator, p) < address(weth);
            if (seen[isC0 ? 0 : 1]) continue;
            seen[isC0 ? 0 : 1] = true;

            vm.prank(creator);
            (address token,) = factory.deployLiveToken(
                p, IVeradaFactory.LiveParams(CAUSE_A, RotationPeriod.OneDay, 0)
            );
            PoolKey memory key = _liveKey(token, address(weth));
            _fund(trader, VeradaToken(token));
            uint256 orgBefore = usdc.balanceOf(orgA);
            (bytes32 cause,, uint256 f, uint256 out, bool converted,) =
                _buyLogged(trader, key, token, 1e18);
            assertEq(cause, CAUSE_A);
            assertEq(f, 3e16, "3% of the input");
            assertTrue(converted, "converted through the unwrap hop");
            assertEq(usdc.balanceOf(orgA) - orgBefore, _net(_share(out)), "pushed in swap");
        }
        assertTrue(seen[0] && seen[1], "both orders");
    }

    function test_deployToken_weeklyModeUnchanged() public {
        IVeradaFactory.DeployParams memory p =
            _deployParams(bytes32(uint256(5)), address(quote), 0, 0);
        address predicted = factory.predictTokenAddress(creator, p);
        PoolKey memory key = _keyWith(predicted, address(quote), address(weeklyHook));

        vm.expectEmit(true, true, false, false, address(factory));
        emit IVeradaFactory.TokenCreated(
            predicted, creator, PoolId.unwrap(key.toId()), address(weeklyHook), 0, 0, ""
        );
        vm.prank(creator);
        (address token,) = factory.deployToken(p);

        assertTrue(feeVault.isRegistered(token));
        assertTrue(epochGov.isRegistered(token));
        assertEq(weeklyHook.feeConfig(token).baseFeeBps, BASE_BPS);
        assertFalse(vault.isRegistered(token));
        assertFalse(rgov.isRegistered(token));
        assertFalse(hook.configured(token));
        (uint160 sqrtWeekly,,,) = manager.getSlot0(key.toId());
        assertGt(sqrtWeekly, 0);
        (uint160 sqrtLive,,,) = manager.getSlot0(_liveKey(token, address(quote)).toId());
        assertEq(sqrtLive, 0);

        // A weekly buy leaves the live ledger untouched.
        _fund(trader, VeradaToken(token));
        _buyExactIn(key, token, 1e18);
        assertGt(VeradaToken(token).balanceOf(trader), 0);
        assertEq(vault.totalPending() + vault.platformAccrued(), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_predictTokenAddress_sameForBothModes() public {
        IVeradaFactory.DeployParams memory p =
            _deployParams(bytes32(uint256(9)), address(quote), 0, 0);
        address predicted = factory.predictTokenAddress(creator, p);

        uint256 snap = vm.snapshotState();
        vm.prank(creator);
        (address weekly,) = factory.deployToken(p);
        vm.revertToState(snap);
        vm.prank(creator);
        (address live,) = factory.deployLiveToken(
            p, IVeradaFactory.LiveParams(CAUSE_A, RotationPeriod.OneHour, 0)
        );
        assertEq(weekly, predicted);
        assertEq(live, predicted);
    }

    function test_sameSaltAcrossModes_reverts() public {
        IVeradaFactory.DeployParams memory p =
            _deployParams(bytes32(uint256(11)), address(quote), 0, 0);
        vm.prank(creator);
        (address token,) = factory.deployToken(p);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IVeradaFactory.TokenAlreadyDeployed.selector, token));
        factory.deployLiveToken(p, IVeradaFactory.LiveParams(CAUSE_A, RotationPeriod.OneHour, 0));
    }

    function test_deployLiveToken_revertsUntilConfigured() public {
        VeradaFactory bare = _bareFactory();
        assertEq(bare.liveHook(), address(0));
        assertEq(bare.liveVault(), address(0));
        vm.expectRevert(IVeradaFactory.LiveModeNotConfigured.selector);
        bare.deployLiveToken(
            _deployParams(bytes32(uint256(1)), address(quote), 0, 0),
            IVeradaFactory.LiveParams(CAUSE_A, RotationPeriod.OneHour, 0)
        );
    }

    function test_configureLiveMode_guards() public {
        // The fixture's factory is configured once and for good.
        assertEq(factory.liveHook(), address(hook));
        assertEq(factory.liveVault(), address(vault));
        assertEq(factory.deployer(), address(this));
        vm.expectRevert(IVeradaFactory.LiveModeAlreadyConfigured.selector);
        factory.configureLiveMode(address(hook), address(vault));

        VeradaFactory bare = _bareFactory();
        vm.prank(alice);
        vm.expectRevert(IVeradaFactory.NotDeployer.selector);
        bare.configureLiveMode(address(hook), address(vault));

        vm.expectRevert(VeradaFactory.ZeroAddress.selector);
        bare.configureLiveMode(address(0), address(vault));
        vm.expectRevert(VeradaFactory.ZeroAddress.selector);
        bare.configureLiveMode(address(hook), address(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                IVeradaFactory.InvalidLiveMode.selector, address(hook), address(feeVault)
            )
        );
        bare.configureLiveMode(address(hook), address(feeVault));

        // The weekly hook has no vault; it can never be the live hook.
        vm.expectRevert();
        bare.configureLiveMode(address(weeklyHook), address(vault));

        vm.expectEmit(false, false, false, true, address(bare));
        emit IVeradaFactory.LiveModeConfigured(address(hook), address(vault));
        bare.configureLiveMode(address(hook), address(vault));
        vm.expectRevert(IVeradaFactory.LiveModeAlreadyConfigured.selector);
        bare.configureLiveMode(address(hook), address(vault));

        // The live hook and vault are bound to their own factory: another factory pointing at
        // them cannot launch.
        vm.prank(creator);
        vm.expectRevert(IVeradaLiveHook.NotFactory.selector);
        bare.deployLiveToken(
            _deployParams(bytes32(uint256(3)), address(quote), 0, 0),
            IVeradaFactory.LiveParams(CAUSE_A, RotationPeriod.OneHour, 0)
        );
    }

    function test_deployLiveToken_invalidLiveParamsRevertWholeLaunch() public {
        IVeradaFactory.DeployParams memory p =
            _deployParams(bytes32(uint256(21)), address(quote), 0, 0);

        causes.deactivateCause(CAUSE_C);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.InactiveCause.selector, CAUSE_C));
        factory.deployLiveToken(p, IVeradaFactory.LiveParams(CAUSE_C, RotationPeriod.OneHour, 0));

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IRotationGovernor.InactiveCause.selector, bytes32(0))
        );
        factory.deployLiveToken(p, IVeradaFactory.LiveParams(bytes32(0), RotationPeriod.OneHour, 0));

        uint96 tooHigh = uint96(vault.MAX_DONATION_THRESHOLD() + 1);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(ILiveDonationVault.ThresholdTooHigh.selector, tooHigh)
        );
        factory.deployLiveToken(
            p, IVeradaFactory.LiveParams(CAUSE_A, RotationPeriod.OneHour, tooHigh)
        );

        // Nothing was left behind: the label and salt are still free.
        address predicted = factory.predictTokenAddress(creator, p);
        assertEq(factory.tokenCount(), 0);
        assertFalse(factory.isVeradaToken(predicted));
        assertEq(profileRegistry.tokenByLabelhash(keccak256(bytes(p.label))), address(0));
        vm.prank(creator);
        (address token,) = factory.deployLiveToken(
            p, IVeradaFactory.LiveParams(CAUSE_A, RotationPeriod.OneHour, 0)
        );
        assertEq(token, predicted);
    }

    function test_deployLiveToken_factoryChecksStillApply() public {
        IVeradaFactory.DeployParams memory p =
            _deployParams(bytes32(uint256(31)), address(quote), 0, 0);
        IVeradaFactory.LiveParams memory live =
            IVeradaFactory.LiveParams(CAUSE_A, RotationPeriod.OneHour, 0);

        vm.deal(creator, 1 ether);
        vm.prank(creator);
        vm.expectRevert(VeradaFactory.UnexpectedValue.selector);
        factory.deployLiveToken{value: 1}(p, live);

        p.baseFeeBps = 50;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IVeradaFactory.InvalidFee.selector, uint24(50)));
        factory.deployLiveToken(p, live);

        p.baseFeeBps = BASE_BPS;
        p.quoteAsset = address(usdc);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IVeradaFactory.QuoteAssetNotAllowed.selector, address(usdc))
        );
        factory.deployLiveToken(p, live);
    }

    /// @dev A live launch fixes the cause focus like a weekly one and is held to the same rule:
    ///      a non-empty focus that the latest catalogue gives at least two entries.
    function test_deployLiveToken_setsAndChecksTheCauseFocus() public {
        (VeradaToken token,) = _launchLive(address(quote), 0, RotationPeriod.OneHour, CAUSE_A);
        (uint64 categories, uint16 regions) = profileRegistry.focusOf(address(token));
        assertEq(categories, FOCUS_CATEGORIES);
        assertEq(regions, FOCUS_REGIONS);

        IVeradaFactory.LiveParams memory live =
            IVeradaFactory.LiveParams(CAUSE_A, RotationPeriod.OneHour, 0);
        IVeradaFactory.DeployParams memory p =
            _deployParams(bytes32(uint256(51)), address(quote), 0, 0);
        p.categoryMask = uint64(1) << 5; // no catalogue entry
        address predicted = factory.predictTokenAddress(creator, p);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.PoolTooSmall.selector, predicted, uint256(0))
        );
        factory.deployLiveToken(p, live);
        // The weekly path refuses the same focus with the same error.
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IEpochGovernor.PoolTooSmall.selector, predicted, uint256(0))
        );
        factory.deployToken(p);

        p.categoryMask = 0;
        vm.prank(creator);
        vm.expectRevert(ITokenProfileRegistry.ZeroFocus.selector);
        factory.deployLiveToken(p, live);

        // A focus the catalogue covers launches.
        p.categoryMask = FOCUS_CATEGORIES;
        vm.prank(creator);
        (address t,) = factory.deployLiveToken(p, live);
        assertEq(t, predicted);
    }

    /// @dev Live in-swap claim conversions share the consolidator and its route pools with weekly
    ///      tokens but never touch a weekly holding: the raw launch surcharge a weekly swap holds
    ///      (the pool manager is unlocked inside the swap) keeps their amount, epoch tag and owed total
    ///      through live conversions in that epoch and the next, and still flush into their own
    ///      epoch afterwards.
    function test_liveConversionsLeaveWeeklyEpochTagsAlone() public {
        IVeradaFactory.DeployParams memory p =
            _deployParams(bytes32(uint256(61)), address(quote), 2000, 1 days);
        vm.prank(creator);
        (address weekly,) = factory.deployToken(p);
        PoolKey memory weeklyKey = _keyWith(weekly, address(quote), address(weeklyHook));
        _fund(trader, VeradaToken(weekly));
        _buyExactIn(weeklyKey, weekly, 1e18);

        uint256 epoch = epochGov.currentEpoch();
        address q = address(quote);
        uint256 heldQuote = cons.heldFees(weekly, q);
        uint256 heldToken = cons.heldFees(weekly, weekly);
        assertGt(heldQuote + heldToken, 0, "weekly fee held");
        uint256 inEpochQuote = cons.heldFeesIn(weekly, q, epoch);
        uint256 owedQuote = cons.totalHeld(q);
        uint256 balanceQuote = quote.balanceOf(address(cons));

        (VeradaToken live, PoolKey memory liveKey) =
            _launchLive(q, 0, RotationPeriod.OneHour, CAUSE_A);
        _fund(trader, live);
        for (uint256 round; round < 2; ++round) {
            vm.recordLogs();
            _buyExactIn(liveKey, address(live), 1e18);
            (bool found,,,,, bool converted,) = _lastFeeTaken(vm.getRecordedLogs());
            assertTrue(found && converted, "converted in the swap");

            assertEq(cons.heldFees(weekly, q), heldQuote, "weekly quote holding");
            assertEq(cons.heldFees(weekly, weekly), heldToken, "weekly token holding");
            assertEq(cons.heldFeesIn(weekly, q, epoch), inEpochQuote, "epoch tag");
            assertEq(cons.totalHeld(q), owedQuote, "owed total");
            assertEq(quote.balanceOf(address(cons)), balanceQuote, "backing balance");
            assertEq(cons.heldFeesIn(weekly, q, epoch + 1), 0, "nothing retagged");
            // The next live conversion runs in the following epoch.
            vm.warp(epochGov.epochStart(epoch + 1) + 1);
        }

        assertTrue(cons.heldThrough(weekly, q, epoch) || heldQuote == 0);
        assertTrue(cons.flushThrough(weekly, epoch), "flushed");
        assertEq(cons.heldFees(weekly, q), 0);
        assertEq(cons.heldFees(weekly, weekly), 0);
    }

    /// @dev An allowed quote without a route to USDC launches in weekly mode but not in live mode.
    function test_deployLiveToken_unroutableQuoteReverts() public {
        address bare = address(new VeradaToken("Bare", "BARE", "", address(this), address(this)));
        registry.addQuoteAsset(bare, IQuoteRegistry.Kind.Ondo);
        IVeradaFactory.DeployParams memory p = _deployParams(bytes32(uint256(41)), bare, 0, 0);
        vm.prank(creator);
        vm.expectRevert();
        factory.deployLiveToken(p, IVeradaFactory.LiveParams(CAUSE_A, RotationPeriod.OneHour, 0));
    }

    /// @dev The LP fee is overridden to zero, so the locked position never accrues anything.
    function test_lockerCollectsNothingForLiveTokens() public {
        (VeradaToken token, PoolKey memory key) =
            _launchLive(address(quote), 0, RotationPeriod.OneHour, CAUSE_A);
        _fund(trader, token);
        _buyExactIn(key, address(token), 5e18);
        _sellExactIn(key, address(token), token.balanceOf(trader) / 2);
        (uint256 a0, uint256 a1) = locker.collectFees(address(token));
        assertEq(a0, 0);
        assertEq(a1, 0);
    }

    // ------------------------------------------------------------------ donations in the swap

    function test_thresholdZero_everySwapDonates() public {
        (VeradaToken token, PoolKey memory key) =
            _launchLive(address(quote), 0, RotationPeriod.OneHour, CAUSE_A);
        _fund(trader, token);
        address t = address(token);

        uint256 orgBefore = usdc.balanceOf(orgA);
        uint256 quoteBefore = quote.balanceOf(trader);
        (
            bytes32 cause,
            uint64 rotation,
            uint256 f,
            uint256 out,
            bool converted,
            Vm.Log[] memory logs
        ) = _buyLogged(trader, key, t, 1e18);
        assertEq(quoteBefore - quote.balanceOf(trader), 1e18, "trader paid exactly the input");
        assertEq(cause, CAUSE_A);
        assertEq(rotation, 0);
        assertEq(f, 3e16);
        assertTrue(converted);
        assertEq(_count(logs, ILiveDonationVault.Donated.selector), 1);
        uint256 platform = out - _share(out);
        assertEq(usdc.balanceOf(orgA) - orgBefore, _net(_share(out)), "org net of Endaoment fee");
        assertEq(_pending(t, CAUSE_A), 0);
        assertEq(vault.platformAccrued(), platform);
        assertEq(usdc.balanceOf(address(vault)), platform);

        // The other three swap kinds donate too.
        _buyExactOut(key, t, 1e20);
        _sellExactIn(key, t, 1e20);
        _sellExactOut(key, t, 1e16);
        assertEq(_pending(t, CAUSE_A), 0);
        assertEq(hook.totalHeld(Currency.wrap(address(quote))), 0);
        assertEq(usdc.balanceOf(address(vault)), vault.platformAccrued());

        vm.prank(keeper);
        uint256 withdrawn = vault.withdrawPlatform();
        assertEq(usdc.balanceOf(treasury), withdrawn);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_thresholdAboveZero_accruesThenPushesOnCrossingSwap() public {
        uint96 threshold = 10e6;
        (VeradaToken token, PoolKey memory key) =
            _launchLive(address(quote), threshold, RotationPeriod.OneHour, CAUSE_A);
        _fund(trader, token);
        address t = address(token);

        uint256 expected;
        bool crossed;
        for (uint256 i; i < 10 && !crossed; ++i) {
            uint256 orgBefore = usdc.balanceOf(orgA);
            (,,, uint256 out, bool converted, Vm.Log[] memory logs) =
                _buyLogged(trader, key, t, 1e18);
            assertTrue(converted);
            uint256 share = _share(out);
            if (expected + share >= threshold) {
                crossed = true;
                assertGt(i, 0, "needs several swaps");
                assertEq(_count(logs, ILiveDonationVault.Donated.selector), 1, "pushed");
                assertEq(usdc.balanceOf(orgA) - orgBefore, _net(expected + share));
                assertEq(_pending(t, CAUSE_A), 0);
            } else {
                assertEq(_count(logs, ILiveDonationVault.Donated.selector), 0, "below threshold");
                expected += share;
                assertEq(_pending(t, CAUSE_A), expected);
            }
        }
        assertTrue(crossed, "threshold crossed");
    }

    function test_swapNeedsTheDocumentedGas() public {
        (VeradaToken token, PoolKey memory key) =
            _launchLive(address(quote), 0, RotationPeriod.OneHour, CAUSE_A);
        _fund(trader, token);
        SwapParams memory sp = SwapParams({
            zeroForOne: _quoteIs0(key, address(token)),
            amountSpecified: -1e18,
            sqrtPriceLimitX96: _quoteIs0(key, address(token)) ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
        PoolSwapTest.TestSettings memory ts =
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

        vm.prank(trader);
        vm.expectRevert();
        swapRouter.swap{gas: 700_000}(key, sp, ts, "");

        vm.prank(trader);
        uint256 g = gasleft();
        swapRouter.swap{gas: 1_000_000}(key, sp, ts, "");
        emit log_named_uint("factory pool, threshold 0, donated buy: gas used", g - gasleft());
        assertGt(usdc.balanceOf(orgA), 0);
    }

    // ------------------------------------------------------------------ rotations

    function test_rotation_votedCauseTakesOverAtTheBoundary() public {
        (VeradaToken token, PoolKey memory key) =
            _launchLive(address(quote), 1000e6, RotationPeriod.OneHour, CAUSE_A);
        address t = address(token);
        _fund(trader, token);
        _fund(alice, token);
        _buyExactIn(key, t, 1e18);
        _swapAs(alice, key, _quoteIs0(key, t), -1e21); // alice holds from launch
        // The first rotation whose hold window starts after launch (the first day of an hourly
        // token carries no vote weight).
        uint64 r = _firstVotingRotation(t);

        (bytes32 cause, uint64 rotation,,,,) = _buyLogged(trader, key, t, 1e18);
        assertEq(cause, CAUSE_A);
        assertEq(rotation, 0);

        _warpToRotation(t, r);
        (cause, rotation,,,,) = _buyLogged(trader, key, t, 1e18);
        assertEq(cause, CAUSE_A);
        assertEq(rotation, r);

        _rotateTo(t, r + 1, 1); // CAUSE_B
        assertLt(block.timestamp, rgov.rotationStart(t, r + 1), "settled inside rotation r");
        (cause, rotation,,,,) = _buyLogged(trader, key, t, 1e18);
        assertEq(cause, CAUSE_A, "never retroactive");
        assertEq(rotation, r);
        assertEq(rgov.activeCauseAt(t, rgov.rotationStart(t, r + 1)), CAUSE_B);
        assertEq(rgov.activeCauseAt(t, rgov.rotationStart(t, r + 1) - 1), CAUSE_A);

        uint256 pendingA = _pending(t, CAUSE_A);
        _warpToRotation(t, r + 1);
        uint256 out;
        (cause, rotation,, out,,) = _buyLogged(trader, key, t, 1e18);
        assertEq(cause, CAUSE_B);
        assertEq(rotation, r + 1);
        assertEq(_pending(t, CAUSE_A), pendingA, "earlier credit stays with A");
        assertEq(_pending(t, CAUSE_B), _share(out));

        // Rotated-out and undeployed-org credit is flushed by anyone.
        uint256 orgABefore = usdc.balanceOf(orgA);
        vm.prank(keeper);
        assertEq(vault.flush(t, CAUSE_A), pendingA);
        assertEq(usdc.balanceOf(orgA) - orgABefore, _net(pendingA));
        assertEq(orgB.code.length, 0);
        vm.prank(keeper);
        vault.flush(t, CAUSE_B);
        assertGt(orgB.code.length, 0, "org deployed by the flush");
        assertEq(usdc.balanceOf(orgB), _net(_share(out)));
        assertEq(vault.totalPending(), 0);
    }

    function test_rotation_noVoteKeepsTheCurrentCause() public {
        (VeradaToken token, PoolKey memory key) =
            _launchLive(address(quote), 0, RotationPeriod.OneHour, CAUSE_C);
        address t = address(token);
        _fund(trader, token);
        _fund(alice, token);
        _swapAs(alice, key, _quoteIs0(key, t), -1e21);

        // Rotation 1: a round opens, nobody votes.
        _warpToRotation(t, 1);
        _prepareRound(t, 2);
        vm.warp(_roundEnd(t, 2));
        rgov.closeRound(t, 2);
        assertEq(uint8(_roundStatus(t, 2)), uint8(IRotationGovernor.RoundStatus.NoChange));
        vm.expectRevert();
        rgov.finalizeRound(t, 2);

        // Rotations 2..5: no round at all. The cause never changes and there is no fallback.
        for (uint64 n = 2; n <= 5; ++n) {
            _warpToRotation(t, n);
            (bytes32 cause, uint64 rotation,,, bool converted,) = _buyLogged(trader, key, t, 1e18);
            assertEq(cause, CAUSE_C);
            assertEq(rotation, n);
            assertTrue(converted);
        }
        assertGt(usdc.balanceOf(orgC), 0);
        assertEq(usdc.balanceOf(orgA), 0);
    }

    function test_rotation_lateTallyAppliesFromTheNextBoundary() public {
        (VeradaToken token, PoolKey memory key) =
            _launchLive(address(quote), 1000e6, RotationPeriod.OneHour, CAUSE_A);
        address t = address(token);
        _fund(trader, token);
        _fund(alice, token);
        _swapAs(alice, key, _quoteIs0(key, t), -1e21);
        uint64 r = _firstVotingRotation(t);

        _warpToRotation(t, r);
        _voteRotation(alice, t, r + 1, 2); // CAUSE_C
        vm.warp(_roundEnd(t, r + 1));
        rgov.closeRound(t, r + 1);

        // The decryption lands after rotation r + 1 started.
        vm.warp(rgov.rotationStart(t, r + 1) + 5 minutes);
        (bytes32 cause, uint64 rotation,,,,) = _buyLogged(trader, key, t, 1e18);
        assertEq(cause, CAUSE_A, "no result yet");
        assertEq(rotation, r + 1);
        vm.expectRevert(IRotationGovernor.TallyNotFinal.selector);
        rgov.finalizeRound(t, r + 1);

        scheme.finalizeFromBallots(address(rgov), t, _rotScope(r + 1));
        rgov.finalizeRound(t, r + 1);
        (IRotationGovernor.RoundStatus st,,,, bytes32 winner, uint64 effectiveFrom,) =
            rgov.roundOf(t, r + 1);
        assertEq(uint8(st), uint8(IRotationGovernor.RoundStatus.Applied));
        assertEq(winner, CAUSE_C);
        assertEq(effectiveFrom, r + 2, "next boundary, never retroactive");

        (cause, rotation,,,,) = _buyLogged(trader, key, t, 1e18);
        assertEq(cause, CAUSE_A, "rotation r + 1 keeps the prior cause");
        assertEq(rotation, r + 1);

        _warpToRotation(t, r + 2);
        (cause, rotation,,,,) = _buyLogged(trader, key, t, 1e18);
        assertEq(cause, CAUSE_C);
        assertEq(rotation, r + 2);
    }

    function test_periodChangeVote_appliesAtTheNextBoundary() public {
        (VeradaToken token, PoolKey memory key) =
            _launchLive(address(quote), 0, RotationPeriod.OneHour, CAUSE_A);
        address t = address(token);
        _fund(trader, token);
        _fund(alice, token);
        _fund(bob, token);
        _swapAs(alice, key, _quoteIs0(key, t), -1e21);
        _swapAs(bob, key, _quoteIs0(key, t), -1e20);

        // No circulating supply exists before launch, so rotation 0 cannot hold a proposal.
        vm.prank(alice);
        vm.expectRevert(IRotationGovernor.NoCirculatingSupply.selector);
        rgov.proposePeriod(t, RotationPeriod.OneDay);

        uint64 r = _firstVotingRotation(t);
        vm.warp(rgov.rotationStart(t, r) + 10);
        vm.prank(alice);
        uint64 id = rgov.proposePeriod(t, RotationPeriod.OneDay);
        uint256 snapshot = rgov.getProposal(id).snapshot;
        assertEq(snapshot, rgov.rotationStart(t, r) - 1);
        assertEq(rgov.getProposal(id).holdFrom, snapshot - 1 days);
        uint256 circulating =
            (token.getPastTotalSupply(snapshot) - token.getPastVotes(address(manager), snapshot))
                / 1e18;
        assertEq(rgov.getProposal(id).quorumWeight, (circulating * 1000 + 9999) / 10_000);

        _votePeriod(alice, t, id, true);
        _votePeriod(bob, t, id, false);
        vm.warp(rgov.getProposal(id).end);
        rgov.closePeriodProposal(id);
        scheme.finalizeFromBallots(address(rgov), t, _perScope(id));
        assertTrue(rgov.executePeriodProposal(id), "scheduled");
        assertEq(uint8(rgov.proposalState(id)), uint8(IRotationGovernor.ProposalState.Executed));

        uint64 c = rgov.currentRotation(t);
        (RotationPeriod cur, bool pending, RotationPeriod next, uint64 from) = rgov.periodOf(t);
        assertEq(uint8(cur), uint8(RotationPeriod.OneHour));
        assertTrue(pending);
        assertEq(uint8(next), uint8(RotationPeriod.OneDay));
        assertEq(from, c + 1, "next boundary");
        uint256 switchAt = rgov.rotationStart(t, from);
        assertEq(switchAt - rgov.rotationStart(t, c), 1 hours, "current rotation keeps its length");
        assertEq(rgov.rotationStart(t, from + 1) - switchAt, 1 days);

        (, uint64 rotation,,,,) = _buyLogged(trader, key, t, 1e18);
        assertEq(rotation, c);

        // Rounds follow the new length: a 6-hour close buffer, and a vote moves the cause at the
        // daily boundary.
        (,, uint40 voteEnd) = rgov.pollWindow(t, from + 1);
        assertEq(voteEnd, switchAt + 1 days - 6 hours);
        vm.warp(switchAt + 1 hours);
        (cur, pending,,) = rgov.periodOf(t);
        assertEq(uint8(cur), uint8(RotationPeriod.OneDay));
        assertFalse(pending);
        _rotateTo(t, from + 1, 1); // CAUSE_B

        vm.warp(switchAt + 23 hours);
        bytes32 cause;
        (cause, rotation,,,,) = _buyLogged(trader, key, t, 1e18);
        assertEq(rotation, from, "a day-long rotation");
        assertEq(cause, CAUSE_A);

        vm.warp(switchAt + 1 days);
        (cause, rotation,,,,) = _buyLogged(trader, key, t, 1e18);
        assertEq(cause, CAUSE_B);
        assertEq(rotation, from + 1);
    }

    // ------------------------------------------------------------------ failures never revert

    function test_failedConversion_holdsThenRetryCreditsTheOriginalCause() public {
        (VeradaToken token, PoolKey memory key) =
            _launchLive(address(quote), 0, RotationPeriod.OneHour, CAUSE_A);
        address t = address(token);
        _fund(trader, token);
        _fund(alice, token);
        _swapAs(alice, key, _quoteIs0(key, t), -1e21);

        // Control: the same buy with a working route.
        uint256 snap = vm.snapshotState();
        BalanceDelta control = _buyExactIn(key, t, 2e18);
        vm.revertToState(snap);

        cons.setReference(quoteUsdcKey, _spotTick(quoteUsdcKey) + 5000);
        vm.recordLogs();
        BalanceDelta d = _buyExactIn(key, t, 2e18);
        (, bytes32 cause,, uint256 f,, bool converted, bytes4 failure) =
            _lastFeeTaken(vm.getRecordedLogs());
        assertEq(BalanceDelta.unwrap(d), BalanceDelta.unwrap(control), "trader unaffected");
        assertEq(cause, CAUSE_A);
        assertFalse(converted);
        assertEq(failure, FeeConsolidator.PriceDeviation.selector);
        assertEq(hook.heldRaw(t, CAUSE_A), f);
        assertEq(_claims(address(hook), address(quote)), f, "held as claims");

        // The cause rotates to B before anyone retries.
        uint64 r = _firstVotingRotation(t);
        _warpToRotation(t, r);
        _rotateTo(t, r + 1, 1);
        _warpToRotation(t, r + 1);
        assertEq(_activeCause(t), CAUSE_B);

        // While the route is still broken, a retry reverts with the route's reason.
        vm.prank(keeper);
        vm.expectRevert();
        hook.retryHeld(t, CAUSE_A, f);

        cons.setReference(quoteUsdcKey, _spotTick(quoteUsdcKey));
        uint256 orgABefore = usdc.balanceOf(orgA);
        vm.recordLogs();
        vm.prank(keeper);
        uint256 out1 = hook.retryHeld(t, CAUSE_A, f / 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(hook.heldRaw(t, CAUSE_A), f - f / 2, "partial retry");
        assertEq(_count(logs, ILiveDonationVault.Donated.selector), 1, "threshold 0 pushes");
        vm.prank(keeper);
        uint256 out2 = hook.retryHeld(t, CAUSE_A, f - f / 2);
        assertEq(hook.heldRaw(t, CAUSE_A), 0);
        assertEq(_claims(address(hook), address(quote)), 0);
        assertEq(
            usdc.balanceOf(orgA) - orgABefore,
            _net(_share(out1)) + _net(_share(out2)),
            "credited to A although B is active"
        );
        assertEq(_pending(t, CAUSE_B), 0);

        // New fees go to B.
        (cause,,,, converted,) = _buyLogged(trader, key, t, 1e18);
        assertEq(cause, CAUSE_B);
        assertTrue(converted);
    }

    function test_failedDonation_undeployedOrgDeferredThenFlushed() public {
        (VeradaToken token, PoolKey memory key) =
            _launchLive(address(quote), 0, RotationPeriod.OneHour, CAUSE_B);
        address t = address(token);
        _fund(trader, token);

        (,,, uint256 out1, bool converted, Vm.Log[] memory logs) = _buyLogged(trader, key, t, 1e18);
        assertTrue(converted);
        (bool deferred, bytes4 reason) = _deferReason(logs);
        assertTrue(deferred);
        assertEq(reason, EndaomentDonateLib.OrgNotDeployed.selector);
        (uint256 pending, uint40 retryAt) = vault.pendingOf(t, CAUSE_B);
        assertEq(pending, _share(out1));
        assertEq(retryAt, block.timestamp + 1 hours, "backoff");

        // Inside the backoff no push is attempted; credit keeps accruing.
        (,,, uint256 out2,, Vm.Log[] memory logs2) = _buyLogged(trader, key, t, 1e18);
        (deferred,) = _deferReason(logs2);
        assertFalse(deferred);
        assertEq(_pending(t, CAUSE_B), _share(out1) + _share(out2));

        vm.recordLogs();
        vm.prank(keeper);
        uint256 donated = vault.flush(t, CAUSE_B);
        assertEq(donated, _share(out1) + _share(out2));
        assertGt(orgB.code.length, 0, "deployed by the flush");
        assertEq(usdc.balanceOf(orgB), _net(donated));
        (pending, retryAt) = vault.pendingOf(t, CAUSE_B);
        assertEq(pending, 0);
        assertEq(retryAt, 0, "backoff cleared");

        // With the org deployed, the next swap pushes in line.
        (,,, uint256 out3,, Vm.Log[] memory logs3) = _buyLogged(trader, key, t, 1e18);
        assertEq(_count(logs3, ILiveDonationVault.Donated.selector), 1);
        assertEq(usdc.balanceOf(orgB), _net(donated) + _net(_share(out3)));
    }

    function test_failedDonation_revertingOrgDoesNotRevertTheTrade() public {
        (VeradaToken token, PoolKey memory key) =
            _launchLive(address(quote), 0, RotationPeriod.OneHour, CAUSE_A);
        address t = address(token);
        _fund(trader, token);
        AdversarialOrg org = _makeAdversarial(orgA);

        AdversarialOrg.Mode[3] memory modes = [
            AdversarialOrg.Mode.Revert, AdversarialOrg.Mode.BurnGas, AdversarialOrg.Mode.ReturnBomb
        ];
        uint256 expected;
        for (uint256 i; i < modes.length; ++i) {
            org.configure(modes[i], address(0), address(0), bytes32(0));
            vm.warp(vm.getBlockTimestamp() + 1 hours); // past any backoff
            uint256 traderTokens = token.balanceOf(trader);
            (,,, uint256 out, bool converted, Vm.Log[] memory logs) =
                _buyLogged(trader, key, t, 1e18);
            assertGt(token.balanceOf(trader), traderTokens, "trade went through");
            assertTrue(converted);
            (bool deferred,) = _deferReason(logs);
            assertTrue(deferred, "push deferred");
            expected += _share(out);
            assertEq(_pending(t, CAUSE_A), expected);
        }

        org.configure(AdversarialOrg.Mode.Normal, address(0), address(0), bytes32(0));
        uint256 before = org.balance();
        vm.prank(keeper);
        assertEq(vault.flush(t, CAUSE_A), expected);
        assertEq(org.balance() - before, _net(expected));
        assertEq(vault.totalPending(), 0);
    }
}
