/**
 * The KeeperHub wire.
 *
 * `Transport` is an interface rather than a class so the executor can be driven
 * by a scripted double in tests. Rate limits, outages, ambiguous timeouts and
 * mid-flight crashes are the conditions this product exists to survive, and
 * none of them are reproducible against a live server on demand.
 *
 * Failures are classified on the way out. A caller must be able to tell "this
 * will never work" from "ask again shortly" without reading an error string,
 * because those two lead to opposite actions.
 */

export type TransportFailureKind =
  /** 429, or a server that asked us to slow down. Same operation, later. */
  | "rate-limited"
  /** 5xx, network error, timeout. The outcome of the request is unknown. */
  | "unavailable"
  /** 4xx that will not become valid by being repeated. */
  | "invalid"
  /** The idempotency key is bound to a different body than the one we sent. */
  | "conflict";

export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind: TransportFailureKind,
    readonly tool: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface Transport {
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
}

export interface McpTransportOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to the global. */
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** JSON-RPC over Streamable HTTP, which is what `app.keeperhub.com/mcp` speaks. */
export class McpTransport implements Transport {
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: McpTransportOptions) {
    if (!opts.apiKey.startsWith("kh_")) {
      throw new TransportError(
        "expected an organization key (prefix kh_); wfb_ webhook keys authenticate a different system",
        "invalid",
        "constructor",
      );
    }
    this.url = `${(opts.baseUrl ?? "https://app.keeperhub.com").replace(/\/$/, "")}/mcp`;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async rpc(method: string, params?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        // Pinned, so a server-side version bump surfaces as a deprecation
        // notice rather than as changed behaviour under our feet.
        "KeeperHub-Version": "1",
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
          signal: controller.signal,
        });
      } catch (cause) {
        // A request that never got an answer may still have been received.
        throw new TransportError(
          `network failure calling ${method}: ${(cause as Error).message}`,
          "unavailable",
          method,
        );
      }

      const sunset = res.headers.get("Sunset");
      if (sunset) {
        process.emitWarning(`KeeperHub announced a Sunset for ${method}: ${sunset}`);
      }

      if (!res.ok) {
        const body = (await res.text()).slice(0, 500);
        throw new TransportError(
          `HTTP ${res.status} from ${method}: ${body}`,
          res.status === 429
            ? "rate-limited"
            : res.status === 409
              ? "conflict"
              : RETRYABLE_STATUS.has(res.status)
                ? "unavailable"
                : "invalid",
          method,
          parseRetryAfter(res.headers.get("Retry-After")),
        );
      }

      const sid = res.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;

      const body = (await res.json()) as { error?: { message?: string }; result?: unknown };
      if (body.error) {
        throw new TransportError(body.error.message ?? "unknown MCP error", "invalid", method);
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async connect(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mirsad", version: "0.2.0" },
    });
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = (await this.rpc("tools/call", { name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new TransportError(`unexpected result shape from ${name}`, "invalid", name);
    }
    if (result.isError) {
      throw new TransportError(text.trim(), "invalid", name);
    }

    // Tool failures can arrive as prose rather than JSON. Parsing blindly turns
    // a legible server message into a SyntaxError about an unexpected token,
    // which is how this was originally found.
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TransportError(text.trim(), "invalid", name);
    }
  }
}
