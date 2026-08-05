import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import {
  DeepSeekClassifier,
  NullClassifier,
  createClassifier,
  renderPrompt,
} from "./classifier.js";
import { runRules, verdictFrom, type RuleContext } from "./rules.js";
import { ERC20_ABI, MAX_UINT256 } from "./signatures.js";
import { SafeOperation, Verdict, type QueuedSafeTransaction } from "../types.js";

const SAFE = "0x499d502527243c56434749CAbd01A115E298e338" as const;
const TRUSTED = "0x1F535539d5495F0e58ECB8F16006605acFfd33f4" as const;
const ATTACKER = "0x000000000000000000000000000000000000dEaD" as const;
const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;

const ctx: RuleContext = { safeAddress: SAFE, addressBook: [TRUSTED] };

function tx(partial: Partial<QueuedSafeTransaction> = {}): QueuedSafeTransaction {
  return {
    safe: SAFE,
    safeTxHash: "0xabc0000000000000000000000000000000000000000000000000000000000001",
    to: TRUSTED,
    value: "0",
    data: null,
    operation: SafeOperation.Call,
    nonce: 7,
    confirmationsRequired: 2,
    confirmations: [],
    ...partial,
  };
}

describe("rules-only mode", () => {
  it("NullClassifier contributes nothing", async () => {
    expect(await new NullClassifier().classify()).toEqual([]);
  });

  it("createClassifier falls back to rules-only when disabled", () => {
    const c = createClassifier({
      MIRSAD_CLASSIFIER: "none",
      CLASSIFIER_API_KEY: "sk-whatever",
      CLASSIFIER_BASE_URL: "https://api.deepseek.com",
      CLASSIFIER_MODEL: "deepseek-v4-flash",
    });
    expect(c.name).toBe("none");
  });

  it("createClassifier falls back to rules-only when no key is configured", () => {
    const c = createClassifier({
      MIRSAD_CLASSIFIER: "deepseek",
      CLASSIFIER_API_KEY: undefined,
      CLASSIFIER_BASE_URL: "https://api.deepseek.com",
      CLASSIFIER_MODEL: "deepseek-v4-flash",
    });
    expect(c.name).toBe("none");
  });
});

describe("prompt", () => {
  it("carries the facts the model needs and marks a missing intent explicitly", () => {
    const p = renderPrompt({ transaction: tx({ to: ATTACKER, value: "1000" }), ruleFindings: [] });
    expect(p).toContain(ATTACKER);
    expect(p).toContain("1000 wei");
    expect(p).toContain("(none provided)");
    expect(p).toContain("CALL");
  });

  it("labels a delegatecall so the model cannot miss it", () => {
    const p = renderPrompt({
      transaction: tx({ operation: SafeOperation.DelegateCall }),
      ruleFindings: [],
    });
    expect(p).toContain("DELEGATECALL");
  });

  it("passes rule findings through so the model does not repeat them", () => {
    const findings = runRules(tx({ to: ATTACKER, value: "5" }), ctx);
    const p = renderPrompt({ transaction: tx(), ruleFindings: findings });
    expect(p).toContain("unknown-recipient");
    expect(p).toContain("do not repeat");
  });
});

describe("resilience", () => {
  it("degrades to rules-only when the provider is unreachable, instead of throwing", async () => {
    const c = new DeepSeekClassifier({
      apiKey: "sk-invalid",
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 1500,
    });
    await expect(c.classify({ transaction: tx(), ruleFindings: [] })).resolves.toEqual([]);
  });
});

// Live integration. Opt-in: runs only when a real key is present.
const liveKey = process.env.CLASSIFIER_API_KEY;
describe.runIf(liveKey)("live DeepSeek", () => {
  it(
    "detects intent drift between a stated proposal and the actual calldata",
    { timeout: 60_000 },
    async () => {
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [ATTACKER, MAX_UINT256],
      });
      const transaction = tx({ to: TOKEN, data });

      const ruleFindings = runRules(transaction, ctx);
      const classifier = new DeepSeekClassifier({
        apiKey: liveKey!,
        model: process.env.CLASSIFIER_MODEL ?? "deepseek-v4-flash",
      });

      const modelFindings = await classifier.classify({
        transaction,
        // The lie. The calldata is an unlimited approval to an unknown address.
        statedIntent: "Routine monthly payment of 5,000 USDC to our auditor, Trail of Bits.",
        decoded: `approve(spender=${ATTACKER}, amount=${MAX_UINT256})`,
        ruleFindings,
      });

      // eslint-disable-next-line no-console
      console.log("model findings:", JSON.stringify(modelFindings, null, 2));

      expect(modelFindings.length).toBeGreaterThan(0);
      expect(modelFindings.every((f) => f.source === "model")).toBe(true);

      // The safety property that matters: whatever the model says, a model
      // finding alone can never reach VETO.
      expect(verdictFrom(modelFindings)).not.toBe(Verdict.Veto);

      // But combined with the rules, this transaction is still blocked.
      expect(verdictFrom([...ruleFindings, ...modelFindings])).toBe(Verdict.Veto);
    },
  );
});
