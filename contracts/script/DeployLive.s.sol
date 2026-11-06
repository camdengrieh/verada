// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

import {FeeConsolidator} from "../src/FeeConsolidator.sol";
import {LiveDonationVault} from "../src/LiveDonationVault.sol";
import {RotationGovernor} from "../src/RotationGovernor.sol";
import {VeradaFactory} from "../src/VeradaFactory.sol";
import {VeradaLiveHook} from "../src/VeradaLiveHook.sol";
import {ZamaVotingScheme} from "../src/governance/ZamaVotingScheme.sol";
import {ICauseRegistry} from "../src/interfaces/ICauseRegistry.sol";
import {IFeeConsolidator} from "../src/interfaces/IFeeConsolidator.sol";
import {IRotationGovernor} from "../src/interfaces/IRotationGovernor.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {IOutcomeVotingScheme, IVotingScheme} from "../src/interfaces/IVotingScheme.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {Deploy} from "./Deploy.s.sol";

/// @title DeployLive
/// @notice Deploys the full Verada system (the `Deploy` script, unchanged) plus live-donation
///         mode: the rotation governor, the live-donation vault and the mined live hook, wires
///         them, enables live launches on the factory, then hands every admin contract to the
///         final owner. Writes `deployments/<chainid>.json` (as `Deploy`) and
///         `deployments/<chainid>-live.json`.
/// @dev `Deploy.run()` stays the weekly-only entry point; this script's entry point is
///      `runWithLive()`. Same environment as `Deploy` (OWNER, PLATFORM_TREASURY, SITE_SWARM_REF).
///      Example (fork dry run, nothing is broadcast):
///        forge script script/DeployLive.s.sol --sig "runWithLive()" --fork-url $ETH_RPC_URL
///
///      Order. `Deploy.deploy` runs with the deployer as interim owner, so its nonce offsets and
///      addresses are exactly those of a weekly-only deployment. Then, from the same deployer:
///      rotation governor, vault, live hook (through the CREATE2 deployer), wiring, and the
///      two-step ownership transfers. `configureLiveMode` must come from the factory deployer,
///      and `setSource` / `setGovernor` from the owners of the consolidator and the voting
///      scheme, which is why live mode is wired before any ownership moves.
///
///      Manual steps after deployment, in addition to those listed in `Deploy`:
///        1. The owner accepts ownership of the rotation governor and the live vault.
///        2. The owner sets the rotation governor's default shortlist
///           (`RotationGovernor.setDefaultShortlist`, 2 to 10 active causes).
///        3. The tally keeper (services/publisher) also follows the rotation governor's polls.
///           These are outcome-only polls: it decrypts `ZamaVotingScheme.outcomeHandle` and
///           relays it with `submitOutcome` (not `tallyHandles` / `submitTally`).
contract DeployLive is Deploy {
    /// @dev Permission flags the live hook's address must encode.
    uint160 internal constant LIVE_HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            | Hooks.BEFORE_DONATE_FLAG
    );
    /// @dev Fewest ballots a rotation poll or period proposal needs to be decrypted: a poll with
    ///      a single ballot would reveal that voter's choice through its outcome.
    uint32 internal constant ROTATION_MIN_VOTERS = 2;

    struct LiveDeployment {
        address rotationGovernor;
        address liveVault;
        address liveHook;
    }

    error LiveHookMiningFailed();

    /// @notice Entry point: the full system with live-donation mode enabled.
    function runWithLive() external returns (Deployment memory d, LiveDeployment memory l) {
        Config memory cfg = Config({
            owner: vm.envAddress("OWNER"),
            platformTreasury: vm.envAddress("PLATFORM_TREASURY"),
            siteSwarmRef: vm.envOr("SITE_SWARM_REF", bytes32(0))
        });

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        (d, l) = deployWithLive(cfg, deployer);
        vm.stopBroadcast();

        _write(d);
        _writeLive(l);
        _log(d);
        _logLive(l);
    }

    /// @notice Initial period-change parameters: a one-day vote, a three-day execution window,
    ///         a seven-day cooldown, 10% quorum and a 0.5% proposal threshold (of the circulating
    ///         supply).
    function defaultRotationParams() public pure returns (IRotationGovernor.Params memory) {
        return IRotationGovernor.Params({
            votingPeriod: 24 hours,
            executionWindow: 3 days,
            cooldown: 7 days,
            quorumBps: 1000,
            proposalThresholdBps: 50
        });
    }

    /// @notice Deploys the system and live mode, then moves ownership to `cfg.owner`. The caller
    ///         must already be acting as `deployer` (broadcasting or pranking).
    function deployWithLive(Config memory cfg, address deployer)
        public
        returns (Deployment memory d, LiveDeployment memory l)
    {
        address finalOwner = cfg.owner;
        d = deploy(
            Config({
                owner: deployer,
                platformTreasury: cfg.platformTreasury,
                siteSwarmRef: cfg.siteSwarmRef
            }),
            deployer
        );
        l = deployLive(d, cfg.platformTreasury, deployer);

        // Same two-step hand-over as `Deploy`, plus the two live admin contracts.
        if (finalOwner != deployer) {
            _handOver(d, finalOwner);
            Ownable(l.rotationGovernor).transferOwnership(finalOwner);
            Ownable(l.liveVault).transferOwnership(finalOwner);
        }
    }

    /// @notice Deploys and wires live-donation mode on top of `d`. `deployer` must be the factory
    ///         deployer and still own the consolidator and the voting scheme.
    function deployLive(Deployment memory d, address platformTreasury, address deployer)
        public
        returns (LiveDeployment memory l)
    {
        RotationGovernor gov = new RotationGovernor(
            deployer,
            ICauseRegistry(d.causeRegistry),
            ITokenProfileRegistry(d.profileRegistry),
            POOL_MANAGER,
            IOutcomeVotingScheme(d.votingScheme),
            defaultRotationParams()
        );
        LiveDonationVault vault = new LiveDonationVault(
            deployer,
            d.factory,
            platformTreasury,
            ICauseRegistry(d.causeRegistry),
            IEndaomentOrgFundFactory(ENDAOMENT_FACTORY),
            IRotationGovernor(address(gov)),
            IPoolManager(POOL_MANAGER),
            IFeeConsolidator(d.feeConsolidator)
        );

        bytes memory hookArgs =
            abi.encode(POOL_MANAGER, d.factory, d.feeConsolidator, address(gov), address(vault));
        bytes memory hookInit = abi.encodePacked(type(VeradaLiveHook).creationCode, hookArgs);
        (address hookAddr, bytes32 hookSalt) = _mineLiveHook(hookInit);
        _deployHook(hookSalt, hookInit, hookAddr);

        gov.setVault(address(vault));
        gov.setMinVoters(ROTATION_MIN_VOTERS);
        vault.setHook(hookAddr);
        FeeConsolidator(payable(d.feeConsolidator)).setSource(hookAddr, true);
        ZamaVotingScheme(d.votingScheme).setGovernor(address(gov), true);
        VeradaFactory(d.factory).configureLiveMode(hookAddr, address(vault));

        l = LiveDeployment({
            rotationGovernor: address(gov), liveVault: address(vault), liveHook: hookAddr
        });
    }

    // ------------------------------------------------------------------ hook mining

    function _mineLiveHook(bytes memory initCode)
        internal
        pure
        returns (address hook, bytes32 salt)
    {
        bytes32 initCodeHash = keccak256(initCode);
        uint160 mask = Hooks.ALL_HOOK_MASK;
        for (uint256 i; i < MAX_MINING_ITERATIONS; ++i) {
            salt = bytes32(i);
            hook = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash)
                        )
                    )
                )
            );
            if (uint160(hook) & mask == LIVE_HOOK_FLAGS) return (hook, salt);
        }
        revert LiveHookMiningFailed();
    }

    // ------------------------------------------------------------------ output

    function _writeLive(LiveDeployment memory l) internal {
        string memory k = "verada-live";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "rotationGovernor", l.rotationGovernor);
        vm.serializeAddress(k, "liveVault", l.liveVault);
        string memory json = vm.serializeAddress(k, "liveHook", l.liveHook);
        vm.createDir("deployments", true);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-live.json"));
    }

    function _logLive(LiveDeployment memory l) internal pure {
        console2.log("rotationGovernor", l.rotationGovernor);
        console2.log("liveVault", l.liveVault);
        console2.log("liveHook", l.liveHook);
    }
}
