/**
 * ============================================================================
 * CLAUDE AGENT SDK CLIENT — forced structured output
 * ============================================================================
 *
 * One function, `runStructuredQuery`, which is the ONLY place in the codebase
 * that talks to a model. Everything else works with validated TypeScript.
 *
 * HOW THE JSON IS FORCED (three independent layers, deliberately belt-and-braces)
 *
 *   1. SCHEMA CONSTRAINT — `outputFormat: { type: 'json_schema', schema }`.
 *      The schema is generated from the agent's own Zod schema via Zod 4's
 *      native `z.toJSONSchema(..., { io: 'output' })`, which emits
 *      `additionalProperties: false` and marks every field required. The model
 *      is constrained at generation time; it cannot return a different shape.
 *      The result arrives on `result.structured_output` — already parsed JSON,
 *      never a string we have to scrape out of prose.
 *
 *   2. ZOD VALIDATION — the returned object is parsed back through the SAME Zod
 *      schema that generated the JSON Schema. Single source of truth, so drift
 *      between "what we asked for" and "what we accept" is impossible. This
 *      also applies Zod's coercions and defaults.
 *
 *   3. REPAIR RETRY — if step 2 fails (a nullable/enum edge the schema could not
 *      express, say), we re-ask once with the exact Zod issues appended. Bounded
 *      by LLM_MAX_REPAIR_ATTEMPTS.
 *
 * TOOLS ARE OFF. These agents reason over JSON handed to them in the prompt.
 * They must not read files, run bash, or search the web — so every built-in tool
 * is denied and `maxTurns` is 1. That also removes the Agent SDK's filesystem
 * surface area from a server process, which matters more than the latency win.
 *
 * `settingSources: []` stops the SDK loading the developer's ~/.claude settings,
 * CLAUDE.md or project skills into a server request. Without this, behaviour
 * would differ between laptops.
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ZodType, z } from 'zod';
import { env } from '../config/env';
import { logger } from '../core/logger';
import { toStrictJsonSchema } from '../lib/zod-to-json-schema';

/* -------------------------------------------------------------------------- */
/* Concurrency gate                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Limits how many Agent SDK calls run at once.
 *
 * WHY THIS IS NEEDED: each call spawns a Claude Code subprocess with its own JS
 * engine. The pipeline has two parallel stages, so without a gate two large
 * prompts can be in flight together — which on a normal laptop produced
 * `MemoryExhaustion` inside the CLI's allocator and, more often, a truncated
 * response surfacing as `API Error: JSON Parse error: Unable to parse JSON
 * string`. Both look like model failures and are actually resource exhaustion.
 *
 * Parallelism across agents is a LATENCY optimization; correctness is not
 * negotiable. Serializing the model calls costs seconds and buys reliability.
 * The orchestrator's logical parallelism is unchanged — stage 1 and stage 5
 * still fan out, they just queue here.
 */
class ConcurrencyGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;

    let released = false;
    return () => {
      if (released) return; // release must be idempotent
      released = true;
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
}

const gate = new ConcurrencyGate(Math.max(1, env.LLM_MAX_CONCURRENCY));

/**
 * Whether a model accepts the `effort` control.
 *
 * Effort is available on the Opus/Sonnet/Fable generations. Haiku 4.5 does not
 * take it and errors if it is sent, so the parameter must be omitted rather
 * than passed as undefined.
 */
function supportsEffort(model: string): boolean {
  return !/haiku/i.test(model);
}

/** Every built-in tool, denied. These agents are pure reasoners. */
const DENIED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoWrite',
] as const;

export interface StructuredQueryRequest<TSchema extends ZodType> {
  /** Used only for logging and error messages. */
  label: string;
  /** Role, decision rules, and hard constraints. Stable per agent — put the
   *  invariant instructions here and the case data in `userPrompt`. */
  systemPrompt: string;
  /** The case-specific payload. */
  userPrompt: string;
  /** Drives BOTH the forced JSON Schema and the validation. */
  schema: TSchema;
  /** Overrides for this call. */
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs?: number;
  /** Cooperative cancellation from the agent harness. */
  signal?: AbortSignal;
}

export interface StructuredQueryResult<T> {
  data: T;
  /** Estimated USD for this call, from the SDK's own accounting. */
  costUsd: number;
  durationMs: number;
  /** Model turns consumed (1 unless a repair retry happened). */
  attempts: number;
  modelUsed: string;
  /** Populated when a repair retry was needed — useful for prompt tuning. */
  repairedFrom: string | null;
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export class LlmSchemaError extends Error {
  constructor(
    message: string,
    readonly issues: unknown,
  ) {
    super(message);
    this.name = 'LlmSchemaError';
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Runs one forced-JSON query and returns validated, typed data.
 * Throws `LlmUnavailableError` / `LlmSchemaError` — callers decide whether to
 * fall back to rules.
 */
export async function runStructuredQuery<TSchema extends ZodType>(
  request: StructuredQueryRequest<TSchema>,
): Promise<StructuredQueryResult<z.infer<TSchema>>> {
  if (!env.hasCredential) {
    throw new LlmUnavailableError(
      'Neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is set, so no model call can be made.',
    );
  }

  const log = logger.child({ llm: request.label });
  const jsonSchema = toStrictJsonSchema(request.schema);
  const startMs = Date.now();

  let attempts = 0;
  let costUsd = 0;
  let repairedFrom: string | null = null;
  let lastIssues: unknown = null;
  let prompt = request.userPrompt;

  const maxAttempts = 1 + env.LLM_MAX_REPAIR_ATTEMPTS;

  while (attempts < maxAttempts) {
    attempts += 1;

    const turn = await runOneTurn({
      label: request.label,
      systemPrompt: request.systemPrompt,
      prompt,
      jsonSchema,
      model: request.model ?? env.LLM_MODEL,
      effort: request.effort ?? env.LLM_EFFORT,
      timeoutMs: request.timeoutMs ?? env.LLM_TIMEOUT_MS,
      signal: request.signal,
    });

    costUsd += turn.costUsd;

    /* --- layer 2: validate against the very schema we constrained with --- */
    const parsed = request.schema.safeParse(turn.structuredOutput);
    if (parsed.success) {
      return {
        data: parsed.data as z.infer<TSchema>,
        costUsd,
        durationMs: Date.now() - startMs,
        attempts,
        modelUsed: turn.model,
        repairedFrom,
      };
    }

    lastIssues = parsed.error.issues.slice(0, 12).map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
      code: i.code,
    }));

    log.warn('Structured output failed Zod validation', { attempt: attempts, issues: lastIssues });

    if (attempts >= maxAttempts) break;

    /* --- layer 3: re-ask with the precise failures appended --------------- */
    repairedFrom = JSON.stringify(lastIssues);
    prompt = [
      request.userPrompt,
      '',
      '## CORRECTION REQUIRED',
      'Your previous response was structurally valid JSON but failed schema validation.',
      'Fix exactly these problems and return the corrected object. Change nothing else:',
      '',
      ...(lastIssues as { path: string; message: string }[]).map((i) => `- \`${i.path}\`: ${i.message}`),
    ].join('\n');
  }

  throw new LlmSchemaError(
    `${request.label}: model output failed schema validation after ${attempts} attempt(s).`,
    lastIssues,
  );
}

/* -------------------------------------------------------------------------- */
/* Subprocess environment                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Builds the env handed to the Agent SDK's CLI subprocess.
 *
 * THE IMPORTANT SUBTLETY: exactly ONE credential variable is forwarded.
 *
 * Claude Code prefers `ANTHROPIC_API_KEY` (sent as `x-api-key`) whenever it is
 * present. Many third-party gateways only accept `Authorization: Bearer`, and
 * reject `x-api-key` with a `400 This key was not found` — which reads like a
 * bad credential but is actually a wrong-header problem. So when a Bearer token
 * is configured we must actively DELETE any inherited `ANTHROPIC_API_KEY` from
 * the parent process, not merely leave it unset, or it silently wins.
 */
function buildSubprocessEnv(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') inherited[key] = value;
  }

  // Clear both, then set only the one we mean.
  delete inherited.ANTHROPIC_API_KEY;
  delete inherited.ANTHROPIC_AUTH_TOKEN;

  if (env.ANTHROPIC_AUTH_TOKEN) inherited.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN;
  else if (env.ANTHROPIC_API_KEY) inherited.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;

  if (env.ANTHROPIC_BASE_URL) inherited.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;

  return inherited;
}

/* -------------------------------------------------------------------------- */
/* One SDK turn                                                                */
/* -------------------------------------------------------------------------- */

interface TurnResult {
  structuredOutput: unknown;
  costUsd: number;
  model: string;
  text: string;
}

async function runOneTurn(args: {
  label: string;
  systemPrompt: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<TurnResult> {
  // The SDK aborts via AbortController; bridge the caller's signal into ours and
  // add our own timeout so a hung subprocess cannot wedge the pipeline.
  // Queue behind any in-flight model call. Acquired BEFORE the timeout starts
  // so queue time is not charged against the call's own budget.
  const release = await gate.acquire();

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  args.signal?.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const options: Options = {
    model: args.model,
    // A bare string system prompt REPLACES Claude Code's default preset, which
    // is what we want: this is a returns analyst, not a coding agent.
    systemPrompt: args.systemPrompt,
    // `effort` is an Opus/Sonnet-generation control. Haiku 4.5 rejects it, so
    // omit the key entirely rather than sending an unsupported parameter.
    ...(supportsEffort(args.model) ? { effort: args.effort } : {}),
    maxTurns: env.LLM_MAX_TURNS,
    outputFormat: { type: 'json_schema', schema: args.jsonSchema },
    // Layer 1 of the JSON forcing, plus: no tools, no filesystem, no network.
    disallowedTools: [...DENIED_TOOLS],
    allowedTools: [],
    // Do not inherit the developer's ~/.claude config into a server request.
    settingSources: [],
    // Stateless: every agent call is independent, so no session on disk.
    persistSession: false,
    abortController: controller,
    env: buildSubprocessEnv(),
    ...(env.LLM_MAX_BUDGET_USD > 0 ? { maxBudgetUsd: env.LLM_MAX_BUDGET_USD } : {}),
  };

  try {
    let structuredOutput: unknown = undefined;
    let costUsd = 0;
    let text = '';
    let sawResult = false;

    for await (const message of query({ prompt: args.prompt, options })) {
      const m = message as SDKMessage & Record<string, unknown>;

      // NOTE: we deliberately do not scrape assistant text. The decision comes
      // exclusively from `result.structured_output`, which the json_schema
      // outputFormat guarantees. `text` below is diagnostics only.
      if (m.type === 'result') {
        sawResult = true;
        costUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0;

        if (m.subtype !== 'success') {
          throw new LlmUnavailableError(
            `${args.label}: Agent SDK ended with '${String(m.subtype)}'${
              Array.isArray(m.errors) && m.errors.length ? ` — ${m.errors.join('; ')}` : ''
            }`,
          );
        }

        structuredOutput = m.structured_output;
        if (typeof m.result === 'string' && !text) text = m.result;
      }
    }

    if (!sawResult) {
      throw new LlmUnavailableError(`${args.label}: the Agent SDK stream ended without a result message.`);
    }
    if (structuredOutput === undefined || structuredOutput === null) {
      throw new LlmUnavailableError(
        `${args.label}: the Agent SDK returned no structured_output despite a json_schema outputFormat.`,
      );
    }

    return { structuredOutput, costUsd, model: args.model, text };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new LlmUnavailableError(`${args.label}: model call aborted after ${args.timeoutMs}ms.`);
    }
    if (err instanceof LlmUnavailableError || err instanceof LlmSchemaError) throw err;
    throw new LlmUnavailableError(
      `${args.label}: Agent SDK call failed — ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onAbort);
    release();
  }
}
