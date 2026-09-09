import { MemoryJournal } from "@mirsad/keeperhub";
import type { PositionReader, Transport } from "@mirsad/keeperhub";
import { aaveBasePolicy, aaveMarket } from "@mirsad/policy";
import { describe, expect, it } from "vitest";

import { run } from "./run.js";

const ACTOR = "0x1f535539d5495f0e58ecb8f16006605acffd33f4";
const ATTACKER = "0xdead00000000000000000000000000000000beef";
const NOW = new Date("2026-09-09T12:00:00.000Z");
const CHAIN_ID = 8453;
const MARKET = aaveMarket(CHAIN_ID);
const policy = aaveBasePolicy({ actor: ACTOR, chainId: CHAIN_ID });

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "mirsad.intent.v1",
    source: { system: "wayfinder", runId: "local", path: "mirsad-guarded-aave@0.11.0" },
    chainId: CHAIN_ID,
    protocol: "aave-v3",
    action: "supply",
    target: MARKET.pool,
    token: MARKET.usdc,
    amountBaseUnits: "1000000",
    beneficiary: ACTOR,
    observations: { blockNumber: "51100697", observedAt: "2026-09-09T11:59:40.000Z" },
    ...overrides,
  };
}

function countingTransport(): { transport: Transport; count: () => number } {
  let calls = 0;
  return {
    count: () => calls,
    transport: {
      callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
        calls += 1;
        if (name === "get_direct_execution_status") return Promise.resolve({ status: "completed" } as T);
        if (args.simulate === true) {
          return Promise.resolve({ success: true, wouldRevert: false } as T);
        }
        return Promise.resolve({
          executionId: `exec-${calls}`,
          status: "completed",
          transactionHash: `0x${"1".repeat(64)}`,
        } as T);
      },
    },
  };
}

/** Returns a growing balance so a supply looks like it landed. */
function readersFor(before: bigint, after: bigint): PositionReader[] {
  let reads = 0;
  const make = (source: "keeperhub" | "rpc"): PositionReader => ({
    read: () => {
      reads += 1;
      return Promise.resolve({
        source,
        aTokenBalanceBaseUnits: reads <= 2 ? before : after,
      });
    },
  });
  return [make("keeperhub"), make("rpc")];
}

const base = () => ({
  policy,
  journal: new MemoryJournal(),
  readers: readersFor(0n, 1_000_000n),
  now: NOW,
  sleep: async () => {},
});

describe("run", () => {
  it("blocks a tampered beneficiary without calling KeeperHub at all", async () => {
    const { transport, count } = countingTransport();
    const report = await run({
      ...base(),
      proposal: proposal({ beneficiary: ATTACKER }),
      transport,
      broadcast: true,
    });
    expect(report.decision.verdict).toBe("BLOCK");
    expect(report.quiet).toBe(true);
    expect(count()).toBe(0);
  });

  it("does not broadcast unless broadcasting was asked for", async () => {
    const { transport, count } = countingTransport();
    const report = await run({ ...base(), proposal: proposal(), transport });
    expect(report.decision.verdict).toBe("ALLOW");
    expect(report.outcome).toBeUndefined();
    expect(count()).toBe(0);
  });

  it("executes an allowed proposal and proves the position moved", async () => {
    const { transport } = countingTransport();
    const report = await run({
      ...base(),
      proposal: proposal(),
      transport,
      broadcast: true,
    });
    expect(report.outcome?.kind).toBe("executed");
    expect(report.postcondition?.ok).toBe(true);
    expect(report.postcondition?.observedIncreaseBaseUnits).toBe("1000000");
  });

  it("does not claim success when the receipt settled but the position did not move", async () => {
    const { transport } = countingTransport();
    const report = await run({
      ...base(),
      readers: readersFor(0n, 0n),
      proposal: proposal(),
      transport,
      broadcast: true,
    });
    expect(report.outcome?.kind).toBe("executed");
    expect(report.postcondition?.ok).toBe(false);
    expect(report.postcondition?.message).toMatch(/short of/);
  });

  it("reads the position before executing, so the delta is measured not assumed", async () => {
    const order: string[] = [];
    const { transport } = countingTransport();
    const reader: PositionReader = {
      read: () => {
        order.push("read");
        return Promise.resolve({ source: "rpc", aTokenBalanceBaseUnits: 0n });
      },
    };
    await run({
      ...base(),
      readers: [reader],
      proposal: proposal(),
      transport: {
        callTool: <T,>(name: string, args: Record<string, unknown>) => {
          if (name === "execute_contract_call" && args.simulate !== true) {
            order.push("send");
          }
          return transport.callTool<T>(name, args);
        },
      },
      broadcast: true,
    });
    expect(order[0]).toBe("read");
    expect(order).toContain("send");
  });
});
