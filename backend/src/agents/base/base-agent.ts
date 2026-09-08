/**
 * BaseAgent — the execution harness shared by all seven agents.
 *
 * Handles, once, for everybody:
 *   - input validation against the agent's Zod schema
 *   - simulated latency (so the UI can animate the pipeline)
 *   - hard timeout + AbortSignal
 *   - timing / runId / traceId stamping
 *   - escalation ID + timestamp stamping
 *   - status derivation (warnings -> COMPLETED_WITH_WARNINGS, etc.)
 *   - error capture into a FAILED result instead of a thrown exception
 *   - output validation, so a malformed agent output is caught at its source
 *     rather than three stages downstream
 *
 * AGENT OWNERS: subclass this, set the readonly fields, implement `execute()`.
 * Do not override `run()`.
 */
import type { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../core/logger';
import { newId } from '../../core/ids';
import { clock } from '../../core/clock';
import {
  AGENT_METADATA,
  type AgentId,
  type AgentResult,
  type AgentRunStatus,
  type Escalation,
  type EscalationCode,
  type EscalationSeverity,
  type HumanQueue,
} from '../../domain/agent.schema';
import type { Agent, AgentExecutionContext, AgentExecutionOutput, DraftEscalation } from './agent.interface';

/**
 * Helper for agent owners to declare an escalation without boilerplate.
 *
 *   return { output, rationale, confidence: 0.9,
 *            escalations: [escalate('OUTSIDE_RETURN_WINDOW', {
 *              severity: 'HIGH', reason: '...', blocking: true,
 *              requiresHuman: true, suggestedQueue: 'TIER2_SPECIALIST' })] }
 */
export function escalate(
  code: EscalationCode,
  opts: {
    severity: EscalationSeverity;
    reason: string;
    blocking: boolean;
    requiresHuman: boolean;
    suggestedQueue?: HumanQueue;
    priority?: number;
    suggestedAction?: string;
    internalDetail?: string;
    context?: Record<string, unknown>;
  },
): DraftEscalation {
  return {
    code,
    severity: opts.severity,
    reason: opts.reason,
    blocking: opts.blocking,
    requiresHuman: opts.requiresHuman,
    suggestedQueue: opts.suggestedQueue ?? 'NONE',
    priority: opts.priority ?? 3,
    suggestedAction: opts.suggestedAction ?? null,
    internalDetail: opts.internalDetail ?? null,
    context: opts.context ?? {},
  };
}

/** Convenience for the common "agent had nothing to do" result. */
export function skipped(rationale: string): AgentExecutionOutput<never> {
  return { output: null, rationale, confidence: 1, status: 'SKIPPED' };
}

export abstract class BaseAgent<TInput, TOutput> implements Agent<TInput, TOutput> {
  abstract readonly id: AgentId;
  abstract readonly stage: number;
  // `unknown` on the input side: contract schemas use `.default()`, so their
  // input type differs from their output type. See agent.interface.ts.
  abstract readonly inputSchema: z.ZodType<TInput, unknown>;
  abstract readonly outputSchema: z.ZodTypeAny;

  readonly version: string = '0.1.0';

  get name(): string {
    return AGENT_METADATA[this.id].name;
  }

  /**
   * Hard execution budget. Overridden by `PromptAgent`, which needs far longer
   * than a rules agent because it makes a real model call.
   */
  protected get timeoutMs(): number {
    return env.AGENT_TIMEOUT_MS;
  }

  /**
   * Whether to inject artificial latency so the UI can animate the pipeline.
   * Rules agents finish in microseconds and need it; LLM agents do not.
   */
  protected get simulateLatency(): boolean {
    return true;
  }

  /** This agent's implementation kind. Overridden by `PromptAgent`. */
  protected get implementation(): 'rules' | 'llm' {
    return 'rules';
  }

  /** THE method to implement. See agent.interface.ts for the rules. */
  abstract execute(input: TInput, ctx: AgentExecutionContext): Promise<AgentExecutionOutput<TOutput>>;

  /** Called by the orchestrator. Do not override. */
  async run(
    input: TInput,
    ctx: { caseId: string; runId?: string; traceId: string; now: string },
  ): Promise<AgentResult<TOutput>> {
    const runId = ctx.runId ?? newId('agentRun');
    const startedAt = clock.nowIso();
    const startMs = Date.now();
    const log = logger.child({ agent: this.id, caseId: ctx.caseId, runId });

    const controller = new AbortController();
    const execCtx: AgentExecutionContext = {
      caseId: ctx.caseId,
      runId,
      traceId: ctx.traceId,
      now: ctx.now,
      log,
      signal: controller.signal,
    };

    const base = {
      agentId: this.id,
      agentName: this.name,
      version: this.version,
      caseId: ctx.caseId,
      runId,
      traceId: ctx.traceId,
      startedAt,
    };

    try {
      /* -- 1. validate input at the boundary ------------------------------- */
      const parsed = this.inputSchema.safeParse(input);
      if (!parsed.success) {
        // A schema violation here means the ORCHESTRATOR built a bad input.
        // Surface it loudly as a failure rather than letting the agent guess.
        return this.finish(base, startMs, {
          status: 'FAILED',
          output: null,
          rationale: `Input validation failed for ${this.name}. The orchestrator supplied an input that does not match this agent's contract.`,
          confidence: 0,
          error: {
            code: 'INPUT_VALIDATION_ERROR',
            message: parsed.error.message,
            stack: null,
          },
        });
      }

      /* -- 2. simulated latency for the demo animation --------------------- */
      if (this.simulateLatency) await this.applySimulatedLatency();

      /* -- 3. execute with a hard timeout ---------------------------------- */
      const timeoutMs = this.timeoutMs;
      const result = await Promise.race([
        this.execute(parsed.data, execCtx),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => {
            controller.abort();
            reject(new Error(`AGENT_TIMEOUT_${timeoutMs}ms`));
          }, timeoutMs);
          // Don't hold the event loop open on a fast path.
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);

      /* -- 4. validate output ---------------------------------------------- */
      if (result.output !== null && result.status !== 'SKIPPED') {
        const outParsed = this.outputSchema.safeParse(result.output);
        if (!outParsed.success) {
          log.error('Agent produced an output that violates its own contract', {
            issues: outParsed.error.issues.slice(0, 5),
          });
          return this.finish(base, startMs, {
            status: 'FAILED',
            output: null,
            rationale: `${this.name} produced an output that does not satisfy its declared schema.`,
            confidence: 0,
            error: { code: 'OUTPUT_VALIDATION_ERROR', message: outParsed.error.message, stack: null },
          });
        }
      }

      /* -- 5. stamp escalations and derive status -------------------------- */
      const escalations = (result.escalations ?? []).map((d) => this.stampEscalation(d));
      const warnings = (result.warnings ?? []).map((w) => ({
        code: w.code,
        message: w.message,
        field: w.field ?? null,
      }));

      const status: AgentRunStatus =
        result.status === 'SKIPPED'
          ? 'SKIPPED'
          : escalations.some((e) => e.blocking)
            ? 'ESCALATED'
            : warnings.length > 0 || escalations.length > 0
              ? 'COMPLETED_WITH_WARNINGS'
              : (result.status ?? 'COMPLETED');

      return this.finish(base, startMs, {
        status,
        output: result.output,
        rationale: result.rationale,
        confidence: result.confidence,
        warnings,
        escalations,
        inputsUsed: result.inputsUsed ?? [],
        implementation: result.implementation,
        error: null,
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.startsWith('AGENT_TIMEOUT_');
      log.error(isTimeout ? 'Agent timed out' : 'Agent threw', {
        error: err instanceof Error ? err.message : String(err),
      });

      return this.finish(base, startMs, {
        status: 'FAILED',
        output: null,
        rationale: isTimeout
          ? `${this.name} did not finish within its ${env.AGENT_TIMEOUT_MS}ms budget and was aborted.`
          : `${this.name} failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        confidence: 0,
        escalations: [
          this.stampEscalation(
            escalate(isTimeout ? 'AGENT_TIMEOUT' : 'AGENT_ERROR', {
              severity: 'HIGH',
              reason: isTimeout
                ? 'This step took too long and was stopped automatically.'
                : 'This step hit an unexpected problem.',
              // Whether a failed agent halts the pipeline is a PIPELINE
              // decision (`optional` in pipeline.config), not the agent's.
              blocking: false,
              requiresHuman: true,
              suggestedQueue: 'TIER2_SPECIALIST',
              priority: 4,
              internalDetail: err instanceof Error ? err.message : String(err),
            }),
          ),
        ],
        error: {
          code: isTimeout ? 'AGENT_TIMEOUT' : 'AGENT_EXECUTION_ERROR',
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? (err.stack ?? null) : null,
        },
      });
    }
  }

  /* ------------------------------- internals ------------------------------ */

  private finish(
    base: {
      agentId: AgentId;
      agentName: string;
      version: string;
      caseId: string;
      runId: string;
      traceId: string;
      startedAt: string;
    },
    startMs: number,
    parts: {
      status: AgentRunStatus;
      output: TOutput | null;
      rationale: string;
      confidence: number;
      warnings?: { code: string; message: string; field: string | null }[];
      escalations?: Escalation[];
      inputsUsed?: string[];
      implementation?: 'rules' | 'llm';
      error: { code: string; message: string; stack: string | null } | null;
    },
  ): AgentResult<TOutput> {
    return {
      ...base,
      // What actually ran, which may differ from what was configured (an LLM
      // agent that fell back reports 'rules').
      implementation: parts.implementation ?? this.implementation,
      status: parts.status,
      completedAt: clock.nowIso(),
      durationMs: Date.now() - startMs,
      output: parts.output,
      rationale: parts.rationale,
      confidence: parts.confidence,
      warnings: parts.warnings ?? [],
      escalations: parts.escalations ?? [],
      error: parts.error,
      inputsUsed: parts.inputsUsed ?? [],
    };
  }

  private stampEscalation(draft: DraftEscalation): Escalation {
    return {
      escalationId: newId('escalation'),
      raisedBy: this.id,
      code: draft.code,
      severity: draft.severity,
      reason: draft.reason,
      internalDetail: draft.internalDetail ?? null,
      blocking: draft.blocking,
      requiresHuman: draft.requiresHuman,
      suggestedQueue: draft.suggestedQueue ?? 'NONE',
      priority: draft.priority ?? 3,
      suggestedAction: draft.suggestedAction ?? null,
      context: draft.context ?? {},
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      raisedAt: clock.nowIso(),
    };
  }

  /** Random jitter in the configured range, so the pipeline animates. */
  private async applySimulatedLatency(): Promise<void> {
    const min = env.AGENT_SIMULATED_LATENCY_MIN_MS;
    const max = Math.max(min, env.AGENT_SIMULATED_LATENCY_MAX_MS);
    if (max <= 0) return;
    const ms = min + Math.floor(Math.random() * (max - min + 1));
    await new Promise((r) => setTimeout(r, ms));
  }
}
