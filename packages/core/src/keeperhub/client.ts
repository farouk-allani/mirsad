/**
 * KeeperHub MCP client — JSON-RPC over Streamable HTTP.
 *
 * Canonical implementation. `packages/contracts/lib/keeperhub.ts` is a
 * demo-script copy kept because that package is CommonJS; if you change the
 * safe-write sequence, change it here first.
 */

export interface ExecutionResult {
  executionId: string;
  status: string;
  transactionHash?: string;
  transactionLink?: string;
  sponsored?: boolean;
  gasUsedWei?: string;
  retryCount?: number;
  error?: unknown;
}

export interface SimulationOutcome {
  success: boolean;
  wouldRevert: boolean;
  gasEstimate?: string;
  revertReason?: string;
}

export class KeeperHubError extends Error {
  constructor(
    message: string,
    readonly tool: string,
  ) {
    super(message);
    this.name = "KeeperHubError";
  }
}

export interface KeeperHubOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class KeeperHubClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly mcpUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: KeeperHubOptions) {
    if (!opts.apiKey.startsWith("kh_")) {
      throw new KeeperHubError(
        "Expected an organization key (prefix `kh_`). `wfb_` webhook keys will not authenticate.",
        "constructor",
      );
    }
    this.mcpUrl = `${(opts.baseUrl ?? "https://app.keeperhub.com").replace(/\/$/, "")}/mcp`;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private async rpc(method: string, params?: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

      const res = await fetch(this.mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new KeeperHubError(`HTTP ${res.status}: ${await res.text()}`, method);
      const sid = res.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;
      const body = (await res.json()) as { error?: { message?: string }; result?: unknown };
      if (body.error) throw new KeeperHubError(body.error.message ?? "unknown MCP error", method);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async connect(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mirsad", version: "0.1.0" },
    });
  }

  async callTool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") throw new KeeperHubError("unexpected result shape", name);
    if (text.startsWith("MCP error")) throw new KeeperHubError(text, name);

    // Tool results are usually JSON in a text block, but failures can come back
    // as plain prose ("API call failed: ..."). Parsing blindly turns a legible
    // server message into a SyntaxError about token 'A', which is how this was
    // found. Surface the server's own words instead.
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new KeeperHubError(text.trim(), name);
    }
  }

  /** Run a workflow and return its output once settled. Used by the queue poller. */
  async runWorkflow(workflowId: string): Promise<unknown> {
    const started = await this.callTool<{ executionId: string }>("execute_workflow", {
      workflowId,
    });
    for (const delay of [1000, 2000, 3000, 5000, 8000]) {
      await new Promise((r) => setTimeout(r, delay));
      const res = await this.callTool<any>("get_execution", { executionId: started.executionId });
      const status = res?.status?.status;
      if (status === "success") return res?.logs?.execution?.output;
      if (status === "error") {
        return { error: res?.status?.errorContext?.error ?? "workflow failed" };
      }
    }
    return { error: `workflow ${started.executionId} did not settle` };
  }

  /**
   * The documented safe-write sequence, as one call.
   *
   * simulate -> require success && !wouldRevert -> resend with an idempotency
   * key -> poll with bounded backoff. Broadcasting without the preflight is how
   * agents burn gas on transactions that were always going to revert.
   */
  async writeContract(opts: {
    chainId: string;
    contractAddress: string;
    functionName: string;
    functionArgs: unknown[];
    abi: string;
    idempotencyKey: string;
  }): Promise<{ simulation: SimulationOutcome; execution: ExecutionResult }> {
    // Field names verified against the server's own inputSchema; the published
    // docs use different ones (contractAddress/function/args). See FRICTION #10.
    const base = {
      chain_id: opts.chainId,
      contract_address: opts.contractAddress,
      function_name: opts.functionName,
      function_args: JSON.stringify(opts.functionArgs),
      abi: opts.abi,
    };

    const simulation = await this.callTool<SimulationOutcome>("execute_contract_call", {
      ...base,
      simulate: true,
    });
    if (!simulation.success || simulation.wouldRevert) {
      throw new KeeperHubError(
        `preflight refused: ${simulation.revertReason ?? JSON.stringify(simulation)}`,
        "execute_contract_call",
      );
    }

    const submitted = await this.callTool<ExecutionResult>("execute_contract_call", {
      ...base,
      idempotency_key: opts.idempotencyKey,
    });
    const execution = await this.pollUntilSettled(submitted.executionId);
    return { simulation, execution };
  }

  async pollUntilSettled(
    executionId: string,
    delaysMs = [1000, 2000, 3000, 5000, 8000, 13000],
  ): Promise<ExecutionResult> {
    let last: ExecutionResult | null = null;
    for (const delay of delaysMs) {
      last = await this.callTool<ExecutionResult>("get_direct_execution_status", {
        execution_id: executionId,
      });
      if (last.status === "completed" || last.status === "failed") return last;
      await new Promise((r) => setTimeout(r, delay));
    }
    throw new KeeperHubError(
      `execution ${executionId} did not settle; last status ${last?.status}`,
      "get_direct_execution_status",
    );
  }
}
