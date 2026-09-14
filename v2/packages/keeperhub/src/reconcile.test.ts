import { describe, expect, it } from "vitest";

import { MemoryJournal } from "./journal.js";
import type { JournalEntry } from "./journal.js";
import { reconcile, unfinished } from "./reconcile.js";
import { type Transport, TransportError } from "./transport.js";

const HASH = `0x${"a".repeat(64)}`;

function entry(overrides: Partial<JournalEntry>): JournalEntry {
  return {
    idempotencyKey: `mirsad:${HASH}:approve`,
    artifactHash: HASH,
    leg: "approve",
    requestHash: `0x${"b".repeat(64)}`,
    state: "prepared",
    at: "2026-09-09T12:00:00.000Z",
    ...overrides,
  };
}

function statusTransport(response: unknown): Transport {
  return {
    callTool: <T>() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response as T),
  };
}

const silent: Transport = {
  callTool: () => Promise.reject(new Error("reconcile must not call KeeperHub for this entry")),
};

describe("unfinished", () => {
  it("returns only the latest state for each key, and only if it is not settled", async () => {
    const journal = new MemoryJournal();
    await journal.append(entry({ state: "prepared" }));
    await journal.append(entry({ state: "sent", executionId: "e1" }));
    await journal.append(entry({ state: "settled", executionId: "e1" }));
    await journal.append(
      entry({ idempotencyKey: `mirsad:${HASH}:action`, leg: "action", state: "sent", executionId: "e2" }),
    );
    const open = await unfinished(journal);
    expect(open.map((e) => e.leg)).toEqual(["action"]);
  });
});

describe("reconcile", () => {
  it("marks a sent leg settled when KeeperHub says it completed", async () => {
    const journal = new MemoryJournal();
    await journal.append(entry({ state: "sent", executionId: "e1" }));
    const results = await reconcile(
      journal,
      statusTransport({ status: "completed", transactionHash: `0x${"c".repeat(64)}` }),
    );
    expect(results[0]?.status).toBe("settled");
    expect((await journal.all()).at(-1)?.state).toBe("settled");
    expect(await unfinished(journal)).toHaveLength(0);
  });

  it("reports a failed execution without pretending it can be resumed", async () => {
    const journal = new MemoryJournal();
    await journal.append(entry({ state: "sent", executionId: "e1" }));
    const results = await reconcile(journal, statusTransport({ status: "failed" }));
    expect(results[0]?.status).toBe("failed");
    expect(await unfinished(journal)).toHaveLength(1);
  });

  it("leaves a pending execution open", async () => {
    const journal = new MemoryJournal();
    await journal.append(entry({ state: "sent", executionId: "e1" }));
    const results = await reconcile(journal, statusTransport({ status: "pending" }));
    expect(results[0]?.status).toBe("pending");
  });

  it("does not query KeeperHub for a leg that was prepared but never sent", async () => {
    const journal = new MemoryJournal();
    await journal.append(entry({ state: "prepared" }));
    const results = await reconcile(journal, silent);
    expect(results[0]?.status).toBe("unsent");
    if (results[0]?.status === "unsent") expect(results[0].advice).toMatch(/same artifact/);
  });

  it("reports unknown rather than guessing when the status query fails", async () => {
    const journal = new MemoryJournal();
    await journal.append(entry({ state: "sent", executionId: "e1" }));
    const results = await reconcile(
      journal,
      statusTransport(new TransportError("HTTP 503", "unavailable", "get_direct_execution_status")),
    );
    expect(results[0]?.status).toBe("unknown");
    expect(await unfinished(journal)).toHaveLength(1);
  });

  it("never sends a transaction", async () => {
    const journal = new MemoryJournal();
    await journal.append(entry({ state: "sent", executionId: "e1" }));
    const names: string[] = [];
    await reconcile(journal, {
      callTool: <T>(name: string) => {
        names.push(name);
        return Promise.resolve({ status: "completed" } as T);
      },
    });
    expect(names).toEqual(["get_direct_execution_status"]);
  });
});
