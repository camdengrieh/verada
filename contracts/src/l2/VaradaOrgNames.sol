// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// OpenZeppelin v5.0.0 (MIT) from the pinned v4-core submodule: the repo's own OpenZeppelin
// (5.7) needs solc ^0.8.31 for ERC721, and this project compiles with 0.8.26. Both imports come
// from the same copy so `Context` is not declared twice.
import {
    Ownable,
    Ownable2Step
} from "../../lib/v4-core/lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import {
    ERC721
} from "../../lib/v4-core/lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";

/// @title VaradaOrgNames
/// @notice Registry of `<label>.org.varada.eth` on Optimism. Each name is an ERC-721 token
///         (`tokenId = uint256(labelhash)`) for one Endaoment org in the Varada cause catalogue.
///         The tokens are minted to a custody account and transferred to a charity when it claims
///         its Endaoment org. A token records which Endaoment org id the name points at on each
///         chain. `VaradaOrgResolver` on Ethereum reads these records with Unruggable storage
///         proofs, then computes the addresses with Endaoment's factory.
/// @dev The records sit at fixed storage slots so L1 proof requests do not depend on the
///      compiler's layout of inherited state:
///        defaultOrgId[labelhash]          at keccak256(abi.encode(labelhash, DEFAULT_IDS_SLOT))
///        chainOrgId[labelhash][chainId]   at keccak256(abi.encode(chainId,
///                                              keccak256(abi.encode(labelhash, CHAIN_IDS_SLOT))))
///      A chain override of zero means "use the default"; `NONE` means "no record on that chain".
///      Record updates are the registrars' job, because they follow the catalogue. Token owners
///      hold and transfer the names.
contract VaradaOrgNames is ERC721, Ownable2Step {
    /// @notice Base slot of `mapping(bytes32 labelhash => bytes32 orgId)`.
    bytes32 public constant DEFAULT_IDS_SLOT = keccak256("varada.orgnames.defaultOrgId");
    /// @notice Base slot of `mapping(bytes32 labelhash => mapping(uint256 chainId => bytes32))`.
    bytes32 public constant CHAIN_IDS_SLOT = keccak256("varada.orgnames.chainOrgId");
    /// @notice Chain override meaning the name has no record on that chain.
    bytes32 public constant NONE = bytes32(type(uint256).max);

    struct Registration {
        string label;
        bytes32 orgId;
    }

    struct ChainOverride {
        bytes32 labelhash;
        uint256 chainId;
        /// @dev Zero clears the override; `NONE` removes the chain.
        bytes32 orgId;
    }

    mapping(address => bool) public isRegistrar;
    string internal _baseTokenURI;

    event NameRegistered(bytes32 indexed labelhash, string label, bytes32 orgId, address owner);
    event DefaultOrgIdSet(bytes32 indexed labelhash, bytes32 orgId);
    event ChainOrgIdSet(bytes32 indexed labelhash, uint256 indexed chainId, bytes32 orgId);
    event RegistrarSet(address indexed account, bool enabled);
    event BaseURISet(string baseURI);

    error NotRegistrar(address account);
    error InvalidLabel(string label);
    error ZeroOrgId(bytes32 labelhash);
    error UnknownName(bytes32 labelhash);

    modifier onlyRegistrar() {
        if (!isRegistrar[msg.sender] && msg.sender != owner()) revert NotRegistrar(msg.sender);
        _;
    }

    constructor(address owner_, string memory baseURI_)
        ERC721("Varada org names", "VORG")
        Ownable(owner_)
    {
        _baseTokenURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    // ------------------------------------------------------------------ admin

    function setRegistrar(address account, bool enabled) external onlyOwner {
        isRegistrar[account] = enabled;
        emit RegistrarSet(account, enabled);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseTokenURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    // ------------------------------------------------------------------ registrar

    /// @notice Mints one name per registration to `to`. Reverts if any label is taken.
    function register(Registration[] calldata regs, address to) external onlyRegistrar {
        for (uint256 i; i < regs.length; ++i) {
            string calldata label = regs[i].label;
            uint256 len = bytes(label).length;
            if (len == 0 || len > 63) revert InvalidLabel(label);
            bytes32 lh = keccak256(bytes(label));
            bytes32 orgId = regs[i].orgId;
            if (orgId == bytes32(0)) revert ZeroOrgId(lh);
            _mint(to, uint256(lh));
            _sstore(_defaultSlot(lh), orgId);
            emit NameRegistered(lh, label, orgId, to);
        }
    }

    function setDefaultOrgId(bytes32 labelhash, bytes32 orgId) external onlyRegistrar {
        _requireName(labelhash);
        if (orgId == bytes32(0)) revert ZeroOrgId(labelhash);
        _sstore(_defaultSlot(labelhash), orgId);
        emit DefaultOrgIdSet(labelhash, orgId);
    }

    function setChainOrgIds(ChainOverride[] calldata overrides) external onlyRegistrar {
        for (uint256 i; i < overrides.length; ++i) {
            ChainOverride calldata o = overrides[i];
            _requireName(o.labelhash);
            _sstore(_chainSlot(o.labelhash, o.chainId), o.orgId);
            emit ChainOrgIdSet(o.labelhash, o.chainId, o.orgId);
        }
    }

    // ------------------------------------------------------------------ views

    function defaultOrgIdOf(bytes32 labelhash) external view returns (bytes32) {
        return _sload(_defaultSlot(labelhash));
    }

    /// @notice The raw override for `chainId` (zero: none, `NONE`: no record on that chain).
    function chainOverrideOf(bytes32 labelhash, uint256 chainId) external view returns (bytes32) {
        return _sload(_chainSlot(labelhash, chainId));
    }

    /// @notice The org id the name points at on `chainId`, or zero for no record.
    function orgIdOf(bytes32 labelhash, uint256 chainId) external view returns (bytes32) {
        bytes32 d = _sload(_defaultSlot(labelhash));
        if (d == bytes32(0)) return bytes32(0);
        bytes32 o = _sload(_chainSlot(labelhash, chainId));
        if (o == NONE) return bytes32(0);
        return o == bytes32(0) ? d : o;
    }

    function defaultSlot(bytes32 labelhash) external pure returns (bytes32) {
        return _defaultSlot(labelhash);
    }

    function chainSlot(bytes32 labelhash, uint256 chainId) external pure returns (bytes32) {
        return _chainSlot(labelhash, chainId);
    }

    // ------------------------------------------------------------------ internals

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function _requireName(bytes32 labelhash) internal view {
        if (_ownerOf(uint256(labelhash)) == address(0)) revert UnknownName(labelhash);
    }

    function _defaultSlot(bytes32 labelhash) internal pure returns (bytes32) {
        return keccak256(abi.encode(labelhash, DEFAULT_IDS_SLOT));
    }

    function _chainSlot(bytes32 labelhash, uint256 chainId) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, keccak256(abi.encode(labelhash, CHAIN_IDS_SLOT))));
    }

    function _sstore(bytes32 slot, bytes32 value) internal {
        assembly ("memory-safe") {
            sstore(slot, value)
        }
    }

    function _sload(bytes32 slot) internal view returns (bytes32 value) {
        assembly ("memory-safe") {
            value := sload(slot)
        }
    }
}
