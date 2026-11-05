// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title PollScopeLib
/// @notice Encodes the poll scope the rotation governor uses with its voting scheme, so rotation
///         polls and period-change proposals of the same token can never share a poll.
/// @dev Layout: the kind in the top byte (bits 248..255), the id in the low 64 bits, and zero in
///      between. Invariant: `decode(encode(kind, id)) == (kind, id)` for both kinds, and every
///      scope with another kind or dirty middle bits is rejected.
library PollScopeLib {
    /// @notice Scope kind of a rotation poll; the id is the target rotation.
    uint8 internal constant KIND_ROTATION = 1;
    /// @notice Scope kind of a period-change proposal; the id is the proposal id.
    uint8 internal constant KIND_PERIOD = 2;

    /// @notice The scope is not one this library produces.
    error InvalidScope(uint256 scope);

    /// @notice Scope of poll `id` of `kind`.
    function encode(uint8 kind, uint64 id) internal pure returns (uint256) {
        return (uint256(kind) << 248) | uint256(id);
    }

    /// @notice Kind and id of `scope`. Reverts `InvalidScope` for an unknown kind or set middle bits.
    function decode(uint256 scope) internal pure returns (uint8 kind, uint64 id) {
        // The top byte fits in 8 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        kind = uint8(scope >> 248);
        uint256 middle = (scope << 8) >> 72;
        if (middle != 0 || (kind != KIND_ROTATION && kind != KIND_PERIOD)) {
            revert InvalidScope(scope);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        id = uint64(scope);
    }
}
