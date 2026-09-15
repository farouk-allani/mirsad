/**
 * Golden vectors for the marketplace engine.
 *
 * Every case is decided by the TypeScript engine and written with its full
 * expected output. marketplace.test.ts then runs marketplace/engine.js against
 * each one. Cases are round-tripped through JSON first, because that is how
 * they reach the sandbox: a key set to undefined does not survive the trip,
 * and the two engines must be judged on the same bytes.
 *
 *   pnpm exec tsx scripts/vectors.ts
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decide } from "../src/engine.js";
import { aaveBasePolicy, aaveMarket } from "../src/packs/aave-base.js";

const ACTOR = "0x1f535539d5495f0e58ecb8f16006605acffd33f4";
const ATTACKER = "0xdead00000000000000000000000000000000beef";
const NOW = "2026-09-09T12:00:00.000Z";
const UINT256_MAX =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const CHAIN_ID = 8453;
const MARKET = aaveMarket(CHAIN_ID);
const policy = aaveBasePolicy({ actor: ACTOR, chainId: CHAIN_ID });

function intent(overrides: Record<string, unknown> = {}, drop: string[] = []): unknown {
  const base: Record<string, unknown> = {
    schemaVersion: "mirsad.intent.v1",
    source: { system: "wayfinder", runId: "run-1", path: "mirsad-guarded-aave@0.11.0" },
    chainId: CHAIN_ID,
    protocol: "aave-v3",
    action: "supply",
    target: MARKET.pool,
    token: MARKET.usdc,
    amountBaseUnits: "1000000",
    beneficiary: ACTOR,
    observations: { blockNumber: "51100697", observedAt: "2026-09-09T11:59:00.000Z" },
    ...overrides,
  };
  for (const key of drop) delete base[key];
  return JSON.parse(JSON.stringify(base));
}

interface Case {
  name: string;
  intent: unknown;
  policy?: unknown;
  now?: string;
  /** The intent is handed to the sandbox as a JSON string rather than an object. */
  asString?: boolean;
}

const cases: Case[] = [
  { name: "allow", intent: intent() },
  {
    name: "allow with checksummed addresses",
    intent: intent({
      beneficiary: "0x1F535539d5495F0e58ECB8F16006605acFfd33f4",
      target: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    }),
  },
  { name: "allow, intent delivered as a JSON string", intent: intent(), asString: true },
  { name: "block beneficiary", intent: intent({ beneficiary: ATTACKER }) },
  { name: "block amount over cap", intent: intent({ amountBaseUnits: "100000000" }) },
  { name: "block unlimited amount", intent: intent({ amountBaseUnits: UINT256_MAX }) },
  { name: "block zero amount", intent: intent({ amountBaseUnits: "0" }) },
  { name: "block other chain", intent: intent({ chainId: 84532 }) },
  { name: "block lookalike pool", intent: intent({ target: ATTACKER }) },
  { name: "block other token", intent: intent({ token: ATTACKER }) },
  { name: "block borrow", intent: intent({ action: "borrow" }) },
  { name: "block other protocol", intent: intent({ protocol: "morpho" }) },
  {
    name: "block stale observation",
    intent: intent({ observations: { blockNumber: "1", observedAt: "2026-09-09T11:00:00.000Z" } }),
  },
  {
    name: "block future observation",
    intent: intent({ observations: { blockNumber: "1", observedAt: "2026-09-09T13:00:00.000Z" } }),
  },
  {
    name: "block three violations at once",
    intent: intent({ beneficiary: ATTACKER, amountBaseUnits: "100000000", chainId: 1 }),
  },
  { name: "schema unknown field", intent: intent({ referralCode: 7 }) },
  { name: "schema missing field", intent: intent({}, ["beneficiary"]) },
  { name: "schema leading zero", intent: intent({ amountBaseUnits: "01" }) },
  { name: "schema fractional amount", intent: intent({ amountBaseUnits: "1.5" }) },
  { name: "schema negative amount", intent: intent({ amountBaseUnits: "-1" }) },
  { name: "schema amount as number", intent: intent({ amountBaseUnits: 1000000 }) },
  { name: "schema truncated address", intent: intent({ beneficiary: "0xdead" }) },
  { name: "schema future version", intent: intent({ schemaVersion: "mirsad.intent.v2" }) },
  { name: "schema chainId not integer", intent: intent({ chainId: 8453.5 }) },
  { name: "schema not an object", intent: "supply everything" },
  {
    name: "unsupported action with a permissive policy",
    intent: intent({ action: "flashloan" }),
    policy: {
      ...policy,
      allow: [{ protocol: "aave-v3", action: "flashloan", target: MARKET.pool, token: MARKET.usdc }],
    },
  },
  {
    name: "allow at the edge of freshness",
    intent: intent({ observations: { blockNumber: "1", observedAt: "2026-09-09T11:55:00.000Z" } }),
  },
  { name: "allow at the cap exactly", intent: intent({ amountBaseUnits: "5000000" }) },
  { name: "block one unit over the cap", intent: intent({ amountBaseUnits: "5000001" }) },
];

const vectors = cases.map((c) => {
  const pol = JSON.parse(JSON.stringify(c.policy ?? policy));
  const expected = decide({ intent: c.intent, policy: pol, now: new Date(c.now ?? NOW) });
  return {
    name: c.name,
    now: c.now ?? NOW,
    intent: c.asString ? JSON.stringify(c.intent) : c.intent,
    policy: pol,
    expected,
  };
});

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../marketplace/vectors.json");
writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`${vectors.length} vectors -> ${out}`);
