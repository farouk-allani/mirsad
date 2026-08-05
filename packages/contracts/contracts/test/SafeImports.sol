// SPDX-License-Identifier: MIT
pragma solidity >=0.7.0 <0.9.0;

/**
 * Test-only. Hardhat compiles what is reachable from `contracts/`, and our
 * production contracts import only `GuardManager` and `Enum` from Safe. Pulling
 * the full Safe and its proxy factory in here gives the test suite artifacts to
 * deploy, so the guard is exercised against the real Safe v1.4.1 implementation
 * rather than a mock. Nothing here is deployed by `scripts/deploy.ts`.
 */
import {Safe} from "@safe-global/safe-contracts/contracts/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol";
