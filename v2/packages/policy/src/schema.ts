/**
 * The three documents MIRSAD reasons about, and the one it emits.
 *
 * An `ExecutionIntent` is what a planner proposes. It is untrusted input: it
 * arrives from a Wayfinder Path that read live market data, and any field in it
 * may be wrong, stale or hostile.
 *
 * A `Policy` is what a human agreed to once, in advance, out of band. It is the
 * only trusted document here.
 *
 * A `Decision` is the answer, and an `ApprovalArtifact` is what an ALLOW is
 * worth: the exact calls, hashed, with an expiry. The executor rebuilds its
 * request from the artifact and refuses to send anything whose hash differs.
 *
 * Every schema is `.strict()`. An unrecognised field is a parse failure and a
 * parse failure is a BLOCK, because a field we do not model is a field nobody
 * checked.
 */

import { z } from "zod";

/**
 * Addresses are lowercased on the way in. `0xABC…` and `0xabc…` are the same
 * account, so they have to be the same bytes, or a hash comparison rejects a
 * request that is materially identical.
 */
export const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "not a 20-byte hex address")
  .transform((s) => s.toLowerCase() as `0x${string}`);

/**
 * Token amounts in base units, as a canonical decimal string: no sign, no
 * exponent, no leading zeros. Never a JavaScript number - 1 USDC is 1e6 and a
 * DAI amount exceeds `Number.MAX_SAFE_INTEGER` long before it is interesting.
 */
export const BaseUnits = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "not a canonical base-unit integer string");

const Iso8601 = z.string().datetime({ offset: false });

export const Observations = z
  .object({
    blockNumber: BaseUnits,
    observedAt: Iso8601,
  })
  .strict();
export type Observations = z.infer<typeof Observations>;

export const ExecutionIntent = z
  .object({
    schemaVersion: z.literal("mirsad.intent.v1"),
    source: z
      .object({
        system: z.string().min(1),
        runId: z.string().min(1),
        path: z.string().min(1),
      })
      .strict(),
    chainId: z.number().int().positive(),
    protocol: z.string().min(1),
    action: z.string().min(1),
    /** The contract the action is performed against, e.g. the Aave V3 Pool. */
    target: Address,
    token: Address,
    amountBaseUnits: BaseUnits,
    /** Who ends up holding the position. Not necessarily who signs. */
    beneficiary: Address,
    observations: Observations,
  })
  .strict();
export type ExecutionIntent = z.infer<typeof ExecutionIntent>;

/**
 * One permitted (protocol, action, target, token) tuple.
 *
 * Kept as an exact tuple rather than four independent allowlists so that
 * permission to supply USDC to Aave is not also permission to supply USDC to
 * something else that happens to be on the target list.
 */
export const AllowEntry = z
  .object({
    protocol: z.string().min(1),
    action: z.string().min(1),
    target: Address,
    token: Address,
  })
  .strict();
export type AllowEntry = z.infer<typeof AllowEntry>;

export const Policy = z
  .object({
    schemaVersion: z.literal("mirsad.policy.v1"),
    name: z.string().min(1),
    chainId: z.number().int().positive(),
    /**
     * The account that signs and holds the resulting position. For P0 this is
     * the KeeperHub organization wallet, and it is also the only permitted
     * beneficiary: an agent may move the operator's money into the operator's
     * own position and nowhere else.
     */
    actor: Address,
    allow: z.array(AllowEntry).min(1),
    maxAmountBaseUnits: BaseUnits,
    /** How stale the planner's observation may be when the decision is made. */
    maxObservationAgeSeconds: z.number().int().positive(),
    /** How long an ALLOW stays valid. Short, because state moves. */
    artifactTtlSeconds: z.number().int().positive(),
  })
  .strict();
export type Policy = z.infer<typeof Policy>;

/** One reason a decision went the way it did. `rule` is stable and greppable. */
export interface Finding {
  rule: string;
  message: string;
}

/**
 * A single contract call, named by ABI function and arguments rather than
 * pre-encoded calldata.
 *
 * MIRSAD never accepts calldata from the planner. It derives the arguments from
 * fields it has validated, so there is no encoded blob for a mismatch to hide
 * in, and the executor can rebuild the identical KeeperHub request body from
 * the artifact alone.
 */
export const ArtifactCall = z
  .object({
    leg: z.enum(["approve", "action"]),
    contract: Address,
    functionName: z.string().min(1),
    args: z.array(z.union([z.string(), z.number().int()])),
  })
  .strict();
export type ArtifactCall = z.infer<typeof ArtifactCall>;

export const ApprovalArtifact = z
  .object({
    schemaVersion: z.literal("mirsad.artifact.v1"),
    intentHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    policyHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    chainId: z.number().int().positive(),
    actor: Address,
    calls: z.array(ArtifactCall).min(1),
    observations: Observations,
    issuedAt: Iso8601,
    expiresAt: Iso8601,
  })
  .strict();
export type ApprovalArtifact = z.infer<typeof ApprovalArtifact>;

export type Decision =
  | {
      verdict: "BLOCK";
      intentHash: `0x${string}`;
      policyHash: `0x${string}`;
      reasons: Finding[];
    }
  | {
      verdict: "ALLOW";
      intentHash: `0x${string}`;
      policyHash: `0x${string}`;
      artifact: ApprovalArtifact;
      artifactHash: `0x${string}`;
    };
