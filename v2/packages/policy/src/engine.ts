/**
 * The decision.
 *
 * Pure: no network, no clock of its own, no filesystem. `now` is passed in so
 * that expiry and staleness are testable rather than flaky, and so that the
 * same inputs always produce the same decision and the same hashes.
 *
 * Every rule runs. None of them short-circuits, because an operator debugging
 * a blocked intent wants all four things that are wrong with it, not the first
 * one in declaration order.
 */

import { canonicalize, hashCanonical } from "./canonical.js";
import {
  type ApprovalArtifact,
  type ArtifactCall,
  type Decision,
  ExecutionIntent,
  type Finding,
  type Policy,
} from "./schema.js";

const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * Builders for the calls an allowed intent turns into.
 *
 * A `protocol/action` with no builder is refused even if a policy permits it.
 * The allowlist says what an operator is willing to authorise; this map says
 * what MIRSAD knows how to express exactly. Adding to the former without the
 * latter must not widen what can execute.
 */
const CALL_BUILDERS: Record<string, (intent: ExecutionIntent) => ArtifactCall[]> = {
  "aave-v3/supply": (intent) => [
    {
      leg: "approve",
      contract: intent.token,
      functionName: "approve",
      // Exactly the amount being supplied. MIRSAD derives this rather than
      // accepting it, so an unlimited allowance is not something a planner can
      // ask for - only something an amount cap can fail to catch.
      args: [intent.target, intent.amountBaseUnits],
    },
    {
      leg: "action",
      contract: intent.target,
      functionName: "supply",
      args: [intent.token, intent.amountBaseUnits, intent.beneficiary, 0],
    },
  ],
};

function ruleChain(intent: ExecutionIntent, policy: Policy): Finding[] {
  if (intent.chainId === policy.chainId) return [];
  return [
    {
      rule: "chain",
      message: `intent targets chain ${intent.chainId}; policy permits ${policy.chainId} only`,
    },
  ];
}

function ruleAllowed(intent: ExecutionIntent, policy: Policy): Finding[] {
  const permitted = policy.allow.some(
    (entry) =>
      entry.protocol === intent.protocol &&
      entry.action === intent.action &&
      entry.target === intent.target &&
      entry.token === intent.token,
  );
  if (permitted) return [];
  return [
    {
      rule: "allowlist",
      message:
        `no policy entry permits ${intent.protocol}/${intent.action} ` +
        `on ${intent.target} with token ${intent.token}`,
    },
  ];
}

function ruleAmount(intent: ExecutionIntent, policy: Policy): Finding[] {
  const amount = BigInt(intent.amountBaseUnits);
  const cap = BigInt(policy.maxAmountBaseUnits);
  if (amount === 0n) {
    return [{ rule: "amount", message: "amount is zero" }];
  }
  if (amount > cap) {
    return [
      {
        rule: "amount",
        message: `amount ${intent.amountBaseUnits} exceeds the cap of ${policy.maxAmountBaseUnits} base units`,
      },
    ];
  }
  return [];
}

function ruleBeneficiary(intent: ExecutionIntent, policy: Policy): Finding[] {
  if (intent.beneficiary === policy.actor) return [];
  return [
    {
      rule: "beneficiary",
      message: `position would accrue to ${intent.beneficiary}; policy names ${policy.actor}`,
    },
  ];
}

function ruleFreshness(intent: ExecutionIntent, policy: Policy, now: Date): Finding[] {
  const observedAt = Date.parse(intent.observations.observedAt);
  const ageSeconds = (now.getTime() - observedAt) / 1000;

  // A future observation is not merely fresh, it is unverifiable, and it would
  // let a planner hold an intent open indefinitely by dating it forward.
  if (ageSeconds < 0) {
    return [
      {
        rule: "freshness",
        message: `observation is dated ${Math.abs(Math.round(ageSeconds))}s in the future`,
      },
    ];
  }
  if (ageSeconds > policy.maxObservationAgeSeconds) {
    return [
      {
        rule: "freshness",
        message: `observation is ${Math.round(ageSeconds)}s old; policy allows ${policy.maxObservationAgeSeconds}s`,
      },
    ];
  }
  return [];
}

/**
 * A hash for an intent that failed to parse.
 *
 * The raw value still gets hashed where it can be, so a rejected proposal is
 * still identifiable in the audit trail. Input that is not even canonicalizable
 * falls back to the zero hash rather than throwing, because refusing to record
 * a malformed proposal is worse than recording it without an identity.
 */
function hashUnparsed(value: unknown): `0x${string}` {
  try {
    return hashCanonical(value);
  } catch {
    return ZERO_HASH;
  }
}

export interface DecideArgs {
  intent: unknown;
  policy: Policy;
  now: Date;
}

export function decide({ intent: raw, policy, now }: DecideArgs): Decision {
  const policyHash = hashCanonical(policy);

  const parsed = ExecutionIntent.safeParse(raw);
  if (!parsed.success) {
    return {
      verdict: "BLOCK",
      intentHash: hashUnparsed(raw),
      policyHash,
      reasons: parsed.error.issues.map((issue) => ({
        rule: "schema",
        message: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      })),
    };
  }

  const intent = parsed.data;
  const intentHash = hashCanonical(intent);

  const reasons = [
    ...ruleChain(intent, policy),
    ...ruleAllowed(intent, policy),
    ...ruleAmount(intent, policy),
    ...ruleBeneficiary(intent, policy),
    ...ruleFreshness(intent, policy, now),
  ];

  const build = CALL_BUILDERS[`${intent.protocol}/${intent.action}`];
  if (!build) {
    reasons.push({
      rule: "unsupported-action",
      message: `no call builder for ${intent.protocol}/${intent.action}`,
    });
  }

  if (reasons.length > 0 || !build) {
    return { verdict: "BLOCK", intentHash, policyHash, reasons };
  }

  const artifact: ApprovalArtifact = {
    schemaVersion: "mirsad.artifact.v1",
    intentHash,
    policyHash,
    chainId: intent.chainId,
    actor: policy.actor,
    calls: build(intent),
    observations: intent.observations,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + policy.artifactTtlSeconds * 1000).toISOString(),
  };

  return {
    verdict: "ALLOW",
    intentHash,
    policyHash,
    artifact,
    artifactHash: hashCanonical(artifact),
  };
}

export type ArtifactRejection =
  | { ok: true }
  | { ok: false; rule: "artifact-hash" | "artifact-expired"; message: string };

/**
 * The check the executor runs immediately before it broadcasts.
 *
 * An ALLOW is only worth the bytes it committed to. If the artifact reaching
 * the executor does not hash to the value the decision published, something
 * edited it in transit and the correct response is to send nothing.
 */
export function verifyArtifact(
  artifact: ApprovalArtifact,
  expectedHash: string,
  now: Date,
): ArtifactRejection {
  const actual = hashCanonical(artifact);
  if (actual !== expectedHash) {
    return {
      ok: false,
      rule: "artifact-hash",
      message: `artifact hashes to ${actual}, expected ${expectedHash}`,
    };
  }
  if (now.getTime() > Date.parse(artifact.expiresAt)) {
    return {
      ok: false,
      rule: "artifact-expired",
      message: `artifact expired at ${artifact.expiresAt}`,
    };
  }
  return { ok: true };
}

export { canonicalize, hashCanonical };
