/**
 * Minimal KeeperHub MCP client (JSON-RPC over Streamable HTTP).
 *
 * Lives here for now so the demo scripts exercise the real integration path
 * rather than shelling out. Graduates to packages/core with the watch loop.
 */

const MCP_URL = "https://app.keeperhub.com/mcp";

export interface ExecutionResult {
  executionId: string;
  status: string;
  transactionHash?: string;
  transactionLink?: string;
  sponsored?: boolean;
  gasUsedWei?: string;
  error?: unknown;
}

export class KeeperHub {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(private readonly apiKey: string) {
    if (!apiKey.startsWith("kh_")) {
      throw new Error("Expected a KeeperHub organization key (prefix `kh_`).");
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  private async rpc(method: string, params?: unknown): Promise<any> {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    if (!res.ok) throw new Error(`KeeperHub ${method}: HTTP ${res.status} ${await res.text()}`);
    const sid = res.headers.get("Mcp-Session-Id");
    if (sid) this.sessionId = sid;
    const body = await res.json();
    if (body.error) throw new Error(`KeeperHub ${method}: ${body.error.message}`);
    return body.result;
  }

  async connect(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mirsad", version: "0.1.0" },
    });
  }

  /** Tool results arrive as a text block containing JSON. */
  async callTool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") throw new Error(`${name}: unexpected result shape`);
    if (text.startsWith("MCP error")) throw new Error(`${name}: ${text}`);
    return JSON.parse(text) as T;
  }

  /**
   * The documented safe-write sequence, as a single call.
   *
   * simulate -> require success && !wouldRevert -> re-send with an
   * idempotency key -> poll with bounded backoff. Skipping any step is how
   * agents broadcast transactions that were always going to revert.
   */
  async writeContract(opts: {
    chainId: string;
    contractAddress: string;
    functionName: string;
    functionArgs: unknown[];
    abi: string;
    idempotencyKey: string;
  }): Promise<ExecutionResult> {
    const base = {
      chain_id: opts.chainId,
      contract_address: opts.contractAddress,
      function_name: opts.functionName,
      // Note: a JSON *string*, not an array. The docs disagree; the server wins.
      function_args: JSON.stringify(opts.functionArgs),
      abi: opts.abi,
    };

    const sim = await this.callTool<{ success: boolean; wouldRevert: boolean; revertReason?: string }>(
      "execute_contract_call",
      { ...base, simulate: true },
    );
    if (!sim.success || sim.wouldRevert) {
      throw new Error(`preflight refused: ${sim.revertReason ?? JSON.stringify(sim)}`);
    }

    const submitted = await this.callTool<ExecutionResult>("execute_contract_call", {
      ...base,
      idempotency_key: opts.idempotencyKey,
    });

    return this.pollUntilSettled(submitted.executionId);
  }

  async pollUntilSettled(executionId: string, delaysMs = [1000, 2000, 3000, 5000, 8000, 13000]) {
    let last: ExecutionResult | null = null;
    for (const delay of delaysMs) {
      last = await this.callTool<ExecutionResult>("get_direct_execution_status", {
        execution_id: executionId,
      });
      if (last.status === "completed" || last.status === "failed") return last;
      await new Promise((r) => setTimeout(r, delay));
    }
    throw new Error(`execution ${executionId} did not settle; last status ${last?.status}`);
  }
}
