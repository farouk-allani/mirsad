import { decodeFunctionData, getAddress, isAddressEqual } from "viem";
import { SafeOperation, Verdict, type Finding, type QueuedSafeTransaction } from "../types.js";
import {
  EFFECTIVELY_UNLIMITED,
  ERC20_ABI,
  ERC20_SELECTORS,
  PROXY_ABI,
  PROXY_SELECTORS,
  SAFE_ADMIN_ABI,
  SAFE_ADMIN_SELECTORS,
} from "./signatures.js";

/**
 * Deterministic detectors.
 *
 * These run before the model and can reach VETO on their own. That ordering is
 * deliberate and worth stating plainly: an LLM must never be the only thing
 * standing between a treasury and a drain. The model's job is to catch intent
 * drift that no rule anticipated -- it adds findings, it does not gate them.
 *
 * Every detector is pure: (transaction, context) -> Finding[]. No network, no
 * clock, no state. That is what makes the audit trail replayable.
 */

export interface RuleContext {
  /** The Safe being guarded. A `to` equal to this is self-administration. */
  safeAddress: `0x${string}`;
  /** Recipients the treasury has explicitly approved. Compared case-insensitively. */
  addressBook: readonly `0x${string}`[];
  /** Native balance of the Safe, for proportional value checks. */
  safeBalanceWei?: bigint;
  /** Owner set at assessment time, used to spot removals of known owners. */
  owners?: readonly `0x${string}`[];
}

const veto = (code: string, summary: string, detail?: string): Finding => ({
  code,
  severity: Verdict.Veto,
  source: "rule",
  summary,
  ...(detail === undefined ? {} : { detail }),
});

const warn = (code: string, summary: string, detail?: string): Finding => ({
  code,
  severity: Verdict.Warn,
  source: "rule",
  summary,
  ...(detail === undefined ? {} : { detail }),
});

function selectorOf(data: string | null): `0x${string}` | null {
  if (!data || data.length < 10) return null;
  return data.slice(0, 10).toLowerCase() as `0x${string}`;
}

function inAddressBook(book: readonly `0x${string}`[], addr: `0x${string}`): boolean {
  return book.some((entry) => isAddressEqual(entry, addr));
}

/**
 * A delegatecall executes foreign code in the Safe's own storage context. It
 * can rewrite owners, thresholds, and the singleton pointer in a single call
 * that looks, in a signing UI, like an ordinary contract interaction.
 *
 * This is the shape of the Bybit loss. It is never routine.
 */
export function detectDelegateCall(tx: QueuedSafeTransaction): Finding[] {
  if (tx.operation !== SafeOperation.DelegateCall) return [];
  return [
    veto(
      "delegatecall",
      "Transaction is a delegatecall, which executes foreign code against the Safe's own storage.",
      `target=${tx.to}. A delegatecall can rewrite the owner set, threshold, or implementation pointer in one call.`,
    ),
  ];
}

/**
 * Calls where `to` is the Safe itself are the Safe administering itself:
 * changing owners, threshold, modules, guard, or fallback handler. Every one of
 * these alters who controls the treasury from that point onward.
 */
export function detectSafeSelfAdministration(
  tx: QueuedSafeTransaction,
  ctx: RuleContext,
): Finding[] {
  if (!isAddressEqual(tx.to, ctx.safeAddress)) return [];
  const selector = selectorOf(tx.data);
  if (!selector) return [];

  const fn = SAFE_ADMIN_SELECTORS[selector];
  if (!fn) {
    return [
      warn(
        "safe-self-call-unknown",
        "Transaction calls the Safe itself with an unrecognised function.",
        `selector=${selector}`,
      ),
    ];
  }

  let args: readonly unknown[] = [];
  try {
    args = decodeFunctionData({ abi: SAFE_ADMIN_ABI, data: tx.data as `0x${string}` }).args ?? [];
  } catch {
    /* Selector matched but arguments are malformed — still report the call. */
  }

  switch (fn) {
    case "setGuard": {
      const next = args[0] as `0x${string}` | undefined;
      const removing = next && /^0x0{40}$/i.test(next);
      return [
        veto(
          "guard-change",
          removing
            ? "Transaction REMOVES the Safe's transaction guard."
            : "Transaction replaces the Safe's transaction guard.",
          removing
            ? "Removing the guard disables MIRSAD's enforcement. An attacker does this first."
            : `new guard=${next}`,
        ),
      ];
    }
    case "setFallbackHandler":
      return [
        veto(
          "fallback-handler-change",
          "Transaction changes the Safe's fallback handler.",
          `handler=${args[0]}. A malicious handler can intercept arbitrary calls to the Safe.`,
        ),
      ];
    case "enableModule":
      return [
        veto(
          "module-enabled",
          "Transaction enables a Safe module.",
          `module=${args[0]}. Modules can move funds without any owner signature at all.`,
        ),
      ];
    case "addOwnerWithThreshold":
      return [
        veto(
          "owner-added",
          "Transaction adds a new Safe owner.",
          `owner=${args[0]} threshold=${args[1]}`,
        ),
      ];
    case "removeOwner": {
      const removed = args[1] as `0x${string}` | undefined;
      const known = removed && ctx.owners?.some((o) => isAddressEqual(o, removed));
      return [
        veto(
          "owner-removed",
          "Transaction removes a Safe owner.",
          `owner=${removed}${known ? " (a current owner)" : ""} threshold=${args[2]}`,
        ),
      ];
    }
    case "swapOwner":
      return [
        veto(
          "owner-swapped",
          "Transaction replaces a Safe owner.",
          `old=${args[1]} new=${args[2]}. A silent owner swap leaves the treasury under new control with an unchanged threshold.`,
        ),
      ];
    case "changeThreshold":
      return [
        veto(
          "threshold-changed",
          "Transaction changes the Safe's signature threshold.",
          `threshold=${args[0]}. Lowering it weakens every future approval.`,
        ),
      ];
    case "disableModule":
      return [veto("module-disabled", "Transaction disables a Safe module.", `module=${args[1]}`)];
    default:
      return [warn("safe-self-call", `Transaction calls Safe.${fn} on itself.`)];
  }
}

/** Unlimited or near-unlimited ERC-20 approvals are a drain waiting to happen. */
export function detectDangerousApproval(
  tx: QueuedSafeTransaction,
  ctx: RuleContext,
): Finding[] {
  const selector = selectorOf(tx.data);
  if (!selector) return [];
  const fn = ERC20_SELECTORS[selector];
  if (fn !== "approve" && fn !== "increaseAllowance") return [];

  let spender: `0x${string}`;
  let amount: bigint;
  try {
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data: tx.data as `0x${string}` });
    [spender, amount] = decoded.args as [`0x${string}`, bigint];
  } catch {
    return [warn("approval-undecodable", "Approval-shaped call could not be decoded.")];
  }

  const findings: Finding[] = [];
  if (amount >= EFFECTIVELY_UNLIMITED) {
    findings.push(
      veto(
        "unlimited-approval",
        "Transaction grants an effectively unlimited token allowance.",
        `token=${tx.to} spender=${spender} amount=${amount}. The spender can drain this token at any later time.`,
      ),
    );
  }
  if (!inAddressBook(ctx.addressBook, spender)) {
    findings.push(
      (amount >= EFFECTIVELY_UNLIMITED ? veto : warn)(
        "approval-unknown-spender",
        "Allowance granted to an address that is not in the treasury address book.",
        `spender=${spender}`,
      ),
    );
  }
  return findings;
}

/** Value leaving the treasury toward an address nobody has vouched for. */
export function detectUnknownRecipient(
  tx: QueuedSafeTransaction,
  ctx: RuleContext,
): Finding[] {
  const movesValue = BigInt(tx.value) > 0n;
  if (!movesValue) return [];
  if (isAddressEqual(tx.to, ctx.safeAddress)) return [];
  if (inAddressBook(ctx.addressBook, tx.to)) return [];

  return [
    warn(
      "unknown-recipient",
      "Native value is being sent to an address that is not in the treasury address book.",
      `to=${tx.to} value=${tx.value}`,
    ),
  ];
}

/**
 * A transfer of most of the treasury is categorically different from a routine
 * payment, whoever the recipient is.
 */
export function detectValueDrift(tx: QueuedSafeTransaction, ctx: RuleContext): Finding[] {
  const value = BigInt(tx.value);
  if (value === 0n || ctx.safeBalanceWei === undefined || ctx.safeBalanceWei === 0n) return [];

  const pct = Number((value * 10_000n) / ctx.safeBalanceWei) / 100;
  if (pct < 50) return [];

  const summary = `Transaction moves ${pct.toFixed(1)}% of the Safe's native balance.`;
  const detail = `value=${value} balance=${ctx.safeBalanceWei}`;
  return [pct >= 90 ? veto("value-drift", summary, detail) : warn("value-drift", summary, detail)];
}

/** Proxy upgrades replace the code behind an address the treasury already trusts. */
export function detectProxyUpgrade(tx: QueuedSafeTransaction): Finding[] {
  const selector = selectorOf(tx.data);
  if (!selector) return [];
  const fn = PROXY_SELECTORS[selector];
  if (!fn) return [];

  let impl: unknown;
  try {
    impl = decodeFunctionData({ abi: PROXY_ABI, data: tx.data as `0x${string}` }).args?.[0];
  } catch {
    /* report the upgrade regardless */
  }
  return [
    veto(
      "proxy-upgrade",
      "Transaction upgrades a proxy implementation.",
      `proxy=${tx.to} implementation=${impl ?? "undecodable"}`,
    ),
  ];
}

const DETECTORS = [
  detectDelegateCall,
  detectSafeSelfAdministration,
  detectDangerousApproval,
  detectUnknownRecipient,
  detectValueDrift,
  detectProxyUpgrade,
] as const;

/** Run every deterministic detector. Order of findings is stable for replay. */
export function runRules(tx: QueuedSafeTransaction, ctx: RuleContext): Finding[] {
  const normalised: RuleContext = {
    ...ctx,
    safeAddress: getAddress(ctx.safeAddress),
    addressBook: ctx.addressBook.map((a) => getAddress(a)),
  };
  return DETECTORS.flatMap((detect) => detect(tx, normalised));
}

/**
 * Collapse findings into a single verdict: the highest severity present.
 *
 * A model-sourced finding can never produce a VETO on its own — it is clamped
 * to WARN. Rules gate; the model explains.
 */
export function verdictFrom(findings: readonly Finding[]): Verdict {
  let result: Verdict = Verdict.Allow;
  for (const f of findings) {
    const severity = f.source === "model" && f.severity === Verdict.Veto ? Verdict.Warn : f.severity;
    if (severity === Verdict.Veto) return Verdict.Veto;
    if (severity === Verdict.Warn) result = Verdict.Warn;
  }
  return result;
}
