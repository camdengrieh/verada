// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VaradaOrgResolver} from "../src/VaradaOrgResolver.sol";
import {IEndaomentOrgFundFactory} from "../src/interfaces/external/IEndaomentOrgFundFactory.sol";
import {
    EnsV2Roles,
    IEnsV2StandardRegistry,
    IEnsV2UserRegistryInit,
    IEnsVerifiableFactory
} from "../src/interfaces/external/ens/IEnsV2Subregistry.sol";
import {IGatewayVerifier} from "../src/vendor/unruggable/IGatewayVerifier.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @title SetupOrgNames
/// @notice Puts `<label>.org.varada.eth` on ENSv2 for every Endaoment org in the catalogue:
///           1. deploys `VaradaOrgResolver` (unless ORG_RESOLVER is given)
///           2. deploys a `UserRegistry` for `varada.eth` and makes it the name's subregistry
///           3. deploys a `UserRegistry` for `org.varada.eth`, which holds claimed org names
///           4. registers `org` in the varada.eth registry with that subregistry and the resolver
///         The Universal Resolver then finds `org`'s resolver for every `<label>.org.varada.eth`
///         that has no token of its own. Labels outside `org` are not in the varada.eth registry,
///         so they keep falling through to varada.eth's own resolver.
///         Every step checks state first and is skipped when already done, so reruns are safe.
/// @dev Environment for `run()`:
///        ORG_NAMES_ROOT    names Merkle root (required when deploying the resolver)
///        ORG_GATEWAY_URLS  comma-separated EIP-3668 URL templates for the Merkle fallback
///                          (default https://org.varada.eth.limo/ccip/{data}.json, i.e. Swarm)
///        ORG_NAMESPACE_CONTENTHASH  contenthash for org.varada.eth (ENSIP-7, Swarm) to set
///        ORG_L2_FALLBACK_URL  last Optimism URL, the static `l2-fallback.json?d={data}` (default via
///                          org.varada.eth.limo; set the content-addressed gateway URL instead)
///        ORG_SITE_PREFIX   prefix for the `url` text record (default https://varada.eth.limo/causes?org=)
///        ORG_NAMES_SHARD_BITS  shard bits the names root was built with (default 12, the
///                          catalogue's `namesShardBits`)
///        ORG_L2_REGISTRY   VaradaOrgNames on Optimism (required when deploying the resolver)
///        ORG_L2_GATEWAY_URLS  comma-separated Optimism proof gateways. Put our gateway's
///                          `https://<host>/l2/{sender}/{data}.json` first: it proxies the public
///                          ones with a 3 s budget and answers "0x" (Merkle fallback) when they
///                          are down. Default: the public Unruggable gateways only.
///        ORG_RESOLVER      an already deployed VaradaOrgResolver (optional)
///        ENS_OWNER         signer (default: the registry's current owner of varada.eth)
///      Simulate:   forge script script/SetupOrgNames.s.sol --rpc-url $ETH_RPC_URL
///      Send:       add --broadcast and --ledger (or --account / --private-key)
contract SetupOrgNames is Script {
    IEnsV2StandardRegistry internal constant ETH_REGISTRY =
        IEnsV2StandardRegistry(0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2);
    IEnsVerifiableFactory internal constant VERIFIABLE_FACTORY =
        IEnsVerifiableFactory(0x77510ba162dfeA3d8989E3f0928a691B345730D2);
    address internal constant USER_REGISTRY_IMPL = 0xFAA23592ACA10A6d8875b18eA86954e8EB6d8d72;
    /// @dev Unruggable's Optimism fault-proof verifier, the one ENS's Optimism reverse resolver
    ///      (0xF9Ed…F107) uses.
    IGatewayVerifier internal constant OP_VERIFIER =
        IGatewayVerifier(0x7F49A74D264e48E64e76E136b2a4BA1310C3604c);
    IEndaomentOrgFundFactory internal constant ENDAOMENT_FACTORY =
        IEndaomentOrgFundFactory(0x10fD9348136dCea154F752fe0B6dB45Fc298A589);

    string internal constant PARENT_LABEL = "varada";
    string internal constant NAMESPACE_LABEL = "org";
    /// @dev DNS wire format of `org.varada.eth`.
    bytes internal constant NAMESPACE_DNS_NAME = hex"036f7267067661726164610365746800";
    /// @dev No per-charity page yet: the causes explorer, with the label as a hint for later pages.
    uint8 internal constant DEFAULT_SHARD_BITS = 12;
    /// @dev The Merkle fallback served from Swarm through org.varada.eth's own contenthash.
    string internal constant DEFAULT_MERKLE_URL = "https://org.varada.eth.limo/ccip/{data}.json";
    /// @dev Last-resort Optimism "proof" (always 0x): a static file in the same Swarm collection.
    string internal constant SWARM_L2_FALLBACK_URL =
        "https://org.varada.eth.limo/l2-fallback.json?d={data}";
    string internal constant DEFAULT_SITE_PREFIX = "https://varada.eth.limo/causes?org=";

    /// @dev VerifiableFactory salts. The proxy address depends on the signer and the salt.
    uint256 internal constant VARADA_REGISTRY_SALT = uint256(keccak256("varada.eth/registry"));
    uint256 internal constant ORG_REGISTRY_SALT = uint256(keccak256("org.varada.eth/registry"));

    error NotMainnet(uint256 chainId);
    error NotOwner(address nameOwner, address signer);
    error Expired(uint64 expiry);
    error MissingEnv(string key);
    error ForeignSubregistry(address current);
    error NamespaceTaken(address resolver, address subregistry);

    struct Result {
        address resolver;
        address varadaRegistry;
        address orgRegistry;
    }

    function run() external returns (Result memory) {
        address nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(parentId()));
        address signer = vm.envOr("ENS_OWNER", nameOwner);
        address resolver = vm.envOr("ORG_RESOLVER", address(0));
        bytes32 root;
        string[] memory urls;
        if (resolver == address(0)) {
            root = vm.envOr("ORG_NAMES_ROOT", bytes32(0));
            if (root == bytes32(0)) revert MissingEnv("ORG_NAMES_ROOT");
            urls = vm.envOr("ORG_GATEWAY_URLS", ",", new string[](0));
            if (urls.length == 0) {
                urls = new string[](1);
                urls[0] = DEFAULT_MERKLE_URL;
            }
        }
        string memory prefix = vm.envOr("ORG_SITE_PREFIX", string(DEFAULT_SITE_PREFIX));
        address l2Registry = vm.envOr("ORG_L2_REGISTRY", address(0));
        if (resolver == address(0) && l2Registry == address(0)) {
            revert MissingEnv("ORG_L2_REGISTRY");
        }
        _l2FallbackUrl = vm.envOr("ORG_L2_FALLBACK_URL", string(SWARM_L2_FALLBACK_URL));
        string[] memory l2Urls = vm.envOr("ORG_L2_GATEWAY_URLS", ",", new string[](0));
        for (uint256 i; i < l2Urls.length; ++i) {
            _l2UrlsEnv.push(l2Urls[i]);
        }
        uint8 bits = uint8(vm.envOr("ORG_NAMES_SHARD_BITS", uint256(DEFAULT_SHARD_BITS)));
        Result memory r = execute(signer, resolver, root, bits, urls, prefix, l2Registry);
        // Point org.varada.eth at the Swarm upload of the fallback shards (the Merkle URL above).
        bytes memory ch = vm.envOr("ORG_NAMESPACE_CONTENTHASH", bytes(""));
        if (
            ch.length != 0
                && keccak256(VaradaOrgResolver(r.resolver).namespaceContenthash()) != keccak256(ch)
        ) {
            vm.startBroadcast(signer);
            VaradaOrgResolver(r.resolver).setNamespaceContenthash(ch);
            vm.stopBroadcast();
            console.log("org.varada.eth contenthash set");
        }
        return r;
    }

    /// @notice Unruggable Optimism gateways (ENS's reverse resolver lists the last two).
    /// @dev Set by `run()` from ORG_L2_GATEWAY_URLS.
    string[] internal _l2UrlsEnv;
    /// @dev Last-resort Optimism URL; `run()` overrides it with ORG_L2_FALLBACK_URL. Prefer a
    ///      content-addressed Swarm gateway URL (https://api.gateway.ethswarm.org/bzz/<ref>/...):
    ///      under EIP-3668 a client may stop at a 4xx, so the last-resort URL must not depend on
    ///      a gateway resolving org.varada.eth.
    string internal _l2FallbackUrl = SWARM_L2_FALLBACK_URL;

    /// @notice Optimism proof gateways in order: ORG_L2_GATEWAY_URLS (our /l2 proxy first), else
    ///         the public Unruggable ones; the Swarm `l2-fallback.json` always comes last so a
    ///         lookup reaches the Merkle fallback when every proof gateway is down.
    function l2GatewayUrls() public view returns (string[] memory u) {
        string[] memory head = _l2UrlsEnv.length != 0 ? _l2UrlsEnv : opGatewayUrls();
        u = new string[](head.length + 1);
        for (uint256 i; i < head.length; ++i) {
            u[i] = head[i];
        }
        u[head.length] = _l2FallbackUrl;
    }

    function opGatewayUrls() public pure returns (string[] memory u) {
        u = new string[](3);
        u[0] = "https://optimism.gateway.unruggable.com";
        u[1] = "https://lb.drpc.org/gateway/unruggable?network=optimism";
        u[2] = "https://optimism.3668.io";
    }

    function parentId() public pure returns (uint256) {
        return uint256(keccak256(bytes(PARENT_LABEL)));
    }

    function namespaceId() public pure returns (uint256) {
        return uint256(keccak256(bytes(NAMESPACE_LABEL)));
    }

    /// @notice Root roles the signer keeps on both registries.
    function registryRootRoles() public pure returns (uint256) {
        return EnsV2Roles.withAdmin(
            EnsV2Roles.ROLE_REGISTRAR | EnsV2Roles.ROLE_REGISTER_RESERVED
                | EnsV2Roles.ROLE_SET_PARENT | EnsV2Roles.ROLE_UNREGISTER | EnsV2Roles.ROLE_RENEW
                | EnsV2Roles.ROLE_SET_SUBREGISTRY | EnsV2Roles.ROLE_SET_RESOLVER
                | EnsV2Roles.ROLE_UPGRADE
        );
    }

    /// @notice Roles on the `org` token, so the owner can repoint its resolver and subregistry.
    function namespaceTokenRoles() public pure returns (uint256) {
        return EnsV2Roles.withAdmin(
            EnsV2Roles.ROLE_SET_RESOLVER | EnsV2Roles.ROLE_SET_SUBREGISTRY | EnsV2Roles.ROLE_RENEW
        ) | EnsV2Roles.ROLE_CAN_TRANSFER_ADMIN;
    }

    function execute(
        address signer,
        address resolver,
        bytes32 root,
        uint8 shardBits,
        string[] memory urls,
        string memory prefix,
        address l2Registry
    ) public returns (Result memory r) {
        if (block.chainid != 1) revert NotMainnet(block.chainid);
        uint256 pid = parentId();
        address nameOwner = ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(pid));
        if (signer != nameOwner) revert NotOwner(nameOwner, signer);
        uint64 expiry = ETH_REGISTRY.getExpiry(pid);
        if (expiry <= block.timestamp) revert Expired(expiry);

        vm.startBroadcast(signer);

        // 1. Resolver.
        if (resolver == address(0)) {
            resolver = address(
                new VaradaOrgResolver(
                    signer,
                    ENDAOMENT_FACTORY,
                    NAMESPACE_DNS_NAME,
                    root,
                    shardBits,
                    urls,
                    prefix,
                    l2Registry,
                    OP_VERIFIER,
                    l2GatewayUrls()
                )
            );
            console.log("deployed VaradaOrgResolver", resolver);
        }
        r.resolver = resolver;

        // 2. varada.eth subregistry.
        address predictedVarada =
            VERIFIABLE_FACTORY.predictProxyAddress(signer, VARADA_REGISTRY_SALT);
        address current = ETH_REGISTRY.getSubregistry(PARENT_LABEL);
        if (current == address(0)) {
            r.varadaRegistry = _deployRegistry(signer, VARADA_REGISTRY_SALT, predictedVarada);
            ETH_REGISTRY.setSubregistry(pid, r.varadaRegistry);
            IEnsV2StandardRegistry(r.varadaRegistry).setParent(address(ETH_REGISTRY), PARENT_LABEL);
            console.log("varada.eth subregistry   ", r.varadaRegistry);
        } else if (current == predictedVarada) {
            r.varadaRegistry = current;
        } else {
            revert ForeignSubregistry(current);
        }

        // 3. org.varada.eth subregistry (claimed names).
        r.orgRegistry = VERIFIABLE_FACTORY.predictProxyAddress(signer, ORG_REGISTRY_SALT);
        if (r.orgRegistry.code.length == 0) {
            _deployRegistry(signer, ORG_REGISTRY_SALT, r.orgRegistry);
            IEnsV2StandardRegistry(r.orgRegistry).setParent(r.varadaRegistry, NAMESPACE_LABEL);
            console.log("org.varada.eth registry  ", r.orgRegistry);
        }

        // 4. `org` entry: subregistry for claimed names, wildcard resolver for the rest.
        IEnsV2StandardRegistry vr = IEnsV2StandardRegistry(r.varadaRegistry);
        address nsResolver = vr.getResolver(NAMESPACE_LABEL);
        address nsRegistry = vr.getSubregistry(NAMESPACE_LABEL);
        if (nsResolver == address(0) && nsRegistry == address(0)) {
            vr.register(
                NAMESPACE_LABEL,
                signer,
                r.orgRegistry,
                resolver,
                namespaceTokenRoles(),
                type(uint64).max
            );
            console.log("registered org.varada.eth");
        } else if (nsResolver != resolver || nsRegistry != r.orgRegistry) {
            revert NamespaceTaken(nsResolver, nsRegistry);
        }

        vm.stopBroadcast();
    }

    function _deployRegistry(address signer, uint256 salt, address predicted)
        internal
        returns (address proxy)
    {
        IEnsV2UserRegistryInit.Grant[] memory grants = new IEnsV2UserRegistryInit.Grant[](1);
        grants[0] = IEnsV2UserRegistryInit.Grant(signer, registryRootRoles());
        proxy = VERIFIABLE_FACTORY.deployProxy(
            USER_REGISTRY_IMPL, salt, abi.encodeCall(IEnsV2UserRegistryInit.initialize, (grants))
        );
        require(proxy == predicted, "unexpected proxy address");
    }
}
