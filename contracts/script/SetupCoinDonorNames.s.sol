// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VaradaCoinResolver} from "../src/VaradaCoinResolver.sol";
import {VaradaDonorNames} from "../src/VaradaDonorNames.sol";
import {IExtendedResolver} from "../src/interfaces/external/ens/IEnsResolverProfiles.sol";
import {
    EnsV2Roles,
    IEnsV2StandardRegistry
} from "../src/interfaces/external/ens/IEnsV2Subregistry.sol";
import {DnsNameLib} from "../src/libraries/DnsNameLib.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

interface IProfileReservations {
    function owner() external view returns (address);
    function setReservation(bytes32 labelhash, bool reserved, address allowedCreator) external;
    function reservationOf(bytes32 labelhash)
        external
        view
        returns (bool reserved, address allowedCreator);
}

/// @title SetupCoinDonorNames
/// @notice `<label>.coin.varada.eth` for every coin and `<name>.donor.varada.eth` for donors, on the
///         ENSv2 registry that SetupOrgNames gave varada.eth:
///           1. deploys VaradaCoinResolver (an alias onto varada.eth's VaradaResolver) and
///              VaradaDonorNames (a first-come donor name registry that is also their resolver)
///           2. registers `coin` and `donor` in the varada.eth registry with those resolvers
///           3. reserves `coin`, `donor`, `endaoment` and `varada` in the TokenProfileRegistry
///         Each step checks state first and is skipped when already done.
///         varada.eth's own resolver is never changed.
/// @dev Environment:
///        PROFILE_REGISTRY   TokenProfileRegistry (default: `profileRegistry` in deployments/1.json)
///        ENS_OWNER          signer (default: the registry's owner of varada.eth)
///      Simulate:   forge script script/SetupCoinDonorNames.s.sol --rpc-url $ETH_RPC_URL
///      Send:       add --broadcast and a wallet
contract SetupCoinDonorNames is Script {
    IEnsV2StandardRegistry internal constant ETH_REGISTRY =
        IEnsV2StandardRegistry(0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2);

    error NotMainnet(uint256 chainId);
    error NotOwner(address nameOwner, address signer);
    error NoSubregistry();
    error NoParentResolver();
    error LabelTaken(string label, address resolver);
    error NotProfileOwner(address owner, address signer);

    struct Result {
        address coinResolver;
        address donorNames;
        address varadaRegistry;
    }

    function run() external returns (Result memory) {
        address nameOwner =
            ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(uint256(keccak256("varada"))));
        address signer = vm.envOr("ENS_OWNER", nameOwner);
        address profiles = vm.envOr("PROFILE_REGISTRY", address(0));
        if (profiles == address(0)) {
            string memory json =
                vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
            profiles = vm.parseJsonAddress(json, ".profileRegistry");
        }
        return execute(signer, profiles);
    }

    function reservedDonorLabels() public pure returns (string[] memory r) {
        r = new string[](10);
        r[0] = "org";
        r[1] = "coin";
        r[2] = "donor";
        r[3] = "agent";
        r[4] = "names";
        r[5] = "varada";
        r[6] = "endaoment";
        r[7] = "admin";
        r[8] = "www";
        r[9] = "api";
    }

    function namespaceTokenRoles() public pure returns (uint256) {
        return EnsV2Roles.withAdmin(
            EnsV2Roles.ROLE_SET_RESOLVER | EnsV2Roles.ROLE_SET_SUBREGISTRY | EnsV2Roles.ROLE_RENEW
        ) | EnsV2Roles.ROLE_CAN_TRANSFER_ADMIN;
    }

    function execute(address signer, address profiles) public returns (Result memory r) {
        if (block.chainid != 1) revert NotMainnet(block.chainid);
        address nameOwner =
            ETH_REGISTRY.ownerOf(ETH_REGISTRY.getTokenId(uint256(keccak256("varada"))));
        if (signer != nameOwner) revert NotOwner(nameOwner, signer);
        r.varadaRegistry = ETH_REGISTRY.getSubregistry("varada");
        if (r.varadaRegistry == address(0)) revert NoSubregistry();
        address parentResolver = ETH_REGISTRY.getResolver("varada");
        if (parentResolver == address(0)) revert NoParentResolver();
        IEnsV2StandardRegistry vr = IEnsV2StandardRegistry(r.varadaRegistry);
        IProfileReservations pr = IProfileReservations(profiles);
        if (pr.owner() != signer) revert NotProfileOwner(pr.owner(), signer);

        vm.startBroadcast(signer);

        // `coin`: alias onto varada.eth's resolver.
        r.coinResolver = vr.getResolver("coin");
        if (r.coinResolver == address(0)) {
            r.coinResolver = address(
                new VaradaCoinResolver(
                    IExtendedResolver(parentResolver),
                    DnsNameLib.encode("coin.varada.eth"),
                    DnsNameLib.encode("varada.eth")
                )
            );
            vr.register(
                "coin", signer, address(0), r.coinResolver, namespaceTokenRoles(), type(uint64).max
            );
            console.log("coin.varada.eth  -> VaradaCoinResolver", r.coinResolver);
        }

        // `donor`: first-come names, resolved by the registry itself.
        r.donorNames = vr.getResolver("donor");
        if (r.donorNames == address(0)) {
            bytes memory dns = DnsNameLib.encode("donor.varada.eth");
            r.donorNames = address(
                new VaradaDonorNames(
                    signer, dns, DnsNameLib.namehash(dns, 0), reservedDonorLabels()
                )
            );
            vr.register(
                "donor", signer, address(0), r.donorNames, namespaceTokenRoles(), type(uint64).max
            );
            console.log("donor.varada.eth -> VaradaDonorNames ", r.donorNames);
        }

        // No coin may take these labels (org, names and agent are reserved by Deploy); matches the
        // wizard's client-side list.
        string[4] memory labels = ["coin", "donor", "endaoment", "varada"];
        for (uint256 i; i < 4; ++i) {
            bytes32 lh = keccak256(bytes(labels[i]));
            (bool reserved,) = pr.reservationOf(lh);
            if (!reserved) {
                pr.setReservation(lh, true, address(0));
                console.log("reserved coin label", labels[i]);
            }
        }

        vm.stopBroadcast();
    }
}
