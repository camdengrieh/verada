// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VaradaOrgNames} from "../src/l2/VaradaOrgNames.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

/// @title DeployOrgNamesOp
/// @notice Deploys `VaradaOrgNames` (the `<label>.org.varada.eth` registry) on Optimism and
///         optionally enables a registrar (the minting key). Next steps: mint with
///         `services/org-gateway/scripts/op-mint.ts`, then run `SetupOrgNames` on Ethereum with
///         ORG_L2_REGISTRY set to the address printed here.
/// @dev Environment:
///        ORG_NAMES_OWNER      owner of the registry (required)
///        ORG_NAMES_BASE_URI   token metadata base URI (default https://varada.eth.limo/org-token/)
///        ORG_NAMES_REGISTRAR  account allowed to mint and update records (optional)
///      Simulate:   forge script script/DeployOrgNamesOp.s.sol --rpc-url $OP_RPC_URL
///      Send:       add --broadcast and --ledger (or --account / --private-key)
///      When ORG_NAMES_REGISTRAR is set, the signer must be ORG_NAMES_OWNER.
contract DeployOrgNamesOp is Script {
    error NotOptimism(uint256 chainId);

    function run() external returns (VaradaOrgNames reg) {
        if (block.chainid != 10) revert NotOptimism(block.chainid);
        address owner = vm.envAddress("ORG_NAMES_OWNER");
        string memory baseURI =
            vm.envOr("ORG_NAMES_BASE_URI", string("https://varada.eth.limo/org-token/"));
        address registrar = vm.envOr("ORG_NAMES_REGISTRAR", address(0));

        vm.startBroadcast();
        reg = new VaradaOrgNames(owner, baseURI);
        if (registrar != address(0)) reg.setRegistrar(registrar, true);
        vm.stopBroadcast();

        console.log("VaradaOrgNames (Optimism)", address(reg));
        console.log("owner                    ", owner);
        if (registrar != address(0)) console.log("registrar                ", registrar);
    }
}
