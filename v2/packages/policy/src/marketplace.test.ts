/**
 * The marketplace engine makes the same decisions as this package.
 *
 * marketplace/engine.js is a second implementation, written for a sandbox
 * that cannot import anything. This is what keeps it honest: every vector in
 * marketplace/vectors.json was decided by the TypeScript engine, and the
 * sandbox copy has to produce the same verdict, the same hashes, the same
 * artifact and the same rule ids for each one.
 *
 * Messages are compared exactly for every rule except `schema`, whose wording
 * comes from zod on one side and from hand-written parsing on the other.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";

import { hashCanonical } from "./canonical.js";
import type { Decision } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = readFileSync(resolve(here, "../marketplace/engine.js"), "utf8");

interface Vector {
  name: string;
  now: string;
  intent: unknown;
  policy: unknown;
  expected: Decision;
}
const VECTORS = JSON.parse(
  readFileSync(resolve(here, "../marketplace/vectors.json"), "utf8"),
) as Vector[];

/** Run the engine the way KeeperHub does: bindings above, async, top-level return. */
function runEngine(intent: unknown, policy: unknown, now?: string): Promise<Decision> {
  const source =
    `const rawIntent = ${JSON.stringify(intent)};\n` +
    `const rawPolicy = ${JSON.stringify(policy)};\n` +
    ENGINE;
  const wrapped = `(async () => {\n${source}\n})()`;
  return runInNewContext(wrapped, {
    TextEncoder,
    ...(now ? { __MIRSAD_NOW: now } : {}),
  }) as Promise<Decision>;
}

describe("the marketplace engine's keccak", () => {
  const cases = ["", "abc", '{"a":1}', "x".repeat(200), "مِرْصاد"];
  for (const text of cases) {
    it(`matches viem for ${JSON.stringify(text.slice(0, 12))}${text.length > 12 ? "…" : ""}`, async () => {
      const probe =
        `const rawIntent = null; const rawPolicy = null;\n` +
        ENGINE.replace(/return decide\(.*\);\s*$/s, `return keccak256(${JSON.stringify(text)});`);
      const got = await runInNewContext(`(async () => {\n${probe}\n})()`, { TextEncoder });
      expect(got).toBe(keccak256(toHex(text)));
    });
  }
});

describe("the marketplace engine against the golden vectors", () => {
  it("has enough vectors to mean something", () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(25);
  });

  for (const v of VECTORS) {
    it(v.name, async () => {
      const got = await runEngine(v.intent, v.policy, v.now);

      expect(got.verdict).toBe(v.expected.verdict);
      expect(got.intentHash).toBe(v.expected.intentHash);
      expect(got.policyHash).toBe(v.expected.policyHash);

      if (v.expected.verdict === "ALLOW") {
        if (got.verdict !== "ALLOW") throw new Error("verdict mismatch");
        expect(got.artifact).toEqual(v.expected.artifact);
        expect(got.artifactHash).toBe(v.expected.artifactHash);
        // And the hash the sandbox reports is the hash this package computes
        // over the artifact it returned - not merely a copy of the expected.
        // Round-tripped through JSON, as it travels: the object belongs to
        // the vm's realm and canonical.ts rightly refuses foreign prototypes.
        expect(hashCanonical(JSON.parse(JSON.stringify(got.artifact)))).toBe(got.artifactHash);
      } else {
        if (got.verdict !== "BLOCK") throw new Error("verdict mismatch");
        const expectedRules = v.expected.reasons.map((r) => r.rule);
        const gotRules = got.reasons.map((r) => r.rule);
        expect(new Set(gotRules)).toEqual(new Set(expectedRules));
        if (!expectedRules.every((r) => r === "schema")) {
          expect(got.reasons).toEqual(v.expected.reasons);
        }
      }
    });
  }
});

describe("what the marketplace engine adds", () => {
  it("refuses a malformed policy rather than deciding against it", async () => {
    const v = VECTORS[0]!;
    const got = await runEngine(v.intent, { ...(v.policy as object), maxAmountBaseUnits: 5 }, v.now);
    expect(got.verdict).toBe("BLOCK");
    if (got.verdict === "BLOCK") expect(got.reasons[0]?.rule).toBe("policy-schema");
  });

  it("accepts the policy as a JSON string too", async () => {
    const v = VECTORS[0]!;
    const got = await runEngine(v.intent, JSON.stringify(v.policy), v.now);
    expect(got.verdict).toBe("ALLOW");
    expect(got.policyHash).toBe(v.expected.policyHash);
  });

  it("uses the wall clock when the test override is absent", async () => {
    const v = VECTORS[0]!;
    const got = await runEngine(v.intent, v.policy);
    // The vector's observation is from 2026-09-09; by now it is stale.
    expect(got.verdict).toBe("BLOCK");
    if (got.verdict === "BLOCK") expect(got.reasons.map((r) => r.rule)).toContain("freshness");
  });

  it("contains no template markers of its own", () => {
    // KeeperHub resolves {{...}} before execution; a stray pair in the engine
    // would be treated as an unresolved reference.
    expect(ENGINE.includes("{{")).toBe(false);
  });
});
