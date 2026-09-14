/**
 * The operator's view.
 *
 *   plan       run the Wayfinder planner and print what it proposes
 *   check      plan, then decide against the policy. Never broadcasts.
 *   execute    the same decision, then act on it. Broadcasts.
 *   journal    what previous runs left behind, finished or not
 *   reconcile  ask KeeperHub about anything unfinished. Never broadcasts.
 *
 * `check` and `execute` run identical code up to the point of sending, so the
 * thing an operator inspected is the thing that later executes rather than a
 * separate rehearsal of it.
 *
 * `--proposal <file>` replaces the planner with a saved proposal. The policy
 * does not know or care where a proposal came from, and the freshness rule
 * still applies, so a stale file is blocked like a stale planner.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  FileJournal,
  KeeperHubPositionReader,
  McpTransport,
  RpcPositionReader,
  reconcile,
  unfinished,
} from "@mirsad/keeperhub";
import type { PositionReader } from "@mirsad/keeperhub";
import { aaveBasePolicy, aaveMarket, isAaveChainId } from "@mirsad/policy";

import { plan } from "./plan.js";
import { run } from "./run.js";

interface Config {
  apiKey: string;
  actor: `0x${string}`;
  chainId: 8453 | 84532;
  rpcUrl: string;
  interpreter: string;
  script: string;
  journalPath: string;
}

const DEFAULT_RPC: Record<number, string> = {
  8453: "https://mainnet.base.org",
  84532: "https://sepolia.base.org",
};

/** Balances are bigint in memory and decimal strings on the wire. */
function bigintAsString(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function loadConfig(argv: Map<string, string>): Config {
  const apiKey = required("KEEPERHUB_API_KEY");
  if (!apiKey.startsWith("kh_")) {
    throw new Error("KEEPERHUB_API_KEY must be an organization key (kh_); wfb_ keys are a different system");
  }
  const chainId = Number(argv.get("chain") ?? process.env.MIRSAD_CHAIN_ID ?? 8453);
  if (!isAaveChainId(chainId)) {
    throw new Error(`chain ${chainId} has no pinned Aave market in this build`);
  }
  const root = resolve(process.cwd(), "v2/integrations/wayfinder");
  return {
    apiKey,
    actor: required("MIRSAD_ACTOR").toLowerCase() as `0x${string}`,
    chainId,
    rpcUrl: argv.get("rpc") ?? process.env.MIRSAD_RPC_URL ?? DEFAULT_RPC[chainId] ?? "",
    interpreter: process.env.MIRSAD_PYTHON ?? `${root}/.venv/Scripts/python.exe`,
    script: `${root}/paths/mirsad-guarded-aave/scripts/main.py`,
    journalPath: process.env.MIRSAD_JOURNAL ?? resolve(process.cwd(), "v2/.mirsad/journal.jsonl"),
  };
}

function parseArgv(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=", 2);
    if (!name) continue;
    flags.set(name, inline ?? argv[i + 1] ?? "true");
    if (inline === undefined) i += 1;
  }
  return flags;
}

function plannerArgs(config: Config, flags: Map<string, string>): string[] {
  const args = [
    "--chain-id",
    String(config.chainId),
    "--rpc-url",
    config.rpcUrl,
    "--amount",
    flags.get("amount") ?? "1",
    "--beneficiary",
    flags.get("beneficiary") ?? config.actor,
  ];
  const symbol = flags.get("symbol");
  return symbol ? [...args, "--symbol", symbol] : args;
}

function readersFor(config: Config, transport: McpTransport): PositionReader[] {
  const market = aaveMarket(config.chainId);
  return [
    new KeeperHubPositionReader(transport, {
      chainId: config.chainId,
      asset: market.usdc,
      user: config.actor,
    }),
    new RpcPositionReader({
      rpcUrl: config.rpcUrl,
      aToken: market.aUsdc as `0x${string}`,
      user: config.actor,
    }),
  ];
}

async function main(): Promise<void> {
  const [command = "check", ...rest] = process.argv.slice(2);
  const flags = parseArgv(rest);
  const config = loadConfig(flags);
  const journal = new FileJournal(config.journalPath);

  if (command === "journal") {
    const entries = await journal.all();
    const open = await unfinished(journal);
    console.log(JSON.stringify({ entries, unfinished: open.length }, null, 2));
    return;
  }
  if (command === "reconcile") {
    const transport = new McpTransport({ apiKey: config.apiKey });
    await transport.connect();
    const results = await reconcile(journal, transport);
    console.log(JSON.stringify(results, null, 2));
    if (results.some((r) => r.status !== "settled")) process.exitCode = 5;
    return;
  }

  const proposalFile = flags.get("proposal");
  const planned = proposalFile
    ? (JSON.parse(await readFile(resolve(proposalFile), "utf8")) as Awaited<ReturnType<typeof plan>>)
    : await plan({
        interpreter: config.interpreter,
        script: config.script,
        args: plannerArgs(config, flags),
        env: { MIRSAD_ACTOR: config.actor },
      });

  if (command === "plan") {
    console.log(JSON.stringify(planned, null, 2));
    return;
  }
  if (command !== "check" && command !== "execute") {
    throw new Error(`unknown command ${command}; expected plan, check or execute`);
  }

  const transport = new McpTransport({ apiKey: config.apiKey });
  await transport.connect();

  const policy = aaveBasePolicy({
    actor: config.actor,
    chainId: config.chainId,
    ...(flags.has("cap") ? { maxAmountBaseUnits: flags.get("cap") as string } : {}),
  });

  const report = await run({
    proposal: planned.proposal,
    policy,
    transport,
    journal,
    readers: readersFor(config, transport),
    now: new Date(),
    broadcast: command === "execute",
  });

  console.log(JSON.stringify({ rationale: planned.rationale, ...report }, bigintAsString, 2));
  if (report.decision.verdict === "BLOCK") process.exitCode = 2;
  if (report.outcome && report.outcome.kind !== "executed") process.exitCode = 3;
  if (report.postcondition && !report.postcondition.ok) process.exitCode = 4;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
