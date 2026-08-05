import { getAddress } from "viem";
import { SafeOperation, type QueuedSafeTransaction } from "../types.js";

/**
 * Where MIRSAD gets the Safe's pending queue.
 *
 * Two sources, same shape:
 *
 *  - `KeeperHubQueueSource` runs a KeeperHub workflow whose node is the Safe
 *    plugin's `safe/get-pending-transactions`. This is the preferred path: the
 *    trigger, the credential, and the run log all live in KeeperHub, so the
 *    audit trail is complete on their side too.
 *
 *  - `SafeTransactionServiceSource` talks to the Safe Transaction Service
 *    directly. Used when the KeeperHub Safe integration has no API key yet, so
 *    a new builder is never blocked on a credential to see MIRSAD work.
 *
 * Both need a Safe API key somewhere; the difference is who holds it.
 */

export interface SafeQueueSource {
  readonly name: string;
  /** Pending, unexecuted transactions, oldest nonce first. */
  fetchPending(): Promise<QueuedSafeTransaction[]>;
}

export class SafeQueueUnavailableError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = "SafeQueueUnavailableError";
  }
}

/**
 * Safe chain shortnames for the unified Transaction Service.
 *
 * Verified 2026-08-05: the per-chain `safe-transaction-<chain>.safe.global`
 * hosts now answer 308 and the live endpoint is
 * `https://api.safe.global/tx-service/<shortname>/api/v1/...`. A 308 is a
 * redirect a plain client may not follow with the Authorization header intact,
 * so this reads as an auth failure if you don't check the status code.
 */
const SAFE_CHAIN_SHORTNAMES: Record<string, string> = {
  "1": "eth",
  "10": "oeth",
  "137": "matic",
  "8453": "base",
  "42161": "arb1",
  "11155111": "sep",
  "84532": "basesep",
};

const txServiceBase = (shortname: string) => `https://api.safe.global/tx-service/${shortname}`;

/** Raw Safe Transaction Service shape, narrowed to what we consume. */
interface TxServiceEntry {
  safe: string;
  safeTxHash: string;
  to: string;
  value: string;
  data: string | null;
  operation: number;
  nonce: number;
  confirmationsRequired: number;
  confirmations?: { owner: string }[];
  proposer?: string | null;
  submissionDate?: string;
  isExecuted?: boolean;
}

/**
 * Normalise whatever the source returned into our domain type.
 *
 * Kept separate and exported so it can be tested against recorded fixtures
 * without any network, and so both sources cannot drift in how they parse.
 */
export function normaliseQueueEntry(raw: unknown): QueuedSafeTransaction | null {
  const e = raw as TxServiceEntry;
  if (!e || typeof e.safeTxHash !== "string" || typeof e.to !== "string") return null;
  if (e.isExecuted) return null;

  return {
    safe: getAddress(e.safe) as `0x${string}`,
    safeTxHash: e.safeTxHash as `0x${string}`,
    to: getAddress(e.to) as `0x${string}`,
    value: String(e.value ?? "0"),
    data: e.data && e.data !== "0x" ? (e.data as `0x${string}`) : null,
    operation: e.operation === 1 ? SafeOperation.DelegateCall : SafeOperation.Call,
    nonce: Number(e.nonce ?? 0),
    confirmationsRequired: Number(e.confirmationsRequired ?? 0),
    confirmations: (e.confirmations ?? []).map((c) => ({
      owner: getAddress(c.owner) as `0x${string}`,
    })),
    ...(e.proposer ? { proposedBy: getAddress(e.proposer) as `0x${string}` } : {}),
    ...(e.submissionDate ? { submissionDate: e.submissionDate } : {}),
  };
}

function byNonce(a: QueuedSafeTransaction, b: QueuedSafeTransaction) {
  return a.nonce - b.nonce;
}

/** Preferred path: the Safe plugin, via a KeeperHub workflow. */
export class KeeperHubQueueSource implements SafeQueueSource {
  readonly name = "keeperhub:safe-plugin";

  constructor(
    private readonly runWorkflow: (workflowId: string) => Promise<unknown>,
    private readonly workflowId: string,
  ) {}

  async fetchPending(): Promise<QueuedSafeTransaction[]> {
    const output = (await this.runWorkflow(this.workflowId)) as
      | { transactions?: unknown[]; success?: boolean; error?: string }
      | undefined;

    if (output?.error) {
      throw new SafeQueueUnavailableError(
        `KeeperHub Safe plugin: ${output.error}`,
        "Add a Safe Transaction Service API key under KeeperHub integration settings, " +
          "or set SAFE_API_KEY to use the direct Transaction Service source.",
      );
    }
    return (output?.transactions ?? [])
      .map(normaliseQueueEntry)
      .filter((t): t is QueuedSafeTransaction => t !== null)
      .sort(byNonce);
  }
}

/** Fallback path: the Safe Transaction Service, spoken to directly. */
export class SafeTransactionServiceSource implements SafeQueueSource {
  readonly name = "safe-transaction-service";
  private readonly host: string;

  constructor(
    private readonly safeAddress: `0x${string}`,
    chainId: string,
    private readonly apiKey?: string,
    private readonly timeoutMs = 15_000,
  ) {
    const shortname = SAFE_CHAIN_SHORTNAMES[chainId];
    if (!shortname) {
      throw new SafeQueueUnavailableError(
        `No Safe Transaction Service shortname known for chain ${chainId}.`,
        `Supported chains: ${Object.keys(SAFE_CHAIN_SHORTNAMES).join(", ")}.`,
      );
    }
    this.host = txServiceBase(shortname);
  }

  async fetchPending(): Promise<QueuedSafeTransaction[]> {
    const url =
      `${this.host}/api/v1/safes/${this.safeAddress}/multisig-transactions/` +
      `?executed=false&limit=50&ordering=nonce`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new SafeQueueUnavailableError(
          `Safe Transaction Service rejected the request (HTTP ${res.status}).`,
          "Set SAFE_API_KEY. Safe requires an API key from developer.safe.global.",
        );
      }
      if (res.status === 301 || res.status === 308) {
        throw new SafeQueueUnavailableError(
          `Safe Transaction Service redirected (HTTP ${res.status}) to ${res.headers.get("location") ?? "an unknown host"}.`,
          "The per-chain safe-transaction-*.safe.global hosts are retired. Update SAFE_CHAIN_SHORTNAMES.",
        );
      }
      if (!res.ok) throw new Error(`Safe Transaction Service HTTP ${res.status}`);

      const body = (await res.json()) as { results?: unknown[] };
      return (body.results ?? [])
        .map(normaliseQueueEntry)
        .filter((t): t is QueuedSafeTransaction => t !== null)
        .sort(byNonce);
    } finally {
      clearTimeout(timer);
    }
  }
}
