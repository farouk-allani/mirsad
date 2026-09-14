/**
 * Executing an approved artifact, and nothing else.
 *
 * The property this file exists to hold: the bytes KeeperHub is asked to
 * execute are derived from an artifact that hashes to the value the decision
 * published. Nothing between the policy engine and the wire can add a
 * recipient, widen an allowance or change a chain without the hash check
 * failing first.
 *
 * The ABIs live here rather than in the artifact. An ABI supplied by a planner
 * is a planner deciding what a function means, and `supply(address,uint256,
 * address,uint16)` with the arguments shuffled is a different transaction
 * wearing the same name.
 */

import { hashCanonical, verifyArtifact } from "@mirsad/policy";
import type { ApprovalArtifact, ArtifactCall } from "@mirsad/policy";

import type { Journal } from "./journal.js";
import { type Transport, TransportError } from "./transport.js";
import type { ContractCallRequest, ExecutionOutcome, LegReceipt } from "./types.js";

interface KnownFunction {
  inputs: Array<{ name: string; type: string }>;
  outputs: Array<{ name: string; type: string }>;
}

const KNOWN_FUNCTIONS: Record<string, KnownFunction> = {
  approve: {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  supply: {
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
};

function abiFor(functionName: string): string {
  const fn = KNOWN_FUNCTIONS[functionName];
  if (!fn) throw new Error(`no pinned ABI for ${functionName}`);
  return JSON.stringify([
    {
      type: "function",
      name: functionName,
      stateMutability: "nonpayable",
      inputs: fn.inputs,
      outputs: fn.outputs,
    },
  ]);
}

export function buildRequest(call: ArtifactCall, chainId: number): ContractCallRequest {
  return {
    contract_address: call.contract,
    chain_id: String(chainId),
    function_name: call.functionName,
    function_args: JSON.stringify(call.args),
    abi: abiFor(call.functionName),
  };
}

/**
 * The idempotency key is a pure function of the proposal and the policy.
 *
 * Not of the artifact: an artifact carries `issuedAt`, so a process that
 * crashes and decides the same proposal again would mint a new artifact, a
 * new hash and a new key, and its resume would be a second send. The intent
 * hash covers every argument that reaches the chain and the policy hash covers
 * every rule that shaped them, so the pair identifies the operation exactly.
 *
 * Same proposal under the same policy, same key, on any machine and after any
 * crash, without consulting stored state. KeeperHub's own guidance is to keep
 * the key and rebuild the body when an outcome is unknown; deriving the key
 * from the inputs that determine the body makes that the only thing that can
 * happen.
 */
export function idempotencyKeyFor(
  artifact: Pick<ApprovalArtifact, "intentHash" | "policyHash">,
  leg: string,
): string {
  const operation = hashCanonical({
    intentHash: artifact.intentHash,
    policyHash: artifact.policyHash,
  });
  return `mirsad:${operation}:${leg}`;
}

/**
 * Deliberate crash points, for proving resume rather than hoping to catch it.
 *
 * Set MIRSAD_FAULT to "after-prepared" or "after-sent" and the process exits
 * at that point. Nothing in production sets it. This is how the crash-safety
 * claim in the README is exercised, and it is safer than trying to time a
 * Ctrl-C into a four-second window.
 */
function faultPoint(name: "after-prepared" | "after-sent"): void {
  if (process.env.MIRSAD_FAULT === name) {
    process.stderr.write(`MIRSAD_FAULT=${name}: exiting on purpose\n`);
    process.exit(137);
  }
}

interface SimulationResponse {
  success?: boolean;
  wouldRevert?: boolean;
  reason?: string;
  revertReason?: string;
  gasEstimate?: string;
}

interface SubmitResponse {
  executionId?: string;
  execution_id?: string;
  status?: string;
  transactionHash?: string;
  transactionLink?: string;
}

export interface ExecuteArtifactOptions {
  transport: Transport;
  journal: Journal;
  artifact: ApprovalArtifact;
  artifactHash: string;
  now: Date;
  /** Bounded. An unbounded poll turns an ambiguous send into a hung process. */
  pollDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_DELAYS = [1000, 2000, 3000, 5000, 8000, 13000];

export async function executeArtifact(
  options: ExecuteArtifactOptions,
): Promise<ExecutionOutcome> {
  const {
    transport,
    journal,
    artifact,
    artifactHash,
    now,
    pollDelaysMs = DEFAULT_POLL_DELAYS,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  // Before anything is built, let alone sent.
  const verdict = verifyArtifact(artifact, artifactHash, now);
  if (!verdict.ok) {
    return { kind: "artifact-invalid", rule: verdict.rule, message: verdict.message };
  }

  const receipts: LegReceipt[] = [];

  for (const call of artifact.calls) {
    if (!KNOWN_FUNCTIONS[call.functionName]) {
      return {
        kind: "artifact-invalid",
        rule: "unknown-function",
        message: `no pinned ABI for ${call.functionName}; refusing to guess its signature`,
      };
    }
    const expectedArgs = KNOWN_FUNCTIONS[call.functionName]?.inputs.length ?? 0;
    if (call.args.length !== expectedArgs) {
      return {
        kind: "artifact-invalid",
        rule: "arity",
        message: `${call.functionName} takes ${expectedArgs} arguments; artifact supplies ${call.args.length}`,
      };
    }

    const request = buildRequest(call, artifact.chainId);
    const requestHash = hashCanonical(request);
    const key = idempotencyKeyFor(artifact, call.leg);

    const prior = await journal.latest(key);
    if (prior && prior.requestHash !== requestHash) {
      // The key is already bound to different bytes. Rotating to a fresh key
      // here is what escapes the in-flight guard and broadcasts twice.
      return {
        kind: "request-drift",
        leg: call.leg,
        expected: prior.requestHash,
        actual: requestHash,
      };
    }
    if (prior?.state === "settled") {
      receipts.push({
        leg: call.leg,
        executionId: prior.executionId ?? "",
        status: "completed",
        ...(prior.transactionHash ? { transactionHash: prior.transactionHash } : {}),
      });
      continue;
    }

    // A leg already in flight is not simulated again. Its preflight passed
    // before it was sent, and a second dry run would only widen the window
    // between the check and the send.
    if (!prior) {
      let simulation: SimulationResponse;
      try {
        simulation = await transport.callTool<SimulationResponse>("execute_contract_call", {
          ...request,
          simulate: true,
        });
      } catch (cause) {
        return failureToOutcome(cause, call.leg, "preflight");
      }
      if (simulation.success !== true || simulation.wouldRevert === true) {
        return {
          kind: "simulation-reverted",
          leg: call.leg,
          reason:
            simulation.reason ?? simulation.revertReason ?? JSON.stringify(simulation),
        };
      }

      // Persisted before the send, so a crash in the next few milliseconds
      // leaves proof that a broadcast may have happened.
      await journal.append({
        idempotencyKey: key,
        artifactHash,
        leg: call.leg,
        requestHash,
        state: "prepared",
        at: new Date().toISOString(),
      });
      faultPoint("after-prepared");
    }

    let submitted: SubmitResponse;
    try {
      submitted = await transport.callTool<SubmitResponse>("execute_contract_call", {
        ...request,
        idempotency_key: key,
      });
    } catch (cause) {
      return sendFailureToOutcome(cause, call.leg);
    }

    const executionId = submitted.executionId ?? submitted.execution_id;
    if (!executionId) {
      return {
        kind: "unconfirmed",
        leg: call.leg,
        executionId: "",
        message: "accepted without an execution id; outcome unknown",
      };
    }

    await journal.append({
      idempotencyKey: key,
      artifactHash,
      leg: call.leg,
      requestHash,
      state: "sent",
      at: new Date().toISOString(),
      executionId,
    });
    faultPoint("after-sent");

    const settled = await pollUntilSettled(
      transport,
      executionId,
      submitted,
      pollDelaysMs,
      sleep,
    );
    if (settled.kind !== "settled") {
      return settled.outcome(call.leg);
    }

    await journal.append({
      idempotencyKey: key,
      artifactHash,
      leg: call.leg,
      requestHash,
      state: "settled",
      at: new Date().toISOString(),
      executionId,
      ...(settled.receipt.transactionHash
        ? { transactionHash: settled.receipt.transactionHash }
        : {}),
    });
    receipts.push({ ...settled.receipt, leg: call.leg });
  }

  return { kind: "executed", legs: receipts };
}

type PollResult =
  | { kind: "settled"; receipt: LegReceipt }
  | { kind: "unsettled"; outcome: (leg: string) => ExecutionOutcome };

async function pollUntilSettled(
  transport: Transport,
  executionId: string,
  first: SubmitResponse,
  delaysMs: number[],
  sleep: (ms: number) => Promise<void>,
): Promise<PollResult> {
  let last: SubmitResponse = first;

  for (let attempt = 0; ; attempt += 1) {
    if (last.status === "completed") {
      return {
        kind: "settled",
        receipt: {
          leg: "",
          executionId,
          status: "completed",
          ...(last.transactionHash ? { transactionHash: last.transactionHash } : {}),
          ...(last.transactionLink ? { transactionLink: last.transactionLink } : {}),
        },
      };
    }
    if (last.status === "failed") {
      const settledLast = last;
      return {
        kind: "unsettled",
        outcome: (leg) => ({
          kind: "rejected",
          leg,
          executionId,
          message: `execution settled as failed${
            settledLast.transactionHash ? ` (${settledLast.transactionHash})` : ""
          }`,
        }),
      };
    }
    const delay = delaysMs[attempt];
    if (delay === undefined) break;

    await sleep(delay);
    try {
      last = await transport.callTool<SubmitResponse>("get_direct_execution_status", {
        execution_id: executionId,
      });
    } catch (cause) {
      // Losing the ability to ask does not mean the transaction stopped.
      const message = (cause as Error).message;
      return {
        kind: "unsettled",
        outcome: (leg) => ({ kind: "unconfirmed", leg, executionId, message }),
      };
    }
  }

  return {
    kind: "unsettled",
    outcome: (leg) => ({
      kind: "unconfirmed",
      leg,
      executionId,
      message: `did not settle within ${delaysMs.length} polls; last status ${last.status}`,
    }),
  };
}

/** Failures reaching this point happened before anything was broadcast. */
function failureToOutcome(cause: unknown, leg: string, phase: string): ExecutionOutcome {
  if (cause instanceof TransportError) {
    if (cause.kind === "rate-limited" || cause.kind === "unavailable") {
      return {
        kind: "unavailable",
        leg,
        message: `${phase}: ${cause.message}`,
        ...(cause.retryAfterMs === undefined ? {} : { retryAfterMs: cause.retryAfterMs }),
      };
    }
    return { kind: "rejected", leg, message: `${phase}: ${cause.message}` };
  }
  return { kind: "rejected", leg, message: `${phase}: ${(cause as Error).message}` };
}

/**
 * Failures on the send itself, where the outcome is genuinely unknown.
 *
 * A 429 is refused before the request is processed, so it is safe to call that
 * one "not executed". A 5xx or a dropped connection is not: the request may
 * have been received and acted on, and reporting it as a clean failure is how
 * a retry becomes a duplicate.
 */
function sendFailureToOutcome(cause: unknown, leg: string): ExecutionOutcome {
  if (cause instanceof TransportError) {
    if (cause.kind === "rate-limited") {
      return {
        kind: "unavailable",
        leg,
        message: cause.message,
        ...(cause.retryAfterMs === undefined ? {} : { retryAfterMs: cause.retryAfterMs }),
      };
    }
    if (cause.kind === "conflict") {
      return {
        kind: "request-drift",
        leg,
        expected: "the body already bound to this key",
        actual: "the body just rebuilt",
      };
    }
    if (cause.kind === "unavailable") {
      return { kind: "unconfirmed", leg, executionId: "", message: cause.message };
    }
    return { kind: "rejected", leg, message: cause.message };
  }
  return { kind: "unconfirmed", leg, executionId: "", message: (cause as Error).message };
}
