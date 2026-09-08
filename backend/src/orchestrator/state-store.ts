/**
 * STATE STORE — the ONLY writer of `ReturnCase`.
 *
 * Every mutation goes through a named method here, each of which:
 *   1. applies the change,
 *   2. appends a `TraceEvent`,
 *   3. bumps `updatedAt`,
 *   4. publishes a `CaseStatusEvent` for the live UI.
 *
 * Centralizing this is what lets agents stay pure and lets the frontend trust
 * that the trace is complete. If you find yourself mutating a case outside this
 * file, add a method here instead.
 */
import { clock } from '../core/clock';
import { newId, newTraceId } from '../core/ids';
import { notFound } from '../core/errors';
import { logger } from '../core/logger';
import { db } from '../repositories/db';
import { AGENT_METADATA, type AgentId, type AgentResult, type AgentRunStatus, type AgentRunSummary, type Escalation } from '../domain/agent.schema';
import type { CaseContext } from '../domain/case-context.schema';
import type { ReturnIntent } from '../domain/return.schema';
import {
  type CaseStatus,
  type CaseStatusEvent,
  type CaseSummary,
  type ConflictRecord,
  type FinalOutcome,
  type HumanDecision,
  type ReturnCase,
  type TraceEvent,
  type TraceEventType,
} from '../domain/case-state.schema';
import { TOTAL_STAGES, stageForAgent } from './pipeline.config';
import { implementationFor } from '../agents/base/registry';
import { eventBus } from './event-bus';

/* -------------------------------------------------------------------------- */
/* Creation                                                                    */
/* -------------------------------------------------------------------------- */

export function createCase(rawInput: string, scenarioId: string | null = null): ReturnCase {
  const now = clock.nowIso();
  const returnCase: ReturnCase = {
    caseId: newId('case'),
    traceId: newTraceId(),
    status: 'RECEIVED',
    rawInput,
    intent: null,
    context: null,
    returnId: null,
    resolutionId: null,
    shipmentId: null,
    sustainabilityRecordId: null,
    notificationIds: [],
    insightIds: [],
    agentResults: {},
    agentRuns: [],
    currentStage: 0,
    completedStages: [],
    totalStages: TOTAL_STAGES,
    escalations: [],
    conflicts: [],
    humanDecisions: [],
    trace: [],
    finalOutcome: null,
    scenarioId,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    totalDurationMs: null,
  };

  db.cases.insert(returnCase as ReturnCase & Record<string, unknown>);
  appendTrace(returnCase.caseId, 'CASE_CREATED', 'Return request received.', { rawInput }, null, null);
  return getCase(returnCase.caseId);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export function getCase(caseId: string): ReturnCase {
  const found = db.cases.get(caseId);
  if (!found) throw notFound('Case', caseId);
  return found as ReturnCase;
}

export function tryGetCase(caseId: string): ReturnCase | undefined {
  return db.cases.get(caseId) as ReturnCase | undefined;
}

export function listCases(): ReturnCase[] {
  return (db.cases.all() as ReturnCase[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Drops per-case timing state. Called by `POST /demo/reset`. */
export function resetStore(): void {
  realStartMs.clear();
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

function patch(caseId: string, changes: Partial<ReturnCase>): ReturnCase {
  const updated = db.cases.update(caseId, { ...changes, updatedAt: clock.nowIso() } as never);
  if (!updated) throw notFound('Case', caseId);
  return updated as ReturnCase;
}

/**
 * Real wall-clock start time per case, in ms.
 *
 * WHY NOT USE `startedAt`: the demo clock is FROZEN, so `completedAt - startedAt`
 * is always 0. Pipeline duration is a performance measurement, not a business
 * timestamp, so it has to come from the real clock. The ISO timestamps stay on
 * the frozen clock for reproducibility.
 */
const realStartMs = new Map<string, number>();

export function setStatus(caseId: string, status: CaseStatus, reason?: string): ReturnCase {
  const before = getCase(caseId).status;

  if (status === 'RUNNING' && !realStartMs.has(caseId)) realStartMs.set(caseId, Date.now());

  const updated = patch(caseId, {
    status,
    ...(status === 'RUNNING' && !getCase(caseId).startedAt ? { startedAt: clock.nowIso() } : {}),
  });

  if (before !== status) {
    logger.debug('[case] status transition', { caseId, from: before, to: status });
    publish(caseId, null);
  }
  if (reason) {
    appendTrace(caseId, status === 'AWAITING_HUMAN_REVIEW' ? 'PIPELINE_HALTED' : 'STAGE_COMPLETED', reason, { status }, null, null);
  }
  // Re-read rather than returning `updated`: appendTrace() above mutated the
  // stored case, so the snapshot from patch() is already stale and would be
  // missing its own trace event.
  return getCase(caseId);
}

export function setIntent(caseId: string, intent: ReturnIntent): ReturnCase {
  const updated = patch(caseId, { intent });
  appendTrace(
    caseId,
    'INTENT_PARSED',
    `Understood: ${intent.reason.replace(/_/g, ' ').toLowerCase()}${intent.productMention ? ` on a ${intent.productMention}` : ''} (confidence ${Math.round(intent.parseConfidence * 100)}%).`,
    { reason: intent.reason, confidence: intent.parseConfidence, missingFields: intent.missingFields, entities: intent.extractedEntities },
    null,
    null,
  );
  // Re-read rather than returning `updated`: appendTrace() above mutated the
  // stored case, so the snapshot from patch() is already stale and would be
  // missing its own trace event.
  return getCase(caseId);
}

export function setContext(caseId: string, context: CaseContext): ReturnCase {
  const updated = patch(caseId, { context });
  appendTrace(
    caseId,
    'CONTEXT_HYDRATED',
    `Loaded ${context.customer.firstName} ${context.customer.lastName} (${context.customer.loyaltyTier}), order ${context.order.orderId}, ${context.product.name}. Effective return window: ${context.policy.effectiveReturnWindowDays} days.`,
    {
      customerId: context.customer.customerId,
      orderId: context.order.orderId,
      sku: context.product.sku,
      effectiveWindowDays: context.policy.effectiveReturnWindowDays,
      carriersAvailable: context.logisticsCatalog.carriers.length,
    },
    null,
    null,
  );
  // Re-read rather than returning `updated`: appendTrace() above mutated the
  // stored case, so the snapshot from patch() is already stale and would be
  // missing its own trace event.
  return getCase(caseId);
}

/** Marks an agent as running, so the UI shows a spinner immediately. */
export function markAgentRunning(caseId: string, agentId: AgentId): ReturnCase {
  const current = getCase(caseId);
  const summary: AgentRunSummary = {
    agentId,
    agentName: AGENT_METADATA[agentId].name,
    runId: '',
    stage: stageForAgent(agentId),
    status: 'RUNNING',
    // Provisional: what is configured. Replaced by what actually ran once the
    // result comes back (a fallback flips this to 'rules').
    implementation: implementationFor(agentId),
    startedAt: clock.nowIso(),
    completedAt: null,
    durationMs: 0,
    headline: null,
    rationale: null,
    confidence: null,
    warningCount: 0,
    escalationCount: 0,
  };

  const agentRuns = [...current.agentRuns.filter((r) => r.agentId !== agentId), summary];
  const updated = patch(caseId, { agentRuns });
  appendTrace(caseId, 'AGENT_STARTED', `${summary.agentName} started.`, {}, agentId, summary.stage);
  // Re-read rather than returning `updated`: appendTrace() above mutated the
  // stored case, so the snapshot from patch() is already stale and would be
  // missing its own trace event.
  return getCase(caseId);
}

/**
 * Records a completed agent run: stores the typed result, merges escalations,
 * updates the run summary and publishes to the live stream.
 */
export function recordAgentResult<T>(caseId: string, result: AgentResult<T>): ReturnCase {
  const current = getCase(caseId);
  const stage = stageForAgent(result.agentId);

  const summary: AgentRunSummary = {
    agentId: result.agentId,
    agentName: result.agentName,
    runId: result.runId,
    stage,
    status: result.status,
    implementation: result.implementation,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    headline: buildHeadline(result),
    rationale: result.rationale,
    confidence: result.confidence,
    warningCount: result.warnings.length,
    escalationCount: result.escalations.length,
  };

  const updated = patch(caseId, {
    agentResults: { ...current.agentResults, [result.agentId]: result } as ReturnCase['agentResults'],
    agentRuns: [...current.agentRuns.filter((r) => r.agentId !== result.agentId), summary],
    escalations: [...current.escalations, ...result.escalations],
  });

  const type: TraceEventType =
    result.status === 'FAILED' ? 'AGENT_FAILED' : result.status === 'SKIPPED' ? 'AGENT_SKIPPED' : 'AGENT_COMPLETED';

  appendTrace(
    caseId,
    type,
    `${result.agentName}: ${result.rationale}`,
    { status: result.status, confidence: result.confidence, warnings: result.warnings.length, escalations: result.escalations.length },
    result.agentId,
    stage,
    result.durationMs,
  );

  for (const esc of result.escalations) {
    appendTrace(
      caseId,
      'ESCALATION_RAISED',
      `${esc.blocking ? 'Blocking' : 'Advisory'} escalation ${esc.code}: ${esc.reason}`,
      { escalationId: esc.escalationId, code: esc.code, severity: esc.severity, blocking: esc.blocking, queue: esc.suggestedQueue },
      result.agentId,
      stage,
    );
  }

  // Re-read rather than returning `updated`: appendTrace() above mutated the
  // stored case, so the snapshot from patch() is already stale and would be
  // missing its own trace event.
  return getCase(caseId);
}

export function markStageComplete(caseId: string, stage: number): ReturnCase {
  const current = getCase(caseId);
  return patch(caseId, {
    currentStage: stage,
    completedStages: current.completedStages.includes(stage) ? current.completedStages : [...current.completedStages, stage],
  });
}

export function recordConflict(caseId: string, conflict: ConflictRecord): ReturnCase {
  const current = getCase(caseId);
  const updated = patch(caseId, { conflicts: [...current.conflicts, conflict] });
  appendTrace(
    caseId,
    'CONFLICT_RESOLVED',
    `${conflict.type.replace(/_/g, ' ').toLowerCase()} resolved: ${conflict.resolution}`,
    { conflictId: conflict.conflictId, policy: conflict.resolutionPolicy, tradeoff: conflict.tradeoffAccepted },
    conflict.winningAgentId,
    null,
  );
  // Re-read rather than returning `updated`: appendTrace() above mutated the
  // stored case, so the snapshot from patch() is already stale and would be
  // missing its own trace event.
  return getCase(caseId);
}

export function recordHumanDecision(caseId: string, decision: HumanDecision): ReturnCase {
  const current = getCase(caseId);
  // Mark the referenced escalation resolved so the queue clears.
  const escalations = current.escalations.map((e) =>
    e.escalationId === decision.escalationId
      ? { ...e, resolvedBy: decision.decidedBy, resolvedAt: decision.decidedAt, resolutionNote: decision.note }
      : e,
  );

  const updated = patch(caseId, { humanDecisions: [...current.humanDecisions, decision], escalations });
  appendTrace(
    caseId,
    'HUMAN_DECISION',
    `${decision.decidedBy} chose to ${decision.action.replace(/_/g, ' ').toLowerCase()}${decision.note ? `: ${decision.note}` : '.'}`,
    { ...decision },
    null,
    null,
  );
  // Re-read rather than returning `updated`: appendTrace() above mutated the
  // stored case, so the snapshot from patch() is already stale and would be
  // missing its own trace event.
  return getCase(caseId);
}

/** Links persisted business records back to the case. */
export function linkRecords(
  caseId: string,
  ids: Partial<Pick<ReturnCase, 'returnId' | 'resolutionId' | 'shipmentId' | 'sustainabilityRecordId'>> & {
    notificationIds?: string[];
    insightIds?: string[];
  },
): ReturnCase {
  const current = getCase(caseId);
  return patch(caseId, {
    ...(ids.returnId !== undefined ? { returnId: ids.returnId } : {}),
    ...(ids.resolutionId !== undefined ? { resolutionId: ids.resolutionId } : {}),
    ...(ids.shipmentId !== undefined ? { shipmentId: ids.shipmentId } : {}),
    ...(ids.sustainabilityRecordId !== undefined ? { sustainabilityRecordId: ids.sustainabilityRecordId } : {}),
    ...(ids.notificationIds ? { notificationIds: [...current.notificationIds, ...ids.notificationIds] } : {}),
    ...(ids.insightIds ? { insightIds: [...current.insightIds, ...ids.insightIds] } : {}),
  });
}

export function finalizeCase(caseId: string, outcome: FinalOutcome, status: CaseStatus): ReturnCase {
  const current = getCase(caseId);
  const completedAt = clock.nowIso();
  const startMs = realStartMs.get(caseId);

  const updated = patch(caseId, {
    finalOutcome: outcome,
    status,
    currentStage: TOTAL_STAGES,
    completedStages: [...new Set([...current.completedStages, TOTAL_STAGES])],
    completedAt,
    // Real elapsed time; the frozen clock cannot measure itself.
    totalDurationMs: startMs !== undefined ? Date.now() - startMs : null,
  });

  appendTrace(caseId, 'CASE_FINALIZED', outcome.headline, { status, fullyAutomated: outcome.fullyAutomated }, null, TOTAL_STAGES);
  publish(caseId, null, outcome);
  // Re-read rather than returning `updated`: appendTrace() above mutated the
  // stored case, so the snapshot from patch() is already stale and would be
  // missing its own trace event.
  return getCase(caseId);
}

/* -------------------------------------------------------------------------- */
/* Trace + publish                                                             */
/* -------------------------------------------------------------------------- */

export function appendTrace(
  caseId: string,
  type: TraceEventType,
  message: string,
  data: Record<string, unknown> = {},
  agentId: AgentId | null = null,
  stage: number | null = null,
  durationMs: number | null = null,
): TraceEvent {
  const current = getCase(caseId);
  const event: TraceEvent = {
    eventId: newId('event'),
    sequence: current.trace.length,
    type,
    at: clock.nowIso(),
    agentId,
    stage,
    message,
    data,
    durationMs,
  };

  db.cases.update(caseId, { trace: [...current.trace, event], updatedAt: clock.nowIso() } as never);
  publish(caseId, event);
  return event;
}

function publish(caseId: string, lastEvent: TraceEvent | null, finalOutcome: FinalOutcome | null = null): void {
  const c = tryGetCase(caseId);
  if (!c) return;

  const payload: CaseStatusEvent = {
    caseId: c.caseId,
    status: c.status,
    currentStage: c.currentStage,
    totalStages: c.totalStages,
    agentRuns: c.agentRuns.sort((a, b) => a.stage - b.stage || a.agentId.localeCompare(b.agentId)),
    lastEvent,
    finalOutcome: finalOutcome ?? c.finalOutcome,
    at: clock.nowIso(),
  };

  eventBus.publish(payload);
}

/* -------------------------------------------------------------------------- */
/* Projections                                                                 */
/* -------------------------------------------------------------------------- */

/** Compact view for list endpoints — omits context, trace and agent outputs. */
export function toSummary(c: ReturnCase): CaseSummary {
  return {
    caseId: c.caseId,
    status: c.status,
    customerId: c.intent?.customerId ?? null,
    customerName: c.context ? `${c.context.customer.firstName} ${c.context.customer.lastName}` : null,
    orderId: c.intent?.orderId ?? null,
    sku: c.intent?.sku ?? null,
    productName: c.context?.product.name ?? null,
    reason: c.intent?.reason ?? null,
    rawInput: c.rawInput,
    currentStage: c.currentStage,
    totalStages: c.totalStages,
    agentRuns: c.agentRuns,
    resolutionType: c.agentResults.resolution?.output?.recommended.type ?? null,
    escalationCount: c.escalations.length,
    blockingEscalation: c.escalations.some((e) => e.blocking && e.resolvedAt === null),
    co2PreventedKg: c.agentResults.sustainability?.output?.co2PreventedKg ?? null,
    totalCostUsd: c.agentResults.resolution?.output?.costs.netCostUsd ?? null,
    headline: c.finalOutcome?.headline ?? c.agentResults.communication?.output?.headline ?? null,
    scenarioId: c.scenarioId,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    totalDurationMs: c.totalDurationMs,
  };
}

/** Unresolved blocking escalations across all cases — the support queue. */
export function openEscalations(): (Escalation & { caseId: string })[] {
  return listCases().flatMap((c) =>
    c.escalations.filter((e) => e.requiresHuman && e.resolvedAt === null).map((e) => ({ ...e, caseId: c.caseId })),
  );
}

/** One-line headline per agent for the pipeline cards. */
function buildHeadline<T>(result: AgentResult<T>): string {
  const o = result.output as Record<string, unknown> | null;
  if (result.status === 'SKIPPED') return 'Not needed for this case';
  if (result.status === 'FAILED') return 'Could not complete';
  if (!o) return result.status;

  switch (result.agentId) {
    case 'eligibility':
      return String(o.decision ?? '').replace(/_/g, ' ').toLowerCase();
    case 'sentiment': {
      const s = o.sentiment as { label?: string } | undefined;
      const churn = o.churnRisk as { band?: string } | undefined;
      return `${(s?.label ?? '').replace(/_/g, ' ').toLowerCase()}, ${churn?.band?.toLowerCase() ?? 'unknown'} churn risk`;
    }
    case 'resolution': {
      const rec = o.recommended as { type?: string } | undefined;
      return (rec?.type ?? '').replace(/_/g, ' ').toLowerCase();
    }
    case 'logistics':
      return o.required === false ? 'No shipment needed' : String(o.customerFacingSummary ?? '').slice(0, 80);
    case 'communication': {
      const plan = o.channelPlan as { primary?: string } | undefined;
      return `${o.totalPlannedTouchpoints ?? 0} touchpoints via ${plan?.primary?.toLowerCase() ?? 'email'}`;
    }
    case 'sustainability':
      return `${o.co2PreventedKg ?? 0}kg CO2 prevented (grade ${o.grade ?? '-'})`;
    case 'insights': {
      const insights = (o.insights as unknown[]) ?? [];
      const signals = (o.caseSignals as unknown[]) ?? [];
      return `${insights.length} insight(s), ${signals.length} signal(s)`;
    }
    default:
      return result.status;
  }
}
