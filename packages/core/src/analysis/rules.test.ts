import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseEther } from "viem";
import { runRules, verdictFrom, type RuleContext } from "./rules.js";
import { ERC20_ABI, MAX_UINT256, SAFE_ADMIN_ABI } from "./signatures.js";
import { SafeOperation, Verdict, type Finding, type QueuedSafeTransaction } from "../types.js";

const SAFE = "0x499d502527243c56434749CAbd01A115E298e338" as const;
const TRUSTED = "0x1F535539d5495F0e58ECB8F16006605acFfd33f4" as const;
const ATTACKER = "0x000000000000000000000000000000000000dEaD" as const;
const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;

const ctx: RuleContext = {
  safeAddress: SAFE,
  addressBook: [TRUSTED],
  safeBalanceWei: parseEther("100"),
  owners: [TRUSTED],
};

function tx(partial: Partial<QueuedSafeTransaction> = {}): QueuedSafeTransaction {
  return {
    safe: SAFE,
    safeTxHash: "0xabc0000000000000000000000000000000000000000000000000000000000001",
    to: TRUSTED,
    value: "0",
    data: null,
    operation: SafeOperation.Call,
    nonce: 1,
    confirmationsRequired: 2,
    confirmations: [],
    ...partial,
  };
}

const codes = (findings: readonly Finding[]) => findings.map((f) => f.code).sort();

describe("attack scenarios", () => {
  it("catches a hidden delegatecall — the Bybit shape", () => {
    const findings = runRules(tx({ to: ATTACKER, operation: SafeOperation.DelegateCall }), ctx);
    expect(codes(findings)).toContain("delegatecall");
    expect(verdictFrom(findings)).toBe(Verdict.Veto);
  });

  it("catches a silent owner swap", () => {
    const data = encodeFunctionData({
      abi: SAFE_ADMIN_ABI,
      functionName: "swapOwner",
      args: ["0x0000000000000000000000000000000000000001", TRUSTED, ATTACKER],
    });
    const findings = runRules(tx({ to: SAFE, data }), ctx);
    expect(codes(findings)).toContain("owner-swapped");
    expect(verdictFrom(findings)).toBe(Verdict.Veto);
  });

  it("catches an unlimited approval to an unknown spender", () => {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ATTACKER, MAX_UINT256],
    });
    const findings = runRules(tx({ to: TOKEN, data }), ctx);
    expect(codes(findings)).toEqual(["approval-unknown-spender", "unlimited-approval"]);
    expect(verdictFrom(findings)).toBe(Verdict.Veto);
  });

  it("catches a spoofed recipient draining the treasury", () => {
    const findings = runRules(tx({ to: ATTACKER, value: parseEther("95").toString() }), ctx);
    expect(codes(findings)).toEqual(["unknown-recipient", "value-drift"]);
    expect(verdictFrom(findings)).toBe(Verdict.Veto);
  });

  it("catches an attacker removing the guard first", () => {
    const data = encodeFunctionData({
      abi: SAFE_ADMIN_ABI,
      functionName: "setGuard",
      args: ["0x0000000000000000000000000000000000000000"],
    });
    const findings = runRules(tx({ to: SAFE, data }), ctx);
    expect(findings[0]?.code).toBe("guard-change");
    expect(findings[0]?.detail).toContain("An attacker does this first");
    expect(verdictFrom(findings)).toBe(Verdict.Veto);
  });

  it("catches a module being enabled — funds movable with no signatures at all", () => {
    const data = encodeFunctionData({
      abi: SAFE_ADMIN_ABI,
      functionName: "enableModule",
      args: [ATTACKER],
    });
    expect(verdictFrom(runRules(tx({ to: SAFE, data }), ctx))).toBe(Verdict.Veto);
  });
});

describe("evasion", () => {
  it("flags a near-unlimited approval that dodges an exact MAX_UINT256 match", () => {
    const sneaky = 2n ** 200n; // huge, but not the value a naive scanner greps for
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ATTACKER, sneaky],
    });
    expect(codes(runRules(tx({ to: TOKEN, data }), ctx))).toContain("unlimited-approval");
  });

  it("still flags an unrecognised function called on the Safe itself", () => {
    const findings = runRules(tx({ to: SAFE, data: "0xdeadbeef" }), ctx);
    expect(codes(findings)).toContain("safe-self-call-unknown");
  });
});

describe("legitimate traffic stays quiet", () => {
  it("allows a payment to an address book entry", () => {
    const findings = runRules(tx({ to: TRUSTED, value: parseEther("1").toString() }), ctx);
    expect(findings).toEqual([]);
    expect(verdictFrom(findings)).toBe(Verdict.Allow);
  });

  it("allows a bounded approval to a known spender", () => {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [TRUSTED, 1_000_000n],
    });
    expect(runRules(tx({ to: TOKEN, data }), ctx)).toEqual([]);
  });

  it("warns rather than vetoes on a modest payment to an unknown address", () => {
    const findings = runRules(tx({ to: ATTACKER, value: parseEther("1").toString() }), ctx);
    expect(codes(findings)).toEqual(["unknown-recipient"]);
    expect(verdictFrom(findings)).toBe(Verdict.Warn);
  });
});

describe("the model can never veto alone", () => {
  it("clamps a model-sourced VETO down to WARN", () => {
    const modelVeto: Finding = {
      code: "intent-drift",
      severity: Verdict.Veto,
      source: "model",
      summary: "Calldata does not match the stated proposal.",
    };
    expect(verdictFrom([modelVeto])).toBe(Verdict.Warn);
  });

  it("still returns VETO when a rule found one alongside the model", () => {
    const findings: Finding[] = [
      { code: "intent-drift", severity: Verdict.Warn, source: "model", summary: "Suspicious." },
      { code: "delegatecall", severity: Verdict.Veto, source: "rule", summary: "Delegatecall." },
    ];
    expect(verdictFrom(findings)).toBe(Verdict.Veto);
  });

  it("is Allow when nothing fired", () => {
    expect(verdictFrom([])).toBe(Verdict.Allow);
  });
});

describe("determinism", () => {
  it("produces identical findings across repeated runs — the audit trail must replay", () => {
    const t = tx({ to: ATTACKER, value: parseEther("99").toString() });
    expect(JSON.stringify(runRules(t, ctx))).toEqual(JSON.stringify(runRules(t, ctx)));
  });

  it("treats address book entries case-insensitively", () => {
    const lower = TRUSTED.toLowerCase() as `0x${string}`;
    const findings = runRules(tx({ to: lower, value: parseEther("1").toString() }), ctx);
    expect(findings).toEqual([]);
  });
});
