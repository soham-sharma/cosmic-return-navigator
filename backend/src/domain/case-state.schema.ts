/**
 * ============================================================================
 * SHARED STATE MODEL — `ReturnCase`
 * ============================================================================
 *
 * The single object every agent reads from and the orchestrator writes to.
 * One case = one customer request = one pipeline execution.
 *
 * DESIGN RULES (non-negotiable, they are what make parallel agents safe):
 *
 *  1. SINGLE WRITER. Only the orchestrator mutates a `ReturnCase`. Agents are
 *     pure functions: (input) -> AgentResult. They never touch shared state,
 *     never call repositories, never mutate their input. This is why two
 *     agents can run concurrently in stage 1 with no locking.
 *
 *  2. APPEND-ONLY HISTORY. `agentResults` is keyed by agentId and written once
 *     per run. `trace` and `escalations` only ever grow. Nothing is deleted, so
 *     the case is a complete audit record and the UI can replay it.
 *
 *  3. CONTEXT IS FROZEN. `context` is hydrated once before stage 1 and is
 *     read-only for the rest of the run. Every agent therefore sees an
 *     identical world — no mid-pipeline drift, no ordering surprises.
 *
 *  4. DERIVED DATA IS NOT STORED TWICE. `finalOutcome` is the only summary
 *     field, computed by the finalizer at the end. Anything else the UI needs
 *     is projected from `agentResults` on read.
 *
 *  5. AGENT OUTPUT ACCESS IS TYPED. `agentResults.eligibility?.output` is
 *     `EligibilityOutput | null | undefined`, so a downstream agent cannot
 *     accidentally read a field its upstream never produced.
 * ============================================================================
 */
import { z } from 'zod';
import { IsoDateTimeSchema } from './common.schema';
import { AgentIdSchema, AgentRunStatusSchema, AgentRunSummarySchema, EscalationSchema, agentResultSchema } from './agent.schema';
import { CaseContextSchema } from './case-context.schema';
import { ReturnIntentSchema } from './return.schema';
import { EligibilityOutputSchema } from '../agents/eligibility/eligibility.contract';
import { SentimentOutputSchema } from '../agents/sentiment/sentiment.contract';
import { ResolutionOutputSchema } from '../agents/resolution/resolution.contract';
import { LogisticsOutputSchema } from '../agents/logistics/logistics.contract';
import { CommunicationOutputSchema } from '../agents/communication/communication.contract';
import { SustainabilityOutputSchema } from '../agents/sustainability/sustainability.contract';
import { InsightsOutputSchema } from '../agents/insights/insights.contract';

/* ------------------------------- Case status ------------------------------- */

export const CaseStatusSchema = z.enum([
  /** Created, intent not yet parsed. */
  'RECEIVED',
  /** Free text being normalized into a ReturnIntent. */
  'PARSING',
  /** Parse confidence too low / required field missing — waiting on the user. */
  'AWAITING_CLARIFICATION',
  /** Context hydrated, pipeline executing. */
  'RUNNING',
  /** Halted mid-pipeline on a blocking escalation; a human must act. */
  'AWAITING_HUMAN_REVIEW',
  /** All stages finished, outcome produced. */
  'COMPLETED',
  /** Finished, but the outcome is a human handoff. */
  'ESCALATED',
  /** Request denied under policy — a legitimate terminal outcome. */
  'DENIED',
  /** Customer cancelled. */
  'CANCELLED',
  /** Unrecoverable system error. */
  'FAILED',
]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const TERMINAL_CASE_STATUSES: readonly CaseStatus[] = [
  'COMPLETED',
  'ESCALATED',
  'DENIED',
  'CANCELLED',
  'FAILED',
];

/* ---------------------------------- Trace ---------------------------------- */

/**
 * Ordered event log. Doubles as (a) the audit trail, (b) the source for the
 * UI's live timeline, and (c) the SSE event payloads.
 */
export const TraceEventTypeSchema = z.enum([
  'CASE_CREATED',
  'INTENT_PARSED',
  'CONTEXT_HYDRATED',
  'STAGE_STARTED',
  'STAGE_COMPLETED',
  'AGENT_STARTED',
  'AGENT_COMPLETED',
  'AGENT_SKIPPED',
  'AGENT_FAILED',
  'ESCALATION_RAISED',
  'ESCALATION_RESOLVED',
  'CONFLICT_DETECTED',
  'CONFLICT_RESOLVED',
  'HUMAN_DECISION',
  'PIPELINE_HALTED',
  'PIPELINE_RESUMED',
  'CASE_FINALIZED',
]);
export type TraceEventType = z.infer<typeof TraceEventTypeSchema>;

export const TraceEventSchema = z.object({
  eventId: z.string(),
  sequence: z.number().int().nonnegative().describe('Monotonic within the case'),
  type: TraceEventTypeSchema,
  at: IsoDateTimeSchema,
  /** Which agent/stage this concerns, when applicable. */
  agentId: AgentIdSchema.nullable().default(null),
  stage: z.number().int().nonnegative().nullable().default(null),
  /** Human-readable line for the timeline UI. */
  message: z.string(),
  /** Structured payload for the drill-down. */
  data: z.record(z.string(), z.unknown()).default({}),
  durationMs: z.number().nonnegative().nullable().default(null),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

/* ------------------------- Orchestrator conflict log ----------------------- */

/**
 * Recorded whenever two agents recommend incompatible things. The demo's
 * marquee conflict is COST_VS_CARBON: Logistics picks the cheapest carrier,
 * Sustainability wants the consolidated green one.
 */
export const ConflictTypeSchema = z.enum([
  'COST_VS_CARBON',
  'ELIGIBILITY_VS_RETENTION',
  'SPEED_VS_CARBON',
  'CUSTOMER_REQUEST_VS_POLICY',
  'GOODWILL_OVER_BUDGET',
]);
export type ConflictType = z.infer<typeof ConflictTypeSchema>;

export const ConflictRecordSchema = z.object({
  conflictId: z.string(),
  type: ConflictTypeSchema,
  /** The agents whose outputs disagreed. */
  parties: z.array(AgentIdSchema).min(2),
  description: z.string(),
  /** What each side wanted. */
  positions: z.array(z.object({ agentId: AgentIdSchema, position: z.string(), value: z.unknown() })),
  /** Which side won, and the policy that decided it. */
  resolution: z.string(),
  winningAgentId: AgentIdSchema.nullable().default(null),
  resolutionPolicy: z.string().describe('e.g. "green_adopted_when_cost_delta_under_2usd"'),
  /** Cost of the decision, for the audit. */
  tradeoffAccepted: z.record(z.string(), z.number()).default({}),
  resolvedAt: IsoDateTimeSchema,
});
export type ConflictRecord = z.infer<typeof ConflictRecordSchema>;

/* ------------------------------ Human decision ---------------------------- */

export const HumanDecisionSchema = z.object({
  decisionId: z.string(),
  escalationId: z.string().nullable().default(null),
  action: z.enum(['APPROVE', 'REJECT', 'OVERRIDE_RESOLUTION', 'REQUEST_INFO', 'RESUME', 'CANCEL']),
  decidedBy: z.string().describe('Support agent identifier (mocked)'),
  note: z.string().nullable().default(null),
  /** For OVERRIDE_RESOLUTION: the resolution option chosen instead. */
  overrideOptionId: z.string().nullable().default(null),
  decidedAt: IsoDateTimeSchema,
});
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

/* ------------------------------ Final outcome ----------------------------- */

/**
 * The flattened answer to "what happened?". Computed once by the finalizer so
 * the UI and the API never have to re-derive it from seven agent outputs.
 */
export const FinalOutcomeSchema = z.object({
  /** The single string shown to the customer. */
  customerMessage: z.string(),
  headline: z.string(),

  resolutionType: z.string(),
  resolutionSummary: z.string(),
  refundAmountUsd: z.number().nullable().default(null),
  pointsAwarded: z.number().int().nullable().default(null),
  replacementSku: z.string().nullable().default(null),

  returnMethod: z.string().nullable().default(null),
  pickupScheduledFor: z.string().nullable().default(null),
  trackingNumber: z.string().nullable().default(null),
  labelUrl: z.string().nullable().default(null),

  co2PreventedKg: z.number().nullable().default(null),
  sustainabilityGrade: z.string().nullable().default(null),

  totalCostUsd: z.number().nullable().default(null),
  slaDueAt: IsoDateTimeSchema.nullable().default(null),

  /** True when no human was involved anywhere in the case. */
  fullyAutomated: z.boolean(),
  /** Ordered next steps for the customer, for the UI checklist. */
  nextSteps: z.array(z.string()).default([]),
  /** Per-agent one-liners, so the UI can render the "how we decided" panel. */
  agentRationales: z.array(z.object({ agentId: AgentIdSchema, rationale: z.string() })).default([]),
  finalizedAt: IsoDateTimeSchema,
});
export type FinalOutcome = z.infer<typeof FinalOutcomeSchema>;

/* ------------------------------- Agent results ----------------------------- */

/**
 * Typed map of agent results. Each key is optional (the agent may not have run
 * yet) and each value carries that agent's specific output type.
 */
export const AgentResultMapSchema = z.object({
  eligibility: agentResultSchema(EligibilityOutputSchema).optional(),
  sentiment: agentResultSchema(SentimentOutputSchema).optional(),
  resolution: agentResultSchema(ResolutionOutputSchema).optional(),
  logistics: agentResultSchema(LogisticsOutputSchema).optional(),
  communication: agentResultSchema(CommunicationOutputSchema).optional(),
  sustainability: agentResultSchema(SustainabilityOutputSchema).optional(),
  insights: agentResultSchema(InsightsOutputSchema).optional(),
});
export type AgentResultMap = z.infer<typeof AgentResultMapSchema>;

/* --------------------------------- The case -------------------------------- */

export const ReturnCaseSchema = z.object({
  caseId: z.string().describe('e.g. RET-000001'),
  /** Correlates every log line and agent run for this execution. */
  traceId: z.string(),
  status: CaseStatusSchema,

  /** Raw customer input, kept verbatim forever. */
  rawInput: z.string(),
  /** Normalized interpretation. Null until parsing succeeds. */
  intent: ReturnIntentSchema.nullable().default(null),
  /** Frozen world state. Null until hydration. */
  context: CaseContextSchema.nullable().default(null),

  /** Persisted business records created during the run. */
  returnId: z.string().nullable().default(null),
  resolutionId: z.string().nullable().default(null),
  shipmentId: z.string().nullable().default(null),
  sustainabilityRecordId: z.string().nullable().default(null),
  notificationIds: z.array(z.string()).default([]),
  insightIds: z.array(z.string()).default([]),

  /** Typed agent outputs. */
  agentResults: AgentResultMapSchema.default({}),
  /** Compact status list for the live pipeline UI. */
  agentRuns: z.array(AgentRunSummarySchema).default([]),

  /** Pipeline progress. */
  currentStage: z.number().int().nonnegative().default(0),
  completedStages: z.array(z.number().int()).default([]),
  totalStages: z.number().int().positive().default(6),

  escalations: z.array(EscalationSchema).default([]),
  conflicts: z.array(ConflictRecordSchema).default([]),
  humanDecisions: z.array(HumanDecisionSchema).default([]),
  trace: z.array(TraceEventSchema).default([]),

  finalOutcome: FinalOutcomeSchema.nullable().default(null),

  /** Set when the pipeline was run from a named demo scenario. */
  scenarioId: z.string().nullable().default(null),

  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable().default(null),
  completedAt: IsoDateTimeSchema.nullable().default(null),
  /** Wall-clock duration of the whole pipeline. */
  totalDurationMs: z.number().nonnegative().nullable().default(null),
});
export type ReturnCase = z.infer<typeof ReturnCaseSchema>;

/* ------------------------------- Projections ------------------------------- */

/**
 * Lightweight case view for list endpoints and the SSE status stream.
 * Excludes `context`, `trace` and agent `output`s, which dominate the payload.
 */
export const CaseSummarySchema = z.object({
  caseId: z.string(),
  status: CaseStatusSchema,
  customerId: z.string().nullable(),
  customerName: z.string().nullable(),
  orderId: z.string().nullable(),
  sku: z.string().nullable(),
  productName: z.string().nullable(),
  reason: z.string().nullable(),
  rawInput: z.string(),
  currentStage: z.number().int(),
  totalStages: z.number().int(),
  agentRuns: z.array(AgentRunSummarySchema),
  resolutionType: z.string().nullable(),
  escalationCount: z.number().int().nonnegative(),
  blockingEscalation: z.boolean(),
  co2PreventedKg: z.number().nullable(),
  totalCostUsd: z.number().nullable(),
  headline: z.string().nullable(),
  scenarioId: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  totalDurationMs: z.number().nullable(),
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

/** Payload pushed over SSE on every state change. */
export const CaseStatusEventSchema = z.object({
  caseId: z.string(),
  status: CaseStatusSchema,
  currentStage: z.number().int(),
  totalStages: z.number().int(),
  agentRuns: z.array(AgentRunSummarySchema),
  /** The trace event that caused this push. */
  lastEvent: TraceEventSchema.nullable(),
  /** Present only on the final push. */
  finalOutcome: FinalOutcomeSchema.nullable().default(null),
  at: IsoDateTimeSchema,
});
export type CaseStatusEvent = z.infer<typeof CaseStatusEventSchema>;

/** Status values that mean "no more agent work will happen". */
export function isTerminalCaseStatus(status: CaseStatus): boolean {
  return TERMINAL_CASE_STATUSES.includes(status);
}

export { AgentRunStatusSchema };
