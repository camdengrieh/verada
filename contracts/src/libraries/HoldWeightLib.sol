// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Vote checkpoint accessors of `ERC20TimestampVotes` (live tokens are `VaradaToken`s).
interface ICheckpointVotes {
    function numCheckpoints(address account) external view returns (uint32);
    function checkpoints(address account, uint32 pos)
        external
        view
        returns (uint48 key, uint208 value);
}

/// @title HoldWeightLib
/// @notice Hold weight shared by the governors: the lowest vote checkpoint an account had over a
///         window `[holdFrom, snapshot]`, in whole tokens.
/// @dev Every checkpoint inside the window is read, newest first; there is no cap. A cap would
///      let a holder hide a dip behind enough later checkpoints, and zeroing or rejecting a
///      capped scan would let anyone cancel a holder's vote, since a transfer to an account
///      writes a checkpoint (tokens self-delegate on receipt).
///
///      Extra checkpoints therefore only make a holder's scan longer: about 4.4k gas each, while
///      each one costs its sender a transfer at a distinct second (one per block at most). So
///      that no number of them can push a ballot past the block gas limit, anyone can run a
///      scan ahead in chunks (`advance`); its progress is cached per window. A window that ends
///      in the past never changes (new checkpoints are keyed at the current time), so the cache
///      stays valid.
library HoldWeightLib {
    /// @dev Cached progress of a window scan: the lowest value read so far, how many checkpoints
    ///      are still unread (the next one read is `next - 1`), and the scan state.
    struct Scan {
        uint208 low;
        uint32 next;
        bool started;
        bool done;
    }

    /// @dev `advance` on a window whose snapshot is not yet in the past.
    error HoldWindowOpen(uint256 snapshot);

    /// @dev Lowest vote checkpoint of `account` over `[holdFrom, snapshot]` in whole tokens,
    ///      capped to 64 bits; zero while `snapshot` is not in the past, or when the account had
    ///      no votes at `holdFrom`. A `holdFrom` at or after `snapshot` reads `snapshot` alone.
    ///      Resumes from the progress cached by `advance`, then reads the rest.
    function lowest(
        mapping(bytes32 => Scan) storage scans,
        address token,
        address account,
        uint256 holdFrom,
        uint256 snapshot
    ) internal view returns (uint64) {
        // forge-lint: disable-next-line(block-timestamp)
        if (snapshot >= block.timestamp) return 0;
        (, Scan memory s) =
            _resume(scans, token, account, holdFrom, snapshot, type(uint256).max);
        uint256 whole = uint256(s.low) / 1e18;
        // Capped just below, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return whole > type(uint64).max ? type(uint64).max : uint64(whole);
    }

    /// @dev Reads at most `maxReads` more checkpoints of the window and caches the progress.
    ///      Returns whether the scan is complete.
    function advance(
        mapping(bytes32 => Scan) storage scans,
        address token,
        address account,
        uint256 holdFrom,
        uint256 snapshot,
        uint256 maxReads
    ) internal returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        if (snapshot >= block.timestamp) revert HoldWindowOpen(snapshot);
        (bytes32 key, Scan memory s) =
            _resume(scans, token, account, holdFrom, snapshot, maxReads);
        scans[key] = s;
        return s.done;
    }

    /// @dev The cached scan of the window, continued by at most `maxReads` reads. One call site
    ///      for the scan, so it is compiled once.
    function _resume(
        mapping(bytes32 => Scan) storage scans,
        address token,
        address account,
        uint256 holdFrom,
        uint256 snapshot,
        uint256 maxReads
    ) private view returns (bytes32 key, Scan memory s) {
        key = keccak256(abi.encode(token, account, holdFrom, snapshot));
        s = scans[key];
        _scan(s, token, account, holdFrom, snapshot, maxReads);
    }

    /// @dev Continues `s` by at most `maxReads` checkpoint reads, newest first, down to and
    ///      including the checkpoint in effect at `holdFrom`.
    function _scan(
        Scan memory s,
        address token,
        address account,
        uint256 holdFrom,
        uint256 snapshot,
        uint256 maxReads
    ) private view {
        if (s.done) return;
        ICheckpointVotes cv = ICheckpointVotes(token);
        uint256 i;
        uint256 low;
        if (s.started) {
            i = s.next;
            low = s.low;
        } else {
            // Index one past the last checkpoint with `key <= snapshot`.
            uint256 hi = cv.numCheckpoints(account);
            while (i < hi) {
                uint256 mid = (i + hi) / 2;
                (uint48 k,) = cv.checkpoints(account, uint32(mid));
                if (k > snapshot) hi = mid;
                else i = mid + 1;
            }
            low = type(uint208).max;
        }
        bool done;
        for (uint256 reads; reads < maxReads; ++reads) {
            // No checkpoint at or before `holdFrom`: no votes at the window's start.
            if (i == 0) {
                low = 0;
                done = true;
                break;
            }
            --i;
            (uint48 key, uint208 value) = cv.checkpoints(account, uint32(i));
            if (value < low) low = value;
            if (low == 0 || key <= holdFrom) {
                done = true;
                break;
            }
        }
        // `low` is a checkpoint value or the uint208 maximum, and `i` a checkpoint index.
        // forge-lint: disable-next-line(unsafe-typecast)
        s.low = uint208(low);
        // forge-lint: disable-next-line(unsafe-typecast)
        s.next = uint32(i);
        s.started = true;
        s.done = done;
    }
}
