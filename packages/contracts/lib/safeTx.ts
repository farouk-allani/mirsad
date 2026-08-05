import type { Signer } from "ethers";

/**
 * Safe transaction construction and EIP-712 signing.
 *
 * Shared by the test suite and the demo scripts so the two cannot drift — a
 * subtle difference between how tests sign and how the live demo signs would
 * be exactly the kind of bug that only shows up on stage.
 */

export const AddressZero = "0x0000000000000000000000000000000000000000";

export enum Operation {
  Call = 0,
  /** The one that drains treasuries. Bybit's loss was a delegatecall. */
  DelegateCall = 1,
}

/** Mirrors MirsadVerdictRegistry.Level. */
export enum Level {
  None = 0,
  Allow = 1,
  Warn = 2,
  Veto = 3,
}

export interface SafeTx {
  to: string;
  value: bigint;
  data: string;
  operation: Operation;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: string;
  refundReceiver: string;
  nonce: bigint;
}

export function safeTx(partial: Partial<SafeTx> & { to: string; nonce: bigint }): SafeTx {
  return {
    value: 0n,
    data: "0x",
    operation: Operation.Call,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: AddressZero,
    refundReceiver: AddressZero,
    ...partial,
  };
}

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/**
 * Produce the packed signature blob Safe expects: each owner's EIP-712
 * signature concatenated in ascending owner-address order. Safe verifies
 * signatures in that order and rejects anything else.
 */
export async function signSafeTx(
  safeAddress: string,
  chainId: bigint,
  tx: SafeTx,
  owners: Signer[],
): Promise<string> {
  const domain = { chainId, verifyingContract: safeAddress };
  const signed = await Promise.all(
    owners.map(async (owner) => ({
      addr: (await owner.getAddress()).toLowerCase(),
      sig: await owner.signTypedData(domain, SAFE_TX_TYPES as never, tx),
    })),
  );
  signed.sort((a, b) => (a.addr < b.addr ? -1 : 1));
  return "0x" + signed.map((s) => s.sig.slice(2)).join("");
}

/** Positional argument list for `Safe.execTransaction` / `getTransactionHash`. */
export function execArgs(tx: SafeTx) {
  return [
    tx.to, tx.value, tx.data, tx.operation,
    tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver,
  ] as const;
}
