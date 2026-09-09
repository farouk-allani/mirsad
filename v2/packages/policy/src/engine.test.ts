import { describe, expect, it } from "vitest";

import { decide, hashCanonical, verifyArtifact } from "./engine.js";
import { BASE_ADDRESSES, BASE_CHAIN_ID, aaveBasePolicy } from "./packs/aave-base.js";
import type { ApprovalArtifact } from "./schema.js";

const ACTOR = "0x1f535539d5495f0e58ecb8f16006605acffd33f4";
const ATTACKER = "0xdead00000000000000000000000000000000beef";
const NOW = new Date("2026-09-09T12:00:00.000Z");
const UINT256_MAX =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const policy = aaveBasePolicy({ actor: ACTOR });

/** A proposal that should pass, so every test below differs from it in one way. */
function intent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "mirsad.intent.v1",
    source: { system: "wayfinder", runId: "run-1", path: "mirsad-guarded-aave@0.1.0" },
    chainId: BASE_CHAIN_ID,
    protocol: "aave-v3",
    action: "supply",
    target: BASE_ADDRESSES.aaveV3Pool,
    token: BASE_ADDRESSES.usdc,
    amountBaseUnits: "1000000",
    beneficiary: ACTOR,
    observations: { blockNumber: "50797452", observedAt: "2026-09-09T11:59:00.000Z" },
    ...overrides,
  };
}

describe("decide, on an intent that satisfies the policy", () => {
  const decision = decide({ intent: intent(), policy, now: NOW });

  it("allows it", () => {
    expect(decision.verdict).toBe("ALLOW");
  });

  it("binds the approval to exactly the amount being supplied", () => {
    if (decision.verdict !== "ALLOW") throw new Error("expected ALLOW");
    const approve = decision.artifact.calls.find((c) => c.leg === "approve");
    expect(approve).toEqual({
      leg: "approve",
      contract: BASE_ADDRESSES.usdc,
      functionName: "approve",
      args: [BASE_ADDRESSES.aaveV3Pool, "1000000"],
    });
  });

  it("supplies to the actor named in the policy, not to anyone the intent names", () => {
    if (decision.verdict !== "ALLOW") throw new Error("expected ALLOW");
    const action = decision.artifact.calls.find((c) => c.leg === "action");
    expect(action?.args).toEqual([BASE_ADDRESSES.usdc, "1000000", ACTOR, 0]);
  });

  it("expires the artifact after the policy's ttl", () => {
    if (decision.verdict !== "ALLOW") throw new Error("expected ALLOW");
    expect(decision.artifact.expiresAt).toBe("2026-09-09T12:02:00.000Z");
  });

  it("is deterministic: the same inputs produce the same hashes", () => {
    const again = decide({ intent: intent(), policy, now: NOW });
    expect(again).toEqual(decision);
  });

  it("hashes an address the same way regardless of its case", () => {
    const shouty = decide({
      intent: intent({ beneficiary: ACTOR.toUpperCase().replace("0X", "0x") }),
      policy,
      now: NOW,
    });
    expect(shouty.intentHash).toBe(decision.intentHash);
  });
});

describe("decide, on an intent that violates the policy", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["a beneficiary the operator never named", { beneficiary: ATTACKER }, "beneficiary"],
    ["an amount over the cap", { amountBaseUnits: "100000000" }, "amount"],
    ["an unlimited amount", { amountBaseUnits: UINT256_MAX }, "amount"],
    ["a zero amount", { amountBaseUnits: "0" }, "amount"],
    ["another chain", { chainId: 1 }, "chain"],
    ["a lookalike pool", { target: ATTACKER }, "allowlist"],
    ["a different token", { token: ATTACKER }, "allowlist"],
    ["borrowing instead of supplying", { action: "borrow" }, "allowlist"],
    ["another protocol", { protocol: "morpho" }, "allowlist"],
    [
      "a stale observation",
      { observations: { blockNumber: "1", observedAt: "2026-09-09T11:00:00.000Z" } },
      "freshness",
    ],
    [
      "an observation dated in the future",
      { observations: { blockNumber: "1", observedAt: "2026-09-09T13:00:00.000Z" } },
      "freshness",
    ],
  ];

  for (const [label, override, rule] of cases) {
    it(`blocks ${label}`, () => {
      const decision = decide({ intent: intent(override), policy, now: NOW });
      expect(decision.verdict).toBe("BLOCK");
      if (decision.verdict !== "BLOCK") return;
      expect(decision.reasons.map((r) => r.rule)).toContain(rule);
    });
  }

  it("reports every violation at once rather than the first", () => {
    const decision = decide({
      intent: intent({ beneficiary: ATTACKER, amountBaseUnits: "100000000", chainId: 1 }),
      policy,
      now: NOW,
    });
    if (decision.verdict !== "BLOCK") throw new Error("expected BLOCK");
    expect(new Set(decision.reasons.map((r) => r.rule))).toEqual(
      new Set(["beneficiary", "amount", "chain"]),
    );
  });
});

describe("decide, on input that does not parse", () => {
  const malformed: Array<[string, Record<string, unknown>]> = [
    ["an unrecognised field", { referralCode: 7 }],
    ["a missing field", { beneficiary: undefined }],
    ["an amount with a leading zero", { amountBaseUnits: "01" }],
    ["a fractional amount", { amountBaseUnits: "1.5" }],
    ["a negative amount", { amountBaseUnits: "-1" }],
    ["an amount as a number", { amountBaseUnits: 1000000 }],
    ["a truncated address", { beneficiary: "0xdead" }],
    ["a schema version from the future", { schemaVersion: "mirsad.intent.v2" }],
    ["a chain id that is not an integer", { chainId: 8453.5 }],
  ];

  for (const [label, override] of malformed) {
    it(`blocks ${label}`, () => {
      const decision = decide({ intent: intent(override), policy, now: NOW });
      expect(decision.verdict).toBe("BLOCK");
      if (decision.verdict !== "BLOCK") return;
      expect(decision.reasons[0]?.rule).toBe("schema");
    });
  }

  it("blocks input that is not an object at all", () => {
    expect(decide({ intent: "supply everything", policy, now: NOW }).verdict).toBe("BLOCK");
  });

  it("still identifies a rejected proposal by hash, so the audit trail has a subject", () => {
    const decision = decide({ intent: intent({ amountBaseUnits: "1.5" }), policy, now: NOW });
    expect(decision.intentHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(decision.intentHash).not.toBe(`0x${"0".repeat(64)}`);
  });
});

describe("decide, on an action nothing knows how to express", () => {
  it("fails closed even when the policy permits the action", () => {
    const permissive = {
      ...policy,
      allow: [
        {
          protocol: "aave-v3",
          action: "flashloan",
          target: BASE_ADDRESSES.aaveV3Pool,
          token: BASE_ADDRESSES.usdc,
        },
      ],
    };
    const decision = decide({
      intent: intent({ action: "flashloan" }),
      policy: permissive,
      now: NOW,
    });
    expect(decision.verdict).toBe("BLOCK");
    if (decision.verdict !== "BLOCK") return;
    expect(decision.reasons.map((r) => r.rule)).toContain("unsupported-action");
  });
});

describe("verifyArtifact", () => {
  const decision = decide({ intent: intent(), policy, now: NOW });
  if (decision.verdict !== "ALLOW") throw new Error("fixture must allow");
  const { artifact, artifactHash } = decision;

  it("accepts the artifact the decision published", () => {
    expect(verifyArtifact(artifact, artifactHash, NOW)).toEqual({ ok: true });
  });

  it("refuses an artifact whose beneficiary was edited after the decision", () => {
    const tampered: ApprovalArtifact = {
      ...artifact,
      calls: artifact.calls.map((call) =>
        call.leg === "action"
          ? { ...call, args: [BASE_ADDRESSES.usdc, "1000000", ATTACKER, 0] }
          : call,
      ),
    };
    const result = verifyArtifact(tampered, artifactHash, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rule).toBe("artifact-hash");
  });

  it("refuses an artifact whose amount gained a single digit", () => {
    const tampered: ApprovalArtifact = {
      ...artifact,
      calls: artifact.calls.map((call) =>
        call.leg === "approve"
          ? { ...call, args: [BASE_ADDRESSES.aaveV3Pool, "10000000"] }
          : call,
      ),
    };
    expect(verifyArtifact(tampered, artifactHash, NOW).ok).toBe(false);
  });

  it("refuses an expired artifact even though it hashes correctly", () => {
    const later = new Date(NOW.getTime() + 121_000);
    const result = verifyArtifact(artifact, artifactHash, later);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rule).toBe("artifact-expired");
  });

  it("cannot be satisfied by re-hashing a tampered artifact against itself", () => {
    const tampered: ApprovalArtifact = { ...artifact, actor: ATTACKER };
    expect(verifyArtifact(tampered, hashCanonical(tampered), NOW)).toEqual({ ok: true });
    expect(verifyArtifact(tampered, artifactHash, NOW).ok).toBe(false);
  });
});
