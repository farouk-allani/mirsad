/**
 * The P0 protocol pack: supplying USDC to Aave V3 on Base.
 *
 * Addresses are pinned here rather than resolved at runtime. A policy that
 * looks its own contracts up over the network can be pointed at a different
 * contract by whatever answers the lookup, which is most of the point of
 * naming them.
 *
 * Every address below was taken from aave-dao/aave-address-book and, for the
 * Pool, cross-checked against KeeperHub's own `protocols/aave-v3.ts`, which
 * carries the same two values. Two independent sources rather than one, because
 * a wrong Pool address is the failure this pack exists to prevent.
 *
 * Note that Base Sepolia's "USDC" is Aave's own test token, not Circle's
 * `0x036CbD53…` bridged USDC. They are different contracts and the Aave market
 * only accepts the former; substituting the familiar one produces a supply that
 * reverts for reasons that look like a permissions problem.
 */

import type { Policy } from "../schema.js";

export const AAVE_V3_MARKETS = {
  8453: {
    label: "Base",
    pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    /** Not called directly; read after execution to confirm the position moved. */
    aUsdc: "0x4e65fe4dba92790696d040ac24aa414708f5c0ab",
    /** Mainnet USDC has to be bought. There is no faucet. */
    faucet: null,
  },
  84532: {
    label: "Base Sepolia",
    pool: "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27",
    usdc: "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f",
    aUsdc: "0x10f1a9d11cdf50041f3f8cb7191cbe2f31750acc",
    /**
     * Aave's testnet faucet, and the owner of the test token above. Its
     * `mint(token, to, amount)` is callable by anyone for anyone, so the
     * KeeperHub wallet can fund itself through the same execution path the
     * demo uses. No external faucet UI, and no wallet to connect.
     */
    faucet: "0xd9145b5f45ad4519c7accd6e0a4a82e83bb8a6dc",
  },
} as const;

export type AaveChainId = keyof typeof AAVE_V3_MARKETS;

export const USDC_DECIMALS = 6;

/** One USDC, in base units. Amounts never travel as human decimals. */
export const ONE_USDC = "1000000";

export function aaveMarket(chainId: AaveChainId) {
  return AAVE_V3_MARKETS[chainId];
}

export function isAaveChainId(value: number): value is AaveChainId {
  return value in AAVE_V3_MARKETS;
}

export interface AaveBasePolicyOptions {
  /** The KeeperHub organization wallet: signer, and the only permitted beneficiary. */
  actor: string;
  chainId: AaveChainId;
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
  const market = aaveMarket(options.chainId);
  return {
    schemaVersion: "mirsad.policy.v1",
    name: `aave-v3-supply-usdc-${options.chainId}`,
    chainId: options.chainId,
    actor: options.actor.toLowerCase() as `0x${string}`,
    allow: [
      {
        protocol: "aave-v3",
        action: "supply",
        target: market.pool,
        token: market.usdc,
      },
    ],
    maxAmountBaseUnits: options.maxAmountBaseUnits ?? "5000000",
    maxObservationAgeSeconds: options.maxObservationAgeSeconds ?? 300,
    artifactTtlSeconds: options.artifactTtlSeconds ?? 120,
  };
}
