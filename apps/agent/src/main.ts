#!/usr/bin/env node
import "dotenv/config";
import { createPublicClient, http } from "viem";
import {
  JsonlAuditTrail,
  KeeperHubClient,
  KeeperHubQueueSource,
  SafeTransactionServiceSource,
  Watchtower,
  createClassifier,
  loadConfig,
  type MirsadConfig,
  type SafeQueueSource,
} from "@mirsad/core";

/**
 * MIRSAD operator entrypoint.
 *
 *   mirsad doctor   validate environment and report readiness
 *   mirsad watch    poll the guarded Safe's queue and assess every entry
 */

import { publish } from "./publish.js";

const COMMANDS = ["doctor", "watch", "audit", "publish"] as const;
type Command = (typeof COMMANDS)[number];

function usage(): never {
  process.stderr.write(
    `mirsad — the watchtower\n\n` +
      `usage: mirsad <command>\n\n` +
      `commands:\n` +
      `  doctor    validate environment and report readiness\n` +
      `  watch     poll the guarded Safe's queue and assess every entry\n` +
      `  audit     print the audit trail and verify its hash chain\n  publish   publish MIRSAD to the KeeperHub marketplace\n`,
  );
  process.exit(2);
}

function loadOrExit(): MirsadConfig {
  try {
    return loadConfig();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
}

function doctor(config: MirsadConfig): number {
  const checks: Array<[string, boolean, string]> = [
    ["KeeperHub org key", true, `${config.KEEPERHUB_API_KEY.slice(0, 6)}…`],
    ["KeeperHub endpoint", true, config.KEEPERHUB_API_URL],
    ["Watch chain", true, config.MIRSAD_CHAIN_ID],
    [
      "Guarded Safe",
      Boolean(config.MIRSAD_SAFE_ADDRESS),
      config.MIRSAD_SAFE_ADDRESS ?? "not set — deploy a Safe first",
    ],
    [
      "Verdict registry",
      Boolean(config.MIRSAD_REGISTRY_ADDRESS),
      config.MIRSAD_REGISTRY_ADDRESS ?? "not deployed yet",
    ],
    [
      "Safe guard",
      Boolean(config.MIRSAD_GUARD_ADDRESS),
      config.MIRSAD_GUARD_ADDRESS ?? "not deployed yet",
    ],
    [
      "Queue source",
      Boolean(config.MIRSAD_QUEUE_WORKFLOW_ID ?? config.SAFE_API_KEY),
      config.MIRSAD_QUEUE_WORKFLOW_ID
        ? `KeeperHub workflow ${config.MIRSAD_QUEUE_WORKFLOW_ID}`
        : config.SAFE_API_KEY
          ? "Safe Transaction Service (direct)"
          : "none — set MIRSAD_QUEUE_WORKFLOW_ID or SAFE_API_KEY",
    ],
    [
      "Classifier",
      config.MIRSAD_CLASSIFIER === "none" || Boolean(config.CLASSIFIER_API_KEY),
      config.MIRSAD_CLASSIFIER === "none"
        ? "rules-only (supported mode)"
        : `${config.MIRSAD_CLASSIFIER} · ${config.CLASSIFIER_MODEL}`,
    ],
    [
      "Onchain response",
      config.MIRSAD_ARMED,
      config.MIRSAD_ARMED ? "ARMED" : "disarmed (observe only)",
    ],
  ];

  for (const [label, ok, detail] of checks) {
    process.stdout.write(`${ok ? "ok  " : "--  "} ${label.padEnd(20)} ${detail}\n`);
  }
  return 0;
}

/** Prefer the KeeperHub Safe plugin; fall back to Safe directly. */
function buildQueueSource(config: MirsadConfig, kh: KeeperHubClient): SafeQueueSource {
  if (config.MIRSAD_QUEUE_WORKFLOW_ID) {
    return new KeeperHubQueueSource(
      (id) => kh.runWorkflow(id),
      config.MIRSAD_QUEUE_WORKFLOW_ID,
    );
  }
  if (!config.MIRSAD_SAFE_ADDRESS) {
    throw new Error("MIRSAD_SAFE_ADDRESS is required to watch a Safe.");
  }
  return new SafeTransactionServiceSource(
    config.MIRSAD_SAFE_ADDRESS as `0x${string}`,
    config.MIRSAD_CHAIN_ID,
    config.SAFE_API_KEY,
  );
}

async function watch(config: MirsadConfig): Promise<number> {
  if (!config.MIRSAD_SAFE_ADDRESS || !config.MIRSAD_REGISTRY_ADDRESS) {
    process.stderr.write("MIRSAD_SAFE_ADDRESS and MIRSAD_REGISTRY_ADDRESS are required.\n");
    return 1;
  }

  const kh = new KeeperHubClient({
    apiKey: config.KEEPERHUB_API_KEY,
    baseUrl: config.KEEPERHUB_API_URL,
  });
  await kh.connect();

  const safeAddress = config.MIRSAD_SAFE_ADDRESS as `0x${string}`;
  const rpcUrl = config.MIRSAD_RPC_URL;
  if (!rpcUrl) {
    process.stdout.write(
      "warning: MIRSAD_RPC_URL unset — proportional value checks are disabled,\n" +
        "         so a drain will not be distinguished from an ordinary payment.\n",
    );
  }
  const rpc = rpcUrl ? createPublicClient({ transport: http(rpcUrl) }) : null;
  const trail = new JsonlAuditTrail(config.MIRSAD_AUDIT_PATH);

  const tower = new Watchtower({
    queue: buildQueueSource(config, kh),
    classifier: createClassifier(config),
    ruleContext: {
      safeAddress: config.MIRSAD_SAFE_ADDRESS as `0x${string}`,
      addressBook: config.MIRSAD_ADDRESS_BOOK,
    },
    keeperhub: kh,
    chainId: config.MIRSAD_CHAIN_ID,
    registryAddress: config.MIRSAD_REGISTRY_ADDRESS as `0x${string}`,
    armed: config.MIRSAD_ARMED,
    onRecord: async (record) => {
      const entry = await trail.append(record);
      process.stdout.write(`  audit  #${entry.seq}  ${entry.recordHash}\n`);
    },
    ...(rpc
      ? {
          balanceProvider: () => rpc.getBalance({ address: safeAddress }),
          alreadyVetoed: (safeTxHash: `0x${string}`) =>
            rpc.readContract({
              address: config.MIRSAD_REGISTRY_ADDRESS as `0x${string}`,
              abi: [
                {
                  type: "function",
                  name: "isVetoed",
                  stateMutability: "view",
                  inputs: [{ name: "safeTxHash", type: "bytes32" }],
                  outputs: [{ type: "bool" }],
                },
              ] as const,
              functionName: "isVetoed",
              args: [safeTxHash],
            }),
        }
      : {}),
  });

  const controller = new AbortController();
  process.on("SIGINT", () => {
    process.stdout.write("\nstopping\n");
    controller.abort();
  });

  await tower.run(config.MIRSAD_POLL_INTERVAL_SECONDS, controller.signal);
  return 0;
}

function audit(config: MirsadConfig): number {
  const trail = new JsonlAuditTrail(config.MIRSAD_AUDIT_PATH);
  const entries = trail.entries();

  if (entries.length === 0) {
    process.stdout.write(`no audit records at ${config.MIRSAD_AUDIT_PATH}\n`);
    return 0;
  }

  for (const { seq, recordHash, record } of entries) {
    const tx = record.transaction;
    process.stdout.write(
      `\n#${seq}  ${record.observedAt}  ${record.verdict}\n` +
        `  safeTx   ${tx.safeTxHash}\n` +
        `  to       ${tx.to}  value=${tx.value}  nonce=${tx.nonce}\n` +
        `  reason   ${recordHash}\n`,
    );
    for (const f of record.findings) {
      process.stdout.write(`  [${f.severity}] ${f.code} (${f.source}) ${f.summary}\n`);
    }
    if (record.transactionLink) {
      process.stdout.write(`  onchain  ${record.transactionLink}  gas=${record.gasUsed ?? "?"}\n`);
    }
  }

  const result = trail.verify();
  process.stdout.write(
    result.ok
      ? `\nchain verified: ${result.count} records, unbroken.\n`
      : `\nCHAIN BROKEN at entry #${result.failedAt}: ${result.reason}\n`,
  );
  return result.ok ? 0 : 1;
}

const command = process.argv[2];
if (!command || !COMMANDS.includes(command as Command)) usage();

const config = loadOrExit();
const code =
  command === "watch"
    ? await watch(config)
    : command === "audit"
      ? audit(config)
      : command === "publish"
        ? await publish(config)
        : doctor(config);
process.exit(code);
