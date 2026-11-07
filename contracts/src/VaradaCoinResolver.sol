// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IExtendedResolver} from "./interfaces/external/ens/IEnsResolverProfiles.sol";

/// @title VaradaCoinResolver
/// @notice ENSIP-10 resolver for `<label>.coin.varada.eth`, the coins' names. Every Varada coin is
///         registered in the TokenProfileRegistry under its label, which is unique, validated and
///         reserved-checked at launch, and `VaradaResolver` already answers `<label>.varada.eth`.
///         This resolver rewrites `<label>.coin.varada.eth` to `<label>.varada.eth` and returns
///         what `VaradaResolver` answers: the token address, its text records, logo and the site
///         contenthash. `coin.varada.eth` itself answers as `varada.eth`, which is the site.
/// @dev Stateless and ownerless, and set on the `coin` entry of varada.eth's ENSv2 registry.
///      Profile calls pass through unchanged. `VaradaResolver.resolve` dispatches on the name and
///      the call's arguments other than the node, so the node inside `data` needs no rewriting.
///      Names deeper than `<label>.coin.varada.eth`, and names outside it, are forwarded only after
///      the rewrite. They then fall under varada.eth's own rules, so `a.b.coin.varada.eth`
///      becomes `a.b.varada.eth`, which VaradaResolver treats as unknown.
contract VaradaCoinResolver is IExtendedResolver, IERC165 {
    /// @notice `VaradaResolver` (the varada.eth wildcard resolver).
    IExtendedResolver public immutable target;

    /// @dev DNS wire format of `coin.varada.eth` and of `varada.eth`.
    bytes32 internal immutable _aliasHash;
    uint256 internal immutable _aliasLength;
    bytes32 internal immutable _parentHash;
    uint256 internal immutable _parentLength;
    /// @dev Length of the alias label with its length byte (`\x04coin` = 5).
    uint256 internal immutable _aliasLabelLength;

    error InvalidDnsName(bytes name);
    error NotAChild(bytes aliasDnsName, bytes parentDnsName);

    /// @param target_ VaradaResolver.
    /// @param aliasDnsName `\x04coin\x06varada\x03eth\x00`.
    /// @param parentDnsName `\x06varada\x03eth\x00`.
    constructor(IExtendedResolver target_, bytes memory aliasDnsName, bytes memory parentDnsName) {
        target = target_;
        uint256 labelLength = uint8(aliasDnsName[0]) + 1;
        if (aliasDnsName.length != labelLength + parentDnsName.length) {
            revert NotAChild(aliasDnsName, parentDnsName);
        }
        bytes memory suffix = new bytes(parentDnsName.length);
        for (uint256 i; i < suffix.length; ++i) {
            suffix[i] = aliasDnsName[labelLength + i];
        }
        if (keccak256(suffix) != keccak256(parentDnsName)) {
            revert NotAChild(aliasDnsName, parentDnsName);
        }
        _aliasHash = keccak256(aliasDnsName);
        _aliasLength = aliasDnsName.length;
        _parentHash = keccak256(parentDnsName);
        _parentLength = parentDnsName.length;
        _aliasLabelLength = labelLength;
    }

    /// @inheritdoc IExtendedResolver
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory)
    {
        return target.resolve(toParentName(name), data);
    }

    /// @notice The name VaradaResolver is asked about: `<x>.coin.varada.eth` → `<x>.varada.eth`, and
    ///         `coin.varada.eth` → `varada.eth`. Names not under coin.varada.eth are returned as is.
    function toParentName(bytes calldata name) public view returns (bytes memory) {
        if (name.length == _aliasLength && keccak256(name) == _aliasHash) {
            return name[_aliasLabelLength:];
        }
        // Walk label boundaries so the suffix only ever matches whole labels.
        uint256 offset;
        while (offset < name.length) {
            uint256 len = uint8(name[offset]);
            if (len == 0) break;
            offset += 1 + len;
            if (offset >= name.length) revert InvalidDnsName(name);
            if (name.length - offset == _aliasLength && keccak256(name[offset:]) == _aliasHash) {
                // `<prefix>` + `coin.varada.eth` → `<prefix>` + `varada.eth`.
                return bytes.concat(name[:offset], name[offset + _aliasLabelLength:]);
            }
        }
        return name;
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId
            || interfaceId == type(IExtendedResolver).interfaceId;
    }
}
