// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    EnsV2Roles,
    IEnsV2StandardRegistry,
    IEnsV2UserRegistryInit,
    IEnsVerifiableFactory
} from "../src/interfaces/external/ens/IEnsV2Subregistry.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @title SetupAgentNames
/// @notice Puts the curator agents' names on ENSv2:
///           1. deploys a `UserRegistry` for `agent.varada.eth` (VerifiableFactory, deterministic)
///           2. registers `agent` in the varada.eth registry, with that subregistry and
///              `VaradaResolver` as its resolver
///           3. registers each cause label (`hunger`, `water`, ...) in the agent registry as an
///              owned ENSv2 name with the same resolver
///         `VaradaResolver` answers `agent.varada.eth` (the agents index) and every
///         `<cause>.agent.varada.eth` (vault, url, description, ENSIP-25 `agent-registration`,
///         ENSIP-26 `agent-endpoint[web]` / `agent-context`) from `CuratorRegistry`. The Universal
///         Resolver v2 calls it with the full name, because the `agent` entry (or the cause's own
///         entry) is the deepest resolver on the path.
///         The varada.eth registry itself comes from `SetupOrgNames.s.sol` (run it first): this
///         script never deploys a second one and reverts when varada.eth has no subregistry.
///         Every step checks state first and is skipped when already done, so reruns are safe.
/// @dev Environment for `run()`:
///        AGENT_RESOLVER  the deployed VaradaResolver (`.resolver` in deployments/1.json)
///        ENS_OWNER       signer (default: the registry's current owner of varada.eth)
///      Simulate:   forge script script/SetupAgentNames.s.sol --rpc-url $ETH_RPC_URL
///      Send:       add --broadcast and --ledger (or --account / --private-key)
contract SetupAgentNames is Script {
    IEnsV2StandardRegistry internal constant ETH_REGISTRY =
        IEnsV2StandardRegistry(0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2);
    IEnsVerifiableFactory internal constant VERIFIABLE_FACTORY =
        IEnsVerifiableFactory(0x77510ba162dfeA3d8989E3f0928a691B345730D2);
    address internal constant USER_REGISTRY_IMPL = 0xFAA23592ACA10A6d8875b18eA86954e8EB6d8d72;

    string internal constant PARENT_LABEL = "varada";
    string internal constant AGENTS_LABEL = "agent";
    /// @dev VerifiableFactory salt; the proxy address depends on the signer and the salt.
    uint256 internal constant AGENT_REGISTRY_SALT = uint256(keccak256("agent.varada.eth/registry"));

    error NotMainnet(uint256 chainId);
    error NotOwner(address nameOwner, address signer);
    error Expired(uint64 expiry);
    error MissingEnv(string key);
    /// @dev varada.eth has no ENSv2 subregistry yet: run SetupOrgNames first.
    error NoVaradaRegistry();
    error AgentsTaken(address resolver, address subregistry);
    error CauseTaken(string label, address resolver, address subregistry);

    struct Result {
        address varadaRegistry;
        address agentRegistry;
        uint256 causesRegistered;
    }

    function run() external returns (Result memory) {
        address nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(parentId()));
        address signer = vm.envOr("ENS_OWNER", nameOwner);
        address resolver = vm.envOr("AGENT_RESOLVER", address(0));
        if (resolver == address(0)) revert MissingEnv("AGENT_RESOLVER");
        return execute(signer, resolver);
    }

    /// @notice The twenty cause labels (`ensLabel` in packages/sdk/src/agents.ts).
    function causeLabels() public pure returns (string[] memory l) {
        l = new string[](20);
        l[0] = "disaster";
        l[1] = "homeless";
        l[2] = "hunger";
        l[3] = "children";
        l[4] = "disease";
        l[5] = "cancer";
        l[6] = "wildlife";
        l[7] = "animals";
        l[8] = "environment";
        l[9] = "water";
        l[10] = "health";
        l[11] = "mental-health";
        l[12] = "research";
        l[13] = "education";
        l[14] = "refugees";
        l[15] = "human-rights";
        l[16] = "women";
        l[17] = "poverty";
        l[18] = "veterans";
        l[19] = "justice";
    }

    function parentId() public pure returns (uint256) {
        return uint256(keccak256(bytes(PARENT_LABEL)));
    }

    /// @notice Root roles the signer keeps on the agent registry (as SetupOrgNames does on its own).
    function registryRootRoles() public pure returns (uint256) {
        return EnsV2Roles.withAdmin(
            EnsV2Roles.ROLE_REGISTRAR | EnsV2Roles.ROLE_REGISTER_RESERVED
                | EnsV2Roles.ROLE_SET_PARENT | EnsV2Roles.ROLE_UNREGISTER | EnsV2Roles.ROLE_RENEW
                | EnsV2Roles.ROLE_SET_SUBREGISTRY | EnsV2Roles.ROLE_SET_RESOLVER
                | EnsV2Roles.ROLE_UPGRADE
        );
    }

    /// @notice Roles on the `agent` token, so the owner can repoint its resolver and subregistry.
    function agentsTokenRoles() public pure returns (uint256) {
        return EnsV2Roles.withAdmin(
            EnsV2Roles.ROLE_SET_RESOLVER | EnsV2Roles.ROLE_SET_SUBREGISTRY | EnsV2Roles.ROLE_RENEW
        ) | EnsV2Roles.ROLE_CAN_TRANSFER_ADMIN;
    }

    /// @notice Roles on each cause token: repoint the resolver, renew, hand the name on later.
    function causeTokenRoles() public pure returns (uint256) {
        return EnsV2Roles.withAdmin(EnsV2Roles.ROLE_SET_RESOLVER | EnsV2Roles.ROLE_RENEW)
            | EnsV2Roles.ROLE_CAN_TRANSFER_ADMIN;
    }

    function execute(address signer, address resolver) public returns (Result memory r) {
        if (block.chainid != 1) revert NotMainnet(block.chainid);
        uint256 pid = parentId();
        address nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(pid));
        if (signer != nameOwner) revert NotOwner(nameOwner, signer);
        uint64 expiry = ETH_REGISTRY.getExpiry(pid);
        if (expiry <= block.timestamp) revert Expired(expiry);
        r.varadaRegistry = ETH_REGISTRY.getSubregistry(PARENT_LABEL);
        if (r.varadaRegistry == address(0)) revert NoVaradaRegistry();
        IEnsV2StandardRegistry vr = IEnsV2StandardRegistry(r.varadaRegistry);

        vm.startBroadcast(signer);

        // 1. agent.varada.eth registry (owned cause names).
        r.agentRegistry = VERIFIABLE_FACTORY.predictProxyAddress(signer, AGENT_REGISTRY_SALT);
        if (r.agentRegistry.code.length == 0) {
            IEnsV2UserRegistryInit.Grant[] memory grants = new IEnsV2UserRegistryInit.Grant[](1);
            grants[0] = IEnsV2UserRegistryInit.Grant(signer, registryRootRoles());
            address proxy = VERIFIABLE_FACTORY.deployProxy(
                USER_REGISTRY_IMPL,
                AGENT_REGISTRY_SALT,
                abi.encodeCall(IEnsV2UserRegistryInit.initialize, (grants))
            );
            require(proxy == r.agentRegistry, "unexpected proxy address");
            IEnsV2StandardRegistry(proxy).setParent(r.varadaRegistry, AGENTS_LABEL);
            console.log("agent.varada.eth registry", proxy);
        }

        // 2. `agent` entry: subregistry for the cause names, VaradaResolver for the rest.
        address aResolver = vr.getResolver(AGENTS_LABEL);
        address aRegistry = vr.getSubregistry(AGENTS_LABEL);
        if (aResolver == address(0) && aRegistry == address(0)) {
            vr.register(
                AGENTS_LABEL, signer, r.agentRegistry, resolver, agentsTokenRoles(), type(uint64).max
            );
            console.log("registered agent.varada.eth");
        } else if (aResolver != resolver || aRegistry != r.agentRegistry) {
            revert AgentsTaken(aResolver, aRegistry);
        }

        // 3. The twenty cause names, each resolved by VaradaResolver.
        IEnsV2StandardRegistry ar = IEnsV2StandardRegistry(r.agentRegistry);
        string[] memory labels = causeLabels();
        for (uint256 i; i < labels.length; ++i) {
            address cResolver = ar.getResolver(labels[i]);
            address cRegistry = ar.getSubregistry(labels[i]);
            if (cResolver == address(0) && cRegistry == address(0)) {
                ar.register(labels[i], signer, address(0), resolver, causeTokenRoles(), type(uint64).max);
                ++r.causesRegistered;
            } else if (cResolver != resolver || cRegistry != address(0)) {
                revert CauseTaken(labels[i], cResolver, cRegistry);
            }
        }
        console.log("cause names registered now", r.causesRegistered);

        vm.stopBroadcast();
    }
}
