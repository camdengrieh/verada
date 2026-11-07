// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {EpochGovernor} from "../src/EpochGovernor.sol";
import {FeeVault} from "../src/FeeVault.sol";

/// @title ConfigureTiming
/// @notice The owner's timing configuration of the weekly cycle: a TRADING phase followed by a
///         VOTING phase, and the grace periods around them. Run as `OWNER`, after `ConfigureRoutes`
///         (which accepts ownership of the epoch governor and the fee vault). Dry run unless forge
///         is given `--broadcast`. Re-running is safe: values that already match are skipped.
/// @dev Defaults are the first production test cycle: 30 minutes of trading then 15 minutes of
///      voting (a 45 minute epoch, hold window = the trading phase) and short grace periods.
///      Production values are the contracts' own defaults (7 day epoch, voting open the whole epoch,
///      14 day tally grace, 6 hour curation grace, 1 day launch snapshot delay, 7 day settle
///      grace); set them back with the same script and the `*_SECONDS` variables below.
///
///        forge script script/ConfigureTiming.s.sol --sig "run()" --rpc-url $ETH_RPC_URL \
///          --account varada-owner [--broadcast]
///
///      Environment (all optional, seconds):
///        DEPLOYMENTS_DIR            default "deployments" (reads `<chainid>.json`)
///        EPOCH_LENGTH_SECONDS       default 2700  (45 min)
///        VOTING_WINDOW_SECONDS      default 900   (15 min, the last part of the epoch)
///        HOLD_WINDOW_SECONDS        default 1800  (30 min, the trading phase)
///        TALLY_GRACE_SECONDS        default 1800  (30 min)
///        CURATION_GRACE_SECONDS     default 300   (5 min)
///        LAUNCH_SNAPSHOT_DELAY_SECONDS default 300 (5 min)
///        SETTLE_GRACE_SECONDS       default 2700  (45 min)
///      A change of the epoch schedule takes effect from the NEXT epoch (see `EpochGovernor`).
contract ConfigureTiming is Script {
    function run() external {
        string memory dir = vm.envOr("DEPLOYMENTS_DIR", string("deployments"));
        string memory w = vm.readFile(string.concat(dir, "/", vm.toString(block.chainid), ".json"));
        EpochGovernor gov = EpochGovernor(vm.parseJsonAddress(w, ".epochGovernor"));
        FeeVault vault = FeeVault(vm.parseJsonAddress(w, ".feeVault"));

        uint256 length = vm.envOr("EPOCH_LENGTH_SECONDS", uint256(45 minutes));
        uint256 voting = vm.envOr("VOTING_WINDOW_SECONDS", uint256(15 minutes));
        uint256 hold = vm.envOr("HOLD_WINDOW_SECONDS", uint256(30 minutes));
        uint256 tally = vm.envOr("TALLY_GRACE_SECONDS", uint256(30 minutes));
        uint256 curation = vm.envOr("CURATION_GRACE_SECONDS", uint256(5 minutes));
        uint256 snapshotDelay = vm.envOr("LAUNCH_SNAPSHOT_DELAY_SECONDS", uint256(5 minutes));
        uint256 settle = vm.envOr("SETTLE_GRACE_SECONDS", uint256(45 minutes));

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        console2.log("sender", sender);
        console2.log("epoch governor owner", gov.owner());
        console2.log("fee vault owner", vault.owner());

        if (gov.epochLength() != length || gov.votingWindow() != voting || gov.holdWindow() != hold) {
            gov.setEpochSchedule(length, voting, hold);
            console2.log("epoch schedule set (length, voting window, hold window)", length, voting, hold);
        }
        if (gov.tallyGrace() != tally) gov.setTallyGrace(tally);
        if (gov.curationGrace() != curation) gov.setCurationGrace(curation);
        if (gov.launchSnapshotDelay() != snapshotDelay) gov.setLaunchSnapshotDelay(snapshotDelay);
        if (vault.settleGrace() != settle) vault.setSettleGrace(settle);
        vm.stopBroadcast();
    }
}
