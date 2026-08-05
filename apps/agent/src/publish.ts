import { KeeperHubClient, type MirsadConfig } from "@mirsad/core";

/**
 * Publishes MIRSAD as a paid, cross-org callable service on the KeeperHub
 * marketplace.
 *
 * This is the step that changes what MIRSAD is. Everything else consumes
 * KeeperHub; this supplies it. Any other DAO's agent can call
 * `mirsad-safe-guard` with a Safe address and get that Safe's pending queue
 * back with MIRSAD's assessment attached — settled per call in USDC over x402
 * or MPP, with no relationship between the two organisations.
 *
 * The detectors run inside KeeperHub's sandboxed Code action rather than on our
 * infrastructure, so a caller depends on KeeperHub's uptime, not ours.
 */

/** Selectors verified with viem, cross-checked against live Safe calldata. */
const DETECTOR_SOURCE = String.raw`
const txs = {{@step-1:Get Pending Transactions.transactions}} || [];
const safeAddr = String({{@trigger-1:Trigger.safeAddress}} || "").toLowerCase();
const book = String({{@trigger-1:Trigger.addressBook}} || "")
  .toLowerCase().split(",").map(function (s) { return s.trim(); }).filter(Boolean);

var SAFE_ADMIN = {
  "0x0d582f13": ["owner-added", "Adds a new Safe owner."],
  "0xf8dc5dd9": ["owner-removed", "Removes a Safe owner."],
  "0xe318b52b": ["owner-swapped", "Replaces a Safe owner. A silent swap leaves the treasury under new control."],
  "0x694e80c3": ["threshold-changed", "Changes the signature threshold."],
  "0x610b5925": ["module-enabled", "Enables a module. Modules move funds with no owner signature at all."],
  "0xe009cfde": ["module-disabled", "Disables a module."],
  "0xe19a9dd9": ["guard-change", "Changes or removes the transaction guard. An attacker does this first."],
  "0xf08a0323": ["fallback-handler-change", "Changes the fallback handler, which can intercept arbitrary calls."]
};
var APPROVE = { "0x095ea7b3": 1, "0x39509351": 1 };
var UPGRADE = { "0x3659cfe6": 1 };
// 2^128: an allowance this large is unlimited in practice. Attackers avoid
// exact uint256 max precisely because naive scanners only match that value.
var UNLIMITED = BigInt("340282366920938463463374607431768211456");

function sel(d) { return d && d.length >= 10 ? d.slice(0, 10).toLowerCase() : null; }
function known(a) { return book.indexOf(String(a || "").toLowerCase()) !== -1; }

var results = txs.map(function (tx) {
  var findings = [];
  var to = String(tx.to || "").toLowerCase();
  var data = tx.data || null;
  var s = sel(data);

  if (Number(tx.operation) === 1) {
    findings.push({ code: "delegatecall", severity: "VETO",
      summary: "Delegatecall executes foreign code against the Safe's own storage." });
  }
  if (to === safeAddr && s) {
    var hit = SAFE_ADMIN[s];
    findings.push(hit
      ? { code: hit[0], severity: "VETO", summary: hit[1] }
      : { code: "safe-self-call-unknown", severity: "WARN",
          summary: "Calls the Safe itself with an unrecognised function (" + s + ")." });
  }
  if (s && APPROVE[s] && data.length >= 138) {
    var spender = "0x" + data.slice(34, 74);
    var amount = BigInt("0x" + data.slice(74, 138));
    if (amount >= UNLIMITED) {
      findings.push({ code: "unlimited-approval", severity: "VETO",
        summary: "Grants an effectively unlimited token allowance to " + spender + "." });
    } else if (!known(spender)) {
      findings.push({ code: "approval-unknown-spender", severity: "WARN",
        summary: "Allowance granted to an address not in the address book." });
    }
  }
  if (s && UPGRADE[s]) {
    findings.push({ code: "proxy-upgrade", severity: "VETO",
      summary: "Upgrades a proxy implementation, replacing code behind a trusted address." });
  }
  if (BigInt(tx.value || "0") > BigInt(0) && to !== safeAddr && !known(to)) {
    findings.push({ code: "unknown-recipient", severity: "WARN",
      summary: "Sends native value to an address not in the treasury address book." });
  }

  var verdict = "ALLOW";
  for (var i = 0; i < findings.length; i++) {
    if (findings[i].severity === "VETO") { verdict = "VETO"; break; }
    if (findings[i].severity === "WARN") verdict = "WARN";
  }
  return {
    safeTxHash: tx.safeTxHash, nonce: tx.nonce, to: tx.to, value: tx.value,
    operation: tx.operation,
    confirmations: (tx.confirmations || []).length + "/" + tx.confirmationsRequired,
    verdict: verdict, findings: findings
  };
});

return {
  safe: safeAddr,
  assessed: results.length,
  vetoed: results.filter(function (r) { return r.verdict === "VETO"; }).length,
  warned: results.filter(function (r) { return r.verdict === "WARN"; }).length,
  transactions: results
};
`;

export const MARKETPLACE_SLUG = "mirsad-safe-guard";

export function buildAuditWorkflow(defaultSafe: string) {
  return {
    name: "MIRSAD: Safe queue audit",
    description:
      "Audits a Safe multisig's pending transaction queue before anyone signs. " +
      "Returns each queued transaction with a VETO / WARN / ALLOW verdict and the " +
      "findings behind it: delegatecall, owner and threshold changes, module and " +
      "guard tampering, unlimited approvals, and payments to addresses outside the " +
      "treasury address book.",
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: {
          type: "trigger",
          label: "Trigger",
          status: "idle",
          config: { triggerType: "Manual", safeAddress: defaultSafe, network: "11155111", addressBook: "" },
        },
      },
      {
        id: "step-1",
        type: "action",
        position: { x: 252, y: 0 },
        data: {
          type: "action",
          label: "Get Pending Transactions",
          status: "idle",
          description: "Read the Safe's unexecuted queue",
          config: {
            actionType: "safe/get-pending-transactions",
            safeAddress: "{{@trigger-1:Trigger.safeAddress}}",
            network: "{{@trigger-1:Trigger.network}}",
          },
        },
      },
      {
        id: "step-2",
        type: "action",
        position: { x: 504, y: 0 },
        data: {
          type: "action",
          label: "MIRSAD Assessment",
          status: "idle",
          description: "Deterministic detectors over every queued transaction",
          config: { actionType: "code/run-code", code: DETECTOR_SOURCE, timeout: 30 },
        },
      },
    ],
    edges: [
      { id: "e-trigger-1-step-1", source: "trigger-1", target: "step-1" },
      { id: "e-step-1-step-2", source: "step-1", target: "step-2" },
    ],
  };
}

export async function publish(config: MirsadConfig): Promise<number> {
  const kh = new KeeperHubClient({
    apiKey: config.KEEPERHUB_API_KEY,
    baseUrl: config.KEEPERHUB_API_URL,
  });
  await kh.connect();

  const wf = buildAuditWorkflow(config.MIRSAD_SAFE_ADDRESS ?? "");
  const created = await kh.callTool<{ id: string }>("create_workflow", {
    ...wf,
    enabled: true,
    idempotency_key: `mirsad-marketplace-${MARKETPLACE_SLUG}`,
  });
  process.stdout.write(`workflow  ${created.id}\n`);

  const validation = await kh.callTool<{ ok: boolean; result?: unknown }>("validate_workflow", {
    workflowId: created.id,
    deepCheck: true,
  });
  process.stdout.write(`validated ${JSON.stringify(validation)}\n`);

  // The slug is permanent once published; the price and output schema are not.
  const listing = await kh.callTool("list_workflow", {
    workflowId: created.id,
    slug: MARKETPLACE_SLUG,
    category: "Security",
    chain: "11155111",
    workflowType: "read",
    inputSchema: {
      type: "object",
      properties: {
        safeAddress: { type: "string", description: "Safe multisig address to audit (0x...)" },
        network: { type: "string", description: "Chain ID, e.g. 11155111 for Sepolia" },
        addressBook: {
          type: "string",
          description:
            "Comma-separated addresses the treasury has vouched for. Recipients outside this list are flagged.",
        },
      },
      required: ["safeAddress", "network"],
    },
    outputMapping: { nodeId: "step-2", fields: "all" },
  });
  process.stdout.write(`listed    ${JSON.stringify(listing)}\n`);
  process.stdout.write(
    `\npublic    https://app.keeperhub.com/mcp/w/${MARKETPLACE_SLUG}\n` +
      `call      https://app.keeperhub.com/api/mcp/workflows/${MARKETPLACE_SLUG}/call\n`,
  );
  return 0;
}
