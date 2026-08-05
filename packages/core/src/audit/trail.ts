import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { keccak256, toHex } from "viem";
import type { AuditRecord } from "../types.js";

/**
 * The audit trail.
 *
 * KeeperHub's pitch includes "every action logged: trigger, simulation result,
 * submitted transaction, gas used, outcome, timestamp". This is MIRSAD's side
 * of that, and it is deliberately more than a log file.
 *
 * A treasury-security tool whose own records can be edited after the fact is
 * not evidence of anything. Each entry therefore carries the hash of the entry
 * before it, so any modification, deletion, or reordering of history breaks the
 * chain and `verify()` names the first entry that fails. Append-only JSONL:
 * greppable, tailable, diffable, no database to operate.
 *
 * The `recordHash` of an entry is exactly the `reasonHash` committed onchain by
 * the veto, so an onchain verdict can be checked against the offchain reasoning
 * that produced it by anyone holding this file.
 */

export interface AuditEntry {
  seq: number;
  /** Hash of the previous entry, chaining history together. Genesis is 32 zero bytes. */
  prevHash: `0x${string}`;
  /** keccak256 of the canonical record. Matches the onchain reasonHash. */
  recordHash: `0x${string}`;
  record: AuditRecord;
}

export const GENESIS_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * The canonical form a record is hashed in.
 *
 * Only the fields that constitute the *judgement* are included — the
 * transaction, the findings, and the verdict. Execution results (tx hash, gas)
 * are recorded but excluded, because they are learned after the verdict is
 * reached and must not change the hash committed onchain.
 */
export function canonicalise(record: AuditRecord): string {
  return JSON.stringify({
    safeTxHash: record.transaction.safeTxHash,
    findings: record.findings,
    verdict: record.verdict,
  });
}

export function hashRecord(record: AuditRecord): `0x${string}` {
  return keccak256(toHex(canonicalise(record)));
}

function linkHash(prevHash: string, recordHash: string, seq: number): `0x${string}` {
  return keccak256(toHex(`${seq}:${prevHash}:${recordHash}`));
}

export interface AuditTrail {
  append(record: AuditRecord): Promise<AuditEntry>;
  entries(): AuditEntry[];
  verify(): VerificationResult;
}

export type VerificationResult =
  | { ok: true; count: number }
  | { ok: false; count: number; failedAt: number; reason: string };

/** In-memory trail, for tests and dry runs. */
export class MemoryAuditTrail implements AuditTrail {
  protected readonly log: AuditEntry[] = [];

  async append(record: AuditRecord): Promise<AuditEntry> {
    const entry = buildEntry(this.log, record);
    this.log.push(entry);
    return entry;
  }

  entries(): AuditEntry[] {
    return [...this.log];
  }

  verify(): VerificationResult {
    return verifyChain(this.log);
  }
}

/** Append-only JSONL on disk. Survives restarts; the chain survives tampering. */
export class JsonlAuditTrail implements AuditTrail {
  private log: AuditEntry[];

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.log = existsSync(path) ? readEntries(path).entries : [];
  }

  async append(record: AuditRecord): Promise<AuditEntry> {
    const entry = buildEntry(this.log, record);
    // Written before it is trusted in memory: a crash between the two should
    // lose the in-memory copy, never leave a durable gap in the chain.
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8");
    this.log.push(entry);
    return entry;
  }

  entries(): AuditEntry[] {
    return [...this.log];
  }

  verify(): VerificationResult {
    // Re-read from disk rather than trusting memory — the point is to detect
    // edits made behind our back.
    if (!existsSync(this.path)) return verifyChain([]);
    const { entries, parseError } = readEntries(this.path);
    const chain = verifyChain(entries);
    // A chain break earlier than the corruption is the more precise finding.
    if (!chain.ok) return chain;
    if (parseError) {
      return {
        ok: false,
        count: entries.length,
        failedAt: entries.length,
        reason: `line ${parseError.line} is not valid JSON — the trail is truncated or corrupted (${parseError.message})`,
      };
    }
    return chain;
  }
}

export interface ReadResult {
  entries: AuditEntry[];
  /** First unparseable line, if any. Corruption is a chain break, not a crash. */
  parseError?: { line: number; message: string };
}

/**
 * Read the trail, tolerating corruption.
 *
 * Throwing here would mean a single mangled byte takes down `mirsad audit`
 * entirely — which is a gift to anyone trying to destroy evidence, since a
 * crash hides the rest of the log too. Instead we stop at the bad line and let
 * `verify()` report exactly where the trail stops being trustworthy.
 */
function readEntries(path: string): ReadResult {
  const entries: AuditEntry[] = [];
  const lines = readFileSync(path, "utf8").split("\n");

  for (let i = 0; i < lines.length; i++) {
    // Strip a UTF-8 BOM: editors on Windows add one, and it is not corruption.
    const line = lines[i]!.replace(/^﻿/, "").trim();
    if (line.length === 0) continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch (err) {
      return { entries, parseError: { line: i + 1, message: (err as Error).message } };
    }
  }
  return { entries };
}

function buildEntry(log: readonly AuditEntry[], record: AuditRecord): AuditEntry {
  const last = log[log.length - 1];
  const seq = log.length;
  const prevHash = last ? linkHash(last.prevHash, last.recordHash, last.seq) : GENESIS_HASH;
  return { seq, prevHash, recordHash: hashRecord(record), record };
}

export function verifyChain(log: readonly AuditEntry[]): VerificationResult {
  let expectedPrev: `0x${string}` = GENESIS_HASH;

  for (let i = 0; i < log.length; i++) {
    const entry = log[i]!;
    if (entry.seq !== i) {
      return { ok: false, count: log.length, failedAt: i, reason: `seq is ${entry.seq}, expected ${i}` };
    }
    if (entry.prevHash !== expectedPrev) {
      return {
        ok: false,
        count: log.length,
        failedAt: i,
        reason: "prevHash does not match the preceding entry — history was altered or reordered",
      };
    }
    const recomputed = hashRecord(entry.record);
    if (recomputed !== entry.recordHash) {
      return {
        ok: false,
        count: log.length,
        failedAt: i,
        reason: "record does not match its recordHash — the entry was edited after being written",
      };
    }
    expectedPrev = linkHash(entry.prevHash, entry.recordHash, entry.seq);
  }
  return { ok: true, count: log.length };
}
