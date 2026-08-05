import { describe, expect, it, vi } from "vitest";
import { Watchtower, assess, reasonHashOf } from "./watch.js";
import { MemoryAuditTrail } from "./audit/trail.js";
import { NullClassifier, type Classifier } from "./analysis/classifier.js";
import type { RuleContext } from "./analysis/rules.js";
import type { SafeQueueSource } from "./safe/queue.js";
import type { KeeperHubClient } from "./keeperhub/client.js";
import {
  SafeOperation,
  Verdict,
  type AuditRecord,
  type Finding,
  type QueuedSafeTransaction,
} from "./types.js";

const SAFE = "0x499d502527243c56434749CAbd01A115E298e338" as const;
const REGISTRY = "0xe51388ac0CB9Bcc36548E2D0F163055FaE402256" as const;
const ATTACKER = "0x000000000000000000000000000000000000dEaD" as const;
const TRUSTED = "0x1F535539d5495F0e58ECB8F16006605acFfd33f4" as const;

function tx(partial: Partial<QueuedSafeTransaction> = {}): QueuedSafeTransaction {
  return {
    safe: SAFE,
    safeTxHash: "0xaa00000000000000000000000000000000000000000000000000000000000001",
    to: TRUSTED,
    value: "0",
    data: null,
    operation: SafeOperation.Call,
    nonce: 1,
    confirmationsRequired: 2,
    confirmations: [],
    ...partial,
  };
}

/** A delegatecall: a rule-only VETO, no model needed. */
const maliciousTx = tx({
  safeTxHash: "0xbb00000000000000000000000000000000000000000000000000000000000002",
  to: ATTACKER,
  operation: SafeOperation.DelegateCall,
});

function queueOf(...txs: QueuedSafeTransaction[]): SafeQueueSource {
  return { name: "test-queue", fetchPending: async () => txs };
}

/** A KeeperHub double that records what it was asked to write. */
function fakeKeeperHub() {
  const writes: any[] = [];
  const client = {
    writeContract: vi.fn(async (opts: any) => {
      writes.push(opts);
      return {
        simulation: { success: true, wouldRevert: false, gasEstimate: "94967" },
        execution: {
          executionId: "exec-1",
          status: "completed",
          transactionLink: "https://sepolia.etherscan.io/tx/0xfeed",
          gasUsedWei: "116332",
        },
      };
    }),
  } as unknown as KeeperHubClient;
  return { client, writes };
}

const ctx = (): RuleContext => ({ safeAddress: SAFE, addressBook: [TRUSTED] });

function tower(overrides: Partial<Parameters<typeof Watchtower.prototype.constructor>[0]> = {}) {
  const kh = fakeKeeperHub();
  const records: AuditRecord[] = [];
  const logs: string[] = [];
  const t = new Watchtower({
    queue: queueOf(maliciousTx),
    classifier: new NullClassifier(),
    ruleContext: ctx(),
    keeperhub: kh.client,
    chainId: "11155111",
    registryAddress: REGISTRY,
    armed: true,
    onRecord: (r) => void records.push(r),
    log: (m) => void logs.push(m),
    ...(overrides as object),
  });
  return { t, kh, records, logs };
}

describe("assess", () => {
  it("combines rule and model findings and takes the highest severity", async () => {
    const modelWarn: Classifier = {
      name: "stub",
      classify: async () => [
        { code: "intent-drift", severity: Verdict.Warn, source: "model", summary: "Mismatch." },
      ],
    };
    const { findings, verdict } = await assess(maliciousTx, ctx(), modelWarn);
    expect(findings.map((f) => f.source)).toEqual(["rule", "model"]);
    expect(verdict).toBe(Verdict.Veto);
  });

  it("still reaches a verdict when the classifier returns nothing", async () => {
    const { verdict } = await assess(maliciousTx, ctx(), new NullClassifier());
    expect(verdict).toBe(Verdict.Veto);
  });
});

describe("arming", () => {
  it("writes the veto onchain when armed", async () => {
    const { t, kh } = tower();
    await t.tick();
    expect(kh.client.writeContract).toHaveBeenCalledOnce();
    expect(kh.writes[0].functionName).toBe("setVerdict");
    // [safeTxHash, Level.Veto, reasonHash] — Level.Veto is 3 in the registry enum.
    expect(kh.writes[0].functionArgs[0]).toBe(maliciousTx.safeTxHash);
    expect(kh.writes[0].functionArgs[1]).toBe(3);
  });

  it("never broadcasts when disarmed, but still records the verdict", async () => {
    const { t, kh, records, logs } = tower({ armed: false });
    await t.tick();
    expect(kh.client.writeContract).not.toHaveBeenCalled();
    expect(records[0]!.verdict).toBe(Verdict.Veto);
    expect(logs.join("\n")).toMatch(/DISARMED/);
  });
});

describe("idempotence and retries", () => {
  it("assesses each transaction once across ticks", async () => {
    const { t, kh } = tower();
    await t.tick();
    await t.tick();
    expect(kh.client.writeContract).toHaveBeenCalledOnce();
  });

  it("derives the same idempotency key for the same transaction", async () => {
    const { t, kh } = tower();
    await t.tick();
    const first = kh.writes[0].idempotencyKey;
    const { t: t2, kh: kh2 } = tower();
    await t2.tick();
    expect(kh2.writes[0].idempotencyKey).toBe(first);
  });

  it("retries on the next tick when a write fails", async () => {
    const kh = fakeKeeperHub();
    let calls = 0;
    (kh.client as any).writeContract = vi.fn(async () => {
      if (++calls === 1) throw new Error("network blip");
      return {
        simulation: { success: true, wouldRevert: false },
        execution: { executionId: "e", status: "completed" },
      };
    });
    const t = new Watchtower({
      queue: queueOf(maliciousTx),
      classifier: new NullClassifier(),
      ruleContext: ctx(),
      keeperhub: kh.client,
      chainId: "11155111",
      registryAddress: REGISTRY,
      armed: true,
      log: () => {},
    });
    await t.tick();
    await t.tick();
    expect(calls).toBe(2);
  });
});

describe("already-enforced short circuit", () => {
  it("skips the write when the registry already vetoes the hash", async () => {
    const { t, kh, records } = tower({ alreadyVetoed: async () => true });
    await t.tick();
    expect(kh.client.writeContract).not.toHaveBeenCalled();
    expect(records[0]!.outcome).toBe("completed");
  });

  it("writes anyway when the registry read fails — a read outage must not block a veto", async () => {
    const { t, kh } = tower({
      alreadyVetoed: async () => {
        throw new Error("rpc down");
      },
    });
    await t.tick();
    expect(kh.client.writeContract).toHaveBeenCalledOnce();
  });
});

describe("resilience", () => {
  it("refreshes the balance before assessing so proportional checks can fire", async () => {
    const drain = tx({
      safeTxHash: "0xcc00000000000000000000000000000000000000000000000000000000000003",
      to: ATTACKER,
      value: (80n * 10n ** 18n).toString(),
    });
    const { t, records } = tower({
      queue: queueOf(drain),
      balanceProvider: async () => 100n * 10n ** 18n,
    });
    await t.tick();
    expect(records[0]!.findings.map((f) => f.code)).toContain("value-drift-to-unknown");
    expect(records[0]!.verdict).toBe(Verdict.Veto);
  });

  it("keeps assessing when the balance lookup fails", async () => {
    const { t, records } = tower({
      balanceProvider: async () => {
        throw new Error("rpc down");
      },
    });
    await t.tick();
    expect(records).toHaveLength(1);
    expect(records[0]!.verdict).toBe(Verdict.Veto);
  });
});

describe("audit linkage", () => {
  it("the reason hash written onchain matches the audit trail entry", async () => {
    const trail = new MemoryAuditTrail();
    const { t, kh } = tower({ onRecord: (r: AuditRecord) => trail.append(r) });
    await t.tick();

    const entry = trail.entries()[0]!;
    expect(kh.writes[0].functionArgs[2]).toBe(entry.recordHash);
    expect(trail.verify().ok).toBe(true);
  });

  it("reasonHashOf depends on the findings, not on execution results", () => {
    const findings: Finding[] = [
      { code: "delegatecall", severity: Verdict.Veto, source: "rule", summary: "x" },
    ];
    const a = reasonHashOf({ safeTxHash: "0xaa", findings, verdict: Verdict.Veto });
    const b = reasonHashOf({ safeTxHash: "0xaa", findings, verdict: Verdict.Veto });
    const c = reasonHashOf({ safeTxHash: "0xbb", findings, verdict: Verdict.Veto });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
