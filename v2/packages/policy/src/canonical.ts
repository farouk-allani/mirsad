/**
 * Canonical encoding and hashing.
 *
 * Every hash MIRSAD produces commits to bytes, not to a JavaScript object, so
 * two processes that agree on the value must agree on the encoding. The rules
 * below are deliberately narrower than JSON:
 *
 * - object keys are sorted, so property order cannot change a hash;
 * - non-integer numbers are rejected, because `0.1` and `0.10` are the same
 *   value and different bytes. Token amounts travel as base-unit decimal
 *   strings instead. KeeperHub's own idempotency documentation names this
 *   exact drift ("re-serializing `0.1` as `0.10`") as a cause of a 409
 *   conflict against a key that is already bound to the earlier body;
 * - `undefined` is rejected rather than dropped. A field that vanished is a
 *   field nobody decided about.
 *
 * Addresses are lowercased at the schema boundary, not here, so that the
 * encoder stays a pure function of its input.
 */

import { keccak256, toHex } from "viem";

export class CanonicalError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path || "<root>"}`);
    this.name = "CanonicalError";
  }
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function encode(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isInteger(value)) {
        throw new CanonicalError(
          "non-integer number; use a base-unit decimal string",
          path,
        );
      }
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalError("integer outside the safe range", path);
      }
      return String(value);
    case "bigint":
      throw new CanonicalError("bigint; convert to a decimal string first", path);
    case "undefined":
      throw new CanonicalError("undefined; omit the key or use null", path);
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, i) => encode(item, `${path}[${i}]`)).join(",")}]`;
  }

  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalError("not a plain object", path);
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const body = entries
      .map(([k, v]) => `${JSON.stringify(k)}:${encode(v, path ? `${path}.${k}` : k)}`)
      .join(",");
    return `{${body}}`;
  }

  throw new CanonicalError(`unsupported type ${typeof value}`, path);
}

/** Deterministic bytes for a value. The same value always yields the same string. */
export function canonicalize(value: Json | unknown): string {
  return encode(value, "");
}

/**
 * keccak256 of the canonical encoding.
 *
 * keccak rather than SHA-256 so a hash can be committed onchain later without
 * re-deriving it under a different algorithm.
 */
export function hashCanonical(value: unknown): `0x${string}` {
  return keccak256(toHex(canonicalize(value)));
}
