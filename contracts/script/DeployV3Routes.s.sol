// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";

import {DeployLive} from "./DeployLive.s.sol";

/// @title DeployV3Routes
/// @notice The one-command mainnet deployment of the consolidator/registry generation (routes with
///         Uniswap v3 hops, live and weekly modes). It is `DeployLive.deployWithLive` plus the
///         safeguards a mainnet run needs: pre-flight checks, an explicit confirmation gate for
///         broadcasting, and a single manifest JSON that the indexer, web app and SDK configs are
///         generated from.
/// @dev Dry run by default. Without `--broadcast` forge simulates only and nothing is sent. With
///      `--broadcast` the script refuses to run unless `CONFIRM_MAINNET_DEPLOY=I-HAVE-RUN-THE-FORK-REHEARSAL`
///      is set. No key is ever read from the environment or a file by this script: the sender is
///      whatever account forge is given (`--account <keystore>` or `--ledger`).
///
///      Environment: OWNER, PLATFORM_TREASURY (required); SITE_SWARM_REF (optional bytes32);
///      GIT_COMMIT (optional, recorded in the manifest); MIN_DEPLOYER_BALANCE_WEI (default 0.1 ether).
///
///      Why everything is redeployed: `QuoteRegistry` (route format) and `FeeConsolidator` (v3 hops)
///      change. The hooks, the locker and the live vault hold the consolidator (and the live hook
///      the registry) as immutables; the factory holds the registry, hook and locker; the fee
///      vault, profile registry (so the resolver, governors and curator registry) hold the factory.
///      Nothing that is immutable can be repointed, so the whole system is deployed fresh from
///      one deployer nonce sequence and `varada.eth` is pointed at the new resolver.
contract DeployV3Routes is DeployLive {
    bytes32 internal constant CONFIRMATION = keccak256("I-HAVE-RUN-THE-FORK-REHEARSAL");

    error ConfirmationMissing();
    error DeployerUnderfunded(uint256 balance, uint256 required);
    error OwnerIsZero();

    function runV3() external {
        // Entry point is runV3 (run() belongs to Deploy), so a stale command cannot reach the
        // old path. Use --sig "runV3()".
        Config memory cfg = Config({
            owner: vm.envAddress("OWNER"),
            platformTreasury: vm.envAddress("PLATFORM_TREASURY"),
            siteSwarmRef: vm.envOr("SITE_SWARM_REF", bytes32(0))
        });
        if (cfg.owner == address(0) || cfg.platformTreasury == address(0)) revert OwnerIsZero();

        bool broadcasting = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
            || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        if (
            broadcasting
                && keccak256(bytes(vm.envOr("CONFIRM_MAINNET_DEPLOY", string("")))) != CONFIRMATION
        ) {
            revert ConfirmationMissing();
        }

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        uint256 minBalance = vm.envOr("MIN_DEPLOYER_BALANCE_WEI", uint256(0.1 ether));
        if (deployer.balance < minBalance) {
            revert DeployerUnderfunded(deployer.balance, minBalance);
        }
        console2.log("mode", broadcasting ? "BROADCAST" : "DRY RUN (nothing is sent)");
        console2.log("deployer", deployer);
        console2.log("deployer balance (wei)", deployer.balance);
        console2.log("deployer nonce", vm.getNonce(deployer));

        (Deployment memory d, LiveDeployment memory l) = deployWithLive(cfg, deployer);
        vm.stopBroadcast();

        // A dry run never touches the deployment records a real run left behind: only a
        // broadcast writes `<chainid>.json` and `<chainid>-live.json`.
        if (broadcasting) {
            _write(d);
            _writeLive(l);
        }
        _log(d);
        _logLive(l);
        _writeManifest(d, l, cfg, deployer, broadcasting);
    }

    /// @dev One JSON for tooling: addresses, start block, owner/treasury and the env values the
    ///      indexer and web app need (same keys as services/indexer/.env.example and
    ///      apps/web/public/config.json).
    function _writeManifest(
        Deployment memory d,
        LiveDeployment memory l,
        Config memory cfg,
        address deployer,
        bool broadcast
    ) internal {
        string memory a = "addresses";
        vm.serializeAddress(a, "factory", d.factory);
        vm.serializeAddress(a, "hook", d.hook);
        vm.serializeAddress(a, "lpLocker", d.lpLocker);
        vm.serializeAddress(a, "feeVault", d.feeVault);
        vm.serializeAddress(a, "feeConsolidator", d.feeConsolidator);
        vm.serializeAddress(a, "quoteRegistry", d.quoteRegistry);
        vm.serializeAddress(a, "causeRegistry", d.causeRegistry);
        vm.serializeAddress(a, "causeCatalog", d.causeCatalog);
        vm.serializeAddress(a, "epochGovernor", d.epochGovernor);
        vm.serializeAddress(a, "donationDistributor", d.donationDistributor);
        vm.serializeAddress(a, "profileRegistry", d.profileRegistry);
        vm.serializeAddress(a, "resolver", d.resolver);
        vm.serializeAddress(a, "takeoverGovernor", d.takeoverGovernor);
        vm.serializeAddress(a, "votingScheme", d.votingScheme);
        vm.serializeAddress(a, "curatorRegistry", d.curatorRegistry);
        vm.serializeAddress(a, "rotationGovernor", l.rotationGovernor);
        vm.serializeAddress(a, "liveVault", l.liveVault);
        string memory addrs = vm.serializeAddress(a, "liveHook", l.liveHook);

        string memory e = "indexerEnv";
        vm.serializeUint(e, "START_BLOCK", d.deployBlock);
        vm.serializeAddress(e, "FACTORY_ADDRESS", d.factory);
        vm.serializeAddress(e, "FEE_VAULT_ADDRESS", d.feeVault);
        vm.serializeAddress(e, "FEE_CONSOLIDATOR_ADDRESS", d.feeConsolidator);
        vm.serializeAddress(e, "QUOTE_REGISTRY_ADDRESS", d.quoteRegistry);
        vm.serializeAddress(e, "CAUSE_REGISTRY_ADDRESS", d.causeRegistry);
        vm.serializeAddress(e, "EPOCH_GOVERNOR_ADDRESS", d.epochGovernor);
        vm.serializeAddress(e, "DONATION_DISTRIBUTOR_ADDRESS", d.donationDistributor);
        vm.serializeAddress(e, "TOKEN_REGISTRY_ADDRESS", d.profileRegistry);
        vm.serializeAddress(e, "CAUSE_CATALOG_ADDRESS", d.causeCatalog);
        vm.serializeAddress(e, "CURATOR_REGISTRY_ADDRESS", d.curatorRegistry);
        vm.serializeAddress(e, "VOTING_SCHEME_ADDRESS", d.votingScheme);
        vm.serializeAddress(e, "TAKEOVER_GOVERNOR_ADDRESS", d.takeoverGovernor);
        string memory indexerEnv =
            vm.serializeAddress(e, "ROTATION_GOVERNOR_ADDRESS", l.rotationGovernor);

        string memory w = "webConfig";
        vm.serializeUint(w, "chainId", block.chainid);
        vm.serializeAddress(w, "factoryAddress", d.factory);
        vm.serializeUint(w, "factoryDeployBlock", d.deployBlock);
        vm.serializeAddress(w, "vaultAddress", d.feeVault);
        vm.serializeAddress(w, "governorAddress", d.epochGovernor);
        vm.serializeAddress(w, "profileRegistryAddress", d.profileRegistry);
        vm.serializeAddress(w, "votingSchemeAddress", d.votingScheme);
        vm.serializeAddress(w, "takeoverGovernorAddress", d.takeoverGovernor);
        string memory webConfig =
            vm.serializeAddress(w, "curatorRegistryAddress", d.curatorRegistry);

        string memory m = "manifest";
        vm.serializeUint(m, "chainId", block.chainid);
        vm.serializeBool(m, "broadcast", broadcast);
        vm.serializeUint(m, "deployBlock", d.deployBlock);
        vm.serializeAddress(m, "deployer", deployer);
        vm.serializeAddress(m, "owner", cfg.owner);
        vm.serializeAddress(m, "platformTreasury", cfg.platformTreasury);
        vm.serializeString(m, "gitCommit", vm.envOr("GIT_COMMIT", string("unset")));
        vm.serializeString(m, "ensParent", "varada.eth");
        vm.serializeString(
            m, "ensNextStep", "SetParentResolver.s.sol points varada.eth at addresses.resolver"
        );
        vm.serializeString(m, "indexerEnv", indexerEnv);
        vm.serializeString(m, "webConfig", webConfig);
        string memory json = vm.serializeString(m, "addresses", addrs);

        string memory path = string.concat(
            "deployments/",
            vm.toString(block.chainid),
            broadcast ? "-manifest.json" : "-manifest-dryrun.json"
        );
        vm.createDir("deployments", true);
        vm.writeJson(json, path);
        console2.log("manifest written", path);
        console2.log(json);
    }
}
