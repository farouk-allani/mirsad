#!/usr/bin/env node
import "dotenv/config";
import { loadConfig } from "@mirsad/core";

/**
 * MIRSAD operator entrypoint.
 *
 * Only `doctor` is wired today: it validates the environment and reports what is
 * still missing before the watch loop can arm. Everything else is deliberately
 * absent rather than stubbed — see CLAUDE.md §9 for the build order.
 */

const COMMANDS = ["doctor"] as const;
type Command = (typeof COMMANDS)[number];

function usage(): never {
  process.stderr.write(`mirsad — the watchtower\n\nusage: mirsad <command>\n\ncommands:\n  doctor    validate environment and report readiness\n`);
  process.exit(2);
}

function doctor(): number {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const checks: Array<[string, boolean, string]> = [
    ["KeeperHub org key", true, `${config.KEEPERHUB_API_KEY.slice(0, 6)}…`],
    ["KeeperHub endpoint", true, config.KEEPERHUB_API_URL],
    ["Watch chain", true, config.MIRSAD_CHAIN_ID],
    ["Guarded Safe", Boolean(config.MIRSAD_SAFE_ADDRESS), config.MIRSAD_SAFE_ADDRESS ?? "not set — deploy a Safe first"],
    ["Verdict registry", Boolean(config.MIRSAD_REGISTRY_ADDRESS), config.MIRSAD_REGISTRY_ADDRESS ?? "not deployed yet"],
    ["Safe guard", Boolean(config.MIRSAD_GUARD_ADDRESS), config.MIRSAD_GUARD_ADDRESS ?? "not deployed yet"],
    [
      "Classifier",
      config.MIRSAD_CLASSIFIER === "none" || Boolean(config.CLASSIFIER_API_KEY),
      config.MIRSAD_CLASSIFIER === "none"
        ? "rules-only (supported mode)"
        : `${config.MIRSAD_CLASSIFIER} · ${config.CLASSIFIER_MODEL}`,
    ],
    ["Onchain response", config.MIRSAD_ARMED, config.MIRSAD_ARMED ? "ARMED" : "disarmed (observe only)"],
  ];

  for (const [label, ok, detail] of checks) {
    process.stdout.write(`${ok ? "ok  " : "--  "} ${label.padEnd(20)} ${detail}\n`);
  }

  return 0;
}

const command = process.argv[2];
if (!command || !COMMANDS.includes(command as Command)) usage();

process.exit(doctor());
