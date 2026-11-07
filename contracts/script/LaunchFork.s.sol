// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

import {CauseCatalog} from "../src/CauseCatalog.sol";
import {CauseRegistry} from "../src/CauseRegistry.sol";
import {FeeConsolidator} from "../src/FeeConsolidator.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {IQuoteRegistry} from "../src/interfaces/IQuoteRegistry.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {CatalogPublish} from "../test/utils/CatalogFixture.sol";
import {DeployLive} from "./DeployLive.s.sol";

/// @title LaunchFork
/// @notice FORK-ONLY fixture for driving the launch wizard in a browser against an anvil mainnet fork.
///         Deploys the whole system with live mode, allowlists WETH and AMZNon through their real pools,
///         publishes a catalogue and activates two causes, and launches nothing. Every address the web app
///         and the indexer need goes to `deployments/launch-fork.json`. Refuses to run unless
///         `LAUNCH_FORK_FIXTURE=1`; never broadcast it to a real network.
/// @dev    LAUNCH_FORK_FIXTURE=1 PLATFORM_TREASURY=<addr> forge script script/LaunchFork.s.sol --sig "fixture()"
///         --rpc-url http://127.0.0.1:<port> --broadcast --private-key <deployer key>
contract LaunchFork is DeployLive {
    address internal constant AMZN_ON = 0xbb8774FB97436d23d74C1b882E8E9A69322cFD31;
    bytes32 internal constant WIKI_ORG = bytes32("200049703");
    address internal constant WIKI_ADDR = 0xe5F123750FcEa2D82b1441048F1A431FDD3D2Dc1;
    bytes32 internal constant FRESH_ORG = bytes32("999000111");

    function fixture() external {
        require(vm.envOr("LAUNCH_FORK_FIXTURE", uint256(0)) == 1, "fork fixture only");
        address treasury = vm.envAddress("PLATFORM_TREASURY");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        (Deployment memory d, LiveDeployment memory l) = deployWithLive(
            Config({owner: deployer, platformTreasury: treasury, siteSwarmRef: bytes32(0)}), deployer
        );

        bytes32[] memory orgs = new bytes32[](2);
        orgs[0] = WIKI_ORG;
        orgs[1] = FRESH_ORG;
        CatalogPublish.publish(CauseCatalog(d.causeCatalog), orgs);
        address freshAddr = IEndaomentOrgFundFactory(ENDAOMENT_FACTORY).computeOrgAddress(FRESH_ORG);
        CauseRegistry(d.causeRegistry).addCause(keccak256(abi.encode(WIKI_ORG)), WIKI_ORG, WIKI_ADDR, "ipfs://wiki");
        CauseRegistry(d.causeRegistry).addCause(keccak256(abi.encode(FRESH_ORG)), FRESH_ORG, freshAddr, "ipfs://fresh");

        PoolKey[] memory ethRoute = new PoolKey[](1);
        ethRoute[0] = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 500, 10, IHooks(address(0)));
        QuoteRegistry(d.quoteRegistry).addQuoteAssetWithRoute(WETH, IQuoteRegistry.Kind.Native, ethRoute);
        FeeConsolidator(payable(d.feeConsolidator)).seedReferences(ethRoute);

        PoolKey[] memory amznRoute = new PoolKey[](1);
        amznRoute[0] = PoolKey(Currency.wrap(USDC), Currency.wrap(AMZN_ON), 10_000, 100, IHooks(address(0)));
        QuoteRegistry(d.quoteRegistry).addQuoteAssetWithRoute(AMZN_ON, IQuoteRegistry.Kind.Ondo, amznRoute);
        FeeConsolidator(payable(d.feeConsolidator)).seedReferences(amznRoute);
        vm.stopBroadcast();

        string memory k = "launchfork";
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "hook", d.hook);
        vm.serializeAddress(k, "liveHook", l.liveHook);
        vm.serializeAddress(k, "feeVault", d.feeVault);
        vm.serializeAddress(k, "feeConsolidator", d.feeConsolidator);
        vm.serializeAddress(k, "quoteRegistry", d.quoteRegistry);
        vm.serializeAddress(k, "causeRegistry", d.causeRegistry);
        vm.serializeAddress(k, "causeCatalog", d.causeCatalog);
        vm.serializeAddress(k, "epochGovernor", d.epochGovernor);
        vm.serializeAddress(k, "donationDistributor", d.donationDistributor);
        vm.serializeAddress(k, "profileRegistry", d.profileRegistry);
        vm.serializeAddress(k, "takeoverGovernor", d.takeoverGovernor);
        vm.serializeAddress(k, "votingScheme", d.votingScheme);
        vm.serializeAddress(k, "curatorRegistry", d.curatorRegistry);
        vm.serializeAddress(k, "rotationGovernor", l.rotationGovernor);
        vm.serializeAddress(k, "liveVault", l.liveVault);
        string memory json = vm.serializeUint(k, "deployBlock", d.deployBlock);
        vm.createDir("deployments", true);
        vm.writeJson(json, "deployments/launch-fork.json");
    }
}
