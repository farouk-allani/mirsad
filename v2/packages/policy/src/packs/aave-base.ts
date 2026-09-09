/**
 * The P0 protocol pack: supplying USDC to Aave V3 on Base.
 *
 * Addresses are pinned here rather than resolved at runtime. A policy that
 * looks its own contracts up over the network can be pointed at a different
 * contract by whatever answers the lookup, which defeats the point of naming
 * them. These were read from the live Base deployment during the capability
 * spike and cross-checked against aave-dao/aave-address-book.
 */

import type { Policy } from "../schema.js";

export const BASE_CHAIN_ID = 8453;

export const BASE_ADDRESSES = {
  aaveV3Pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  /** Not called directly; read after execution to confirm the position moved. */
  aUsdc: "0x4e65fe4dba92790696d040ac24aa414708f5c0ab",
} as const;

export const USDC_DECIMALS = 6;

export interface AaveBasePolicyOptions {
  /** The KeeperHub organization wallet: signer, and the only permitted beneficiary. */
  actor: string;
  /** Hard ceiling per supply, in USDC base units. Defaults to 5 USDC. */
  maxAmountBaseUnits?: string;
  maxObservationAgeSeconds?: number;
  artifactTtlSeconds?: number;
}

/**
 * Build the demo policy.
 *
 * The defaults are deliberately small. An artifact that lives for two minutes
 * cannot be replayed into a market that has moved, and a five-dollar ceiling
 * bounds what a bug in everything above this layer is able to cost.
 */
export function aaveBasePolicy(options: AaveBasePolicyOptions): Policy {
  return {
    schemaVersion: "mirsad.policy.v1",
    name: "aave-v3-supply-usdc-base",
    chainId: BASE_CHAIN_ID,
    actor: options.actor.toLowerCase() as `0x${string}`,
    allow: [
      {
        protocol: "aave-v3",
        action: "supply",
        target: BASE_ADDRESSES.aaveV3Pool,
        token: BASE_ADDRESSES.usdc,
      },
    ],
    maxAmountBaseUnits: options.maxAmountBaseUnits ?? "5000000",
    maxObservationAgeSeconds: options.maxObservationAgeSeconds ?? 300,
    artifactTtlSeconds: options.artifactTtlSeconds ?? 120,
  };
}
