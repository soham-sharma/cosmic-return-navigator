/**
 * ============================================================================
 * PromptAgent — an agent backed by the Claude Agent SDK
 * ============================================================================
 *
 * Extends `BaseAgent`, so an LLM-backed agent is INDISTINGUISHABLE to the rest
 * of the system from a rules-backed one: same `AgentResult` envelope, same
 * escalation stamping, same trace events, same API responses, same frontend
 * contract. Swapping an agent's implementation touches only the registry.
 *
 * WHAT A SUBCLASS SUPPLIES
 *   `systemPrompt`         the agent's role, decision rules and constraints
 *   `buildUserPrompt()`    the case-specific payload
 *   `fallback`             the deterministic rules agent to use if the model
 *                          is unavailable (optional but strongly recommended)
 *
 * WHAT THIS CLASS HANDLES
 *   - forcing structured output against the subclass's own `outputSchema`
 *   - unwrapping the envelope into rationale / confidence / warnings / escalations
 *   - cost and latency telemetry onto the warnings channel
 *   - falling back to rules on failure, with the reason recorded as a warning
 *     rather than silently pretending the model ran
 */
import type { z } from 'zod';
import { env } from '../../config/env';
import { llmAgentEnvelopeSchema, type AgentId } from '../../domain/agent.schema';
import { LlmSchemaError, LlmUnavailableError, runStructuredQuery } from '../../llm/agent-sdk-client';
import { BaseAgent } from './base-agent';
import type { Agent, AgentExecutionContext, AgentExecutionOutput } from './agent.interface';

export abstract class PromptAgent<TInput, TOutput> extends BaseAgent<TInput, TOutput> {
  /**
   * The invariant instructions for this agent. Keep case data OUT of here — a
   * stable system prompt is what makes prompt caching effective across cases.
   */
  protected abstract readonly systemPrompt: string;

  /** Renders the case into the user turn. */
  protected abstract buildUserPrompt(input: TInput): string;

  /**
   * Deterministic implementation to fall back to when the model cannot be
   * reached. Leave undefined to hard-fail instead.
   */
  protected readonly fallback?: Agent<TInput, TOutput>;

  /** Per-agent effort override. Default comes from LLM_EFFORT. */
  protected get effort(): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
    return undefined;
  }

  /**
   * LLM calls need a far larger budget than the rules-mode default.
   *
   * Set 2s ABOVE `runStructuredQuery`'s own internal timeout (env.LLM_TIMEOUT_MS
   * is used as that internal budget below), so this outer `BaseAgent` race never
   * wins first. If it did, `BaseAgent` would report FAILED directly — bypassing
   * this class's own catch block, where the fallback-to-rules logic lives. The
   * margin is what makes the fallback path reachable at all.
   */
  protected override get timeoutMs(): number {
    return env.LLM_TIMEOUT_MS + 2000;
  }

  /** Real latency is real; never add artificial delay on top of a model call. */
  protected override get simulateLatency(): boolean {
    return false;
  }

  protected override get implementation(): 'rules' | 'llm' {
    return 'llm';
  }

  async execute(input: TInput, ctx: AgentExecutionContext): Promise<AgentExecutionOutput<TOutput>> {
    const envelopeSchema = llmAgentEnvelopeSchema(this.outputSchema as z.ZodTypeAny);

    try {
      const result = await runStructuredQuery({
        label: `${this.id}-agent`,
        systemPrompt: this.systemPrompt,
        userPrompt: this.buildUserPrompt(input),
        schema: envelopeSchema,
        effort: this.effort,
        timeoutMs: this.timeoutMs,
        signal: ctx.signal,
      });

      const envelope = result.data as {
        output: TOutput;
        rationale: string;
        confidence: number;
        warnings: { code: string; message: string; field: string | null }[];
        escalations: AgentExecutionOutput<TOutput>['escalations'];
      };

      ctx.log.debug('LLM agent completed', {
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        attempts: result.attempts,
      });

      const warnings = [...envelope.warnings];
      if (result.attempts > 1) {
        // Surface repairs rather than hiding them — they are the signal that a
        // prompt or a schema needs work.
        warnings.push({
          code: 'LLM_OUTPUT_REPAIRED',
          message: `The model's first response failed schema validation and was corrected on retry ${result.attempts - 1}.`,
          field: null,
        });
      }

      return {
        output: envelope.output,
        rationale: envelope.rationale,
        confidence: envelope.confidence,
        warnings,
        escalations: envelope.escalations,
        inputsUsed: [`llm:${result.modelUsed}`, `cost:$${result.costUsd.toFixed(4)}`],
        implementation: 'llm',
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const isSchema = err instanceof LlmSchemaError;
      const isUnavailable = err instanceof LlmUnavailableError;

      if (!this.fallback || !env.LLM_FALLBACK_TO_RULES) {
        // No safety net configured — let BaseAgent turn this into a FAILED result.
        throw err;
      }

      ctx.log.warn('LLM agent failed; falling back to deterministic rules', { reason, isSchema, isUnavailable });

      const fallbackResult = await this.fallback.execute(input, ctx);

      return {
        ...fallbackResult,
        // Never claim the model produced this — the rationale AND the stamped
        // implementation both say who actually decided.
        implementation: 'rules',
        rationale: `${fallbackResult.rationale} (Decided by deterministic rules: the model was unavailable for this run.)`,
        warnings: [
          ...(fallbackResult.warnings ?? []),
          {
            code: isSchema ? 'LLM_SCHEMA_FALLBACK' : 'LLM_UNAVAILABLE_FALLBACK',
            message: `Fell back to rules-based logic. ${reason}`,
            field: null,
          },
        ],
      };
    }
  }
}

/**
 * Helper for prompt authors: renders a labelled JSON block.
 *
 * Deterministic key order (JSON.stringify over a rebuilt object would not be),
 * so identical inputs produce byte-identical prompts. That matters for prompt
 * caching and for reproducing a run while debugging.
 */
export function jsonBlock(label: string, value: unknown): string {
  return [`### ${label}`, '```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

/**
 * Trims a context object down to the fields an agent actually needs.
 *
 * Handing the whole `CaseContext` to every agent would work, but it is several
 * KB of carriers, facilities and policy tables — most of it irrelevant to any
 * one agent, and all of it billed on every call. Each agent picks its slice.
 */
export function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = source[key];
  return out;
}

export type { AgentId };
