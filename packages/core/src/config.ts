import { z } from "zod";

/**
 * Environment contract for MIRSAD.
 *
 * Parsed once, loudly. An execution layer that starts up with a half-configured
 * environment and discovers it mid-transaction is exactly the failure mode this
 * project exists to argue against.
 */
/**
 * Treat an empty string as unset.
 *
 * A dotenv line with no value (`MIRSAD_SAFE_ADDRESS=`) yields `""`, not
 * `undefined` — so a bare `.optional()` rejects a freshly copied `.env.example`
 * and the README quickstart fails on the first command. Same for a shell that
 * exports a variable to nothing.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const EnvSchema = z.object({
  /** Organization API key from app.keeperhub.com → Settings → API Keys. Prefix `kh_`. */
  KEEPERHUB_API_KEY: z
    .string()
    .min(1, "KEEPERHUB_API_KEY is required")
    .refine((v) => v.startsWith("kh_"), {
      message:
        "Expected an organization key (prefix `kh_`). Keys with prefix `wfb_` are user webhook keys and will not authenticate the API, MCP server, or CLI.",
    }),

  KEEPERHUB_API_URL: z.string().url().default("https://app.keeperhub.com"),

  /** Chain MIRSAD watches. Ethereum Sepolia by default — see CLAUDE.md §3.5 for why not Base Sepolia. */
  MIRSAD_CHAIN_ID: z.string().regex(/^\d+$/, "chain_id must be a numeric string").default("11155111"),

  /** The Safe whose queue we guard. */
  MIRSAD_SAFE_ADDRESS: optional(
    z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Expected a 20-byte hex address"),
  ),

  /** Deployed MirsadVerdictRegistry — MIRSAD writes verdicts here via KeeperHub. */
  MIRSAD_REGISTRY_ADDRESS: optional(
    z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Expected a 20-byte hex address"),
  ),

  /** Deployed MirsadGuard — installed on a Safe with `setGuard` to enforce vetoes. */
  MIRSAD_GUARD_ADDRESS: optional(
    z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Expected a 20-byte hex address"),
  ),

  /**
   * Intent-drift classifier. Held behind a provider interface rather than
   * pinned to one vendor: the model is additive here — deterministic rules
   * reach VETO on their own, and the classifier only raises to WARN and
   * supplies reasoning. `none` runs MIRSAD rules-only, which is a supported
   * mode, not a degraded one.
   */
  MIRSAD_CLASSIFIER: z.enum(["deepseek", "none"]).default("deepseek"),

  CLASSIFIER_API_KEY: optional(z.string().min(1)),
  CLASSIFIER_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  CLASSIFIER_MODEL: z.string().default("deepseek-chat"),

  /** Seconds between queue polls. */
  MIRSAD_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(20),

  /**
   * When false, MIRSAD reaches verdicts and writes the audit trail but never
   * broadcasts. Default false: arming the onchain response is an explicit act.
   */
  MIRSAD_ARMED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
}).superRefine((env, ctx) => {
  if (env.MIRSAD_CLASSIFIER !== "none" && !env.CLASSIFIER_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["CLASSIFIER_API_KEY"],
      message: `Required when MIRSAD_CLASSIFIER is "${env.MIRSAD_CLASSIFIER}". Set MIRSAD_CLASSIFIER=none to run rules-only.`,
    });
  }
});

export type MirsadConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MirsadConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid MIRSAD environment:\n${issues}\n\nSee .env.example.`);
  }
  return parsed.data;
}
