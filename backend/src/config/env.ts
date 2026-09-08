/**
 * Typed, validated environment configuration.
 *
 * Loaded once at process start. Every field has a demo-safe default so the
 * service boots with zero configuration (`npm run dev` just works).
 */
import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  /** Comma-separated allowed origins for the Next.js frontend. */
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://127.0.0.1:3000'),

  /** Freeze "now" so return-window math stays reproducible across demos. */
  DEMO_FREEZE_CLOCK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  DEMO_NOW: z.string().datetime().default('2026-09-08T10:15:00.000Z'),

  /** Artificial agent latency so the UI can animate the pipeline. */
  AGENT_SIMULATED_LATENCY_MIN_MS: z.coerce.number().int().min(0).default(350),
  AGENT_SIMULATED_LATENCY_MAX_MS: z.coerce.number().int().min(0).default(900),

  /** Per-agent hard timeout; breaching it raises an AGENT_TIMEOUT escalation. */
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  /** Resolution value above which a human must approve. */
  AUTO_APPROVE_MAX_USD: z.coerce.number().nonnegative().default(500),

  /* ------------------------------------------------------------------------ */
  /* Claude Agent SDK                                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * Which implementation backs the seven agents.
   *   'rules' — deterministic TypeScript rules. No network, no cost, instant,
   *             reproducible. Backs the test suite.
   *   'llm'   — each agent is a Claude Agent SDK call with a forced JSON schema.
   *   'hybrid'— LLM for the agents in LLM_AGENTS, rules for the rest.
   */
  AGENT_RUNTIME: z.enum(['rules', 'llm', 'hybrid']).default('rules'),

  /**
   * Which agents use the LLM when AGENT_RUNTIME=hybrid. Comma-separated agent
   * ids, or 'all'. Default targets the four agents where language understanding
   * and synthesis genuinely beat rules; eligibility/logistics/sustainability are
   * policy and arithmetic, which rules do better and more auditably.
   */
  LLM_AGENTS: z.string().default('sentiment,resolution,communication,insights'),

  /**
   * If an LLM agent fails (no key, network down, schema violation after
   * retries), silently fall back to its rules implementation. Keeps a live demo
   * alive when the wifi is not.
   */
  LLM_FALLBACK_TO_RULES: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * Credentials for the Agent SDK subprocess. Two mutually exclusive modes —
   * which one you need depends on the endpoint:
   *
   *   ANTHROPIC_API_KEY     sent as `x-api-key`. Correct for the first-party
   *                         Anthropic API and `sk-ant-…` keys.
   *   ANTHROPIC_AUTH_TOKEN  sent as `Authorization: Bearer`. Required by most
   *                         third-party gateways and classroom proxies
   *                         (Vocareum, LiteLLM, OpenRouter-style shims), which
   *                         reject `x-api-key` with a confusing
   *                         "key was not found" 400 even when the key is valid.
   *
   * If both are set, AUTH_TOKEN wins and API_KEY is deliberately NOT forwarded:
   * Claude Code prefers `x-api-key` when it sees one, which would silently
   * defeat a working Bearer configuration.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  /** Optional gateway/proxy base URL. */
  ANTHROPIC_BASE_URL: z.string().optional(),

  LLM_MODEL: z.string().default('claude-opus-5'),
  /** Depth/spend per agent call. 'low' is plenty for most of these agents. */
  LLM_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  /**
   * Turn budget per agent call.
   *
   * These agents use no tools, so 1 looks right — but it is NOT: producing the
   * forced structured output consumes a turn of its own, so a budget of 1 makes
   * every call terminate with `error_max_turns` before it can answer. 4-6 gives
   * headroom for that plus the SDK's own internal structured-output retries.
   */
  LLM_MAX_TURNS: z.coerce.number().int().positive().default(6),
  /** Per-agent wall-clock budget. Much larger than the rules-mode timeout. */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Re-asks with the validation errors appended when the JSON fails Zod. */
  LLM_MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(3).default(1),
  /** Hard USD ceiling per agent call. 0 disables. */
  LLM_MAX_BUDGET_USD: z.coerce.number().nonnegative().default(0),

  /**
   * How many Agent SDK calls may run concurrently.
   *
   * Each call spawns a Claude Code subprocess with its own JS engine, so the
   * pipeline's two parallel stages can otherwise put two large prompts in
   * flight at once — which exhausts memory and surfaces as a truncated
   * response ("JSON Parse error"). Default 1: serialize the model calls and
   * keep the logical parallelism.
   */
  LLM_MAX_CONCURRENCY: z.coerce.number().int().positive().default(1),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loudly — a misconfigured env should never boot half-working.
  console.error('[env] Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const llmAgentList = parsed.data.LLM_AGENTS.split(',')
  .map((a) => a.trim())
  .filter(Boolean);

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  isTest: parsed.data.NODE_ENV === 'test',
  isProduction: parsed.data.NODE_ENV === 'production',

  /** Agent ids that should use the LLM, resolved from AGENT_RUNTIME + LLM_AGENTS. */
  llmAgents: llmAgentList,
  /** True when any agent could route to the Agent SDK. */
  llmEnabled: parsed.data.AGENT_RUNTIME !== 'rules',
  /** True when SOME credential is available, in either mode. */
  hasCredential: Boolean(parsed.data.ANTHROPIC_AUTH_TOKEN ?? parsed.data.ANTHROPIC_API_KEY),
  /** Which header the credential will travel in — surfaced in /ready. */
  authMode: (parsed.data.ANTHROPIC_AUTH_TOKEN
    ? 'bearer'
    : parsed.data.ANTHROPIC_API_KEY
      ? 'x-api-key'
      : 'none') as 'bearer' | 'x-api-key' | 'none',
} as const;

export type Env = typeof env;

/** Whether a specific agent should run through the Claude Agent SDK. */
export function usesLlm(agentId: string): boolean {
  if (env.AGENT_RUNTIME === 'rules') return false;
  if (env.AGENT_RUNTIME === 'llm') return true;
  return env.llmAgents.includes('all') || env.llmAgents.includes(agentId);
}

/**
 * Fail fast on an impossible configuration rather than at the first agent call
 * three stages into a demo.
 */
if (env.llmEnabled && !env.hasCredential) {
  const message =
    `AGENT_RUNTIME=${env.AGENT_RUNTIME} needs ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY. ` +
    (env.LLM_FALLBACK_TO_RULES
      ? 'LLM_FALLBACK_TO_RULES=true, so agents will run on deterministic rules instead.'
      : 'Set a credential, or set AGENT_RUNTIME=rules.');
  if (env.LLM_FALLBACK_TO_RULES) console.warn(`[env] ${message}`);
  else {
    console.error(`[env] ${message}`);
    process.exit(1);
  }
}
