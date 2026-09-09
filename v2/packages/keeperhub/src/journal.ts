/**
 * What survives a crash.
 *
 * The executor writes `prepared` before it sends anything, so a process that
 * dies between persisting and broadcasting leaves evidence that a broadcast may
 * have happened. On the next run that entry is found and the same request is
 * replayed under the same key, which KeeperHub answers with the original result
 * rather than a second transaction.
 *
 * The idempotency key does not actually depend on this file - it is derived
 * from the artifact hash, so a restart computes the identical key from scratch.
 * The journal exists so that a human can reconcile afterwards, and so that a
 * rebuilt request that no longer matches the one already bound to the key is
 * caught here rather than by a 409 nobody knows how to interpret.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type JournalState = "prepared" | "sent" | "settled";

export interface JournalEntry {
  idempotencyKey: string;
  artifactHash: string;
  leg: string;
  /** Hash of the canonical request body bound to this key. */
  requestHash: string;
  state: JournalState;
  at: string;
  executionId?: string;
  transactionHash?: string;
}

export interface Journal {
  append(entry: JournalEntry): Promise<void>;
  /** The most recent entry for a key, or undefined if the key is new. */
  latest(idempotencyKey: string): Promise<JournalEntry | undefined>;
  all(): Promise<JournalEntry[]>;
}

export class MemoryJournal implements Journal {
  private readonly entries: JournalEntry[] = [];

  append(entry: JournalEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }

  latest(idempotencyKey: string): Promise<JournalEntry | undefined> {
    return Promise.resolve(
      this.entries.filter((e) => e.idempotencyKey === idempotencyKey).at(-1),
    );
  }

  all(): Promise<JournalEntry[]> {
    return Promise.resolve([...this.entries]);
  }
}

/**
 * Append-only JSONL.
 *
 * Append-only because an executor that rewrites its own history cannot be used
 * to work out what it did. A corrupt line is skipped rather than thrown on: a
 * reader that dies on bad input hides every good line after it, which is the
 * opposite of what someone investigating an ambiguous send needs.
 */
export class FileJournal implements Journal {
  constructor(private readonly path: string) {}

  async append(entry: JournalEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async all(): Promise<JournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    const entries: JournalEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // Skip; a truncated final line is the expected shape of a crash.
      }
    }
    return entries;
  }

  async latest(idempotencyKey: string): Promise<JournalEntry | undefined> {
    const entries = await this.all();
    return entries.filter((e) => e.idempotencyKey === idempotencyKey).at(-1);
  }
}
