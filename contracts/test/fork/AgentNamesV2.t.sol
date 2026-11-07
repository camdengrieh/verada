// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {SetupAgentNames} from "../../script/SetupAgentNames.s.sol";
import {CuratorRegistry} from "../../src/CuratorRegistry.sol";
import {IEnsV2StandardRegistry} from "../../src/interfaces/external/ens/IEnsV2Subregistry.sol";
import {VaradaNamesV2ForkTest} from "./VaradaNamesV2.t.sol";

/// @notice The curator agents' names on ENSv2, on top of the whole varada.eth tree
///         (`VaradaNamesV2ForkTest`: Deploy, varada.eth -> VaradaResolver, SetupOrgNames):
///         `SetupAgentNames` registers `agent` in the varada.eth registry and the twenty cause
///         names in the agent registry, all resolved by VaradaResolver. Every inherited assertion
///         (token subnames, varada.eth, the org branch, reserved labels) re-runs with the agent
///         names in place. Resolution goes through the Universal Resolver v2, which calls the
///         resolver with the full name. Skipped when ETH_RPC_URL is unset.
contract AgentNamesV2ForkTest is VaradaNamesV2ForkTest {
    SetupAgentNames.Result internal agents;
    address internal nameOwner;
    address internal reliefSigner = address(uint160(uint256(keccak256("relief signer"))));
    uint256 internal hungerId;
    address internal hungerVault;

    /// @dev The base `setUp` is not virtual, so each test sets the agents up first.
    function _setupAgents() internal {
        nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(PARENT_LABEL_ID));
        CuratorRegistry curators = CuratorRegistry(d.curatorRegistry);
        if (Ownable(address(curators)).owner() != owner) {
            vm.prank(owner);
            Ownable2Step(address(curators)).acceptOwnership();
        }
        // `relief` runs disaster (bit 0) and hunger (bit 2) with one signer.
        vm.startPrank(owner);
        curators.registerAgent(0, "disaster", reliefSigner, "", "Disaster relief curator");
        (hungerId, hungerVault) =
            curators.registerAgent(2, "hunger", reliefSigner, "", "Hunger curator");
        vm.stopPrank();
        agents = new SetupAgentNames().execute(nameOwner, d.resolver);
    }

    function test_agentNamesAreOnEnsV2() public {
        _setupAgents();
        assertEq(agents.varadaRegistry, org.varadaRegistry, "reuses the varada.eth registry");
        assertEq(agents.causesRegistered, 20);
        IEnsV2StandardRegistry vr = IEnsV2StandardRegistry(org.varadaRegistry);
        assertEq(vr.getSubregistry("agent"), agents.agentRegistry);
        assertEq(vr.getResolver("agent"), d.resolver);
        IEnsV2StandardRegistry ar = IEnsV2StandardRegistry(agents.agentRegistry);
        uint256 tokenId = ar.getTokenId(uint256(keccak256("hunger")));
        assertEq(ar.ownerOf(tokenId), nameOwner, "an owned ENSv2 name");
        assertEq(ar.getResolver("hunger"), d.resolver);
        assertEq(_found("agent.varada.eth"), d.resolver);
        assertEq(_found("hunger.agent.varada.eth"), d.resolver);
        assertEq(_found("justice.agent.varada.eth"), d.resolver);
    }

    function test_agentResolvesThroughTheUniversalResolver() public {
        _setupAgents();
        assertEq(_addr("hunger.agent.varada.eth"), hungerVault, "the cause's vault");
        assertEq(_addr("agent.varada.eth"), d.curatorRegistry, "the agents index");
        string memory key = string.concat(
            "agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][",
            vm.toString(hungerId),
            "]"
        );
        assertEq(_text("hunger.agent.varada.eth", key), "1", "ENSIP-25");
        assertEq(_text("hunger.agent.varada.eth", "agent-endpoint[web]"), "https://hunger.agent.varada.eth.limo");
        assertEq(_text("hunger.agent.varada.eth", "agent-context"), "Hunger curator");
        assertEq(_text("hunger.agent.varada.eth", "description"), "Hunger curator");
        // Both causes of `relief` share its signer but keep their own vault and identity.
        assertTrue(_addr("disaster.agent.varada.eth") != hungerVault);
        // A cause not registered in CuratorRegistry yet answers empty records, never a token.
        assertEq(_addr("justice.agent.varada.eth"), address(0));
        // Token names still resolve as before.
        assertEq(_addr("pepe.varada.eth"), tokenAddr);
    }

    function test_rerunIsANoOp() public {
        _setupAgents();
        SetupAgentNames.Result memory again = new SetupAgentNames().execute(nameOwner, d.resolver);
        assertEq(again.agentRegistry, agents.agentRegistry);
        assertEq(again.causesRegistered, 0);
    }

    function test_refusesWithoutVaradaRegistryOrOwner() public {
        _setupAgents();
        SetupAgentNames s = new SetupAgentNames();
        vm.expectRevert();
        s.execute(address(0xBEEF), d.resolver);
    }
}
