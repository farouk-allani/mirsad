/**
 * Running the planner, without handing it anything worth stealing.
 *
 * The Wayfinder Path is a separate process for one reason: so that the
 * environment it runs in can be built rather than inherited. Wayfinder's own
 * local runner passes `os.environ.copy()` to Path code, which means any secret
 * exported in the parent shell is readable by whatever a Path decides to do
 * with it. A Path is community-authored code that a user installs. It should
 * not be able to read a KeeperHub organization key, and here it cannot, because
 * the key is never in the environment it is given.
 *
 * The proposal that comes back is parsed as data and nothing else. It is not
 * eval'd, its addresses are not resolved, and no field of it reaches KeeperHub
 * without passing the policy first.
 */

import { spawn } from "node:child_process";

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "PlannerError";
  }
}

/**
 * Variables the child genuinely needs to run at all.
 *
 * An allowlist rather than a denylist: a denylist protects the secrets someone
 * remembered to name, and the interesting one is always the one they did not.
 */
const PASSTHROUGH = [
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "PYTHONIOENCODING",
  "PYTHONUTF8",
];

export function scrubbedEnv(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  // Text out of Python is parsed as JSON; a code page that mangles it is a
  // confusing failure a long way from its cause.
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  return { ...env, ...extra };
}

export interface PlanOptions {
  /** Interpreter to run. Taking this as a parameter keeps the venv explicit. */
  interpreter: string;
  script: string;
  args?: string[];
  /** Passed to the child in addition to the allowlist. Never secrets. */
  env?: Record<string, string>;
  timeoutMs?: number;
  cwd?: string;
}

export interface PlanResult {
  proposal: unknown;
  rationale?: unknown;
}

export async function plan(options: PlanOptions): Promise<PlanResult> {
  const { interpreter, script, args = [], env = {}, timeoutMs = 120_000, cwd } = options;

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  const child = spawn(interpreter, [script, ...args], {
    env: scrubbedEnv(process.env, env),
    ...(cwd ? { cwd } : {}),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode));
  }).finally(() => clearTimeout(timer));

  const err = Buffer.concat(stderr).toString("utf8").trim();
  if (code !== 0) {
    throw new PlannerError(`planner exited with code ${code}`, err);
  }

  const raw = Buffer.concat(stdout).toString("utf8").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PlannerError(`planner did not emit JSON: ${raw.slice(0, 300)}`, err);
  }

  if (typeof parsed !== "object" || parsed === null || !("proposal" in parsed)) {
    throw new PlannerError("planner output has no proposal field");
  }

  const { proposal, rationale } = parsed as PlanResult;
  return rationale === undefined ? { proposal } : { proposal, rationale };
}
