/**
 * The pipeline, end to end: propose, decide, execute, prove.
 *
 * The ordering is the product. Nothing reaches KeeperHub before the policy has
 * seen it, nothing is broadcast before its preflight passes, and nothing is
 * reported as done before a read of the chain agrees that it happened.
 *
 * `broadcast` defaults to false. A run that would move value has to be asked
 * for explicitly, so the demo, the tests and an operator trying things out all
 * share the same code path without any of them being one flag away from a
 * transaction.
 */

import { decide } from "@mirsad/policy";
import type { Decision, Policy } from "@mirsad/policy";
import { checkSupplyPostcondition, executeArtifact } from "@mirsad/keeperhub";
import type {
  ExecutionOutcome,
  Journal,
  Postcondition,
  PositionReader,
  Transport,
} from "@mirsad/keeperhub";

export interface RunOptions {
  proposal: unknown;
  policy: Policy;
  transport: Transport;
  journal: Journal;
  /** Read the same position from independent sources; used before and after. */
  readers: PositionReader[];
  now: Date;
  broadcast?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunReport {
  decision: Decision;
  /** Absent when the decision was BLOCK, or when broadcasting was not asked for. */
  outcome?: ExecutionOutcome;
  postcondition?: Postcondition;
  /** True when nothing was sent to KeeperHub, for any reason. */
  quiet: boolean;
}

export async function run(options: RunOptions): Promise<RunReport> {
  const { proposal, policy, transport, journal, readers, now, broadcast = false } = options;

  const decision = decide({ intent: proposal, policy, now });
  if (decision.verdict === "BLOCK") {
    return { decision, quiet: true };
  }
  if (!broadcast) {
    return { decision, quiet: true };
  }

  const supplied = decision.artifact.calls.find((c) => c.leg === "action")?.args[1];
  if (typeof supplied !== "string") {
    throw new Error("approved artifact has no supply amount; refusing to proceed");
  }

  const before = await Promise.all(readers.map((r) => r.read()));

  const outcome = await executeArtifact({
    transport,
    journal,
    artifact: decision.artifact,
    artifactHash: decision.artifactHash,
    now,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  if (outcome.kind !== "executed") {
    return { decision, outcome, quiet: outcome.kind !== "unconfirmed" };
  }

  const after = await Promise.all(readers.map((r) => r.read()));
  const postcondition = checkSupplyPostcondition({
    before,
    after,
    expectedIncreaseBaseUnits: supplied,
  });

  return { decision, outcome, postcondition, quiet: false };
}
