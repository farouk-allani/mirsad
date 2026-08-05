// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseGuard} from "@safe-global/safe-contracts/contracts/base/GuardManager.sol";
import {Enum} from "@safe-global/safe-contracts/contracts/common/Enum.sol";
import {MirsadVerdictRegistry} from "./MirsadVerdictRegistry.sol";

/// @dev Minimal view of the Safe we are guarding. Declared locally rather than
///      importing the full Safe to keep this contract's surface small.
interface ISafe {
    function nonce() external view returns (uint256);

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);
}

/**
 * @title MirsadGuard
 * @notice A Safe transaction guard that refuses to let a MIRSAD-vetoed
 *         transaction execute.
 *
 * Install once per Safe with `safe.setGuard(address(mirsadGuard))`. From then
 * on every `execTransaction` consults `MirsadVerdictRegistry`, and a vetoed
 * transaction reverts — **regardless of how many owners signed it.**
 *
 * That is the whole point. An alerting bot tells a treasury team that the
 * transaction they are about to sign is malicious, and is ignored at 3am. This
 * makes the chain itself refuse.
 *
 * @dev Fails open by design. If the registry has no verdict for a transaction
 *      — MIRSAD was down, or the transaction was queued and executed inside one
 *      polling interval — execution proceeds. A guard that failed closed would
 *      brick the treasury the moment our watcher went offline, which is a worse
 *      failure than the one we are preventing. `requireAssessment` can be
 *      enabled per-deployment by an operator who has decided otherwise.
 */
contract MirsadGuard is BaseGuard {
    MirsadVerdictRegistry public immutable registry;

    /// @notice When true, an unassessed transaction is also blocked (fail-closed).
    bool public requireAssessment;
    address public owner;

    event Vetoed(address indexed safe, bytes32 indexed safeTxHash);
    event RequireAssessmentSet(bool required);

    error MirsadVeto(bytes32 safeTxHash);
    error MirsadNotAssessed(bytes32 safeTxHash);
    error NotOwner();
    error ZeroAddress();

    constructor(MirsadVerdictRegistry registry_, address owner_) {
        if (address(registry_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        registry = registry_;
        owner = owner_;
    }

    /**
     * @dev Safe increments `nonce` *before* invoking the guard, so the nonce of
     *      the transaction being checked is `nonce() - 1`. Recomputing the hash
     *      from the parameters is necessary because Safe does not pass the hash
     *      to `checkTransaction`.
     */
    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory, // signatures — irrelevant to us; a veto outranks any signature set
        address // msgSender
    ) external override {
        bytes32 safeTxHash = ISafe(msg.sender).getTransactionHash(
            to,
            value,
            data,
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            ISafe(msg.sender).nonce() - 1
        );

        if (registry.isVetoed(safeTxHash)) {
            emit Vetoed(msg.sender, safeTxHash);
            revert MirsadVeto(safeTxHash);
        }

        if (requireAssessment) {
            MirsadVerdictRegistry.Verdict memory v = registry.verdictOf(safeTxHash);
            if (v.level == MirsadVerdictRegistry.Level.None) revert MirsadNotAssessed(safeTxHash);
        }
    }

    function checkAfterExecution(bytes32, bool) external override {}

    function setRequireAssessment(bool required) external {
        if (msg.sender != owner) revert NotOwner();
        requireAssessment = required;
        emit RequireAssessmentSet(required);
    }
}
