// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {FeeVault} from "../../src/FeeVault.sol";
import {LiveDonationVault} from "../../src/LiveDonationVault.sol";
import {VaradaToken} from "../../src/VaradaToken.sol";
import {ICauseRegistry} from "../../src/interfaces/ICauseRegistry.sol";
import {IFeeConsolidator} from "../../src/interfaces/IFeeConsolidator.sol";
import {ILiveDonationVault} from "../../src/interfaces/ILiveDonationVault.sol";
import {IRotationGovernor, RotationPeriod} from "../../src/interfaces/IRotationGovernor.sol";
import {IEndaomentOrgFundFactory} from "../../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {EndaomentDonateLib} from "../../src/libraries/EndaomentDonateLib.sol";
import {MockOrg} from "../mocks/EndaomentMocks.sol";
import {LiveBase} from "./LiveBase.sol";
import {AdversarialOrg} from "./LiveMocks.sol";

contract LiveDonationVaultTest is LiveBase {
    address internal tok = makeAddr("tok");

    function setUp() public {
        _liveSetUp();
        vault.registerToken(tok, 100e6, CAUSE_A, RotationPeriod.OneDay);
    }

    /// @dev Credits `amount` USDC as the hook would (transfer first, then credit).
    function _credit(address t, bytes32 cause, uint256 amount) internal {
        usdc.mint(address(vault), amount);
        _creditFunded(t, cause, amount);
    }

    /// @dev Credits `amount` already paid to the vault.
    function _creditFunded(address t, bytes32 cause, uint256 amount) internal {
        vm.prank(address(hook));
        vault.creditLive(t, cause, 7, amount);
    }

    function _net(uint256 gross) internal view returns (uint256) {
        return gross - (gross * endRegistry.fee()) / 10_000;
    }

    // ------------------------------------------------------------------ deployment and admin

    function test_platformShareMatchesWeeklyVault() public view {
        assertEq(vault.PLATFORM_SHARE_BPS(), FeeVault(address(feeVault)).PLATFORM_SHARE_BPS());
        assertEq(vault.usdc(), address(usdc));
        assertEq(address(vault.endaomentRegistry()), address(endRegistry));
    }

    function test_constructor_rejectsSettlementMismatch() public {
        address fakeCons = makeAddr("fakeCons");
        vm.mockCall(
            fakeCons, abi.encodeWithSignature("settlementAsset()"), abi.encode(address(quote))
        );
        vm.expectRevert(ILiveDonationVault.SettlementMismatch.selector);
        new LiveDonationVault(
            address(this),
            address(this),
            treasury,
            ICauseRegistry(address(causes)),
            IEndaomentOrgFundFactory(address(endFactory)),
            IRotationGovernor(address(rgov)),
            manager,
            IFeeConsolidator(fakeCons)
        );
    }

    function test_setHook_onceAndOwnerOnly() public {
        vm.expectRevert(ILiveDonationVault.HookAlreadySet.selector);
        vault.setHook(address(1));
        LiveDonationVault v2 = new LiveDonationVault(
            address(this),
            address(this),
            treasury,
            ICauseRegistry(address(causes)),
            IEndaomentOrgFundFactory(address(endFactory)),
            IRotationGovernor(address(rgov)),
            manager,
            IFeeConsolidator(address(cons))
        );
        vm.prank(trader);
        vm.expectRevert();
        v2.setHook(address(1));
        vm.expectRevert(ILiveDonationVault.ZeroAddress.selector);
        v2.setHook(address(0));
    }

    // ------------------------------------------------------------------ registration

    function test_registerToken_registersWithGovernor() public view {
        assertTrue(vault.isRegistered(tok));
        assertEq(vault.thresholdOf(tok), 100e6);
        assertTrue(rgov.isRegistered(tok));
        (bytes32 c, uint64 r) = rgov.activeCause(tok);
        assertEq(c, CAUSE_A);
        assertEq(r, 0);
    }

    function test_registerToken_checks() public {
        address t = makeAddr("t2");
        vm.prank(trader);
        vm.expectRevert(ILiveDonationVault.NotFactory.selector);
        vault.registerToken(t, 0, CAUSE_A, RotationPeriod.OneHour);

        vm.expectRevert(
            abi.encodeWithSelector(ILiveDonationVault.ThresholdTooHigh.selector, 1_000_000e6 + 1)
        );
        vault.registerToken(t, 1_000_000e6 + 1, CAUSE_A, RotationPeriod.OneHour);

        causes.deactivateCause(CAUSE_C);
        vm.expectRevert(abi.encodeWithSelector(IRotationGovernor.InactiveCause.selector, CAUSE_C));
        vault.registerToken(t, 0, CAUSE_C, RotationPeriod.OneHour);
        assertFalse(vault.isRegistered(t), "atomic");

        vault.registerToken(t, 0, CAUSE_A, RotationPeriod.OneHour);
        vm.expectRevert(abi.encodeWithSelector(ILiveDonationVault.AlreadyRegistered.selector, t));
        vault.registerToken(t, 0, CAUSE_A, RotationPeriod.OneHour);
    }

    function test_registerToken_emits() public {
        address t = makeAddr("t3");
        vm.expectEmit(address(vault));
        emit ILiveDonationVault.LiveTokenRegistered(t, 5e6, CAUSE_B, RotationPeriod.ThreeDays);
        vault.registerToken(t, 5e6, CAUSE_B, RotationPeriod.ThreeDays);
    }

    // ------------------------------------------------------------------ credit

    function test_creditLive_onlyHook() public {
        vm.expectRevert(ILiveDonationVault.NotHook.selector);
        vault.creditLive(tok, CAUSE_A, 0, 1);
    }

    function test_creditLive_rejectsUnregisteredToken() public {
        usdc.mint(address(vault), 10);
        vm.prank(address(hook));
        vm.expectRevert(
            abi.encodeWithSelector(ILiveDonationVault.TokenNotRegistered.selector, address(9))
        );
        vault.creditLive(address(9), CAUSE_A, 0, 10);
    }

    function test_creditLive_rejectsUnbacked() public {
        usdc.mint(address(vault), 9);
        vm.prank(address(hook));
        vm.expectRevert(abi.encodeWithSelector(ILiveDonationVault.UnbackedCredit.selector, 9, 10));
        vault.creditLive(tok, CAUSE_A, 0, 10);
    }

    function testFuzz_creditLive_split(uint256 gross) public {
        gross = bound(gross, 0, 99e6); // stays below the 100 USDC threshold
        usdc.mint(address(vault), gross);
        vm.expectEmit(address(vault));
        emit ILiveDonationVault.Credited(
            tok, CAUSE_A, 7, gross, (gross * 1000) / 10_000, gross - (gross * 1000) / 10_000
        );
        _creditFunded(tok, CAUSE_A, gross);
        uint256 platform = vault.platformAccrued();
        (uint256 pending,) = vault.pendingOf(tok, CAUSE_A);
        assertEq(platform, (gross * 1000) / 10_000, "V3 floor");
        assertEq(platform + pending, gross, "V3 sum");
        assertEq(vault.totalPending(), pending);
    }

    function testFuzz_threshold_accrualPushesAtCrossing(uint256[6] memory amounts) public {
        uint256 sum;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 a = bound(amounts[i], 1e6, 40e6);
            uint256 before = MockOrg(orgA).balance();
            _credit(tok, CAUSE_A, a);
            uint256 share = a - (a * 1000) / 10_000;
            sum += share;
            (uint256 pending,) = vault.pendingOf(tok, CAUSE_A);
            if (sum >= 100e6) {
                assertEq(pending, 0, "pushed at crossing");
                assertEq(MockOrg(orgA).balance() - before, _net(sum));
                sum = 0;
            } else {
                assertEq(pending, sum, "accrues below threshold");
            }
        }
        assertGe(usdc.balanceOf(address(vault)), vault.platformAccrued() + vault.totalPending());
    }

    function test_thresholdZero_pushesEveryCredit() public {
        address t = makeAddr("t0");
        vault.registerToken(t, 0, CAUSE_A, RotationPeriod.OneHour);
        for (uint256 i; i < 3; ++i) {
            uint256 before = MockOrg(orgA).balance();
            usdc.mint(address(vault), 10e6);
            vm.expectEmit(address(vault));
            emit ILiveDonationVault.Donated(t, CAUSE_A, orgA, 9e6, false, true);
            _creditFunded(t, CAUSE_A, 10e6);
            assertEq(MockOrg(orgA).balance() - before, _net(9e6));
            (uint256 pending,) = vault.pendingOf(t, CAUSE_A);
            assertEq(pending, 0);
        }
        assertEq(vault.platformAccrued(), 3e6);
    }

    // ------------------------------------------------------------------ deferral and flush

    function test_undeployedOrg_deferredThenFlushDeploys() public {
        address t = makeAddr("tb");
        vault.registerToken(t, 0, CAUSE_B, RotationPeriod.OneHour);
        usdc.mint(address(vault), 10e6);
        vm.expectEmit(address(vault));
        emit ILiveDonationVault.DonationDeferred(
            t, CAUSE_B, 9e6, EndaomentDonateLib.OrgNotDeployed.selector
        );
        _creditFunded(t, CAUSE_B, 10e6);
        (uint256 pending, uint40 retryAt) = vault.pendingOf(t, CAUSE_B);
        assertEq(pending, 9e6);
        assertEq(retryAt, block.timestamp + 1 hours, "backoff set");
        assertEq(orgB.code.length, 0, "never deployed inside the push");

        // Backoff honoured: the next credit does not try again.
        vm.recordLogs();
        _credit(t, CAUSE_B, 10e6);
        assertEq(_count(vm.getRecordedLogs(), ILiveDonationVault.DonationDeferred.selector), 0);

        vm.expectEmit(address(vault));
        emit ILiveDonationVault.Donated(t, CAUSE_B, orgB, 18e6, true, false);
        uint256 donated = vault.flush(t, CAUSE_B);
        assertEq(donated, 18e6);
        assertGt(orgB.code.length, 0, "deployed by flush");
        assertEq(usdc.balanceOf(orgB), _net(18e6));
        (pending, retryAt) = vault.pendingOf(t, CAUSE_B);
        assertEq(pending, 0);
        assertEq(retryAt, 0, "backoff cleared");
    }

    function test_backoffExpires_thenPushes() public {
        address t = makeAddr("tb");
        vault.registerToken(t, 0, CAUSE_A, RotationPeriod.OneHour);
        endRegistry.setActive(orgA, false);
        _credit(t, CAUSE_A, 10e6);
        endRegistry.setActive(orgA, true);
        vm.warp(block.timestamp + 1 hours);
        _credit(t, CAUSE_A, 10e6);
        (uint256 pending,) = vault.pendingOf(t, CAUSE_A);
        assertEq(pending, 0, "pushed after the backoff");
        assertEq(MockOrg(orgA).balance(), _net(18e6));
    }

    function test_inactiveEntity_deferredAndFlushReverts() public {
        endRegistry.setActive(orgA, false);
        _credit(tok, CAUSE_A, 200e6);
        (uint256 pending,) = vault.pendingOf(tok, CAUSE_A);
        assertEq(pending, 180e6);
        vm.expectRevert(abi.encodeWithSelector(EndaomentDonateLib.OrgNotActive.selector, orgA));
        vault.flush(tok, CAUSE_A);
    }

    function test_orgAddressMismatch_deferredAndFlushReverts() public {
        address other = makeAddr("other");
        vm.mockCall(
            address(endFactory),
            abi.encodeWithSignature("computeOrgAddress(bytes32)", ORG_A),
            abi.encode(other)
        );
        usdc.mint(address(vault), 200e6);
        vm.expectEmit(address(vault));
        emit ILiveDonationVault.DonationDeferred(
            tok, CAUSE_A, 180e6, EndaomentDonateLib.OrgAddressMismatch.selector
        );
        _creditFunded(tok, CAUSE_A, 200e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                EndaomentDonateLib.OrgAddressMismatch.selector, ORG_A, other, orgA
            )
        );
        vault.flush(tok, CAUSE_A);
    }

    function test_flush_deployMismatchReverts() public {
        address t = makeAddr("tb");
        vault.registerToken(t, 1_000_000e6, CAUSE_B, RotationPeriod.OneHour);
        _credit(t, CAUSE_B, 10e6);
        endFactory.setLie(address(0xBEEF));
        vm.expectRevert(
            abi.encodeWithSelector(
                EndaomentDonateLib.OrgAddressMismatch.selector, ORG_B, orgB, address(0xBEEF)
            )
        );
        vault.flush(t, CAUSE_B);
    }

    function test_flush_nothing() public {
        vm.expectRevert(
            abi.encodeWithSelector(ILiveDonationVault.NothingToFlush.selector, tok, CAUSE_A)
        );
        vault.flush(tok, CAUSE_A);
    }

    function test_flush_ignoresThresholdAndKeepsCauseSeparate() public {
        _credit(tok, CAUSE_A, 10e6);
        _credit(tok, CAUSE_C, 20e6);
        assertEq(vault.flush(tok, CAUSE_A), 9e6);
        (uint256 pendingC,) = vault.pendingOf(tok, CAUSE_C);
        assertEq(pendingC, 18e6, "V2: credit never moves between causes");
        assertEq(vault.totalPending(), 18e6);
    }

    function test_allowanceCleared_whenOrgPullsLess() public {
        AdversarialOrg org = _makeAdversarial(orgA);
        org.configure(AdversarialOrg.Mode.PullLess, address(0), address(0), bytes32(0));
        _credit(tok, CAUSE_A, 200e6);
        assertEq(usdc.allowance(address(vault), orgA), 0, "allowance cleared");
        (uint256 pending,) = vault.pendingOf(tok, CAUSE_A);
        assertEq(pending, 0, "debited in full");
        // What the org left behind is surplus, skimmable to the platform.
        assertEq(vault.skim(address(usdc)), 90e6);
    }

    function test_insufficientPushGas_defers() public {
        address t = makeAddr("t0");
        vault.registerToken(t, 0, CAUSE_A, RotationPeriod.OneHour);
        usdc.mint(address(vault), 10e6);
        vm.expectEmit(address(vault));
        emit ILiveDonationVault.DonationDeferred(
            t, CAUSE_A, 9e6, ILiveDonationVault.InsufficientPushGas.selector
        );
        vm.prank(address(hook));
        vault.creditLive{gas: 200_000}(t, CAUSE_A, 0, 10e6);
        (uint256 pending, uint40 retryAt) = vault.pendingOf(t, CAUSE_A);
        assertEq(pending, 9e6);
        assertEq(retryAt, 0, "no backoff for a gas shortfall");
    }

    function test_reenteringOrg_cannotFlush() public {
        AdversarialOrg org = _makeAdversarial(orgA);
        org.configure(AdversarialOrg.Mode.ReenterFlush, address(vault), tok, CAUSE_A);
        usdc.mint(address(vault), 200e6);
        vm.expectEmit(address(vault));
        emit ILiveDonationVault.DonationDeferred(
            tok, CAUSE_A, 180e6, ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector
        );
        _creditFunded(tok, CAUSE_A, 200e6);
    }

    function test_executePush_onlySelf() public {
        vm.expectRevert(ILiveDonationVault.NotSelf.selector);
        vault.executePush(tok, CAUSE_A, 1);
    }

    // ------------------------------------------------------------------ platform and skim

    function test_withdrawPlatform() public {
        _credit(tok, CAUSE_A, 50e6);
        vm.prank(trader);
        uint256 amount = vault.withdrawPlatform();
        assertEq(amount, 5e6);
        assertEq(usdc.balanceOf(treasury), 5e6);
        assertEq(vault.platformAccrued(), 0);
        vm.expectRevert(ILiveDonationVault.NothingToWithdraw.selector);
        vault.withdrawPlatform();
    }

    function test_skim_onlySurplus() public {
        _credit(tok, CAUSE_A, 50e6);
        vm.expectRevert(
            abi.encodeWithSelector(ILiveDonationVault.NothingToSkim.selector, address(usdc))
        );
        vault.skim(address(usdc));
        usdc.mint(address(vault), 7);
        assertEq(vault.skim(address(usdc)), 7);
        assertEq(usdc.balanceOf(address(vault)), 50e6);
        quote.mint(address(vault), 3e18);
        assertEq(vault.skim(address(quote)), 3e18);
        assertEq(quote.balanceOf(treasury), 3e18);
    }

    // ------------------------------------------------------------------ in-swap pushes

    function test_inSwap_thresholdZero_orgReceivesNetInSameTx() public {
        (VaradaToken t, PoolKey memory k) = _launchDefault(address(quote), 0);
        _fundTrader(trader, t);
        uint256 before = MockOrg(orgA).balance();
        vm.recordLogs();
        _buyExactIn(k, address(t), 1e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, ILiveDonationVault.Donated.selector), 1);
        (,,,, uint256 out,,) = _lastFeeTaken(logs);
        uint256 share = out - (out * 1000) / 10_000;
        assertEq(MockOrg(orgA).balance() - before, _net(share));
        assertEq(vault.totalPending(), 0);
    }

    function test_inSwap_crossingSwapPushes() public {
        (VaradaToken t, PoolKey memory k) = _launchDefault(address(quote), 5e6);
        _fundTrader(trader, t);
        // ~2.9 USDC per 1 quote buy at 3%: the second swap crosses 5 USDC.
        _buyExactIn(k, address(t), 1e18);
        (uint256 p1,) = vault.pendingOf(address(t), CAUSE_A);
        assertGt(p1, 0);
        assertLt(p1, 5e6);
        vm.recordLogs();
        _buyExactIn(k, address(t), 1e18);
        assertEq(_count(vm.getRecordedLogs(), ILiveDonationVault.Donated.selector), 1);
        (uint256 p2,) = vault.pendingOf(address(t), CAUSE_A);
        assertEq(p2, 0);
    }

    function _assertPmGuard(AdversarialOrg.Mode mode) internal {
        (VaradaToken t, PoolKey memory k) = _launchDefault(address(quote), 0);
        _fundTrader(trader, t);
        AdversarialOrg org = _makeAdversarial(orgA);
        org.configure(mode, address(manager), address(t), CAUSE_A);
        vm.recordLogs();
        _buyExactIn(k, address(t), 1e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, ILiveDonationVault.Donated.selector), 0);
        bytes32 topic = ILiveDonationVault.DonationDeferred.selector;
        bytes4 reason;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic) {
                (, reason) = abi.decode(logs[i].data, (uint256, bytes4));
            }
        }
        assertEq(reason, ILiveDonationVault.PoolManagerStateChanged.selector);
        (uint256 pending,) = vault.pendingOf(address(t), CAUSE_A);
        assertGt(pending, 0, "credit kept");
        assertEq(MockOrg(orgA).balance(), 0, "callee effects rolled back");
    }

    function test_inSwap_orgLeavingDelta_rolledBack() public {
        _assertPmGuard(AdversarialOrg.Mode.LeaveDelta);
    }

    function test_inSwap_orgLeavingSync_rolledBack() public {
        _assertPmGuard(AdversarialOrg.Mode.LeaveSync);
    }
}
