import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PlannerError, plan, scrubbedEnv } from "./plan.js";

/**
 * The planner under test is Node rather than Python, so these run anywhere.
 * What is being tested is the boundary, not the language on the far side.
 */
async function scriptWriting(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mirsad-plan-"));
  const path = join(dir, "planner.mjs");
  await writeFile(path, body, "utf8");
  return path;
}

describe("scrubbedEnv", () => {
  it("drops a KeeperHub key that is present in the parent environment", () => {
    const env = scrubbedEnv({
      PATH: "/usr/bin",
      KEEPERHUB_API_KEY: "kh_secret",
      DEPLOYER_PRIVATE_KEY: "0xdead",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.KEEPERHUB_API_KEY).toBeUndefined();
    expect(env.DEPLOYER_PRIVATE_KEY).toBeUndefined();
  });

  it("drops variables it has never heard of, rather than passing them through", () => {
    const env = scrubbedEnv({ PATH: "/usr/bin", SOME_FUTURE_SECRET: "value" });
    expect(env.SOME_FUTURE_SECRET).toBeUndefined();
  });

  it("passes through what was explicitly handed to it", () => {
    const env = scrubbedEnv({ PATH: "/usr/bin" }, { MIRSAD_ACTOR: "0xabc" });
    expect(env.MIRSAD_ACTOR).toBe("0xabc");
  });
});

describe("plan", () => {
  it("returns the proposal the planner printed", async () => {
    const script = await scriptWriting(
      `console.log(JSON.stringify({ proposal: { chainId: 8453 }, rationale: { supplyApy: 0.03 } }));`,
    );
    const result = await plan({ interpreter: process.execPath, script });
    expect(result.proposal).toEqual({ chainId: 8453 });
    expect(result.rationale).toEqual({ supplyApy: 0.03 });
  });

  /** The property that matters: a hostile Path cannot read the org key. */
  it("does not expose a secret from the parent process to the planner", async () => {
    const script = await scriptWriting(
      `console.log(JSON.stringify({ proposal: { leaked: process.env.KEEPERHUB_API_KEY ?? null } }));`,
    );
    process.env.KEEPERHUB_API_KEY = "kh_do_not_leak_this";
    try {
      const result = await plan({ interpreter: process.execPath, script });
      expect(result.proposal).toEqual({ leaked: null });
    } finally {
      delete process.env.KEEPERHUB_API_KEY;
    }
  });

  it("fails loudly when the planner exits non-zero", async () => {
    const script = await scriptWriting(
      `console.error("no reserve for USDC"); process.exit(3);`,
    );
    await expect(plan({ interpreter: process.execPath, script })).rejects.toThrow(
      PlannerError,
    );
  });

  it("fails when the planner prints something that is not JSON", async () => {
    const script = await scriptWriting(`console.log("Traceback (most recent call last):");`);
    await expect(plan({ interpreter: process.execPath, script })).rejects.toThrow(
      /did not emit JSON/,
    );
  });

  it("fails when the output is JSON but carries no proposal", async () => {
    const script = await scriptWriting(`console.log(JSON.stringify({ rationale: {} }));`);
    await expect(plan({ interpreter: process.execPath, script })).rejects.toThrow(
      /no proposal/,
    );
  });

  it("kills a planner that hangs instead of waiting on it forever", async () => {
    const script = await scriptWriting(`setInterval(() => {}, 1000);`);
    await expect(
      plan({ interpreter: process.execPath, script, timeoutMs: 300 }),
    ).rejects.toThrow(PlannerError);
  });
});
