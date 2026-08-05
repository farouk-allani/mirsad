/**
 * Core domain types for MIRSAD.
 *
 * Kept deliberately close to the wire formats we actually consume:
 * - `QueuedSafeTransaction` mirrors the Safe Transaction Service shape that
 *   KeeperHub's Safe plugin `Get Pending Transactions` action returns.
 * - `SimulationResult` mirrors KeeperHub's `simulate: true` preflight response.
 *
 * Anything not yet confirmed against a live response is marked TODO rather than
 * guessed at — see docs/FRICTION.md.
 */

/** Safe `operation` field. `DelegateCall` is the one that steals treasuries. */
export const SafeOperation = {
  Call: 0,
  DelegateCall: 1,
} as const;
export type SafeOperation = (typeof SafeOperation)[keyof typeof SafeOperation];

/** A transaction sitting in a Safe's queue, awaiting signatures. */
export interface QueuedSafeTransaction {
  safe: `0x${string}`;
  safeTxHash: `0x${string}`;
  to: `0x${string}`;
  value: string;
  data: `0x${string}` | null;
  operation: SafeOperation;
  nonce: number;
  confirmationsRequired: number;
  confirmations: Array<{ owner: `0x${string}` }>;
  /** Human-facing description, when the proposer supplied one. This is the claim we test the calldata against. */
  proposedBy?: `0x${string}`;
  submissionDate?: string;
}

/** Result of a KeeperHub preflight (`simulate: true`). */
export interface SimulationResult {
  success: boolean;
  wouldRevert: boolean;
  gasEstimate?: string;
  revertReason?: string;
  raw: unknown;
}

/**
 * Verdicts are ordered by severity. `Veto` is the only one that writes onchain.
 *
 * Deterministic rules alone may reach `Veto`; the model may not. The model can
 * raise to `Warn` and can supply reasoning that accompanies a rule-driven veto,
 * but an LLM is never the sole thing between a treasury and a drain.
 */
export const Verdict = {
  Allow: "ALLOW",
  Warn: "WARN",
  Veto: "VETO",
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

/** Why a verdict was reached. One per triggered detector. */
export interface Finding {
  /** Stable machine id, e.g. `delegatecall`, `owner-set-change`, `unknown-recipient`. */
  code: string;
  severity: Verdict;
  /** Deterministic rule, or model inference. Recorded so the audit trail can distinguish them. */
  source: "rule" | "model";
  summary: string;
  detail?: string;
}

/** The complete, replayable record of one transaction assessment. */
export interface AuditRecord {
  id: string;
  observedAt: string;
  transaction: QueuedSafeTransaction;
  simulation: SimulationResult | null;
  findings: Finding[];
  verdict: Verdict;
  /** KeeperHub execution id of the onchain response, when one was submitted. */
  executionId?: string;
  transactionLink?: string;
  gasUsed?: string;
  outcome?: "completed" | "failed";
}
