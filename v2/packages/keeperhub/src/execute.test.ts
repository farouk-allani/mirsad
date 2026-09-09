import { aaveBasePolicy, aaveMarket, decide, hashCanonical } from "@mirsad/policy";
import type { ApprovalArtifact } from "@mirsad/policy";
import { beforeEach, describe, expect, it } from "vitest";

import { buildRequest, executeArtifact, idempotencyKeyFor } from "./execute.js";
import { MemoryJournal } from "./journal.js";
import { type Transport, TransportError } from "./transport.js";
import type { ExecutionOutcome } from "./types.js";

const ACTOR = "0x1f535539d5495f0e58ecb8f16006605acffd33f4";
const ATTACKER = "0xdead00000000000000000000000000000000beef";
const NOW = new Date("2026-09-09T12:00:00.000Z");
const CHAIN_ID = 84532;
const MARKET = aaveMarket(CHAIN_ID);

const policy = aaveBasePolicy({ actor: ACTOR, chainId: CHAIN_ID });

function approvedArtifact(): { artifact: ApprovalArtifact; artifactHash: string } {
  const decision = decide({
    intent: {
      schemaVersion: "mirsad.intent.v1",
      source: { system: "wayfinder", runId: "run-1", path: "mirsad-guarded-aave@0.1.0" },
      chainId: CHAIN_ID,
      protocol: "aave-v3",
      action: "supply",
      target: MARKET.pool,
      token: MARKET.usdc,
      amountBaseUnits: "1000000",
      beneficiary: ACTOR,
      observations: { blockNumber: "46610337", observedAt: "2026-09-09T11:59:30.000Z" },
    },
    policy,
    now: NOW,
  });
  if (decision.verdict !== "ALLOW") throw new Error("fixture must allow");
  return { artifact: decision.artifact, artifactHash: decision.artifactHash };
}

type Handler = (name: string, args: Record<string, unknown>, nth: number) => unknown;

interface Recorder {
  transport: Transport;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

function recorder(handler: Handler): Recorder {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    transport: {
      callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
        calls.push({ name, args });
        const result = handler(name, args, calls.length - 1);
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result as T);
      },
    },
  };
}

const OK_SIMULATION = { success: true, wouldRevert: false, gasEstimate: "46618" };

/** Simulations pass; sends settle immediately. The shape of a good day. */
const happyPath: Handler = (name, args, nth) => {
  if (name === "get_direct_execution_status") return { status: "completed" };
  if (args.simulate === true) return OK_SIMULATION;
  return {
    executionId: `exec-${nth}`,
    status: "completed",
    transactionHash: `0x${String(nth).padStart(64, "0")}`,
    transactionLink: "https://sepolia.basescan.org/tx/0x0",
  };
};

const instantly = async () => {};

async function run(
  handler: Handler,
  overrides: Partial<Parameters<typeof executeArtifact>[0]> = {},
): Promise<{ outcome: ExecutionOutcome; calls: Recorder["calls"]; journal: MemoryJournal }> {
  const { artifact, artifactHash } = approvedArtifact();
  const journal = (overrides.journal as MemoryJournal) ?? new MemoryJournal();
  const rec = recorder(handler);
  const outcome = await executeArtifact({
    transport: rec.transport,
    journal,
    artifact,
    artifactHash,
    now: NOW,
    sleep: instantly,
    ...overrides,
  });
  return { outcome, calls: rec.calls, journal };
}

describe("executing an approved artifact", () => {
  it("settles both legs and returns their receipts", async () => {
    const { outcome } = await run(happyPath);
    expect(outcome.kind).toBe("executed");
    if (outcome.kind !== "executed") return;
    expect(outcome.legs.map((l) => l.leg)).toEqual(["approve", "action"]);
    expect(outcome.legs[0]?.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("simulates every leg before sending it", async () => {
    const { calls } = await run(happyPath);
    const contractCalls = calls.filter((c) => c.name === "execute_contract_call");
    expect(contractCalls.map((c) => c.args.simulate === true)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it("sends exactly the calls the artifact committed to", async () => {
    const { artifact } = approvedArtifact();
    const { calls } = await run(happyPath);
    const sends = calls.filter(
      (c) => c.name === "execute_contract_call" && c.args.simulate !== true,
    );
    expect(sends).toHaveLength(artifact.calls.length);
    artifact.calls.forEach((call, i) => {
      const expected = buildRequest(call, artifact.chainId);
      expect(sends[i]?.args).toMatchObject(expected as unknown as Record<string, unknown>);
    });
  });

  it("approves exactly the amount being supplied, never more", async () => {
    const { calls } = await run(happyPath);
    const approve = calls.find(
      (c) => c.name === "execute_contract_call" && c.args.function_name === "approve",
    );
    expect(approve?.args.function_args).toBe(JSON.stringify([MARKET.pool, "1000000"]));
  });

  it("records prepared, sent and settled for each leg", async () => {
    const { journal } = await run(happyPath);
    const entries = await journal.all();
    expect(entries.map((e) => `${e.leg}:${e.state}`)).toEqual([
      "approve:prepared",
      "approve:sent",
      "approve:settled",
      "action:prepared",
      "action:sent",
      "action:settled",
    ]);
  });
});

describe("refusing before anything is sent", () => {
  const cases: Array<[string, (a: ApprovalArtifact) => ApprovalArtifact, string]> = [
    [
      "an artifact whose beneficiary was edited in transit",
      (a) => ({
        ...a,
        calls: a.calls.map((c) =>
          c.leg === "action" ? { ...c, args: [MARKET.usdc, "1000000", ATTACKER, 0] } : c,
        ),
      }),
      "artifact-hash",
    ],
    [
      "an artifact whose approval was widened",
      (a) => ({
        ...a,
        calls: a.calls.map((c) =>
          c.leg === "approve" ? { ...c, args: [MARKET.pool, "999999999"] } : c,
        ),
      }),
      "artifact-hash",
    ],
    ["an artifact pointed at another chain", (a) => ({ ...a, chainId: 8453 }), "artifact-hash"],
  ];

  for (const [label, mutate, rule] of cases) {
    it(`refuses ${label}, with zero calls to KeeperHub`, async () => {
      const { artifact, artifactHash } = approvedArtifact();
      const rec = recorder(happyPath);
      const outcome = await executeArtifact({
        transport: rec.transport,
        journal: new MemoryJournal(),
        artifact: mutate(artifact),
        artifactHash,
        now: NOW,
        sleep: instantly,
      });
      expect(outcome.kind).toBe("artifact-invalid");
      if (outcome.kind === "artifact-invalid") expect(outcome.rule).toBe(rule);
      expect(rec.calls).toHaveLength(0);
    });
  }

  it("refuses an expired artifact even though it hashes correctly", async () => {
    const { artifact, artifactHash } = approvedArtifact();
    const rec = recorder(happyPath);
    const outcome = await executeArtifact({
      transport: rec.transport,
      journal: new MemoryJournal(),
      artifact,
      artifactHash,
      now: new Date(NOW.getTime() + 121_000),
      sleep: instantly,
    });
    expect(outcome.kind).toBe("artifact-invalid");
    expect(rec.calls).toHaveLength(0);
  });

  it("refuses a function it has no pinned ABI for, rather than guessing", async () => {
    const { artifact } = approvedArtifact();
    const tampered: ApprovalArtifact = {
      ...artifact,
      calls: [{ leg: "action", contract: MARKET.pool, functionName: "borrow", args: [] }],
    };
    const rec = recorder(happyPath);
    const outcome = await executeArtifact({
      transport: rec.transport,
      journal: new MemoryJournal(),
      artifact: tampered,
      // Hashed against itself, so only the ABI check can stop this one.
      artifactHash: hashCanonical(tampered),
      now: NOW,
      sleep: instantly,
    });
    expect(outcome.kind).toBe("artifact-invalid");
    if (outcome.kind === "artifact-invalid") expect(outcome.rule).toBe("unknown-function");
    expect(rec.calls).toHaveLength(0);
  });
});

describe("when the preflight refuses", () => {
  it("does not broadcast a call that would revert", async () => {
    const { outcome, calls } = await run((_name, args) => {
      if (args.simulate === true) {
        return {
          success: false,
          wouldRevert: true,
          reason: "Error(ERC20: transfer amount exceeds allowance)",
        };
      }
      return new Error("should not have been sent");
    });
    expect(outcome.kind).toBe("simulation-reverted");
    expect(calls.filter((c) => c.args.simulate !== true)).toHaveLength(0);
  });

  it("treats an unreachable preflight as unavailable, never as clean", async () => {
    const { outcome, calls } = await run((_name, args) => {
      if (args.simulate === true) {
        return new TransportError("HTTP 503", "unavailable", "execute_contract_call");
      }
      return new Error("should not have been sent");
    });
    expect(outcome.kind).toBe("unavailable");
    expect(calls.filter((c) => c.args.simulate !== true)).toHaveLength(0);
  });

  it("surfaces the server's Retry-After rather than inventing a backoff", async () => {
    const { outcome } = await run((_name, args) =>
      args.simulate === true
        ? new TransportError("HTTP 429", "rate-limited", "execute_contract_call", 4200)
        : new Error("unreachable"),
    );
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") expect(outcome.retryAfterMs).toBe(4200);
  });
});

describe("when the send is ambiguous", () => {
  it("reports unconfirmed, not failed, when the connection drops mid-send", async () => {
    const { outcome, journal } = await run((_name, args) =>
      args.simulate === true
        ? OK_SIMULATION
        : new TransportError("socket hang up", "unavailable", "execute_contract_call"),
    );
    expect(outcome.kind).toBe("unconfirmed");
    // The prepared record survives, so a later run knows a send may have happened.
    expect((await journal.all()).some((e) => e.state === "prepared")).toBe(true);
  });

  it("reports unavailable when a 429 refuses the send before processing", async () => {
    const { outcome } = await run((_name, args) =>
      args.simulate === true
        ? OK_SIMULATION
        : new TransportError("HTTP 429", "rate-limited", "execute_contract_call", 1000),
    );
    expect(outcome.kind).toBe("unavailable");
  });

  it("reports drift rather than rotating the key when the server says conflict", async () => {
    const { outcome } = await run((_name, args) =>
      args.simulate === true
        ? OK_SIMULATION
        : new TransportError("idempotency_conflict", "conflict", "execute_contract_call"),
    );
    expect(outcome.kind).toBe("request-drift");
  });

  it("reports unconfirmed when the status never settles", async () => {
    const { outcome } = await run((name, args) => {
      if (name === "get_direct_execution_status") return { status: "pending" };
      if (args.simulate === true) return OK_SIMULATION;
      return { executionId: "exec-1", status: "pending" };
    });
    expect(outcome.kind).toBe("unconfirmed");
  });

  it("reports a rejection when the transaction settles as failed", async () => {
    const { outcome } = await run((name, args) => {
      if (name === "get_direct_execution_status") return { status: "failed" };
      if (args.simulate === true) return OK_SIMULATION;
      return { executionId: "exec-1", status: "failed" };
    });
    expect(outcome.kind).toBe("rejected");
  });
});

describe("resuming after a crash", () => {
  let journal: MemoryJournal;

  beforeEach(() => {
    journal = new MemoryJournal();
  });

  it("replays under the same key instead of preparing a second send", async () => {
    const { artifact, artifactHash } = approvedArtifact();
    const request = buildRequest(artifact.calls[0]!, artifact.chainId);

    // The state a process killed between persisting and broadcasting leaves.
    await journal.append({
      idempotencyKey: idempotencyKeyFor(artifactHash, "approve"),
      artifactHash,
      leg: "approve",
      requestHash: hashCanonical(request),
      state: "prepared",
      at: NOW.toISOString(),
    });

    const { outcome, calls } = await run(happyPath, { journal });
    expect(outcome.kind).toBe("executed");

    // The approve leg is not simulated again: three contract calls, not four.
    const simulations = calls.filter(
      (c) => c.name === "execute_contract_call" && c.args.simulate === true,
    );
    expect(simulations).toHaveLength(1);
    expect(simulations[0]?.args.function_name).toBe("supply");
  });

  it("uses the same idempotency key it would have used before the crash", async () => {
    const { artifactHash } = approvedArtifact();
    const { calls } = await run(happyPath, { journal });
    const send = calls.find(
      (c) => c.name === "execute_contract_call" && c.args.simulate !== true,
    );
    expect(send?.args.idempotency_key).toBe(idempotencyKeyFor(artifactHash, "approve"));
  });

  it("skips a leg that already settled rather than sending it twice", async () => {
    const { artifact, artifactHash } = approvedArtifact();
    await journal.append({
      idempotencyKey: idempotencyKeyFor(artifactHash, "approve"),
      artifactHash,
      leg: "approve",
      requestHash: hashCanonical(buildRequest(artifact.calls[0]!, artifact.chainId)),
      state: "settled",
      at: NOW.toISOString(),
      executionId: "exec-old",
      transactionHash: `0x${"a".repeat(64)}`,
    });

    const { outcome, calls } = await run(happyPath, { journal });
    expect(outcome.kind).toBe("executed");
    const approveSends = calls.filter(
      (c) => c.args.function_name === "approve" && c.args.simulate !== true,
    );
    expect(approveSends).toHaveLength(0);
    if (outcome.kind === "executed") {
      expect(outcome.legs[0]?.executionId).toBe("exec-old");
    }
  });

  it("refuses when the rebuilt request no longer matches the key's bound body", async () => {
    const { artifactHash } = approvedArtifact();
    await journal.append({
      idempotencyKey: idempotencyKeyFor(artifactHash, "approve"),
      artifactHash,
      leg: "approve",
      requestHash: `0x${"f".repeat(64)}`,
      state: "sent",
      at: NOW.toISOString(),
      executionId: "exec-old",
    });

    const { outcome, calls } = await run(happyPath, { journal });
    expect(outcome.kind).toBe("request-drift");
    expect(calls).toHaveLength(0);
  });
});

describe("the idempotency key", () => {
  it("is a pure function of the artifact hash and the leg", () => {
    const { artifactHash } = approvedArtifact();
    expect(idempotencyKeyFor(artifactHash, "approve")).toBe(
      idempotencyKeyFor(artifactHash, "approve"),
    );
    expect(idempotencyKeyFor(artifactHash, "approve")).not.toBe(
      idempotencyKeyFor(artifactHash, "action"),
    );
  });

  it("differs for a different approved action", () => {
    const { artifact, artifactHash } = approvedArtifact();
    const other = hashCanonical({ ...artifact, chainId: 8453 });
    expect(idempotencyKeyFor(artifactHash, "approve")).not.toBe(
      idempotencyKeyFor(other, "approve"),
    );
  });
});
