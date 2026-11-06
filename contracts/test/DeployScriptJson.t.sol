// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";

/// @notice The addresses file `Deploy` writes is what the operator copies into the indexer,
///         publisher and infra configuration, so it must carry every contract of the deployment.
contract DeployScriptJsonTest is Test, Deploy {
    function test_writeCarriesEveryAddress() public {
        Deployment memory d = Deployment({
            factory: address(0x1),
            hook: address(0x2),
            lpLocker: address(0x3),
            feeVault: address(0x4),
            feeConsolidator: address(0x5),
            quoteRegistry: address(0x6),
            causeRegistry: address(0x7),
            causeCatalog: address(0x8),
            epochGovernor: address(0x9),
            donationDistributor: address(0xa),
            profileRegistry: address(0xb),
            resolver: address(0xc),
            takeoverGovernor: address(0xd),
            votingScheme: address(0xe),
            curatorRegistry: address(0xf),
            deployBlock: 123
        });
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");

        _write(d);
        string memory json = vm.readFile(path);
        vm.removeFile(path);

        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonUint(json, ".deployBlock"), d.deployBlock);
        assertEq(vm.parseJsonAddress(json, ".factory"), d.factory);
        assertEq(vm.parseJsonAddress(json, ".hook"), d.hook);
        assertEq(vm.parseJsonAddress(json, ".lpLocker"), d.lpLocker);
        assertEq(vm.parseJsonAddress(json, ".feeVault"), d.feeVault);
        assertEq(vm.parseJsonAddress(json, ".feeConsolidator"), d.feeConsolidator);
        assertEq(vm.parseJsonAddress(json, ".quoteRegistry"), d.quoteRegistry);
        assertEq(vm.parseJsonAddress(json, ".causeRegistry"), d.causeRegistry);
        assertEq(vm.parseJsonAddress(json, ".causeCatalog"), d.causeCatalog);
        assertEq(vm.parseJsonAddress(json, ".epochGovernor"), d.epochGovernor);
        assertEq(vm.parseJsonAddress(json, ".donationDistributor"), d.donationDistributor);
        assertEq(vm.parseJsonAddress(json, ".profileRegistry"), d.profileRegistry);
        assertEq(vm.parseJsonAddress(json, ".resolver"), d.resolver);
        assertEq(vm.parseJsonAddress(json, ".takeoverGovernor"), d.takeoverGovernor);
        assertEq(vm.parseJsonAddress(json, ".votingScheme"), d.votingScheme);
        assertEq(vm.parseJsonAddress(json, ".curatorRegistry"), d.curatorRegistry);
    }
}
