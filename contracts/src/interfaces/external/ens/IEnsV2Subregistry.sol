// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev The slice of ENSv2 `IRegistry` / `IStandardRegistry` / `IPermissionedRegistry`
///      (github.com/ensdomains/contracts-v2, contracts/src/registry) that the org names need.
///      `anyId` is a labelhash, token id or resource.
interface IEnsV2StandardRegistry {
    function getSubregistry(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
    function getParent() external view returns (address parent, string memory label);

    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);

    function setSubregistry(uint256 anyId, address registry) external;
    function setResolver(uint256 anyId, address resolver) external;
    function setParent(address parent, string calldata label) external;

    function getTokenId(uint256 anyId) external view returns (uint256);
    function getExpiry(uint256 anyId) external view returns (uint64);
    function ownerOf(uint256 tokenId) external view returns (address);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
}

/// @dev ENSv2 `UserRegistry` proxy initializer as deployed on mainnet (UserRegistryImpl
///      0xfaa2…8d72, selector 0x37cb53a8): root roles granted per account. `main` on GitHub has
///      since moved to `initialize(address,uint256)`; mainnet has not.
interface IEnsV2UserRegistryInit {
    struct Grant {
        address account;
        uint256 roleBitmap;
    }

    function initialize(Grant[] calldata grants) external;
}

/// @dev ENS `VerifiableFactory` (github.com/ensdomains/verifiable-factory). The proxy address
///      depends on the caller and `salt`.
interface IEnsVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data)
        external
        returns (address proxy);

    function predictProxyAddress(address deployer, uint256 salt) external view returns (address);
}

/// @dev `RegistryRolesLib` role bits (contracts-v2). Admin roles are the role shifted by 128.
library EnsV2Roles {
    uint256 internal constant ROLE_REGISTRAR = 1 << 0;
    uint256 internal constant ROLE_REGISTER_RESERVED = 1 << 4;
    uint256 internal constant ROLE_SET_PARENT = 1 << 8;
    uint256 internal constant ROLE_UNREGISTER = 1 << 12;
    uint256 internal constant ROLE_RENEW = 1 << 16;
    uint256 internal constant ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 internal constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 internal constant ROLE_CAN_TRANSFER_ADMIN = (1 << 28) << 128;
    uint256 internal constant ROLE_UPGRADE = 1 << 124;

    function withAdmin(uint256 roles) internal pure returns (uint256) {
        return roles | (roles << 128);
    }
}
