import { describe, expect, it } from "vitest";

import { CanonicalError, canonicalize, hashCanonical } from "./canonical.js";

describe("canonicalize", () => {
  it("is independent of key insertion order", () => {
    const a = { b: 2, a: 1, c: { z: "z", y: "y" } };
    const b = { c: { y: "y", z: "z" }, a: 1, b: 2 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });

  it("preserves array order, because arrays are ordered data", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("emits no incidental whitespace", () => {
    expect(canonicalize({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });

  it("round-trips through JSON.parse to the same value", () => {
    const value = { a: [1, { b: "x" }], c: null, d: true };
    expect(JSON.parse(canonicalize(value))).toEqual(value);
  });

  const rejected: Array<[string, unknown]> = [
    ["a non-integer number", { amount: 0.1 }],
    ["an unsafe integer", { amount: Number.MAX_SAFE_INTEGER + 2 }],
    ["a bigint", { amount: 1n }],
    ["undefined", { amount: undefined }],
    ["a nested undefined", { a: { b: undefined } }],
    ["a class instance", { at: new Date() }],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => canonicalize(value)).toThrow(CanonicalError);
    });
  }

  it("names the path of the offending field", () => {
    expect(() => canonicalize({ outer: { inner: 1.5 } })).toThrow(/outer\.inner/);
  });

  it("distinguishes the string '1' from the number 1", () => {
    expect(canonicalize({ a: "1" })).not.toBe(canonicalize({ a: 1 }));
  });
});

describe("hashCanonical", () => {
  it("returns a 32-byte hex digest", () => {
    expect(hashCanonical({ a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is stable across calls", () => {
    expect(hashCanonical({ a: 1 })).toBe(hashCanonical({ a: 1 }));
  });

  it("changes when any byte of the value changes", () => {
    expect(hashCanonical({ amount: "1000000" })).not.toBe(
      hashCanonical({ amount: "1000001" }),
    );
  });

  /**
   * The regression this exists for: an amount that survives a round trip
   * through a system that reformats numbers is a different amount as far as an
   * idempotency key is concerned, and rebuilding the body wrongly is how a
   * retry becomes a second transaction.
   */
  it("treats '1.0' and '1' as different values", () => {
    expect(hashCanonical({ amount: "1.0" })).not.toBe(hashCanonical({ amount: "1" }));
  });
});
