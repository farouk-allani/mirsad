// MIRSAD policy engine, self-contained, for KeeperHub's Code action.
//
// The Code action runs plain JavaScript in a node:vm sandbox with no imports,
// so this is a second implementation of v2/packages/policy/src, not a build of
// it. What stops it drifting is marketplace/vectors.json: the TypeScript engine
// writes the expected decision for every case it covers, and marketplace.test.ts
// runs this file against each one. Identical verdicts, hashes, artifacts and
// rule ids, or the test fails.
//
// Expects two bindings above it, supplied by the publisher as KeeperHub
// template references and by the test as JSON literals:
//   rawIntent  the proposal, as an object or a JSON string
//   rawPolicy  the policy, as an object or a JSON string
// Returns the decision.

const M64 = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

function rotl(x, n) {
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;
}

function keccakF(s) {
  for (let round = 0; round < 24; round += 1) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    let t = s[1];
    for (let i = 0; i < 24; i += 1) {
      const j = PILN[i];
      const tmp = s[j];
      s[j] = rotl(t, ROTC[i]);
      t = tmp;
    }
    for (let y = 0; y < 25; y += 5) {
      const row = s.slice(y, y + 5);
      for (let x = 0; x < 5; x += 1) s[y + x] = row[x] ^ (~row[(x + 1) % 5] & M64 & row[(x + 2) % 5]);
    }
    s[0] ^= RC[round];
  }
}

/** keccak-256 over UTF-8 text, as a 0x-prefixed lowercase hex string. */
function keccak256(text) {
  const bytes = new TextEncoder().encode(text);
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i += 1) {
      let lane = 0n;
      for (let b = 7; b >= 0; b -= 1) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let hex = "0x";
  for (let i = 0; i < 4; i += 1) {
    let lane = s[i];
    for (let b = 0; b < 8; b += 1) {
      hex += Number(lane & 0xffn).toString(16).padStart(2, "0");
      lane >>= 8n;
    }
  }
  return hex;
}

// Canonical encoding. Same rules as canonical.ts: sorted keys, no whitespace,
// integers only, undefined and non-plain objects refused.
function canonicalize(value, path) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isInteger(value)) throw new Error("non-integer number at " + (path || "<root>"));
    if (!Number.isSafeInteger(value)) throw new Error("unsafe integer at " + (path || "<root>"));
    return String(value);
  }
  if (t === "bigint" || t === "undefined") throw new Error(t + " at " + (path || "<root>"));
  if (Array.isArray(value)) {
    return "[" + value.map((item, i) => canonicalize(item, path + "[" + i + "]")).join(",") + "]";
  }
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("not a plain object at " + (path || "<root>"));
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k], path ? path + "." + k : k)).join(",") + "}";
  }
  throw new Error("unsupported type " + t);
}

function hashCanonical(value) {
  return keccak256(canonicalize(value, ""));
}

const ZERO_HASH = "0x" + "0".repeat(64);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE_UNITS = /^(0|[1-9][0-9]*)$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Strict object parsing. An unrecognised key is an issue, like zod's .strict().
function strictObject(value, path, fields) {
  const issues = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { issues: [{ path, message: "Expected object" }] };
  }
  const out = {};
  for (const key of Object.keys(value)) {
    if (!(key in fields)) issues.push({ path, message: "Unrecognized key(s) in object: '" + key + "'" });
  }
  for (const key of Object.keys(fields)) {
    const sub = path ? path + "." + key : key;
    if (!(key in value) || value[key] === undefined) {
      issues.push({ path: sub, message: "Required" });
      continue;
    }
    const r = fields[key](value[key], sub);
    if (r.issues) issues.push(...r.issues);
    else out[key] = r.value;
  }
  return issues.length ? { issues } : { value: out };
}

const literal = (expected) => (v, p) =>
  v === expected ? { value: v } : { issues: [{ path: p, message: "Invalid literal value, expected " + JSON.stringify(expected) }] };
const nonEmpty = (v, p) =>
  typeof v === "string" && v.length > 0 ? { value: v } : { issues: [{ path: p, message: "String must contain at least 1 character(s)" }] };
const positiveInt = (v, p) =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? { value: v } : { issues: [{ path: p, message: "Expected positive integer" }] };
const address = (v, p) =>
  typeof v === "string" && ADDRESS.test(v) ? { value: v.toLowerCase() } : { issues: [{ path: p, message: "not a 20-byte hex address" }] };
const baseUnits = (v, p) =>
  typeof v === "string" && BASE_UNITS.test(v) ? { value: v } : { issues: [{ path: p, message: "not a canonical base-unit integer string" }] };
const isoUtc = (v, p) =>
  typeof v === "string" && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) ? { value: v } : { issues: [{ path: p, message: "Invalid datetime" }] };

const parseObservations = (v, p) => strictObject(v, p, { blockNumber: baseUnits, observedAt: isoUtc });

function parseIntent(raw) {
  return strictObject(raw, "", {
    schemaVersion: literal("mirsad.intent.v1"),
    source: (v, p) => strictObject(v, p, { system: nonEmpty, runId: nonEmpty, path: nonEmpty }),
    chainId: positiveInt,
    protocol: nonEmpty,
    action: nonEmpty,
    target: address,
    token: address,
    amountBaseUnits: baseUnits,
    beneficiary: address,
    observations: parseObservations,
  });
}

function parsePolicy(raw) {
  return strictObject(raw, "", {
    schemaVersion: literal("mirsad.policy.v1"),
    name: nonEmpty,
    chainId: positiveInt,
    actor: address,
    allow: (v, p) => {
      if (!Array.isArray(v) || v.length === 0) return { issues: [{ path: p, message: "Array must contain at least 1 element(s)" }] };
      const entries = [];
      const issues = [];
      v.forEach((entry, i) => {
        const r = strictObject(entry, p + "[" + i + "]", { protocol: nonEmpty, action: nonEmpty, target: address, token: address });
        if (r.issues) issues.push(...r.issues);
        else entries.push(r.value);
      });
      return issues.length ? { issues } : { value: entries };
    },
    maxAmountBaseUnits: baseUnits,
    maxObservationAgeSeconds: positiveInt,
    artifactTtlSeconds: positiveInt,
  });
}

// The calls an allowed intent becomes. A permitted action with no builder is
// refused; the allowlist says what an operator will authorise, this says what
// the engine knows how to express exactly.
const CALL_BUILDERS = {
  "aave-v3/supply": (intent) => [
    { leg: "approve", contract: intent.token, functionName: "approve", args: [intent.target, intent.amountBaseUnits] },
    { leg: "action", contract: intent.target, functionName: "supply", args: [intent.token, intent.amountBaseUnits, intent.beneficiary, 0] },
  ],
};

function rules(intent, policy, now) {
  const reasons = [];
  if (intent.chainId !== policy.chainId) {
    reasons.push({ rule: "chain", message: "intent targets chain " + intent.chainId + "; policy permits " + policy.chainId + " only" });
  }
  const permitted = policy.allow.some(
    (e) => e.protocol === intent.protocol && e.action === intent.action && e.target === intent.target && e.token === intent.token,
  );
  if (!permitted) {
    reasons.push({
      rule: "allowlist",
      message: "no policy entry permits " + intent.protocol + "/" + intent.action + " on " + intent.target + " with token " + intent.token,
    });
  }
  const amount = BigInt(intent.amountBaseUnits);
  const cap = BigInt(policy.maxAmountBaseUnits);
  if (amount === 0n) {
    reasons.push({ rule: "amount", message: "amount is zero" });
  } else if (amount > cap) {
    reasons.push({ rule: "amount", message: "amount " + intent.amountBaseUnits + " exceeds the cap of " + policy.maxAmountBaseUnits + " base units" });
  }
  if (intent.beneficiary !== policy.actor) {
    reasons.push({ rule: "beneficiary", message: "position would accrue to " + intent.beneficiary + "; policy names " + policy.actor });
  }
  const ageSeconds = (now.getTime() - Date.parse(intent.observations.observedAt)) / 1000;
  if (ageSeconds < 0) {
    reasons.push({ rule: "freshness", message: "observation is dated " + Math.abs(Math.round(ageSeconds)) + "s in the future" });
  } else if (ageSeconds > policy.maxObservationAgeSeconds) {
    reasons.push({ rule: "freshness", message: "observation is " + Math.round(ageSeconds) + "s old; policy allows " + policy.maxObservationAgeSeconds + "s" });
  }
  return reasons;
}

function hashUnparsed(value) {
  try {
    return hashCanonical(value);
  } catch {
    return ZERO_HASH;
  }
}

function decide(rawIntentValue, rawPolicyValue, now) {
  const policyParsed = parsePolicy(rawPolicyValue);
  if (policyParsed.issues) {
    return {
      verdict: "BLOCK",
      intentHash: hashUnparsed(rawIntentValue),
      policyHash: hashUnparsed(rawPolicyValue),
      reasons: policyParsed.issues.map((i) => ({ rule: "policy-schema", message: (i.path || "<root>") + ": " + i.message })),
    };
  }
  const policy = policyParsed.value;
  const policyHash = hashCanonical(policy);

  const intentParsed = parseIntent(rawIntentValue);
  if (intentParsed.issues) {
    return {
      verdict: "BLOCK",
      intentHash: hashUnparsed(rawIntentValue),
      policyHash,
      reasons: intentParsed.issues.map((i) => ({ rule: "schema", message: (i.path || "<root>") + ": " + i.message })),
    };
  }
  const intent = intentParsed.value;
  const intentHash = hashCanonical(intent);

  const reasons = rules(intent, policy, now);
  const build = CALL_BUILDERS[intent.protocol + "/" + intent.action];
  if (!build) {
    reasons.push({ rule: "unsupported-action", message: "no call builder for " + intent.protocol + "/" + intent.action });
  }
  if (reasons.length > 0 || !build) {
    return { verdict: "BLOCK", intentHash, policyHash, reasons };
  }

  const artifact = {
    schemaVersion: "mirsad.artifact.v1",
    intentHash,
    policyHash,
    chainId: intent.chainId,
    actor: policy.actor,
    calls: build(intent),
    observations: intent.observations,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + policy.artifactTtlSeconds * 1000).toISOString(),
  };
  return { verdict: "ALLOW", intentHash, policyHash, artifact, artifactHash: hashCanonical(artifact) };
}

function asValue(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// __MIRSAD_NOW is set only by the equivalence test, so the vectors are
// deterministic. Nothing in KeeperHub's sandbox defines it.
const now = typeof __MIRSAD_NOW === "string" ? new Date(__MIRSAD_NOW) : new Date();
return decide(asValue(rawIntent), asValue(rawPolicy), now);
