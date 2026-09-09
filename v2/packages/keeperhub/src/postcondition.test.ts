import { describe, expect, it } from "vitest";

import { KeeperHubPositionReader, checkSupplyPostcondition } from "./postcondition.js";
import type { PositionReading } from "./postcondition.js";
import type { Transport } from "./transport.js";

const kh = (n: bigint): PositionReading => ({
  source: "keeperhub",
  aTokenBalanceBaseUnits: n,
});
const rpc = (n: bigint): PositionReading => ({ source: "rpc", aTokenBalanceBaseUnits: n });

describe("checkSupplyPostcondition", () => {
  it("passes when the position grew by exactly what was supplied", () => {
    const result = checkSupplyPostcondition({
      before: [kh(0n), rpc(0n)],
      after: [kh(1_000_000n), rpc(1_000_000n)],
      expectedIncreaseBaseUnits: "1000000",
    });
    expect(result.ok).toBe(true);
    expect(result.observedIncreaseBaseUnits).toBe("1000000");
  });

  it("tolerates the few units of interest that accrue between the two reads", () => {
    const result = checkSupplyPostcondition({
      before: [kh(0n), rpc(0n)],
      after: [kh(1_000_003n), rpc(1_000_003n)],
      expectedIncreaseBaseUnits: "1000000",
    });
    expect(result.ok).toBe(true);
  });

  it("fails when the position did not move, even on a settled receipt", () => {
    const result = checkSupplyPostcondition({
      before: [kh(0n), rpc(0n)],
      after: [kh(0n), rpc(0n)],
      expectedIncreaseBaseUnits: "1000000",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/short of/);
  });

  it("fails when the position grew by more than was authorised", () => {
    const result = checkSupplyPostcondition({
      before: [kh(0n), rpc(0n)],
      after: [kh(2_000_000n), rpc(2_000_000n)],
      expectedIncreaseBaseUnits: "1000000",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/more than/);
  });

  it("fails when the two independent readings disagree", () => {
    const result = checkSupplyPostcondition({
      before: [kh(0n), rpc(0n)],
      after: [kh(1_000_000n), rpc(0n)],
      expectedIncreaseBaseUnits: "1000000",
    });
    expect(result.ok).toBe(false);
    expect(result.sourcesAgree).toBe(false);
  });

  it("resolves a disagreement against itself rather than in its own favour", () => {
    // The optimistic reading would satisfy the expectation; the conservative
    // one does not, and that is the one that counts.
    const result = checkSupplyPostcondition({
      before: [kh(0n), rpc(0n)],
      after: [kh(1_000_000n), rpc(400_000n)],
      expectedIncreaseBaseUnits: "1000000",
    });
    expect(result.observedIncreaseBaseUnits).toBe("400000");
    expect(result.ok).toBe(false);
  });

  it("measures the delta, not the balance, so a pre-existing position is not counted", () => {
    const result = checkSupplyPostcondition({
      before: [kh(5_000_000n), rpc(5_000_000n)],
      after: [kh(6_000_000n), rpc(6_000_000n)],
      expectedIncreaseBaseUnits: "1000000",
    });
    expect(result.ok).toBe(true);
    expect(result.observedIncreaseBaseUnits).toBe("1000000");
  });
});

describe("KeeperHubPositionReader", () => {
  function transportReturning(payload: unknown): Transport {
    return { callTool: <T>() => Promise.resolve(payload as T) };
  }

  it("reads the aToken balance out of Aave's reserve data", async () => {
    const reader = new KeeperHubPositionReader(
      transportReturning({ success: true, result: { currentATokenBalance: "1000000" } }),
      { chainId: 84532, asset: "0xba50", user: "0x1f53" },
    );
    expect(await reader.read()).toEqual({
      source: "keeperhub",
      aTokenBalanceBaseUnits: 1_000_000n,
    });
  });

  it("throws rather than reporting zero when the field is absent", async () => {
    const reader = new KeeperHubPositionReader(transportReturning({ success: true, result: {} }), {
      chainId: 84532,
      asset: "0xba50",
      user: "0x1f53",
    });
    await expect(reader.read()).rejects.toThrow(/currentATokenBalance/);
  });
});
