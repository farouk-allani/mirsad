import { z } from "zod";
import { Verdict, type Finding, type QueuedSafeTransaction } from "../types.js";

/**
 * The intent-drift classifier.
 *
 * Deterministic rules answer "is this transaction structurally dangerous?".
 * They cannot answer "does this transaction do what the person who proposed it
 * said it does?" -- that requires reading prose against bytes, which is what a
 * language model is genuinely good at.
 *
 * Two invariants hold no matter which provider is plugged in:
 *
 *  1. Every finding it returns is tagged `source: "model"`, and `verdictFrom`
 *     clamps a model VETO down to WARN. The model cannot block a transaction.
 *  2. It never throws into the watch loop. A provider outage, a timeout, or
 *     malformed JSON degrades MIRSAD to rules-only and is recorded as such.
 *     An execution layer that stops watching because an API was slow is worse
 *     than one that never had a model.
 */

export interface ClassifierInput {
  transaction: QueuedSafeTransaction;
  /** What a human was told this transaction does. The claim we test the bytes against. */
  statedIntent?: string;
  /** Human-readable decode of the calldata, when we could produce one. */
  decoded?: string;
  /** What the deterministic rules already found, so the model does not repeat them. */
  ruleFindings: readonly Finding[];
}

export interface Classifier {
  readonly name: string;
  classify(input: ClassifierInput): Promise<Finding[]>;
}

/** Rules-only mode. A supported configuration, not a degraded one. */
export class NullClassifier implements Classifier {
  readonly name = "none";
  async classify(): Promise<Finding[]> {
    return [];
  }
}

const ModelFinding = z.object({
  code: z.string().min(1).max(64),
  severity: z.enum(["ALLOW", "WARN", "VETO"]),
  summary: z.string().min(1).max(400),
  detail: z.string().max(1000).optional(),
});

const ModelResponse = z.object({
  intent_matches_calldata: z.boolean(),
  findings: z.array(ModelFinding).max(10),
});

const SYSTEM_PROMPT = `You review pending multisig treasury transactions for a security tool called MIRSAD.

You are given a Safe transaction, a decode of its calldata, and the findings that deterministic rules already produced. Your ONLY job is the question rules cannot answer:

  Does this transaction do what the person who proposed it said it does?

Report intent drift: the calldata does something the stated intent does not mention, targets a different contract or recipient than described, moves a different amount, or has effects a reader of the description would not expect.

Rules:
- Do NOT repeat findings the deterministic rules already reported. They are shown to you so you can skip them.
- If no stated intent is given, judge whether the transaction's effects are self-evident and internally consistent, and say so plainly. Absence of a description is not itself a finding.
- Be specific. "Looks suspicious" is useless. Name the mismatch.
- Report nothing rather than pad. An empty findings array is a valid, common answer.
- Your severity is advisory. MIRSAD clamps model severity to at most WARN; only deterministic rules can block a transaction.

Respond with JSON only:
{"intent_matches_calldata": boolean, "findings": [{"code": "kebab-case-id", "severity": "ALLOW"|"WARN"|"VETO", "summary": "one sentence", "detail": "optional specifics"}]}`;

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * OpenAI-compatible chat-completions client.
 *
 * Written against the wire protocol rather than a vendor SDK, so any
 * OpenAI-compatible endpoint works by changing `baseUrl` and `model`.
 */
export class DeepSeekClassifier implements Classifier {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: DeepSeekOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "");
    this.model = opts.model ?? "deepseek-v4-flash";
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.name = `deepseek:${this.model}`;
  }

  async classify(input: ClassifierInput): Promise<Finding[]> {
    const prompt = renderPrompt(input);

    // One retry: transient failures and malformed JSON are both common enough
    // to be worth a second attempt, and both cheap. Beyond that, degrade.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.complete(prompt);
        const parsed = ModelResponse.safeParse(JSON.parse(raw));
        if (!parsed.success) continue;
        return parsed.data.findings.map(toFinding);
      } catch {
        // fall through to the next attempt, then to rules-only
      }
    }
    return [];
  }

  private async complete(userContent: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          response_format: { type: "json_object" },
          max_tokens: 900,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`classifier HTTP ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("classifier returned no content");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

function toFinding(f: z.infer<typeof ModelFinding>): Finding {
  const severity =
    f.severity === "VETO" ? Verdict.Veto : f.severity === "WARN" ? Verdict.Warn : Verdict.Allow;
  return {
    code: f.code,
    severity,
    source: "model",
    summary: f.summary,
    ...(f.detail === undefined ? {} : { detail: f.detail }),
  };
}

export function renderPrompt(input: ClassifierInput): string {
  const { transaction: tx, statedIntent, decoded, ruleFindings } = input;
  const lines = [
    "## Safe transaction",
    `safe:        ${tx.safe}`,
    `to:          ${tx.to}`,
    `value:       ${tx.value} wei`,
    `operation:   ${tx.operation === 1 ? "DELEGATECALL" : "CALL"}`,
    `nonce:       ${tx.nonce}`,
    `signatures:  ${tx.confirmations.length} of ${tx.confirmationsRequired} required`,
    `calldata:    ${tx.data ?? "(none)"}`,
  ];
  if (decoded) lines.push("", "## Decoded calldata", decoded);
  lines.push(
    "",
    "## Stated intent",
    statedIntent?.trim() ? statedIntent.trim() : "(none provided)",
    "",
    "## Already found by deterministic rules (do not repeat)",
    ruleFindings.length
      ? ruleFindings.map((f) => `- [${f.severity}] ${f.code}: ${f.summary}`).join("\n")
      : "(none)",
  );
  return lines.join("\n");
}

/** Build the classifier the environment asks for. */
export function createClassifier(cfg: {
  MIRSAD_CLASSIFIER: "deepseek" | "none";
  CLASSIFIER_API_KEY?: string | undefined;
  CLASSIFIER_BASE_URL: string;
  CLASSIFIER_MODEL: string;
}): Classifier {
  if (cfg.MIRSAD_CLASSIFIER === "none" || !cfg.CLASSIFIER_API_KEY) return new NullClassifier();
  return new DeepSeekClassifier({
    apiKey: cfg.CLASSIFIER_API_KEY,
    baseUrl: cfg.CLASSIFIER_BASE_URL,
    model: cfg.CLASSIFIER_MODEL,
  });
}
