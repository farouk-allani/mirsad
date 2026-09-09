/**
 * What can happen when MIRSAD asks KeeperHub to execute an approved artifact.
 *
 * The distinction that matters most here is between "we know this did not
 * execute" and "we do not know whether this executed". Collapsing the second
 * into the first is how a retry becomes a second transaction, so `unconfirmed`
 * is a first-class outcome rather than an error string.
 *
 * Nothing in this union reports success on the strength of a request having
 * been accepted. Success requires a settled receipt.
 */

export interface LegReceipt {
  leg: string;
  executionId: string;
  status: string;
  transactionHash?: string;
  transactionLink?: string;
}

export type ExecutionOutcome =
  /** Every leg settled with a receipt. */
  | { kind: "executed"; legs: LegReceipt[] }
  /** The artifact does not hash to the value the decision published, or it expired. */
  | { kind: "artifact-invalid"; rule: string; message: string }
  /**
   * The request rebuilt on this run is not the request a previous run bound to
   * the idempotency key. Sending it would be refused as a conflict; rotating the
   * key to get past that is what broadcasts twice.
   */
  | { kind: "request-drift"; leg: string; expected: string; actual: string }
  /** KeeperHub's preflight says this reverts. Nothing was broadcast. */
  | { kind: "simulation-reverted"; leg: string; reason: string }
  /**
   * A definite refusal: the server rejected the request after a clean
   * preflight, or the transaction settled as failed. Retrying the same body
   * changes nothing, so this needs a person, not a backoff.
   */
  | { kind: "rejected"; leg: string; message: string; executionId?: string }
  /**
   * KeeperHub could not answer. Retryable, and never to be read as permission
   * to proceed: an unreachable preflight is not a clean preflight.
   */
  | { kind: "unavailable"; leg: string; message: string; retryAfterMs?: number }
  /**
   * Accepted but not settled. The transaction may or may not be onchain. Retry
   * under the same key; do not report success and do not act on the result.
   */
  | { kind: "unconfirmed"; leg: string; executionId: string; message: string };

/** A leg of an artifact, canonicalised into the body KeeperHub is sent. */
export interface ContractCallRequest {
  contract_address: string;
  chain_id: string;
  function_name: string;
  function_args: string;
  abi: string;
}
