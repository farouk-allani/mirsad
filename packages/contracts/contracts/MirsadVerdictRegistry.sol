// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MirsadVerdictRegistry
 * @notice The onchain record of MIRSAD's judgement on a queued Safe transaction.
 *
 * MIRSAD watches a Safe's pending queue, simulates each queued transaction
 * before any human signs, and writes its verdict here. `MirsadGuard` reads this
 * registry inside `Safe.execTransaction` and reverts on a veto — so a vetoed
 * transaction cannot execute even if every owner signs it.
 *
 * This is the contract KeeperHub writes to. That write is MIRSAD's onchain
 * action: not a notification, a binding constraint on what the Safe will do.
 *
 * @dev Access control is a writer allowlist rather than a single immutable
 *      address. Verified on Sepolia 2026-08-05: a KeeperHub sponsored write
 *      arrives with `msg.sender` equal to the org wallet, because that wallet
 *      is an EOA carrying an EIP-7702 delegation and the relayer/forwarder
 *      preserve it. If the Safe Sender toggle is later enabled, writes route
 *      through `safe.execTransaction` and `msg.sender` becomes the Safe
 *      address instead. The allowlist covers both without a redeploy.
 */
contract MirsadVerdictRegistry {
    /// @notice Severity of a verdict. Ordered; only `Veto` blocks execution.
    enum Level {
        None, // 0 — never assessed
        Allow, // 1 — assessed, no findings
        Warn, // 2 — suspicious, surfaced to humans, does NOT block
        Veto // 3 — malicious, blocks execution via MirsadGuard
    }

    struct Verdict {
        Level level;
        /// @dev keccak256 of the full audit record (findings + model reasoning).
        ///      Keeps the reasoning verifiable offchain without paying to store it.
        bytes32 reasonHash;
        uint64 assessedAt;
        address writer;
    }

    /// @dev Keyed by Safe transaction hash, which is already domain-separated
    ///      per Safe and per chain, so one registry safely serves many Safes.
    mapping(bytes32 => Verdict) private _verdicts;

    mapping(address => bool) public isWriter;
    address public owner;

    event VerdictSet(
        bytes32 indexed safeTxHash,
        Level indexed level,
        bytes32 reasonHash,
        address indexed writer
    );
    event WriterSet(address indexed writer, bool allowed);
    event OwnerTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotWriter();
    error ZeroAddress();
    /// @dev A verdict is a factual record of an assessment; rewriting history
    ///      would let a compromised writer quietly un-veto an attack.
    error AlreadyAssessed(bytes32 safeTxHash);
    error InvalidLevel();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialWriter) {
        owner = msg.sender;
        emit OwnerTransferred(address(0), msg.sender);
        if (initialWriter != address(0)) {
            isWriter[initialWriter] = true;
            emit WriterSet(initialWriter, true);
        }
    }

    /**
     * @notice Record MIRSAD's assessment of a queued Safe transaction.
     * @param safeTxHash The Safe transaction hash, as returned by
     *        `Safe.getTransactionHash(...)` for the queued transaction.
     * @param level      Assessment outcome. `None` is not a valid input.
     * @param reasonHash keccak256 of the audit record backing this verdict.
     *
     * @dev Write-once per hash. Retrying an identical assessment is a no-op
     *      rather than a revert, so KeeperHub's idempotency-key retries and
     *      our own bounded-backoff replays are safe.
     */
    function setVerdict(bytes32 safeTxHash, Level level, bytes32 reasonHash) external {
        if (!isWriter[msg.sender]) revert NotWriter();
        if (level == Level.None) revert InvalidLevel();

        Verdict storage existing = _verdicts[safeTxHash];
        if (existing.level != Level.None) {
            // Idempotent replay of the same assessment: accept silently.
            if (existing.level == level && existing.reasonHash == reasonHash) return;
            revert AlreadyAssessed(safeTxHash);
        }

        _verdicts[safeTxHash] = Verdict({
            level: level,
            reasonHash: reasonHash,
            assessedAt: uint64(block.timestamp),
            writer: msg.sender
        });

        emit VerdictSet(safeTxHash, level, reasonHash, msg.sender);
    }

    /// @notice The single question `MirsadGuard` asks on every execution.
    function isVetoed(bytes32 safeTxHash) external view returns (bool) {
        return _verdicts[safeTxHash].level == Level.Veto;
    }

    /// @notice Full verdict record, for the audit-trail viewer and for humans.
    function verdictOf(bytes32 safeTxHash) external view returns (Verdict memory) {
        return _verdicts[safeTxHash];
    }

    function setWriter(address writer, bool allowed) external onlyOwner {
        if (writer == address(0)) revert ZeroAddress();
        isWriter[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }
}
