// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";

import {VeradaToken} from "../../src/VeradaToken.sol";
import {ILiveDonationVault} from "../../src/interfaces/ILiveDonationVault.sol";
import {LiveBase} from "./LiveBase.sol";
import {AdversarialOrg} from "./LiveMocks.sol";

/// @dev "Never revert" matrix: each failure is injected in turn and every swap kind is run against
///      a control run without the failure. The trader's deltas must be identical, the swap must
///      succeed, and the fee must be either held for the active cause or credited to it.
contract LiveFailureModesTest is LiveBase {
    using PoolIdLibrary for PoolKey;

    VeradaToken internal token;
    PoolKey internal liveKey;
    AdversarialOrg internal org;

    /// @dev Storage slot of `FeeConsolidator.references` (see `forge inspect`).
    uint256 internal constant REFERENCES_SLOT = 11;

    function setUp() public {
        _liveSetUp();
        (token, liveKey) = _launchDefault(address(quote), 0); // threshold 0: push every swap
        _fundTrader(trader, token);
        org = _makeAdversarial(orgA);
    }

    // ------------------------------------------------------------------ runner

    function _swapKind(uint8 kind) internal returns (BalanceDelta) {
        if (kind == 0) return _buyExactIn(liveKey, address(token), 1e18);
        if (kind == 1) return _buyExactOut(liveKey, address(token), 1e20);
        if (kind == 2) return _sellExactIn(liveKey, address(token), 1e20);
        return _sellExactOut(liveKey, address(token), 1e16);
    }

    /// @dev Runs all four swap kinds with and without `inject`; returns how many fees were held.
    function _matrix(function() internal inject, bool expectConverted) internal {
        for (uint8 kind; kind < 4; ++kind) {
            uint256 snap = vm.snapshotState();
            BalanceDelta control = _swapKind(kind);
            vm.revertToState(snap);

            inject();
            uint256 heldBefore = hook.heldRaw(address(token), CAUSE_A);
            (uint256 pendingBefore,) = vault.pendingOf(address(token), CAUSE_A);
            vm.recordLogs();
            BalanceDelta d = _swapKind(kind);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(BalanceDelta.unwrap(d), BalanceDelta.unwrap(control), "trader deltas");

            (bool found, bytes32 cause,, uint256 f, uint256 out, bool converted,) =
                _lastFeeTaken(logs);
            assertTrue(found, "fee taken");
            assertEq(cause, CAUSE_A, "active cause");
            assertEq(converted, expectConverted, "converted");
            if (converted) {
                assertEq(hook.heldRaw(address(token), CAUSE_A), heldBefore);
                (uint256 pendingAfter,) = vault.pendingOf(address(token), CAUSE_A);
                if (_count(logs, ILiveDonationVault.Donated.selector) == 0) {
                    assertEq(pendingAfter, pendingBefore + out - (out * 1000) / 10_000, "kept");
                }
            } else {
                assertEq(hook.heldRaw(address(token), CAUSE_A), heldBefore + f, "held");
            }
            assertEq(_claims(address(hook), address(quote)), hook.totalHeld(address(quote)), "H1");
            assertGe(
                usdc.balanceOf(address(vault)), vault.platformAccrued() + vault.totalPending(), "V1"
            );
            vm.revertToState(snap);
        }
    }

    // ------------------------------------------------------------------ conversion failures

    function _referenceUnset() internal {
        vm.store(
            address(cons),
            keccak256(abi.encode(PoolId.unwrap(quoteUsdcKey.toId()), REFERENCES_SLOT)),
            bytes32(0)
        );
    }

    function test_referenceUnset() public {
        _matrix(_referenceUnset, false);
    }

    function _pastDeviation() internal {
        cons.setReference(quoteUsdcKey, _spotTick(quoteUsdcKey) + 5000);
    }

    function test_priceBeyondDeviation() public {
        _matrix(_pastDeviation, false);
    }

    function _emptyRoute() internal {
        int24 tick = _orientedTick(address(quote), address(usdc), QUOTE_TICK);
        modifyLiquidityRouter.modifyLiquidity(
            quoteUsdcKey,
            ModifyLiquidityParams({
                tickLower: tick - 6000, tickUpper: tick + 6000, liquidityDelta: -2e19, salt: 0
            }),
            ZERO_BYTES
        );
    }

    function test_emptyRouteLiquidity() public {
        _matrix(_emptyRoute, false);
    }

    function _usdcPaused() internal {
        usdc.setPaused(true);
    }

    function test_usdcPaused() public {
        _matrix(_usdcPaused, false);
    }

    function _vaultBlacklisted() internal {
        usdc.setBlacklisted(address(vault), true);
    }

    function test_vaultBlacklistedByUsdc() public {
        _matrix(_vaultBlacklisted, false);
    }

    function _sourceRemoved() internal {
        cons.setSource(address(hook), false);
    }

    function test_consolidatorSourceRemoved() public {
        _matrix(_sourceRemoved, false);
    }

    /// @dev `maxDeviationTicks = 0` stops conversions as soon as spot differs from the reference
    ///      by a tick (moved here by a trade); `setSource(hook, false)` stops them unconditionally.
    function _killSwitch() internal {
        cons.setMaxDeviationTicks(0);
        _swapAs(
            address(this),
            quoteUsdcKey,
            Currency.unwrap(quoteUsdcKey.currency0) == address(quote),
            -1e22
        );
    }

    function test_deviationKillSwitch() public {
        _matrix(_killSwitch, false);
    }

    function _quotePaused() internal {
        quote.setPaused(true);
    }

    /// @dev A paused Ondo quote blocks the trader's own transfers, so the swap itself reverts in
    ///      the router; the fee path adds nothing. Shown here so the matrix documents it.
    function test_quotePaused_swapRevertsInRouterNotInHook() public {
        _quotePaused();
        vm.expectRevert();
        _buyExactIn(liveKey, address(token), 1e18);
    }

    function test_dustFee_heldNotReverted() public {
        vm.recordLogs();
        _buyExactIn(liveKey, address(token), 1000);
        (bool found,,, uint256 f,, bool converted, bytes4 failure) =
            _lastFeeTaken(vm.getRecordedLogs());
        assertTrue(found);
        assertFalse(converted);
        assertEq(f, 30);
        assertTrue(failure != bytes4(0));
        assertEq(hook.heldRaw(address(token), CAUSE_A), 30);
    }

    // ------------------------------------------------------------------ donation failures

    function _orgRevert() internal {
        org.configure(AdversarialOrg.Mode.Revert, address(0), address(0), bytes32(0));
    }

    function _orgBurnGas() internal {
        org.configure(AdversarialOrg.Mode.BurnGas, address(0), address(0), bytes32(0));
    }

    function _orgReturnBomb() internal {
        org.configure(AdversarialOrg.Mode.ReturnBomb, address(0), address(0), bytes32(0));
    }

    function _orgReenterFlush() internal {
        org.configure(AdversarialOrg.Mode.ReenterFlush, address(vault), address(token), CAUSE_A);
    }

    function _orgReenterRetry() internal {
        org.configure(AdversarialOrg.Mode.ReenterRetry, address(hook), address(token), CAUSE_A);
    }

    function _orgReenterSwap() internal {
        org.configure(AdversarialOrg.Mode.ReenterSwap, address(manager), address(token), CAUSE_A);
        org.setKey(liveKey);
    }

    function _orgLeaveDelta() internal {
        org.configure(AdversarialOrg.Mode.LeaveDelta, address(manager), address(0), bytes32(0));
    }

    function _orgLeaveSync() internal {
        org.configure(AdversarialOrg.Mode.LeaveSync, address(manager), address(0), bytes32(0));
    }

    function _orgInactive() internal {
        endRegistry.setActive(orgA, false);
    }

    function test_org_reverts() public {
        _matrix(_orgRevert, true);
    }

    function test_org_burnsGas() public {
        _matrix(_orgBurnGas, true);
    }

    function test_org_returnDataBomb() public {
        _matrix(_orgReturnBomb, true);
    }

    function test_org_reentersFlush() public {
        _matrix(_orgReenterFlush, true);
    }

    function test_org_reentersRetry() public {
        _matrix(_orgReenterRetry, true);
    }

    function test_org_reentersLiveSwap() public {
        _matrix(_orgReenterSwap, true);
    }

    function test_org_leavesPoolManagerDelta() public {
        _matrix(_orgLeaveDelta, true);
    }

    function test_org_leavesSyncedCurrency() public {
        _matrix(_orgLeaveSync, true);
    }

    function test_org_inactiveEntity() public {
        _matrix(_orgInactive, true);
    }

    // ------------------------------------------------------------------ governance state

    function _noShortlist() internal {
        rgov.setDefaultShortlist(new bytes32[](0));
    }

    function test_governorWithoutShortlist() public {
        _matrix(_noShortlist, true);
    }
}
