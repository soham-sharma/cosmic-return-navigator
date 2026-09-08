/**
 * The interface every agent implements. Deliberately tiny: one method.
 *
 * An agent is a PURE FUNCTION of its input. It must not:
 *   - read or write `ReturnCase` (only the orchestrator does)
 *   - call repositories or services
 *   - use `new Date()` (use `input.context.now`)
 *   - mutate its input
 *   - throw for business outcomes (return an escalation instead)
 *
 * Everything else — timing, timeout, retries, error capture, input/output
 * validation, trace emission — is handled by `BaseAgent`. Agent owners
 * implement `execute()` and nothing more.
 */
import type { z } from 'zod';
import type { AgentId, AgentResult } from '../../domain/agent.schema';

/** Ambient services an agent may use for diagnostics only. */
export interface AgentExecutionContext {
  caseId: string;
  runId: string;
  traceId: string;
  /** Frozen ISO timestamp for this pipeline run. */
  now: string;
  log: {
    debug: (m: string, c?: Record<string, unknown>) => void;
    info: (m: string, c?: Record<string, unknown>) => void;
    warn: (m: string, c?: Record<string, unknown>) => void;
    error: (m: string, c?: Record<string, unknown>) => void;
  };
  /** Cooperative cancellation: the orchestrator aborts on timeout. */
  signal: AbortSignal;
}

/**
 * What an agent's `execute()` returns — the interesting parts only. The
 * BaseAgent wraps this into a full `AgentResult` envelope.
 */
export interface AgentExecutionOutput<TOutput> {
  output: TOutput | null;
  /** MANDATORY. Human-readable explanation of the decision. */
  rationale: string;
  confidence: number;
  status?: 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'ESCALATED' | 'SKIPPED';
  warnings?: { code: string; message: string; field?: string | null }[];
  /**
   * Escalations WITHOUT ids/timestamps — BaseAgent stamps those. Use the
   * `escalate()` helper from `base-agent.ts` to build these.
   */
  escalations?: DraftEscalation[];
  /** State keys read, for the dependency graph view. */
  inputsUsed?: string[];
  /**
   * Which implementation actually produced this. Reports what HAPPENED, not
   * what was configured — an LLM agent that fell back to rules must say
   * 'rules'. Defaults to the agent's own declared implementation.
   */
  implementation?: 'rules' | 'llm';
}

/** An escalation as an agent declares it; BaseAgent completes the record. */
export interface DraftEscalation {
  code: import('../../domain/agent.schema').EscalationCode;
  severity: import('../../domain/agent.schema').EscalationSeverity;
  reason: string;
  blocking: boolean;
  requiresHuman: boolean;
  suggestedQueue?: import('../../domain/agent.schema').HumanQueue;
  priority?: number;
  suggestedAction?: string | null;
  internalDetail?: string | null;
  context?: Record<string, unknown>;
}

export interface Agent<TInput, TOutput> {
  readonly id: AgentId;
  readonly name: string;
  readonly version: string;
  /** Pipeline stage this agent belongs to. Informational; the pipeline config
   *  is the source of truth. */
  readonly stage: number;

  /**
   * Zod schemas used by BaseAgent to validate at the boundary.
   *
   * NOTE the third type parameter: contracts use `.default()`, which makes a
   * schema's INPUT type differ from its OUTPUT type. Writing `z.ZodType<TInput>`
   * would pin both to the same type and reject every such schema, so the input
   * side is left open as `unknown` — validation still narrows to `TInput`.
   */
  readonly inputSchema: z.ZodType<TInput, unknown>;
  readonly outputSchema: z.ZodTypeAny;

  /** The one method an agent owner implements. */
  execute(input: TInput, ctx: AgentExecutionContext): Promise<AgentExecutionOutput<TOutput>>;

  /** Wrapper provided by BaseAgent — the orchestrator calls THIS, not execute. */
  run(input: TInput, ctx: Omit<AgentExecutionContext, 'log' | 'signal'>): Promise<AgentResult<TOutput>>;
}
