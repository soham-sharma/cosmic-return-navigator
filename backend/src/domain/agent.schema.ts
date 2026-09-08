/**
 * AGENT ENVELOPE — the universal contract every one of the 7 agents obeys.
 *
 * This file is the single most important integration point in the codebase.
 * Because every agent returns `AgentResult<TOutput>`, the orchestrator, the API
 * layer and the frontend can treat all seven identically: same status values,
 * same timing fields, same rationale, same escalation shape. Only `output`
 * differs, and each agent narrows that via its own contract file.
 *
 * RULE FOR AGENT OWNERS: never throw for a *business* outcome. "Not eligible",
 * "no carrier", "no green option" are all valid results — return them with an
 * escalation attached. Throw only for genuine programming/data errors.
 */
import { z } from 'zod';
import { ConfidenceSchema, IsoDateTimeSchema } from './common.schema';

/* --------------------------------- Agent IDs ------------------------------- */

export const AgentIdSchema = z.enum([
  'eligibility',
  'sentiment',
  'resolution',
  'logistics',
  'communication',
  'sustainability',
  'insights',
]);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const AGENT_IDS: readonly AgentId[] = AgentIdSchema.options;

/** Display metadata, shared with the frontend so labels never diverge. */
export const AGENT_METADATA: Record<AgentId, { name: string; shortName: string; purpose: string; icon: string }> = {
  eligibility: {
    name: 'Return Eligibility Agent',
    shortName: 'Eligibility',
    purpose: 'Validates the return against order history, windows, category rules, loyalty benefits and regional law.',
    icon: 'shield-check',
  },
  sentiment: {
    name: 'Sentiment & Retention Agent',
    shortName: 'Sentiment',
    purpose: 'Reads customer emotion and value to score churn risk and size the right retention gesture.',
    icon: 'heart-pulse',
  },
  resolution: {
    name: 'Resolution Planning Agent',
    shortName: 'Resolution',
    purpose: 'Chooses the optimal outcome — refund, replacement, credit, repair — balancing satisfaction, cost and retention.',
    icon: 'git-branch',
  },
  logistics: {
    name: 'Logistics Agent',
    shortName: 'Logistics',
    purpose: 'Plans reverse logistics: carrier, method, label, pickup window and destination facility.',
    icon: 'truck',
  },
  communication: {
    name: 'Communication Agent',
    shortName: 'Communication',
    purpose: 'Composes and schedules proactive, tone-matched multi-channel updates.',
    icon: 'message-circle',
  },
  sustainability: {
    name: 'Sustainability Agent',
    shortName: 'Sustainability',
    purpose: 'Quantifies CO2 and packaging impact per option and recommends the greenest viable path.',
    icon: 'leaf',
  },
  insights: {
    name: 'Insights Agent',
    shortName: 'Insights',
    purpose: 'Turns each return into trend signals and decision-ready recommendations for product, policy and ops.',
    icon: 'bar-chart-3',
  },
};

/* -------------------------------- Run status ------------------------------- */

/**
 * Status values are what the UI's live agent panel renders, so they cover the
 * whole visible lifecycle, not just terminal states.
 */
export const AgentRunStatusSchema = z.enum([
  /** Queued, dependencies not yet satisfied. */
  'PENDING',
  /** Currently executing — the UI shows a spinner. */
  'RUNNING',
  /** Finished cleanly. */
  'COMPLETED',
  /** Finished, but with caveats worth surfacing (see `warnings`). */
  'COMPLETED_WITH_WARNINGS',
  /** Finished and raised a blocking escalation for a human. */
  'ESCALATED',
  /** Intentionally not run — dependency produced nothing to act on. */
  'SKIPPED',
  /** Crashed or timed out. */
  'FAILED',
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

/** Statuses that mean "this agent will not run again this pipeline". */
export const TERMINAL_AGENT_STATUSES: readonly AgentRunStatus[] = [
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
  'ESCALATED',
  'SKIPPED',
  'FAILED',
];

/* ------------------------------- Escalation -------------------------------- */

/**
 * Escalation codes. Each maps to one PRD edge case (section 10) or an
 * operational failure. Keep this list closed — the UI renders a specific
 * message per code.
 */
export const EscalationCodeSchema = z.enum([
  /* --- eligibility --- */
  'OUTSIDE_RETURN_WINDOW',
  'CATEGORY_NOT_RETURNABLE',
  'FINAL_SALE_ITEM',
  'PROOF_OF_DAMAGE_REQUIRED',
  'FRAUD_SIGNAL_DETECTED',
  'REGIONAL_LAW_OVERRIDE',
  'ORDER_ITEM_MISMATCH',
  /* --- sentiment / retention --- */
  'CRITICAL_SENTIMENT',
  'PUBLIC_COMPLAINT_RISK',
  'VIP_RETENTION_OVERRIDE',
  /* --- resolution --- */
  'HIGH_VALUE_APPROVAL_REQUIRED',
  'NO_FEASIBLE_RESOLUTION',
  'REPLACEMENT_OUT_OF_STOCK',
  'PAYMENT_INSTRUMENT_INVALID',
  /* --- logistics --- */
  'NO_CARRIER_COVERAGE',
  'HAZMAT_RESTRICTED',
  'OVERSIZED_ITEM',
  'PICKUP_UNAVAILABLE',
  /* --- communication --- */
  'HUMAN_AGENT_REQUESTED',
  'NO_REACHABLE_CHANNEL',
  /* --- sustainability --- */
  'NO_GREENER_OPTION_AVAILABLE',
  'DISPOSITION_UNRESOLVED',
  /* --- orchestration / system --- */
  'CONFLICTING_AGENT_OUTPUTS',
  'MISSING_REQUIRED_DATA',
  'AMBIGUOUS_INTENT',
  'AGENT_TIMEOUT',
  'AGENT_ERROR',
]);
export type EscalationCode = z.infer<typeof EscalationCodeSchema>;

export const EscalationSeveritySchema = z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type EscalationSeverity = z.infer<typeof EscalationSeveritySchema>;

/** Human queues an escalation can be routed to (persona "Jordan" et al). */
export const HumanQueueSchema = z.enum([
  'TIER1_SUPPORT',
  'TIER2_SPECIALIST',
  'RETENTION_DESK',
  'FRAUD_REVIEW',
  'LOGISTICS_OPS',
  'POLICY_LEGAL',
  'SUSTAINABILITY_REVIEW',
  'NONE',
]);
export type HumanQueue = z.infer<typeof HumanQueueSchema>;

export const EscalationSchema = z.object({
  escalationId: z.string().describe('e.g. ESC-000001'),
  raisedBy: AgentIdSchema.or(z.literal('orchestrator')),
  code: EscalationCodeSchema,
  severity: EscalationSeveritySchema,

  /** Customer-safe explanation. */
  reason: z.string(),
  /** Internal detail for the support console. */
  internalDetail: z.string().nullable().default(null),

  /**
   * BLOCKING is the critical flag for the orchestrator:
   *   true  -> halt the pipeline at the end of this stage and await a human
   *   false -> record it, keep going (an advisory flag on the timeline)
   */
  blocking: z.boolean(),
  requiresHuman: z.boolean(),
  suggestedQueue: HumanQueueSchema.default('NONE'),
  /** 1 (lowest) .. 5 (drop everything). */
  priority: z.number().int().min(1).max(5).default(3),

  /** What a human should do, pre-written so the queue is actionable. */
  suggestedAction: z.string().nullable().default(null),
  /** Arbitrary diagnostic payload (rule IDs, thresholds breached, values). */
  context: z.record(z.string(), z.unknown()).default({}),

  resolvedBy: z.string().nullable().default(null),
  resolvedAt: IsoDateTimeSchema.nullable().default(null),
  resolutionNote: z.string().nullable().default(null),
  raisedAt: IsoDateTimeSchema,
});
export type Escalation = z.infer<typeof EscalationSchema>;

/* -------------------------------- Warnings --------------------------------- */

export const AgentWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Field or input the warning relates to. */
  field: z.string().nullable().default(null),
});
export type AgentWarning = z.infer<typeof AgentWarningSchema>;

export const AgentErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  stack: z.string().nullable().default(null),
});
export type AgentError = z.infer<typeof AgentErrorSchema>;

/* ------------------------------ Result envelope ---------------------------- */

/**
 * `agentResultSchema(outputSchema)` builds the validated envelope for a
 * specific agent. Each agent's contract file calls this once and exports the
 * result, e.g. `EligibilityResultSchema`.
 */
/**
 * Which implementation produced a result.
 *   'rules' — deterministic TypeScript.
 *   'llm'   — a Claude Agent SDK call with a forced JSON schema.
 *
 * Stamped by the agent itself, and it reports what ACTUALLY happened: an LLM
 * agent that fell back to rules reports 'rules', never 'llm'.
 */
export const AgentImplementationSchema = z.enum(['rules', 'llm']);
export type AgentImplementationKind = z.infer<typeof AgentImplementationSchema>;

export const agentResultSchema = <T extends z.ZodTypeAny>(outputSchema: T) =>
  z.object({
    agentId: AgentIdSchema,
    agentName: z.string(),
    /** Bump when an agent's logic changes materially — shown in the audit log. */
    version: z.string().default('0.1.0'),
    /** Which implementation actually ran. See AgentImplementationSchema. */
    implementation: AgentImplementationSchema.default('rules'),

    caseId: z.string(),
    runId: z.string().describe('e.g. RUN-000001'),
    traceId: z.string(),

    status: AgentRunStatusSchema,
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable().default(null),
    durationMs: z.number().nonnegative().default(0),

    /** Null unless status is COMPLETED / COMPLETED_WITH_WARNINGS / ESCALATED. */
    output: outputSchema.nullable(),

    /**
     * MANDATORY (PRD non-functional requirement: explainability). One or two
     * plain sentences a customer-support agent could read aloud. Never empty,
     * even on failure — explain what went wrong instead.
     */
    rationale: z.string().min(1),
    confidence: ConfidenceSchema,

    warnings: z.array(AgentWarningSchema).default([]),
    escalations: z.array(EscalationSchema).default([]),
    error: AgentErrorSchema.nullable().default(null),

    /** Names of the state keys this run read — powers the dependency graph
     *  view and makes stale-input bugs obvious. */
    inputsUsed: z.array(z.string()).default([]),
  });

/** Generic TS view of the envelope, usable before an agent's output type is known. */
export interface AgentResult<TOutput> {
  agentId: AgentId;
  agentName: string;
  version: string;
  implementation: AgentImplementationKind;
  caseId: string;
  runId: string;
  traceId: string;
  status: AgentRunStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  output: TOutput | null;
  rationale: string;
  confidence: number;
  warnings: AgentWarning[];
  escalations: Escalation[];
  error: AgentError | null;
  inputsUsed: string[];
}

/** Untyped envelope, used where the specific agent is not statically known. */
export const AnyAgentResultSchema = agentResultSchema(z.unknown());
export type AnyAgentResult = AgentResult<unknown>;

/* -------------------------- LLM-facing escalation ------------------------- */

/**
 * An escalation as an AGENT declares it — no id, no timestamp, no raisedBy.
 * Those are stamped by BaseAgent so an agent can never forge them.
 *
 * This Zod mirror exists so the Claude Agent SDK can be handed a JSON Schema
 * that forces the model to emit escalations in exactly this shape.
 */
export const DraftEscalationSchema = z.object({
  code: EscalationCodeSchema,
  severity: EscalationSeveritySchema,
  reason: z.string().describe('Customer-safe explanation, one sentence'),
  blocking: z.boolean().describe('true halts the pipeline for a human; false is advisory only'),
  requiresHuman: z.boolean(),
  suggestedQueue: HumanQueueSchema.default('NONE'),
  priority: z.number().int().min(1).max(5).default(3),
  suggestedAction: z.string().nullable().default(null),
  internalDetail: z.string().nullable().default(null),
  context: z.record(z.string(), z.unknown()).default({}),
});
export type DraftEscalationInput = z.infer<typeof DraftEscalationSchema>;

/* ------------------------- LLM structured-output envelope ----------------- */

/**
 * `llmAgentEnvelopeSchema(outputSchema)` is THE schema handed to the Claude
 * Agent SDK as `outputFormat: { type: 'json_schema', schema }`.
 *
 * WHY AN ENVELOPE RATHER THAN THE BARE OUTPUT: every agent must return a
 * rationale and a confidence (the PRD's explainability requirement), and may
 * raise escalations. Asking for all of it in ONE forced-schema call means one
 * round trip per agent and no free-text parsing anywhere — the model literally
 * cannot return a shape we did not ask for.
 */
export const llmAgentEnvelopeSchema = <T extends z.ZodTypeAny>(outputSchema: T) =>
  z.object({
    /** The agent's contract output, exactly as its contract file declares it. */
    output: outputSchema,
    /**
     * MANDATORY. One or two plain sentences a support agent could read aloud.
     * Must cite the specific facts that drove the decision, not restate the task.
     */
    rationale: z.string().min(1),
    /** The agent's own confidence in this output, 0-1. */
    confidence: z.number().min(0).max(1),
    warnings: z
      .array(
        z.object({
          code: z.string(),
          message: z.string(),
          field: z.string().nullable().default(null),
        }),
      )
      .default([]),
    escalations: z.array(DraftEscalationSchema).default([]),
  });

export type LlmAgentEnvelope<TOutput> = {
  output: TOutput;
  rationale: string;
  confidence: number;
  warnings: { code: string; message: string; field: string | null }[];
  escalations: DraftEscalationInput[];
};

/**
 * Lightweight run summary for the live pipeline UI. Deliberately excludes
 * `output` so the status-polling/SSE payload stays small.
 */
export const AgentRunSummarySchema = z.object({
  agentId: AgentIdSchema,
  agentName: z.string(),
  runId: z.string(),
  stage: z.number().int().nonnegative(),
  status: AgentRunStatusSchema,
  /** Lets the UI badge which agents were model-driven on this specific run. */
  implementation: AgentImplementationSchema.default('rules'),
  startedAt: IsoDateTimeSchema.nullable().default(null),
  completedAt: IsoDateTimeSchema.nullable().default(null),
  durationMs: z.number().nonnegative().default(0),
  /** Short headline for the card, e.g. "Approved — damaged on arrival". */
  headline: z.string().nullable().default(null),
  rationale: z.string().nullable().default(null),
  confidence: ConfidenceSchema.nullable().default(null),
  warningCount: z.number().int().nonnegative().default(0),
  escalationCount: z.number().int().nonnegative().default(0),
});
export type AgentRunSummary = z.infer<typeof AgentRunSummarySchema>;
