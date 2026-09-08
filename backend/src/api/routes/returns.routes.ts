/**
 * RETURNS / CASES ROUTES — the core workflow surface.
 *
 * Base path: /api/v1/returns
 *
 *   POST   /intake                              Submit free-text return intent
 *   POST   /intake/parse                        Parse only (no pipeline run)
 *   GET    /cases                               List cases (filter/paginate)
 *   GET    /cases/:caseId                       Full shared state
 *   GET    /cases/:caseId/agents                Agent run summaries
 *   GET    /cases/:caseId/agents/:agentId       One agent's full result
 *   GET    /cases/:caseId/timeline              Trace events
 *   GET    /cases/:caseId/outcome               Flattened final outcome
 *   GET    /cases/:caseId/conflicts             Orchestrator conflict log
 *   GET    /cases/:caseId/stream                SSE live agent status
 *   POST   /cases/:caseId/decision              Human approve/reject/resume
 *   POST   /cases/:caseId/logistics-selection   Customer picks another route
 *   POST   /cases/:caseId/replay                Re-run as a new case
 *   GET    /escalations                         Cross-case support queue
 */
import { Router, type Request, type Response } from 'express';
import { notFound } from '../../core/errors';
import { paginate } from '../../repositories/memory-collection';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/error-handler';
import {
  AgentRunParamsSchema,
  CaseIdParamsSchema,
  CaseListQuerySchema,
  HumanDecisionRequestSchema,
  IntakeRequestSchema,
  ParsePreviewRequestSchema,
  SelectLogisticsRequestSchema,
  type CaseListQuery,
  type HumanDecisionRequest,
  type IntakeRequest,
  type ParsePreviewRequest,
  type SelectLogisticsRequest,
} from '../contracts/api.schema';
import * as orchestrator from '../../orchestrator/orchestrator';
import * as store from '../../orchestrator/state-store';
import { parseIntent } from '../../orchestrator/intent-parser';
import { eventBus } from '../../orchestrator/event-bus';
import type { AgentId } from '../../domain/agent.schema';

export const returnsRouter = Router();

/* ========================================================================== */
/* Intake                                                                     */
/* ========================================================================== */

/**
 * POST /api/v1/returns/intake
 *
 * `async: false` (default) -> waits and returns the completed case.
 * `async: true`            -> returns `{ caseId, status }` immediately (202);
 *                             the client then opens the SSE stream. This is the
 *                             mode the live demo uses so the UI can animate.
 */
returnsRouter.post(
  '/intake',
  validate(IntakeRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as IntakeRequest;

    const options = {
      customerId: body.customerId,
      orderId: body.orderId,
      orderItemId: body.orderItemId,
      channel: body.channel,
      hasPhotoEvidence: body.hasPhotoEvidence,
      scenarioId: body.scenarioId,
    };

    if (body.async) {
      const { caseId } = orchestrator.startPipeline(body.text, options);
      res.ok(
        {
          caseId,
          status: store.getCase(caseId).status,
          streamUrl: `/api/v1/returns/cases/${caseId}/stream`,
          message: 'Pipeline started. Subscribe to streamUrl for live agent status.',
        },
        undefined,
        202,
      );
      return;
    }

    const result = await orchestrator.runPipeline(body.text, options);
    res.ok(result, undefined, 201);
  }),
);

/**
 * POST /api/v1/returns/intake/parse
 *
 * Parse-only preview. Lets the UI show "here's what we understood" chips and a
 * confidence score before the customer commits — no case is created.
 */
returnsRouter.post('/intake/parse', validate(ParsePreviewRequestSchema), (req: Request, res: Response) => {
  const body = req.body as ParsePreviewRequest;
  const parsed = parseIntent(body.text, body);

  res.ok({
    intent: parsed.intent,
    resolved: {
      customer: parsed.customer ? { customerId: parsed.customer.customerId, name: `${parsed.customer.firstName} ${parsed.customer.lastName}`, loyaltyTier: parsed.customer.loyaltyTier } : null,
      order: parsed.order ? { orderId: parsed.order.orderId, placedAt: parsed.order.placedAt, deliveredAt: parsed.order.deliveredAt } : null,
      orderItem: parsed.orderItem ?? null,
    },
    /** True when the pipeline would run rather than ask for clarification. */
    runnable: parsed.intent.parseConfidence >= 0.5 && Boolean(parsed.customer && parsed.order && parsed.orderItem),
  });
});

/* ========================================================================== */
/* Case reads                                                                 */
/* ========================================================================== */

returnsRouter.get('/cases', validate(CaseListQuerySchema, 'query'), (req: Request, res: Response) => {
  const q = req.query as unknown as CaseListQuery;

  let cases = store.listCases();
  if (q.status) cases = cases.filter((c) => c.status === q.status);
  if (q.customerId) cases = cases.filter((c) => c.intent?.customerId === q.customerId);
  if (q.scenarioId) cases = cases.filter((c) => c.scenarioId === q.scenarioId);
  if (q.escalatedOnly) cases = cases.filter((c) => c.escalations.some((e) => e.blocking && e.resolvedAt === null));

  cases = cases.sort((a, b) => {
    const cmp = a[q.sort].localeCompare(b[q.sort]);
    return q.order === 'asc' ? cmp : -cmp;
  });

  // Summaries only — the full case (with context and trace) is large.
  const { items, pagination } = paginate(cases.map(store.toSummary), q.page, q.pageSize);
  res.ok(items, pagination);
});

returnsRouter.get('/cases/:caseId', validate(CaseIdParamsSchema, 'params'), (req: Request, res: Response) => {
  res.ok(store.getCase(req.params.caseId as string));
});

/** Compact agent status list — what the pipeline UI polls if not using SSE. */
returnsRouter.get('/cases/:caseId/agents', validate(CaseIdParamsSchema, 'params'), (req: Request, res: Response) => {
  const c = store.getCase(req.params.caseId as string);
  res.ok({
    caseId: c.caseId,
    status: c.status,
    currentStage: c.currentStage,
    totalStages: c.totalStages,
    completedStages: c.completedStages,
    agentRuns: c.agentRuns.sort((a, b) => a.stage - b.stage || a.agentId.localeCompare(b.agentId)),
  });
});

returnsRouter.get('/cases/:caseId/agents/:agentId', validate(AgentRunParamsSchema, 'params'), (req: Request, res: Response) => {
  const { caseId, agentId } = req.params as { caseId: string; agentId: AgentId };
  const result = store.getCase(caseId).agentResults[agentId];
  if (!result) throw notFound(`Agent result for '${agentId}' on case`, caseId);
  res.ok(result);
});

returnsRouter.get('/cases/:caseId/timeline', validate(CaseIdParamsSchema, 'params'), (req: Request, res: Response) => {
  res.ok(store.getCase(req.params.caseId as string).trace);
});

returnsRouter.get('/cases/:caseId/outcome', validate(CaseIdParamsSchema, 'params'), (req: Request, res: Response) => {
  const c = store.getCase(req.params.caseId as string);
  if (!c.finalOutcome) {
    res.fail('INVALID_STATE', `Case ${c.caseId} has not finished yet (status ${c.status}).`, 409, { status: c.status });
    return;
  }
  res.ok(c.finalOutcome);
});

/** The orchestrator's conflict log — the "how we arbitrated" panel. */
returnsRouter.get('/cases/:caseId/conflicts', validate(CaseIdParamsSchema, 'params'), (req: Request, res: Response) => {
  res.ok(store.getCase(req.params.caseId as string).conflicts);
});

/* ========================================================================== */
/* Live stream (SSE)                                                          */
/* ========================================================================== */

/**
 * GET /api/v1/returns/cases/:caseId/stream
 *
 * Server-Sent Events. Emits a `CaseStatusEvent` on every state change, so the
 * frontend can animate agents from pending -> running -> complete/escalated.
 *
 * FRONTEND USAGE:
 *   const es = new EventSource(`/api/v1/returns/cases/${caseId}/stream`);
 *   es.addEventListener('status', (e) => setState(JSON.parse(e.data)));
 *   es.addEventListener('done', () => es.close());
 *
 * Buffered events replay on connect, so a client that subscribes mid-pipeline
 * still rebuilds the whole timeline.
 */
returnsRouter.get('/cases/:caseId/stream', validate(CaseIdParamsSchema, 'params'), (req: Request, res: Response) => {
  const caseId = req.params.caseId as string;
  store.getCase(caseId); // 404 early if the case does not exist

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering so events arrive immediately.
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const unsubscribe = eventBus.subscribe(caseId, (payload) => {
    send('status', payload);
    // Terminal states end the stream so the browser stops reconnecting.
    if (['COMPLETED', 'ESCALATED', 'DENIED', 'CANCELLED', 'FAILED', 'AWAITING_CLARIFICATION', 'AWAITING_HUMAN_REVIEW'].includes(payload.status)) {
      send('done', { caseId, status: payload.status });
      cleanup();
      res.end();
    }
  });

  // Keep-alive comment so intermediaries do not drop an idle connection.
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);

  function cleanup() {
    clearInterval(heartbeat);
    unsubscribe();
  }

  req.on('close', cleanup);
  res.on('error', cleanup);
});

/* ========================================================================== */
/* Case actions                                                               */
/* ========================================================================== */

/**
 * POST /api/v1/returns/cases/:caseId/decision
 * The support console's action endpoint (persona "Jordan").
 */
returnsRouter.post(
  '/cases/:caseId/decision',
  validate(CaseIdParamsSchema, 'params'),
  validate(HumanDecisionRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as HumanDecisionRequest;
    const updated = await orchestrator.applyHumanDecision(req.params.caseId as string, body);
    res.ok(updated);
  }),
);

/**
 * POST /api/v1/returns/cases/:caseId/logistics-selection
 * Customer (or agent) picks a different return route — usually the greener one
 * the Sustainability Agent offered.
 */
returnsRouter.post(
  '/cases/:caseId/logistics-selection',
  validate(CaseIdParamsSchema, 'params'),
  validate(SelectLogisticsRequestSchema),
  (req: Request, res: Response) => {
    const body = req.body as SelectLogisticsRequest;
    res.ok(orchestrator.selectLogisticsOption(req.params.caseId as string, body.optionId, body.chosenBy));
  },
);

/** POST /api/v1/returns/cases/:caseId/replay — re-run the same input fresh. */
returnsRouter.post(
  '/cases/:caseId/replay',
  validate(CaseIdParamsSchema, 'params'),
  asyncHandler(async (req: Request, res: Response) => {
    res.ok(await orchestrator.replayCase(req.params.caseId as string), undefined, 201);
  }),
);

/* ========================================================================== */
/* Support queue                                                              */
/* ========================================================================== */

/**
 * GET /api/v1/returns/escalations
 * Every unresolved escalation needing a human, across all cases — the queue
 * behind the support console.
 */
returnsRouter.get('/escalations', (_req: Request, res: Response) => {
  const items = store
    .openEscalations()
    .sort((a, b) => b.priority - a.priority || a.raisedAt.localeCompare(b.raisedAt));
  res.ok(items);
});
