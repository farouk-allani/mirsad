import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENESIS_HASH,
  JsonlAuditTrail,
  MemoryAuditTrail,
  hashRecord,
  verifyChain,
  type AuditEntry,
} from "./trail.js";
import { reasonHashOf } from "../watch.js";
import { SafeOperation, Verdict, type AuditRecord, type Finding } from "../types.js";

const finding: Finding = {
  code: "owner-swapped",
  severity: Verdict.Veto,
  source: "rule",
  summary: "Transaction replaces a Safe owner.",
};

function record(n: number, verdict: Verdict = Verdict.Veto): AuditRecord {
  return {
    id: `0x${n.toString(16).padStart(64, "0")}`,
    observedAt: `2026-08-05T12:0${n}:00.000Z`,
    transaction: {
      safe: "0x499d502527243c56434749CAbd01A115E298e338",
      safeTxHash: `0x${n.toString(16).padStart(64, "0")}`,
      to: "0x000000000000000000000000000000000000dEaD",
      value: "1",
      data: null,
      operation: SafeOperation.Call,
      nonce: n,
      confirmationsRequired: 2,
      confirmations: [],
    },
    simulation: null,
    findings: [finding],
    verdict,
  };
}

function tmpPath() {
  return join(mkdtempSync(join(tmpdir(), "mirsad-audit-")), "trail.jsonl");
}

describe("chain integrity", () => {
  it("starts from genesis and links each entry to the last", async () => {
    const trail = new MemoryAuditTrail();
    const a = await trail.append(record(1));
    const b = await trail.append(record(2));

    expect(a.seq).toBe(0);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.seq).toBe(1);
    expect(b.prevHash).not.toBe(GENESIS_HASH);
    expect(trail.verify()).toEqual({ ok: true, count: 2 });
  });

  it("detects an entry edited after the fact", async () => {
    const trail = new MemoryAuditTrail();
    await trail.append(record(1));
    await trail.append(record(2));

    const tampered = trail.entries();
    // The most damaging possible edit: quietly downgrade a VETO to ALLOW.
    tampered[0]!.record.verdict = Verdict.Allow;

    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedAt).toBe(0);
      expect(result.reason).toMatch(/edited after being written/);
    }
  });

  it("detects a deleted entry", async () => {
    const trail = new MemoryAuditTrail();
    await trail.append(record(1));
    await trail.append(record(2));
    await trail.append(record(3));

    const withHole = trail.entries().filter((e) => e.seq !== 1);
    const result = verifyChain(withHole);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedAt).toBe(1);
  });

  it("detects reordering", async () => {
    const trail = new MemoryAuditTrail();
    await trail.append(record(1));
    await trail.append(record(2));

    const swapped = trail.entries().reverse();
    expect(verifyChain(swapped).ok).toBe(false);
  });

  it("an empty trail is valid", () => {
    expect(verifyChain([])).toEqual({ ok: true, count: 0 });
  });
});

describe("durability", () => {
  it("survives a restart and keeps the chain intact", async () => {
    const path = tmpPath();
    const first = new JsonlAuditTrail(path);
    await first.append(record(1));
    await first.append(record(2));

    const reopened = new JsonlAuditTrail(path);
    await reopened.append(record(3));

    expect(reopened.entries()).toHaveLength(3);
    expect(reopened.verify()).toEqual({ ok: true, count: 3 });
  });

  it("catches tampering done directly on the file", async () => {
    const path = tmpPath();
    const trail = new JsonlAuditTrail(path);
    await trail.append(record(1));
    await trail.append(record(2));

    // Someone edits the file with a text editor to hide a veto.
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]!) as AuditEntry;
    entry.record.verdict = Verdict.Allow;
    lines[0] = JSON.stringify(entry);
    writeFileSync(path, lines.join("\n") + "\n");

    const result = trail.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedAt).toBe(0);
  });

  it("reports corruption as a chain break instead of crashing", async () => {
    const path = tmpPath();
    const trail = new JsonlAuditTrail(path);
    await trail.append(record(1));
    await trail.append(record(2));

    // Destroying evidence by mangling the file should not take down the tool
    // that reports on it.
    writeFileSync(path, readFileSync(path, "utf8") + "{ this is not json\n");

    const result = trail.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid JSON/);
  });

  it("tolerates a UTF-8 BOM, which editors add and is not corruption", async () => {
    const path = tmpPath();
    const trail = new JsonlAuditTrail(path);
    await trail.append(record(1));

    writeFileSync(path, "﻿" + readFileSync(path, "utf8"));
    expect(trail.verify().ok).toBe(true);
  });

  it("writes one JSON object per line", async () => {
    const path = tmpPath();
    const trail = new JsonlAuditTrail(path);
    await trail.append(record(1));
    await trail.append(record(2));

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
  });
});

describe("onchain linkage", () => {
  it("recordHash equals the reasonHash committed onchain", async () => {
    const r = record(7);
    const trail = new MemoryAuditTrail();
    const entry = await trail.append(r);

    // This is what makes the onchain veto auditable: the hash stored in the
    // registry is exactly the hash of the reasoning in this file.
    const onchain = reasonHashOf({
      safeTxHash: r.transaction.safeTxHash,
      findings: r.findings,
      verdict: r.verdict,
    });
    expect(entry.recordHash).toBe(onchain);
  });

  it("ignores execution results, which are learned after the verdict", async () => {
    const before = record(9);
    const after: AuditRecord = {
      ...before,
      executionId: "exec-123",
      transactionLink: "https://sepolia.etherscan.io/tx/0xabc",
      gasUsed: "116332",
      outcome: "completed",
    };
    // Otherwise the hash committed onchain could never match the final record.
    expect(hashRecord(after)).toBe(hashRecord(before));
  });
});
