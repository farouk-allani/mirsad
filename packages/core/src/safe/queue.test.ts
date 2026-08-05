import { describe, expect, it } from "vitest";
import {
  KeeperHubQueueSource,
  SafeQueueUnavailableError,
  SafeTransactionServiceSource,
  normaliseQueueEntry,
} from "./queue.js";
import { SafeOperation } from "../types.js";

/** A recorded Safe Transaction Service entry, trimmed to the fields we consume. */
const RAW = {
  safe: "0x499d502527243c56434749cabd01a115e298e338",
  safeTxHash: "0x8e526a33de78a5a76cec64232eb2a5e338f4342cf67d738844f3433c50442f49",
  to: "0x000000000000000000000000000000000000dead",
  value: "40000000000000000",
  data: null,
  operation: 0,
  nonce: 3,
  confirmationsRequired: 2,
  confirmations: [{ owner: "0xbda7bbd52145d8fbfe96798c54ea35a70825e056" }],
  proposer: "0xbda7bbd52145d8fbfe96798c54ea35a70825e056",
  submissionDate: "2026-08-05T18:00:00Z",
  isExecuted: false,
};

describe("normalisation", () => {
  it("checksums addresses so address-book comparisons are reliable", () => {
    const tx = normaliseQueueEntry(RAW)!;
    expect(tx.safe).toBe("0x499d502527243c56434749CAbd01A115E298e338");
    expect(tx.to).toBe("0x000000000000000000000000000000000000dEaD");
    // Checksum matches the owner address emitted by scripts/deploy-safe.ts.
    expect(tx.confirmations[0]!.owner).toBe("0xbdA7bBd52145d8FBFE96798c54ea35a70825e056");
  });

  it("maps operation 1 to DelegateCall", () => {
    expect(normaliseQueueEntry({ ...RAW, operation: 1 })!.operation).toBe(
      SafeOperation.DelegateCall,
    );
  });

  it("treats empty calldata as absent so detectors need not special-case 0x", () => {
    expect(normaliseQueueEntry({ ...RAW, data: "0x" })!.data).toBeNull();
  });

  it("drops already-executed transactions", () => {
    expect(normaliseQueueEntry({ ...RAW, isExecuted: true })).toBeNull();
  });

  it("drops malformed entries rather than throwing mid-poll", () => {
    expect(normaliseQueueEntry(null)).toBeNull();
    expect(normaliseQueueEntry({ nonce: 1 })).toBeNull();
  });
});

describe("KeeperHub source", () => {
  it("returns the queue oldest-nonce-first", async () => {
    const src = new KeeperHubQueueSource(
      async () => ({
        success: true,
        transactions: [
          { ...RAW, nonce: 5, safeTxHash: "0xbb" },
          { ...RAW, nonce: 2, safeTxHash: "0xaa" },
        ],
      }),
      "wf-1",
    );
    expect((await src.fetchPending()).map((t) => t.nonce)).toEqual([2, 5]);
  });

  it("surfaces a missing Safe credential with an actionable remedy", async () => {
    const src = new KeeperHubQueueSource(
      async () => ({ error: "Safe API key is required. Configure it in the integration settings." }),
      "wf-1",
    );
    await expect(src.fetchPending()).rejects.toThrow(SafeQueueUnavailableError);
    await expect(src.fetchPending()).rejects.toThrow(/Safe API key is required/);
  });

  it("treats an empty queue as empty, not as an error", async () => {
    const src = new KeeperHubQueueSource(async () => ({ success: true, transactions: [] }), "wf-1");
    expect(await src.fetchPending()).toEqual([]);
  });
});

describe("Transaction Service source", () => {
  it("refuses to construct for a chain it has no host for", () => {
    expect(() => new SafeTransactionServiceSource("0x00", "999999")).toThrow(
      SafeQueueUnavailableError,
    );
  });

  it("accepts every chain MIRSAD targets", () => {
    for (const chain of ["1", "11155111", "8453", "84532"]) {
      expect(
        () => new SafeTransactionServiceSource("0x499d502527243c56434749CAbd01A115E298e338", chain),
      ).not.toThrow();
    }
  });
});
