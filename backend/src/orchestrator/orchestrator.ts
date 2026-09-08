/**
 * ============================================================================
 * ORCHESTRATION ENGINE
 * ============================================================================
 *
 * RESPONSIBILITIES (and, just as importantly, what it does NOT do)
 *
 *   IT DOES:
 *     1. Normalize free-text intent into a structured `ReturnIntent` (stage 0).
 *     2. Hydrate the frozen `CaseContext` every agent shares (stage 0).
 *     3. Sequence the agents per `pipeline.config.ts` — parallel where the
 *        dependency graph allows, sequential where it does not.
 *     4. Build each agent's input from shared state. Agents never fetch.
 *     5. Own ALL writes to `ReturnCase` (via `state-store.ts`).
 *     6. Resolve inter-agent conflicts with a named, audited policy.
 *     7. Decide when a blocking escalation halts the pipeline.
 *     8. Persist business records and project the final outcome.
 *     9. Publish live status events for the UI.
 *
 *   IT DOES NOT:
 *     - Make business judgements. Every decision belongs to an agent, except
 *       explicit conflict arbitration, which is recorded as such.
 *     - Reach into an agent's internals or reinterpret its output.
 *     - Retry business failures. A denial is an answer, not an error.
 *
 * FAILURE POSTURE
 *   A required agent failing aborts the pipeline (status FAILED).
 *   An optional agent failing (insights) is logged and the case still completes
 *   — analytics must never break a customer's return.
 *   A blocking escalation halts at the END of its stage, so both parallel
 *   agents in a stage always get to run and report.
 * ============================================================================
 */
import { clock, isoInDays } from '../core/clock';
import { newId } from '../core/ids';
import { logger } from '../core/logger';
import { AppError } from '../core/errors';
import { getAgent } from '../agents/base/registry';
// Pure rule functions, reused when the orchestrator overrides the agent's pick
// so carrier/label/pickup logic lives in exactly one place.
import * as logisticsRules from '../agents/logistics/logistics.rules';
import type { AgentId, AgentResult } from '../domain/agent.schema';
import type { CaseContext } from '../domain/case-context.schema';
import type { ReturnCase } from '../domain/case-state.schema';
import type { EligibilityInput, EligibilityOutput } from '../agents/eligibility/eligibility.contract';
import type { SentimentInput, SentimentOutput } from '../agents/sentiment/sentiment.contract';
import type { ResolutionInput, ResolutionOutput } from '../agents/resolution/resolution.contract';
import type { LogisticsInput, LogisticsOutput } from '../agents/logistics/logistics.contract';
import type { SustainabilityInput, SustainabilityOutput } from '../agents/sustainability/sustainability.contract';
import type { CommunicationInput } from '../agents/communication/communication.contract';
import type { InsightsInput } from '../agents/insights/insights.contract';

import { PIPELINE, TOTAL_STAGES, isOptional } from './pipeline.config';
import { buildContext } from './context-builder';
import { MIN_PARSE_CONFIDENCE, buildClarifyingQuestion, parseIntent, type ParseOptions } from './intent-parser';
import * as store from './state-store';
import * as conflicts from './conflict-resolver';
import { buildFinalOutcome, persistRecords } from './finalizer';

export interface RunOptions extends ParseOptions {
  /** Tags the case with the demo scenario it came from. */
  scenarioId?: string;
}

/* ========================================================================== */
/* Entry points                                                               */
/* ========================================================================== */

/**
 * Runs the full pipeline for one customer request and resolves with the
 * finished case. Blocks until the pipeline is done.
 */
export async function runPipeline(rawInput: string, options: RunOptions = {}): Promise<ReturnCase> {
  const created = store.createCase(rawInput, options.scenarioId ?? null);
  return execute(created.caseId, rawInput, options);
}

/**
 * Fire-and-forget variant. Returns the `caseId` synchronously so an HTTP caller
 * can respond immediately and let the client stream progress over SSE.
 */
export function startPipeline(rawInput: string, options: RunOptions = {}): { caseId: string; promise: Promise<ReturnCase> } {
  const created = store.createCase(rawInput, options.scenarioId ?? null);
  const promise = execute(created.caseId, rawInput, options).catch((err) => {
    logger.error('[orchestrator] background pipeline failed', {
      caseId: created.caseId,
      error: err instanceof Error ? err.message : String(err),
    });
    return store.getCase(created.caseId);
  });
  return { caseId: created.caseId, promise };
}

/* ========================================================================== */
/* The pipeline body — ONE implementation, used by every entry point           */
/* ========================================================================== */

async function execute(caseId: string, rawInput: string, options: RunOptions): Promise<ReturnCase> {
  const log = logger.child({ caseId });

  try {
    /* ------------------------ STAGE 0: intake --------------------------- */
    store.setStatus(caseId, 'PARSING');
    const parsed = parseIntent(rawInput, options);
    store.setIntent(caseId, parsed.intent);

    // Too uncertain to act on: ask rather than guess. Guessing here is exactly
    // the behaviour that generates the complaints in the problem statement.
    if (parsed.intent.parseConfidence < MIN_PARSE_CONFIDENCE || !parsed.customer || !parsed.order || !parsed.orderItem) {
      store.appendTrace(
        caseId,
        'PIPELINE_HALTED',
        buildClarifyingQuestion(parsed.intent),
        { parseConfidence: parsed.intent.parseConfidence, missingFields: parsed.intent.missingFields },
        null,
        0,
      );
      store.setStatus(caseId, 'AWAITING_CLARIFICATION');
      return store.getCase(caseId);
    }

    const context = buildContext(parsed.intent, parsed.customer, parsed.order, parsed.orderItem);
    store.setContext(caseId, context);
    store.markStageComplete(caseId, 0);
    store.setStatus(caseId, 'RUNNING');

    /* ------------------------ STAGES 1-5 -------------------------------- */
    for (const stage of PIPELINE) {
      store.appendTrace(
        caseId,
        'STAGE_STARTED',
        `Stage ${stage.stage} — ${stage.name}: ${stage.description}`,
        { mode: stage.mode, agents: stage.agents },
        null,
        stage.stage,
      );
      const stageStart = Date.now();

      // PARALLEL is safe precisely because agents are pure and only the
      // orchestrator writes state. SEQUENTIAL records each result before the
      // next agent runs, so downstream agents can read upstream output.
      const results =
        stage.mode === 'PARALLEL'
          ? await Promise.all(stage.agents.map((id) => runAgent(caseId, id)))
          : await runSequential(caseId, stage.agents);

      store.markStageComplete(caseId, stage.stage);
      store.appendTrace(
        caseId,
        'STAGE_COMPLETED',
        `Stage ${stage.stage} — ${stage.name} complete.`,
        { agents: stage.agents, durationMs: Date.now() - stageStart },
        null,
        stage.stage,
      );

      /* --- required-agent failure aborts the run --- */
      const fatal = results.find((r) => r.status === 'FAILED' && !isOptional(stage, r.agentId));
      if (fatal) {
        log.error('Required agent failed; aborting pipeline', { agentId: fatal.agentId });
        store.appendTrace(
          caseId,
          'PIPELINE_HALTED',
          `${fatal.agentName} could not complete, so the case needs a human.`,
          { agentId: fatal.agentId },
          fatal.agentId,
          stage.stage,
        );
        return haltForHuman(caseId, 'FAILED');
      }

      /* --- conflict arbitration sits between stages 4 and 5 --- */
      if (stage.stage === 4) applyConflictResolution(caseId);

      /* --- blocking escalation halts at the stage boundary --- */
      if (stage.haltOnBlockingEscalation && hasUnresolvedBlockingEscalation(caseId)) {
        log.info('Blocking escalation raised; halting for human review', { stage: stage.stage });
        // Still send a holding message — silence is the behaviour Cosmic Mart
        // is already being criticized for.
        await runCommunicationOnly(caseId);
        return haltForHuman(caseId, 'AWAITING_HUMAN_REVIEW');
      }
    }

    /* ------------------------ STAGE 6: finalize -------------------------- */
    return finalize(caseId);
  } catch (err) {
    log.error('Pipeline threw', { error: err instanceof Error ? err.message : String(err) });
    store.appendTrace(
      caseId,
      'PIPELINE_HALTED',
      `The workflow hit an unexpected problem: ${err instanceof Error ? err.message : String(err)}`,
      {},
      null,
      null,
    );
    store.setStatus(caseId, 'FAILED');
    if (err instanceof AppError) throw err;
    throw new AppError('PIPELINE_FAILED', 'The orchestration pipeline failed.', { cause: err, details: { caseId } });
  }
}

/* ========================================================================== */
/* Agent execution                                                            */
/* ========================================================================== */

/**
 * Runs one agent: marks it running, builds its input from shared state, runs
 * it, and records the result. Always records — even on failure — so the UI
 * never shows a stuck spinner.
 */
async function runAgent(caseId: string, agentId: AgentId): Promise<AgentResult<unknown>> {
  const c = store.getCase(caseId);
  if (!c.context || !c.intent) {
    throw new AppError('INVALID_STATE', `Case ${caseId} has no hydrated context; cannot run agents.`);
  }

  store.markAgentRunning(caseId, agentId);

  const agent = getAgent(agentId);
  const input = buildAgentInput(agentId, c, c.context);
  const result = (await agent.run(input, {
    caseId,
    runId: newId('agentRun'),
    traceId: c.traceId,
    now: c.context.now,
  })) as AgentResult<unknown>;

  store.recordAgentResult(caseId, result);
  return result;
}

async function runSequential(caseId: string, agentIds: AgentId[]): Promise<AgentResult<unknown>[]> {
  const results: AgentResult<unknown>[] = [];
  for (const id of agentIds) results.push(await runAgent(caseId, id));
  return results;
}

/**
 * THE DEPENDENCY MAP, made explicit. Each agent receives exactly the slice its
 * contract declares — nothing more. Adding an input here is a contract change.
 */
function buildAgentInput(agentId: AgentId, c: ReturnCase, context: CaseContext): unknown {
  const intent = c.intent!;
  const eligibility = c.agentResults.eligibility?.output ?? null;
  const sentiment = c.agentResults.sentiment?.output ?? null;
  const resolution = c.agentResults.resolution?.output ?? null;
  const logistics = c.agentResults.logistics?.output ?? null;
  const sustainability = c.agentResults.sustainability?.output ?? null;

  switch (agentId) {
    case 'eligibility':
      return { caseId: c.caseId, intent, context } satisfies EligibilityInput;

    case 'sentiment':
      // Deliberately NOT given the eligibility outcome — see the contract.
      return { caseId: c.caseId, intent, context } satisfies SentimentInput;

    case 'resolution':
      return {
        caseId: c.caseId,
        intent,
        context,
        eligibility: requireOutput('eligibility', eligibility),
        sentiment: requireOutput('sentiment', sentiment),
      } satisfies ResolutionInput;

    case 'logistics':
      return {
        caseId: c.caseId,
        context,
        resolution: requireOutput('resolution', resolution),
      } satisfies LogisticsInput;

    case 'sustainability':
      return {
        caseId: c.caseId,
        context,
        resolution: requireOutput('resolution', resolution),
        logistics: requireOutput('logistics', logistics),
      } satisfies SustainabilityInput;

    case 'communication':
      return {
        caseId: c.caseId,
        context,
        eligibility: requireOutput('eligibility', eligibility),
        sentiment: requireOutput('sentiment', sentiment),
        resolution,
        logistics,
        sustainability,
        pipelineHalted: hasUnresolvedBlockingEscalation(c.caseId),
      } satisfies CommunicationInput;

    case 'insights':
      // Every upstream output is nullable: a denied or halted case is itself a
      // signal worth recording.
      return {
        caseId: c.caseId,
        intent,
        context,
        eligibility,
        sentiment,
        resolution,
        logistics,
        sustainability,
      } satisfies InsightsInput;
  }
}

function requireOutput<T>(agentId: AgentId, output: T | null): T {
  if (output === null) {
    throw new AppError('INVALID_STATE', `Agent '${agentId}' must run before its dependents, but produced no output.`, {
      details: { agentId },
    });
  }
  return output;
}

/* ========================================================================== */
/* Conflict resolution (between stages 4 and 5)                                */
/* ========================================================================== */

/**
 * Applies the cost-vs-carbon decision (and records the other tensions) BEFORE
 * the Communication Agent runs, so the customer is never told about an option
 * that was subsequently overridden.
 */
function applyConflictResolution(caseId: string): void {
  const c = store.getCase(caseId);
  const logistics = c.agentResults.logistics?.output ?? null;
  const sustainability = c.agentResults.sustainability?.output ?? null;
  const eligibility = c.agentResults.eligibility?.output ?? null;
  const sentiment = c.agentResults.sentiment?.output ?? null;
  const resolution = c.agentResults.resolution?.output ?? null;

  /* --- 1. cost vs carbon --- */
  if (logistics) {
    const decision = conflicts.resolveLogisticsSelection(logistics, sustainability);

    if (decision.conflict) {
      store.appendTrace(
        caseId,
        'CONFLICT_DETECTED',
        decision.conflict.description,
        { type: decision.conflict.type, parties: decision.conflict.parties },
        null,
        4,
      );
      store.recordConflict(caseId, decision.conflict);
    }

    // Write the final selection back so downstream agents and the UI read one
    // authoritative choice.
    applyFinalLogisticsSelection(caseId, decision.finalOptionId, decision.overridden);
  }

  /* --- 2. eligibility vs retention (recorded for audit) --- */
  if (eligibility && sentiment) {
    const conflict = conflicts.resolveEligibilityRetentionConflict(eligibility, sentiment, resolution);
    if (conflict) store.recordConflict(caseId, conflict);
  }

  /* --- 3. goodwill over budget --- */
  if (sentiment && resolution) {
    const conflict = conflicts.resolveGoodwillBudgetConflict(sentiment, resolution);
    if (conflict) store.recordConflict(caseId, conflict);
  }
}

/**
 * Commits the winning logistics option.
 *
 * When the orchestrator overrides the agent's pick, the LABEL, PICKUP WINDOW and
 * TRACKING TIMELINE must be regenerated — a label naming the original carrier
 * would be wrong, and a pickup slot from a different carrier's schedule would be
 * a promise we cannot keep. Regeneration calls the Logistics Agent's own pure
 * rule functions, so carrier logic stays in one place.
 */
function applyFinalLogisticsSelection(caseId: string, finalOptionId: string | null, overridden: boolean): void {
  const c = store.getCase(caseId);
  const result = c.agentResults.logistics;
  if (!result?.output || !c.context) return;
  if (result.output.finalSelectionId === finalOptionId) return;

  const chosen = result.output.candidateOptions.find((o) => o.optionId === finalOptionId);

  // No override (or nothing to switch to): just stamp the selection.
  if (!overridden || !chosen) {
    store.recordAgentResult(caseId, {
      ...result,
      output: { ...result.output, finalSelectionId: finalOptionId },
    });
    return;
  }

  /* --- regenerate the artifacts for the newly chosen carrier --- */
  const label = logisticsRules.generateLabel(c.context, chosen);
  const pickup = chosen.method === 'HOME_PICKUP' ? logisticsRules.schedulePickup(c.context, chosen) : null;
  const trackingEvents = logisticsRules.buildTrackingTimeline(c.context, chosen, pickup);
  const dropOffLocationId =
    chosen.method !== 'HOME_PICKUP'
      ? (c.context.logisticsCatalog.dropOffLocations.find(
          (d) => d.carrierId === chosen.carrierId && d.method === chosen.method,
        )?.locationId ?? null)
      : null;

  const shipment = result.output.shipment
    ? {
        ...result.output.shipment,
        status: pickup ? ('PICKUP_SCHEDULED' as const) : ('LABEL_CREATED' as const),
        method: chosen.method,
        carrierId: chosen.carrierId,
        carrierName: chosen.carrierName,
        label,
        pickup,
        dropOffLocationId,
        destinationFacilityId: chosen.destinationFacilityId,
        packagingKitId: chosen.packagingKitId,
        distanceKm: chosen.distanceKm,
        costUsd: chosen.costUsd,
        co2Kg: chosen.estimatedCo2Kg,
        trackingEvents,
        estimatedArrivalAt: isoInDays(chosen.totalDaysToResolution),
        updatedAt: c.context.now,
      }
    : null;

  const updatedOutput: LogisticsOutput = {
    ...result.output,
    finalSelectionId: finalOptionId,
    method: chosen.method,
    destinationFacilityId: chosen.destinationFacilityId,
    packagingKitId: chosen.packagingKitId,
    estimatedCostUsd: chosen.costUsd,
    estimatedTransitDays: chosen.totalDaysToResolution,
    estimatedCo2Kg: chosen.estimatedCo2Kg,
    estimatedArrivalAt: isoInDays(chosen.totalDaysToResolution),
    convenienceScore: chosen.convenienceScore,
    consolidationApplied: pickup?.isConsolidated ?? false,
    label,
    pickup,
    dropOffLocationId,
    trackingEvents,
    shipment,
    selectionBasis: {
      strategy: 'GREENEST' as const,
      weights: { cost: 0, speed: 0, convenience: 0 },
      reason: 'Overridden by the orchestrator in favour of the lower-carbon route.',
    },
    customerFacingSummary: pickup
      ? `${chosen.carrierName} will collect the parcel on ${pickup.scheduledDate} between 09:00 and 13:00 on a lower-carbon consolidated route. Your label is ready — no printing needed.`
      : `${chosen.customerFacingLabel}. We picked the lower-carbon route for you.`,
  };

  store.recordAgentResult(caseId, { ...result, output: updatedOutput });
}

/* ========================================================================== */
/* Halting, resuming, finalizing                                              */
/* ========================================================================== */

function hasUnresolvedBlockingEscalation(caseId: string): boolean {
  return store.getCase(caseId).escalations.some((e) => e.blocking && e.resolvedAt === null);
}

/**
 * Runs ONLY the Communication Agent, so a halted case still gets a message out.
 * No-op if communication already ran or its required inputs are missing.
 */
async function runCommunicationOnly(caseId: string): Promise<void> {
  const c = store.getCase(caseId);
  if (c.agentResults.communication || !c.context || !c.agentResults.eligibility?.output || !c.agentResults.sentiment?.output) {
    return;
  }
  try {
    await runAgent(caseId, 'communication');
  } catch (err) {
    logger.warn('[orchestrator] holding message could not be sent', {
      caseId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function haltForHuman(caseId: string, status: 'AWAITING_HUMAN_REVIEW' | 'FAILED'): ReturnCase {
  // Persist what we have so a support agent picking this up sees real records.
  store.linkRecords(caseId, persistRecords(store.getCase(caseId)));
  store.setStatus(
    caseId,
    status,
    status === 'FAILED' ? 'The workflow could not complete automatically.' : 'Paused for human review.',
  );
  return store.getCase(caseId);
}

function finalize(caseId: string): ReturnCase {
  store.linkRecords(caseId, persistRecords(store.getCase(caseId)));
  const { outcome, status } = buildFinalOutcome(store.getCase(caseId));
  return store.finalizeCase(caseId, outcome, status);
}

/* ========================================================================== */
/* Human-in-the-loop                                                          */
/* ========================================================================== */

/**
 * Applies a human decision to a halted case and resumes it.
 *
 * TODO(orchestrator owner): resuming re-runs from stage 0 with the escalation
 * marked resolved. That is idempotent for the demo (agents are pure, the clock
 * is frozen), but production should resume from the halted stage to avoid
 * redundant work and duplicate persisted records.
 */
export async function applyHumanDecision(
  caseId: string,
  input: {
    action: 'APPROVE' | 'REJECT' | 'OVERRIDE_RESOLUTION' | 'REQUEST_INFO' | 'RESUME' | 'CANCEL';
    decidedBy: string;
    note?: string;
    escalationId?: string;
    overrideOptionId?: string;
  },
): Promise<ReturnCase> {
  const c = store.getCase(caseId);

  store.recordHumanDecision(caseId, {
    decisionId: newId('event'),
    escalationId:
      input.escalationId ?? c.escalations.find((e) => e.blocking && e.resolvedAt === null)?.escalationId ?? null,
    action: input.action,
    decidedBy: input.decidedBy,
    note: input.note ?? null,
    overrideOptionId: input.overrideOptionId ?? null,
    decidedAt: clock.nowIso(),
  });

  if (input.action === 'CANCEL' || input.action === 'REJECT') {
    store.setStatus(
      caseId,
      input.action === 'CANCEL' ? 'CANCELLED' : 'DENIED',
      `${input.decidedBy} ${input.action === 'CANCEL' ? 'cancelled' : 'rejected'} the case.`,
    );
    return store.getCase(caseId);
  }

  if (input.action === 'REQUEST_INFO') {
    store.setStatus(caseId, 'AWAITING_CLARIFICATION', `${input.decidedBy} requested more information from the customer.`);
    return store.getCase(caseId);
  }

  // APPROVE / RESUME / OVERRIDE_RESOLUTION -> continue the workflow.
  store.appendTrace(
    caseId,
    'PIPELINE_RESUMED',
    `${input.decidedBy} approved the case; resuming the workflow.`,
    { action: input.action },
    null,
    c.currentStage,
  );

  return execute(caseId, c.rawInput, {
    customerId: c.intent?.customerId ?? undefined,
    orderId: c.intent?.orderId ?? undefined,
    orderItemId: c.intent?.orderItemId ?? undefined,
  });
}

/**
 * Customer chooses a different (usually greener) logistics option after the
 * fact. Recorded on the case and reflected in the shipment aggregates.
 */
export function selectLogisticsOption(caseId: string, optionId: string, chosenBy = 'CUSTOMER'): ReturnCase {
  const logistics = store.getCase(caseId).agentResults.logistics?.output;

  if (!logistics?.candidateOptions.some((o) => o.optionId === optionId)) {
    throw new AppError('VALIDATION_ERROR', `Option '${optionId}' is not one of the available return options for this case.`, {
      details: { available: logistics?.candidateOptions.map((o) => o.optionId) ?? [] },
    });
  }

  applyFinalLogisticsSelection(caseId, optionId, true);
  store.appendTrace(caseId, 'HUMAN_DECISION', `${chosenBy} selected a different return option.`, { optionId }, 'logistics', 3);
  return store.getCase(caseId);
}

/** Re-runs a case's input as a NEW case — the demo "replay" button. */
export async function replayCase(caseId: string): Promise<ReturnCase> {
  const original = store.getCase(caseId);
  return runPipeline(original.rawInput, {
    customerId: original.intent?.customerId ?? undefined,
    orderId: original.intent?.orderId ?? undefined,
    orderItemId: original.intent?.orderItemId ?? undefined,
    scenarioId: original.scenarioId ?? undefined,
  });
}

export { TOTAL_STAGES };
