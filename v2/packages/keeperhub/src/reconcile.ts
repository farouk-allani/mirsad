/**
 * Finishing what a previous run started.
 *
 * A journal entry in `prepared` or `sent` is a question: did this go out, and
 * did it land? `reconcile` answers what it can from KeeperHub's own record of
 * the execution, and says plainly when it cannot. It does not send anything.
 * Re-sending is what `executeArtifact` does when handed the same artifact,
 * under the same key, which is the only correct way to retry.
 */

import type { Journal, JournalEntry } from "./journal.js";
import { type Transport, TransportError } from "./transport.js";

export type Reconciliation =
  /** KeeperHub confirms the execution settled; the journal has been updated. */
  | { entry: JournalEntry; status: "settled"; transactionHash?: string }
  /** KeeperHub confirms it failed. Nothing to resume; a person decides. */
  | { entry: JournalEntry; status: "failed"; transactionHash?: string }
  /** Still running. Ask again later. */
  | { entry: JournalEntry; status: "pending"; lastStatus: string }
  /**
   * Prepared but never recorded as sent. Either the crash came before the
   * send, or after it but before the journal write. KeeperHub's idempotency
   * window is the answer: re-running with the same artifact reuses the key,
   * and the server returns the original result if one exists.
   */
  | { entry: JournalEntry; status: "unsent"; advice: string }
  /** The status query itself failed. Nothing is known. */
  | { entry: JournalEntry; status: "unknown"; message: string };

interface StatusResponse {
  status?: string;
  transactionHash?: string;
}

/** Entries whose most recent state is not settled, one per idempotency key. */
export async function unfinished(journal: Journal): Promise<JournalEntry[]> {
  const latest = new Map<string, JournalEntry>();
  for (const entry of await journal.all()) {
    latest.set(entry.idempotencyKey, entry);
  }
  return [...latest.values()].filter((e) => e.state !== "settled");
}

export async function reconcile(
  journal: Journal,
  transport: Transport,
): Promise<Reconciliation[]> {
  const results: Reconciliation[] = [];

  for (const entry of await unfinished(journal)) {
    if (entry.state === "prepared" || !entry.executionId) {
      results.push({
        entry,
        status: "unsent",
        advice:
          "re-run execute with the same artifact; the idempotency key is derived from it " +
          "and KeeperHub returns the original result if a send did go out",
      });
      continue;
    }

    let response: StatusResponse;
    try {
      response = await transport.callTool<StatusResponse>("get_direct_execution_status", {
        execution_id: entry.executionId,
      });
    } catch (cause) {
      const message =
        cause instanceof TransportError ? `${cause.kind}: ${cause.message}` : String(cause);
      results.push({ entry, status: "unknown", message });
      continue;
    }

    if (response.status === "completed") {
      await journal.append({
        ...entry,
        state: "settled",
        at: new Date().toISOString(),
        ...(response.transactionHash ? { transactionHash: response.transactionHash } : {}),
      });
      results.push({
        entry,
        status: "settled",
        ...(response.transactionHash ? { transactionHash: response.transactionHash } : {}),
      });
    } else if (response.status === "failed") {
      results.push({
        entry,
        status: "failed",
        ...(response.transactionHash ? { transactionHash: response.transactionHash } : {}),
      });
    } else {
      results.push({ entry, status: "pending", lastStatus: response.status ?? "unknown" });
    }
  }

  return results;
}
