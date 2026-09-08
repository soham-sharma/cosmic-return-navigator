/**
 * META + DEMO ROUTES.
 *
 *   GET  /health                             Liveness
 *   GET  /ready                              Readiness (fixtures loaded)
 *   GET  /api/v1/meta/pipeline               The agent execution plan
 *   GET  /api/v1/meta/routes                 Machine-readable endpoint list
 *   GET  /api/v1/meta/error-codes            Error taxonomy
 *   GET  /api/v1/demo/scenarios              Named demo scenarios
 *   POST /api/v1/demo/scenarios/:id/run      Run one scenario
 *   POST /api/v1/demo/reset                  Restore seeded state
 *   GET  /api/v1/demo/state                  What's in memory right now
 */
import { Router, type Request, type Response } from 'express';
import { clock } from '../../core/clock';
import { env } from '../../config/env';
import { ERROR_CODE, notFound } from '../../core/errors';
import { db, resetDb } from '../../repositories/db';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/error-handler';
import { RunScenarioRequestSchema, ScenarioIdParamsSchema, type RunScenarioRequest } from '../contracts/api.schema';
import { describePipeline } from '../../orchestrator/pipeline.config';
import { AGENT_METADATA, AGENT_IDS } from '../../domain/agent.schema';
import * as orchestrator from '../../orchestrator/orchestrator';
import * as store from '../../orchestrator/state-store';
import { eventBus } from '../../orchestrator/event-bus';
import { implementationFor, resetRegistry } from '../../agents/base/registry';

export const healthRouter = Router();
export const metaRouter = Router();
export const demoRouter = Router();

/* ========================================================================== */
/* Health                                                                     */
/* ========================================================================== */

healthRouter.get('/health', (_req: Request, res: Response) => {
  res.ok({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: clock.nowIso() });
});

healthRouter.get('/ready', (_req: Request, res: Response) => {
  const fixturesLoaded = db.customers.count() > 0 && db.orders.count() > 0 && db.products.count() > 0;
  const llmAgents = AGENT_IDS.filter((id) => implementationFor(id) === 'llm');

  res.ok(
    {
      status: fixturesLoaded ? 'ready' : 'not-ready',
      fixtures: {
        customers: db.customers.count(),
        orders: db.orders.count(),
        products: db.products.count(),
        carriers: db.carriers.count(),
        templates: db.notificationTemplates.count(),
        scenarios: db.scenarios.count(),
      },
      clock: { frozen: env.DEMO_FREEZE_CLOCK, now: clock.nowIso() },
      agents: AGENT_IDS.length,
      /**
       * Which agents are actually talking to a model right now. `configured`
       * vs `active` differ when AGENT_RUNTIME asked for the LLM but no
       * a credential is present — the most common demo misconfiguration, so it
       * is surfaced rather than silently downgraded.
       */
      runtime: {
        configured: env.AGENT_RUNTIME,
        credentialPresent: env.hasCredential,
        /** 'bearer' vs 'x-api-key'. Gateways usually need bearer. */
        authMode: env.authMode,
        baseUrl: env.ANTHROPIC_BASE_URL ?? null,
        model: llmAgents.length ? env.LLM_MODEL : null,
        effort: llmAgents.length ? env.LLM_EFFORT : null,
        fallbackToRules: env.LLM_FALLBACK_TO_RULES,
        active: Object.fromEntries(AGENT_IDS.map((id) => [id, implementationFor(id)])),
      },
    },
    undefined,
    fixturesLoaded ? 200 : 503,
  );
});

/* ========================================================================== */
/* Meta                                                                       */
/* ========================================================================== */

/**
 * GET /api/v1/meta/pipeline
 * The frontend draws the pipeline diagram from this, so the stage layout is
 * defined once (pipeline.config.ts) rather than in two places.
 */
metaRouter.get('/pipeline', (_req: Request, res: Response) => {
  res.ok({
    ...describePipeline(),
    agents: AGENT_IDS.map((id) => ({ agentId: id, ...AGENT_METADATA[id] })),
  });
});

/** GET /api/v1/meta/error-codes — the error taxonomy, for the frontend's map. */
metaRouter.get('/error-codes', (_req: Request, res: Response) => {
  res.ok(
    Object.values(ERROR_CODE).map((code) => ({
      code,
      description: ERROR_CODE_DESCRIPTIONS[code],
    })),
  );
});

const ERROR_CODE_DESCRIPTIONS: Record<string, string> = {
  VALIDATION_ERROR: 'Request body, query or params failed schema validation. `details.issues` lists the offending fields.',
  NOT_FOUND: 'The referenced entity does not exist in the mock dataset.',
  INVALID_STATE: "The operation is not valid for the case's current status.",
  UNPARSEABLE_INTENT: 'Free-text intake could not be normalized into a return intent.',
  ORDER_NOT_RESOLVED: 'The intent parsed, but no matching order or product could be identified.',
  AGENT_FAILED: 'An agent threw an unexpected error.',
  AGENT_TIMEOUT: 'An agent exceeded its execution budget. Retryable.',
  PIPELINE_FAILED: 'The orchestration pipeline aborted.',
  UNRESOLVED_CONFLICT: 'Two agent outputs conflict and no policy resolves it.',
  NOT_IMPLEMENTED: 'Wireframe stub — not implemented yet.',
  RATE_LIMITED: 'Too many requests.',
  INTERNAL_ERROR: 'Unexpected server error.',
};

/**
 * GET /api/v1/meta/routes
 * Self-describing endpoint list. Saves the frontend team from grepping the
 * router while the API is still moving.
 */
metaRouter.get('/routes', (_req: Request, res: Response) => {
  res.ok(ROUTE_MANIFEST);
});

const ROUTE_MANIFEST = [
  { method: 'POST', path: '/api/v1/returns/intake', purpose: 'Submit a free-text return request and run the pipeline.' },
  { method: 'POST', path: '/api/v1/returns/intake/parse', purpose: 'Parse-only preview of the structured intent.' },
  { method: 'GET', path: '/api/v1/returns/cases', purpose: 'List cases (paginated, filterable).' },
  { method: 'GET', path: '/api/v1/returns/cases/:caseId', purpose: 'Full shared state for one case.' },
  { method: 'GET', path: '/api/v1/returns/cases/:caseId/agents', purpose: 'Agent run summaries for the pipeline UI.' },
  { method: 'GET', path: '/api/v1/returns/cases/:caseId/agents/:agentId', purpose: "One agent's full result." },
  { method: 'GET', path: '/api/v1/returns/cases/:caseId/timeline', purpose: 'Ordered trace events.' },
  { method: 'GET', path: '/api/v1/returns/cases/:caseId/outcome', purpose: 'Flattened final outcome.' },
  { method: 'GET', path: '/api/v1/returns/cases/:caseId/conflicts', purpose: 'Orchestrator conflict log.' },
  { method: 'GET', path: '/api/v1/returns/cases/:caseId/stream', purpose: 'SSE live agent status.' },
  { method: 'POST', path: '/api/v1/returns/cases/:caseId/decision', purpose: 'Human approve / reject / resume.' },
  { method: 'POST', path: '/api/v1/returns/cases/:caseId/logistics-selection', purpose: 'Choose a different return route.' },
  { method: 'POST', path: '/api/v1/returns/cases/:caseId/replay', purpose: 'Re-run the same input as a new case.' },
  { method: 'GET', path: '/api/v1/returns/escalations', purpose: 'Cross-case support queue.' },
  { method: 'GET', path: '/api/v1/agents', purpose: 'Agent catalogue.' },
  { method: 'GET', path: '/api/v1/agents/:agentId', purpose: 'Agent metadata.' },
  { method: 'GET', path: '/api/v1/agents/:agentId/contract', purpose: 'Input/output JSON Schema.' },
  { method: 'POST', path: '/api/v1/agents/:agentId/invoke', purpose: 'Run one agent in isolation.' },
  { method: 'GET', path: '/api/v1/customers', purpose: 'List customers.' },
  { method: 'GET', path: '/api/v1/customers/:customerId', purpose: 'Customer profile.' },
  { method: 'GET', path: '/api/v1/customers/:customerId/orders', purpose: 'Orders with returnability decorated.' },
  { method: 'GET', path: '/api/v1/customers/:customerId/returns', purpose: 'Return/case history.' },
  { method: 'GET', path: '/api/v1/orders', purpose: 'List orders.' },
  { method: 'GET', path: '/api/v1/orders/:orderId', purpose: 'Order with derived returnability.' },
  { method: 'GET', path: '/api/v1/products', purpose: 'Catalogue with inventory.' },
  { method: 'GET', path: '/api/v1/products/:sku', purpose: 'Product with inventory, history and open insights.' },
  { method: 'GET', path: '/api/v1/reference/policy', purpose: 'The full return policy as data.' },
  { method: 'GET', path: '/api/v1/reference/enums', purpose: 'Every closed enum, for dropdowns and badges.' },
  { method: 'GET', path: '/api/v1/reference/carriers', purpose: 'Carrier reference data.' },
  { method: 'GET', path: '/api/v1/reference/facilities', purpose: 'Facility reference data.' },
  { method: 'GET', path: '/api/v1/reference/drop-off-locations', purpose: 'Drop-off points.' },
  { method: 'GET', path: '/api/v1/reference/packaging-kits', purpose: 'Packaging options.' },
  { method: 'GET', path: '/api/v1/reference/sustainability-factors', purpose: 'Emission factors.' },
  { method: 'GET', path: '/api/v1/reference/notification-templates', purpose: 'Message template library.' },
  { method: 'GET', path: '/api/v1/shipments', purpose: 'List shipments.' },
  { method: 'GET', path: '/api/v1/shipments/:shipmentId', purpose: 'One shipment.' },
  { method: 'GET', path: '/api/v1/shipments/:shipmentId/tracking', purpose: 'Tracking timeline.' },
  { method: 'POST', path: '/api/v1/shipments/:shipmentId/advance', purpose: 'Demo: step the parcel forward.' },
  { method: 'GET', path: '/api/v1/notifications', purpose: 'The mock outbox / customer inbox.' },
  { method: 'GET', path: '/api/v1/notifications/:messageId', purpose: 'One rendered message.' },
  { method: 'GET', path: '/api/v1/sustainability/records', purpose: 'CO2 ledger entries.' },
  { method: 'GET', path: '/api/v1/sustainability/records/:recordId', purpose: 'One ledger entry.' },
  { method: 'GET', path: '/api/v1/sustainability/summary', purpose: 'Sustainability dashboard rollup.' },
  { method: 'GET', path: '/api/v1/insights', purpose: 'List insights (filter, sort).' },
  { method: 'GET', path: '/api/v1/insights/:insightId', purpose: 'One insight with evidence and actions.' },
  { method: 'PATCH', path: '/api/v1/insights/:insightId', purpose: 'Acknowledge / action / dismiss.' },
  { method: 'GET', path: '/api/v1/analytics/kpis', purpose: 'Executive KPI snapshot.' },
  { method: 'GET', path: '/api/v1/analytics/metrics', purpose: 'Available trend metrics.' },
  { method: 'GET', path: '/api/v1/analytics/trends', purpose: 'One time series.' },
  { method: 'GET', path: '/api/v1/analytics/trends/all', purpose: 'Every series in one call.' },
  { method: 'GET', path: '/api/v1/analytics/root-causes', purpose: 'Insight types ranked by exposure.' },
  { method: 'GET', path: '/api/v1/demo/scenarios', purpose: 'Named demo scenarios.' },
  { method: 'POST', path: '/api/v1/demo/scenarios/:scenarioId/run', purpose: 'Run one scenario.' },
  { method: 'POST', path: '/api/v1/demo/reset', purpose: 'Restore seeded state.' },
  { method: 'GET', path: '/api/v1/demo/state', purpose: 'In-memory record counts.' },
  { method: 'GET', path: '/api/v1/meta/pipeline', purpose: 'The agent execution plan.' },
  { method: 'GET', path: '/api/v1/meta/routes', purpose: 'This manifest.' },
  { method: 'GET', path: '/api/v1/meta/error-codes', purpose: 'Error taxonomy.' },
  { method: 'GET', path: '/health', purpose: 'Liveness probe.' },
  { method: 'GET', path: '/ready', purpose: 'Readiness probe.' },
];

/* ========================================================================== */
/* Demo control                                                               */
/* ========================================================================== */

demoRouter.get('/scenarios', (_req: Request, res: Response) => {
  res.ok(
    db.scenarios.all().sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
  );
});

/**
 * POST /api/v1/demo/scenarios/:scenarioId/run
 * Runs a named scenario with its fixture-pinned customer/order, so the demo is
 * identical every time. `reset: true` clears prior runs first.
 */
demoRouter.post(
  '/scenarios/:scenarioId/run',
  validate(ScenarioIdParamsSchema, 'params'),
  validate(RunScenarioRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const scenarioId = req.params.scenarioId as string;
    const body = req.body as RunScenarioRequest;

    const scenario = db.scenarios.get(scenarioId);
    if (!scenario) throw notFound('Scenario', scenarioId);

    if (body.reset) resetAll();

    const options = {
      customerId: scenario.customerId,
      orderId: scenario.orderId,
      orderItemId: scenario.orderItemId,
      scenarioId: scenario.scenarioId,
    };

    if (body.async) {
      const { caseId } = orchestrator.startPipeline(scenario.input, options);
      res.ok(
        { caseId, scenarioId, status: store.getCase(caseId).status, streamUrl: `/api/v1/returns/cases/${caseId}/stream` },
        undefined,
        202,
      );
      return;
    }

    const result = await orchestrator.runPipeline(scenario.input, options);
    res.ok({ scenario, case: result }, undefined, 201);
  }),
);

/**
 * POST /api/v1/demo/reset
 * Restores the seeded fixture state and clears every case, so a presenter can
 * run the same scenario repeatedly with identical output.
 */
demoRouter.post('/reset', (_req: Request, res: Response) => {
  resetAll();
  res.ok({
    message: 'Demo state reset to seeded fixtures.',
    fixtures: {
      customers: db.customers.count(),
      orders: db.orders.count(),
      products: db.products.count(),
      insights: db.insights.count(),
    },
    clock: { frozen: env.DEMO_FREEZE_CLOCK, now: clock.nowIso() },
  });
});

demoRouter.get('/state', (_req: Request, res: Response) => {
  res.ok({
    cases: db.cases.count(),
    returns: db.returns.count(),
    resolutions: db.resolutions.count(),
    shipments: db.shipments.count(),
    notifications: db.notifications.count(),
    sustainabilityRecords: db.sustainabilityRecords.count(),
    insights: db.insights.count(),
    clock: { frozen: env.DEMO_FREEZE_CLOCK, now: clock.nowIso() },
  });
});

function resetAll(): void {
  // resetDb() already resets AND re-seeds the ID counters past the fixture IDs;
  // calling resetCounters() again here would undo that re-seeding and let a
  // generated insight collide with INS-000001 from history.json.
  resetDb();
  store.resetStore();
  eventBus.clear();
  resetRegistry();
}
