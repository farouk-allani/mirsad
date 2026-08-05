import { keccak256, toHex } from "viem";
import { Verdict, type AuditRecord, type Finding, type QueuedSafeTransaction } from "./types.js";
import { runRules, verdictFrom, type RuleContext } from "./analysis/rules.js";
import type { Classifier } from "./analysis/classifier.js";
import type { SafeQueueSource } from "./safe/queue.js";
import type { KeeperHubClient } from "./keeperhub/client.js";

/**
 * The watch loop.
 *
 *   poll queue -> for each unseen transaction:
 *     deterministic rules -> classifier -> verdict -> (if VETO) write onchain
 *
 * Ordering is deliberate. Rules run first and can veto alone; the classifier
 * only ever adds context. If the classifier is slow or down, the loop still
 * protects the treasury.
 */

const REGISTRY_ABI = JSON.stringify([
  {
    inputs: [
      { internalType: "bytes32", name: "safeTxHash", type: "bytes32" },
      { internalType: "uint8", name: "level", type: "uint8" },
      { internalType: "bytes32", name: "reasonHash", type: "bytes32" },
    ],
    name: "setVerdict",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
]);

/** Numeric encoding of Verdict for the onchain registry's Level enum. */
const LEVEL_ONCHAIN: Record<Verdict, number> = {
  [Verdict.Allow]: 1,
  [Verdict.Warn]: 2,
  [Verdict.Veto]: 3,
};

export interface WatchOptions {
  queue: SafeQueueSource;
  classifier: Classifier;
  ruleContext: RuleContext;
  keeperhub: KeeperHubClient;
  chainId: string;
  registryAddress: `0x${string}`;
  /**
   * When false, MIRSAD assesses and records but never broadcasts. Default off:
   * arming the onchain response is an explicit act.
   */
  armed: boolean;
  /**
   * Native balance of the Safe, refreshed each tick. Without it the
   * proportional value checks cannot fire at all, so a drain reads as an
   * ordinary payment. Optional only so the loop degrades rather than refusing
   * to start when an RPC is unreachable.
   */
  balanceProvider?: () => Promise<bigint>;
  /**
   * Reads the registry before writing. The goal is the end state "this hash is
   * vetoed onchain" — if it already is, there is nothing to do. Without this
   * check the loop rediscovers a previously-vetoed transaction every tick,
   * fails the write against the registry's write-once rule, and retries
   * forever against a condition that is already satisfied.
   */
  alreadyVetoed?: (safeTxHash: `0x${string}`) => Promise<boolean>;
  onRecord?: (record: AuditRecord) => void | Promise<void>;
  log?: (msg: string) => void;
}

/**
 * The reason hash commits to the full audit record - findings, model reasoning,
 * everything - so the onchain veto is verifiable against an offchain document
 * without paying to store prose in storage.
 */
export function reasonHashOf(record: {
  safeTxHash: string;
  findings: readonly Finding[];
  verdict: Verdict;
}): `0x${string}` {
  return keccak256(toHex(JSON.stringify(record)));
}

/** Assess one queued transaction. Pure apart from the classifier call. */
export async function assess(
  tx: QueuedSafeTransaction,
  ctx: RuleContext,
  classifier: Classifier,
  statedIntent?: string,
): Promise<{ findings: Finding[]; verdict: Verdict }> {
  const ruleFindings = runRules(tx, ctx);

  // The classifier never throws - a provider outage degrades to rules-only.
  const modelFindings = await classifier.classify({
    transaction: tx,
    ruleFindings,
    ...(statedIntent === undefined ? {} : { statedIntent }),
  });

  const findings = [...ruleFindings, ...modelFindings];
  return { findings, verdict: verdictFrom(findings) };
}

export class Watchtower {
  /** safeTxHash values already assessed this process. */
  private readonly seen = new Set<string>();

  constructor(private readonly opts: WatchOptions) {}

  private log(msg: string) {
    (this.opts.log ?? ((m: string) => process.stdout.write(m + "\n")))(msg);
  }

  /** One pass over the queue. Returns the records produced. */
  async tick(): Promise<AuditRecord[]> {
    const pending = await this.opts.queue.fetchPending();
    const records: AuditRecord[] = [];

    // Refresh before assessing: proportional checks are meaningless against a
    // stale balance, and a drain is exactly when the balance is about to move.
    if (this.opts.balanceProvider) {
      try {
        this.opts.ruleContext.safeBalanceWei = await this.opts.balanceProvider();
      } catch (err) {
        this.log(`balance lookup failed (${(err as Error).message}); value checks disabled`);
      }
    }

    for (const tx of pending) {
      if (this.seen.has(tx.safeTxHash)) continue;
      this.seen.add(tx.safeTxHash);
      records.push(await this.handle(tx));
    }
    return records;
  }

  private async handle(tx: QueuedSafeTransaction): Promise<AuditRecord> {
    const observedAt = new Date().toISOString();
    this.log(
      `\nqueued  nonce=${tx.nonce}  to=${tx.to}  value=${tx.value}  ` +
        `sigs=${tx.confirmations.length}/${tx.confirmationsRequired}`,
    );
    this.log(`        ${tx.safeTxHash}`);

    const { findings, verdict } = await assess(tx, this.opts.ruleContext, this.opts.classifier);

    for (const f of findings) {
      this.log(`  [${f.severity}] ${f.code} (${f.source}) - ${f.summary}`);
    }
    this.log(`  verdict: ${verdict}`);

    const record: AuditRecord = {
      id: tx.safeTxHash,
      observedAt,
      transaction: tx,
      simulation: null,
      findings,
      verdict,
    };

    if (verdict === Verdict.Veto) {
      if (await this.isAlreadyEnforced(tx.safeTxHash)) {
        record.outcome = "completed";
        this.log(`  already vetoed onchain - the chain already refuses this transaction`);
      } else if (!this.opts.armed) {
        this.log(`  DISARMED - would write VETO onchain. Set MIRSAD_ARMED=true to act.`);
      } else {
        await this.writeVerdict(record);
      }
    }

    await this.opts.onRecord?.(record);
    return record;
  }

  /** A read failure must not block a veto: assume not-yet-enforced and write. */
  private async isAlreadyEnforced(safeTxHash: `0x${string}`): Promise<boolean> {
    if (!this.opts.alreadyVetoed) return false;
    try {
      return await this.opts.alreadyVetoed(safeTxHash);
    } catch (err) {
      this.log(`  registry read failed (${(err as Error).message}); proceeding with write`);
      return false;
    }
  }

  private async writeVerdict(record: AuditRecord): Promise<void> {
    const reasonHash = reasonHashOf({
      safeTxHash: record.transaction.safeTxHash,
      findings: record.findings,
      verdict: record.verdict,
    });

    try {
      const { simulation, execution } = await this.opts.keeperhub.writeContract({
        chainId: this.opts.chainId,
        contractAddress: this.opts.registryAddress,
        functionName: "setVerdict",
        functionArgs: [
          record.transaction.safeTxHash,
          LEVEL_ONCHAIN[record.verdict],
          reasonHash,
        ],
        abi: REGISTRY_ABI,
        // Deterministic: a retry of the same verdict is the same call, and the
        // registry accepts an identical replay, so this is safe end to end.
        idempotencyKey: `mirsad-${record.transaction.safeTxHash.slice(2, 26)}`,
      });

      record.executionId = execution.executionId;
      if (execution.transactionLink) record.transactionLink = execution.transactionLink;
      if (execution.gasUsedWei) record.gasUsed = execution.gasUsedWei;
      record.outcome = execution.status === "completed" ? "completed" : "failed";

      this.log(`  simulated: gas ${simulation.gasEstimate ?? "?"}, wouldRevert=false`);
      this.log(`  VETO WRITTEN ONCHAIN: ${execution.transactionLink ?? execution.executionId}`);
    } catch (err) {
      // A failed write must not stop the loop; the next tick retries with the
      // same idempotency key.
      record.outcome = "failed";
      this.seen.delete(record.transaction.safeTxHash);
      this.log(`  write failed: ${(err as Error).message} - will retry next tick`);
    }
  }

  /** Poll forever. Resolves only when `signal` aborts. */
  async run(intervalSeconds: number, signal?: AbortSignal): Promise<void> {
    this.log(
      `watching via ${this.opts.queue.name}, every ${intervalSeconds}s, ` +
        `${this.opts.armed ? "ARMED" : "disarmed (observe only)"}`,
    );
    while (!signal?.aborted) {
      try {
        await this.tick();
      } catch (err) {
        // Queue outages are expected; keep watching.
        this.log(`poll failed: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
    }
  }
}
