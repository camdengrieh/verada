// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IEndaomentOrg} from "../interfaces/external/IEndaomentOrg.sol";
import {IEndaomentOrgFundFactory} from "../interfaces/external/IEndaomentOrgFundFactory.sol";
import {IEndaomentRegistry} from "../interfaces/external/IEndaomentRegistry.sol";

/// @title EndaomentDonateLib
/// @notice Donates USDC to an Endaoment org: `donate` on a deployed, active org, or
///         `deployOrgAndDonate` through the OrgFundFactory for an org that is not deployed yet.
/// @dev Same branches as `DonationDistributor.distribute`, kept as a library so the distributor's
///      bytecode is unchanged. Allowances are granted for exactly the donated amount and cleared
///      afterwards; the Endaoment fee is taken by Endaoment out of the gross amount sent.
///      Errors carry the same signatures as `IDonationDistributor` where those exist.
library EndaomentDonateLib {
    using SafeERC20 for IERC20;

    /// @notice The stored org address is not the factory's CREATE2 address for the org id, or a
    ///         deployment returned a different address.
    error OrgAddressMismatch(bytes32 orgId, address expected, address actual);
    /// @notice The Endaoment registry does not list the deployed org as an active entity.
    error OrgNotActive(address org);
    /// @notice The org has no code (only `deployAndDonate` can pay it).
    error OrgNotDeployed(address org);
    /// @notice An allowance to an Endaoment contract could not be cleared after the donation.
    error AllowanceNotCleared(address spender);

    /// @notice Reverts unless `org` is the factory's CREATE2 address for `orgId`.
    function checkOrgAddress(IEndaomentOrgFundFactory factory, bytes32 orgId, address org)
        internal
        view
    {
        address expected = factory.computeOrgAddress(orgId);
        if (expected != org) revert OrgAddressMismatch(orgId, expected, org);
    }

    /// @notice Donates `amount` USDC to a deployed org through `IEndaomentOrg.donate`.
    /// @dev Reverts `OrgNotActive` unless the registry lists the org as active.
    function donateDeployed(IERC20 usdc, IEndaomentRegistry registry, address org, uint256 amount)
        internal
    {
        if (!registry.isActiveEntity(org)) revert OrgNotActive(org);
        usdc.forceApprove(org, amount);
        IEndaomentOrg(org).donate(amount);
        _requireCleared(usdc, org);
    }

    /// @notice Deploys the org for `orgId` and donates `amount` USDC to it in the same call.
    /// @dev Reverts `OrgAddressMismatch` unless the deployed address equals `org`.
    function deployAndDonate(
        IERC20 usdc,
        IEndaomentOrgFundFactory factory,
        bytes32 orgId,
        address org,
        uint256 amount
    ) internal {
        usdc.forceApprove(address(factory), amount);
        address deployed = factory.deployOrgAndDonate(orgId, amount);
        if (deployed != org) revert OrgAddressMismatch(orgId, org, deployed);
        _requireCleared(usdc, address(factory));
    }

    /// @dev Both Endaoment entry points pull the exact approved amount, so the allowance is
    ///      already zero. If a changed implementation pulled less, clear the remainder.
    function _requireCleared(IERC20 usdc, address spender) private {
        if (usdc.allowance(address(this), spender) != 0) {
            usdc.forceApprove(spender, 0);
            if (usdc.allowance(address(this), spender) != 0) revert AllowanceNotCleared(spender);
        }
    }
}
