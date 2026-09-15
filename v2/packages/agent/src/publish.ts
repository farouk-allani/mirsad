/**
 * Publish the policy engine as a paid KeeperHub marketplace listing.
 *
 * The listing is read-only. A caller sends a proposal and a policy and gets
 * back the same decision this repository's engine would make - verdict,
 * reasons, hashes, and the artifact on ALLOW. It holds no key, moves no funds
 * and executes nothing; what it sells is the decision, and the equivalence
 * test in the policy package is what makes that decision worth paying for.
 *
 * The slug is permanent once listed. The price and the output schema are not.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { McpTransport } from "@mirsad/keeperhub";

export const MARKETPLACE_SLUG = "mirsad-preflight";

/**
 * At or above $0.05 a paid call is exempt from the organization's monthly
 * execution quota, so a lower price would cost the publisher more than it
 * earns. For a decision about whether to move money, five cents is not the
 * number anyone is sensitive to.
 */
export const PRICE_USDC_PER_CALL = "0.05";

const ENGINE_PATH = "v2/packages/policy/marketplace/engine.js";

/** The engine expects its two inputs bound above it; KeeperHub inlines these as JSON. */
const BINDINGS =
  "const rawIntent = {{@trigger-1:Trigger.intent}};\n" +
  "const rawPolicy = {{@trigger-1:Trigger.policy}};\n";

export function buildPreflightWorkflow(engineSource: string) {
  return {
    name: "MIRSAD: policy preflight",
    description:
      "Decides whether an agent's proposed DeFi action is permitted under a policy " +
      "the operator signed in advance. Send the proposal and the policy; get ALLOW " +
      "with a hashed execution artifact, or BLOCK with one reason per rule. " +
      "Deterministic, read-only, no custody. The same engine that gates MIRSAD's " +
      "own KeeperHub executions.",
    nodes: [
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: {
          type: "trigger",
          label: "Trigger",
          status: "idle",
          config: { triggerType: "Manual", intent: "", policy: "" },
        },
      },
      {
        id: "step-1",
        type: "action",
        position: { x: 252, y: 0 },
        data: {
          type: "action",
          label: "MIRSAD Decision",
          status: "idle",
          description: "Canonicalise, validate, apply the policy, hash the artifact",
          config: { actionType: "code/run-code", code: BINDINGS + engineSource, timeout: 30 },
        },
      },
    ],
    edges: [{ id: "e-trigger-1-step-1", source: "trigger-1", target: "step-1" }],
  };
}

async function findListedWorkflowId(kh: McpTransport, slug: string): Promise<string | null> {
  try {
    const listing = await kh.callTool<{ id?: string }>("get_workflow_listing", { slug });
    return listing?.id ?? null;
  } catch {
    return null;
  }
}

export async function publish(kh: McpTransport, cwd = process.cwd()): Promise<void> {
  const engine = readFileSync(resolve(cwd, ENGINE_PATH), "utf8");
  const wf = buildPreflightWorkflow(engine);

  // Upsert by slug. An idempotency key guarantees a retry of an identical
  // payload is safe; republishing a changed workflow under one is a 409 by
  // design, not something to work around.
  const existingId = await findListedWorkflowId(kh, MARKETPLACE_SLUG);
  let workflowId: string;
  if (existingId) {
    workflowId = existingId;
    await kh.callTool("update_workflow", {
      workflowId,
      name: wf.name,
      description: wf.description,
      nodes: wf.nodes,
      edges: wf.edges,
      enabled: true,
    });
    console.log(`workflow  ${workflowId} (updated)`);
  } else {
    const created = await kh.callTool<{ id: string }>("create_workflow", { ...wf, enabled: true });
    workflowId = created.id;
    console.log(`workflow  ${workflowId} (created)`);
  }

  const validation = await kh.callTool<unknown>("validate_workflow", { workflowId, deepCheck: true });
  console.log(`validated ${JSON.stringify(validation)}`);

  // The price can only be set while unlisted, so unlist first on a republish.
  try {
    await kh.callTool("unlist_workflow", { workflowId });
  } catch {
    /* not listed yet */
  }
  const priced = await kh.callTool<{ priceUsdcPerCall?: string }>("update_workflow_listing", {
    workflowId,
    priceUsdcPerCall: PRICE_USDC_PER_CALL,
  });
  console.log(`priced    $${priced.priceUsdcPerCall ?? PRICE_USDC_PER_CALL} USDC/call`);

  const listing = await kh.callTool<{ priceUsdcPerCall?: string | null }>("list_workflow", {
    workflowId,
    slug: MARKETPLACE_SLUG,
    category: "Security",
    chain: "8453",
    workflowType: "read",
    inputSchema: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description:
            "The proposed action as a mirsad.intent.v1 JSON object: chainId, protocol, action, " +
            "target, token, amountBaseUnits, beneficiary, observations{blockNumber, observedAt}, source.",
        },
        policy: {
          type: "string",
          description:
            "The operator's policy as a mirsad.policy.v1 JSON object: chainId, actor, allow[], " +
            "maxAmountBaseUnits, maxObservationAgeSeconds, artifactTtlSeconds.",
        },
      },
      required: ["intent", "policy"],
    },
    outputMapping: { nodeId: "step-1", fields: "all" },
  });
  console.log(`listed    slug=${MARKETPLACE_SLUG}  price=${listing.priceUsdcPerCall ?? "unset"}`);
  console.log(`\npublic    https://app.keeperhub.com/mcp/w/${MARKETPLACE_SLUG}`);
  console.log(`call      https://app.keeperhub.com/api/mcp/workflows/${MARKETPLACE_SLUG}/call`);
}
