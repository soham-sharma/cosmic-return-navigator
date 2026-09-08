/**
 * AGENT ROUTES — the parallel-development surface.
 *
 * Base path: /api/v1/agents
 *
 *   GET  /                      Agent catalogue (id, name, purpose, stage)
 *   GET  /:agentId              One agent's metadata
 *   GET  /:agentId/contract     JSON Schema for its input and output
 *   POST /:agentId/invoke       Run ONE agent in isolation
 *
 * WHY `/invoke` MATTERS: it is what lets all seven agent owners work on day one
 * without waiting for the orchestrator or for each other. Post a contract-shaped
 * input, get an `AgentResult` back. Nothing else in the system is touched.
 */
import { Router, type Request, type Response } from 'express';
import { toStrictJsonSchema, zodToJsonSchema } from '../../lib/zod-to-json-schema';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/error-handler';
import { AppError, notFound } from '../../core/errors';
import { AGENT_METADATA, type AgentId } from '../../domain/agent.schema';
import { getAgent, listAgents } from '../../agents/base/registry';
import { AgentIdParamsSchema, AgentInvokeRequestSchema, type AgentInvokeRequest } from '../contracts/api.schema';
import * as store from '../../orchestrator/state-store';
import { newId } from '../../core/ids';
import { clock } from '../../core/clock';

export const agentsRouter = Router();

/* ========================================================================== */
/* Catalogue                                                                  */
/* ========================================================================== */

/** GET /api/v1/agents — drives the frontend's agent panel with no hardcoding. */
agentsRouter.get('/', (_req: Request, res: Response) => {
  res.ok(listAgents());
});

agentsRouter.get('/:agentId', validate(AgentIdParamsSchema, 'params'), (req: Request, res: Response) => {
  const agentId = req.params.agentId as AgentId;
  const agent = getAgent(agentId);
  res.ok({ agentId, ...AGENT_METADATA[agentId], version: agent.version, stage: agent.stage });
});

/**
 * GET /api/v1/agents/:agentId/contract
 *
 * JSON Schema for the agent's input and output, derived from the Zod schemas.
 * Lets the frontend generate example payloads and lets each owner see exactly
 * what they must produce without reading TypeScript.
 */
agentsRouter.get('/:agentId/contract', validate(AgentIdParamsSchema, 'params'), (req: Request, res: Response) => {
  const agentId = req.params.agentId as AgentId;
  const agent = getAgent(agentId);

  res.ok({
    agentId,
    ...AGENT_METADATA[agentId],
    version: agent.version,
    stage: agent.stage,
    // 'input' mode: defaulted fields shown as optional, matching what a caller
    // actually has to supply.
    input: zodToJsonSchema(agent.inputSchema, { io: 'input' }),
    output: zodToJsonSchema(agent.outputSchema, { io: 'input' }),
    /** The exact strict schema used to force the model's structured output. */
    forcedOutputSchema: toStrictJsonSchema(agent.outputSchema),
  });
});

/* ========================================================================== */
/* Direct invocation                                                          */
/* ========================================================================== */

/**
 * POST /api/v1/agents/:agentId/invoke
 *
 * Body is either:
 *   { "input": { ...contract-shaped input... } }
 * or
 *   { "caseId": "RET-000001", "persist": false }
 *
 * With `caseId`, the input is rebuilt from that case's hydrated context and
 * upstream outputs — handy for re-running one agent against a real case after
 * changing its rules. `persist: true` writes the result back onto the case.
 */
agentsRouter.post(
  '/:agentId/invoke',
  validate(AgentIdParamsSchema, 'params'),
  validate(AgentInvokeRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.params.agentId as AgentId;
    const body = req.body as AgentInvokeRequest;
    const agent = getAgent(agentId);

    /* --- Mode 1: explicit input --- */
    if (body.input) {
      const result = await agent.run(body.input, {
        caseId: (body.input.caseId as string) ?? 'ADHOC',
        runId: newId('agentRun'),
        traceId: `adhoc-${newId('event')}`,
        now: (body.input.context as { now?: string } | undefined)?.now ?? clock.nowIso(),
      });
      res.ok(result);
      return;
    }

    /* --- Mode 2: rebuild from an existing case --- */
    const caseId = body.caseId!;
    const c = store.getCase(caseId);
    if (!c.context || !c.intent) {
      throw new AppError('INVALID_STATE', `Case ${caseId} has no hydrated context yet, so an agent cannot be run against it.`, {
        details: { status: c.status },
      });
    }

    const input = buildInputFromCase(agentId, caseId);
    if (!input) {
      throw new AppError(
        'INVALID_STATE',
        `Agent '${agentId}' needs upstream outputs that case ${caseId} does not have yet.`,
        { details: { available: Object.keys(c.agentResults) } },
      );
    }

    if (body.persist) store.markAgentRunning(caseId, agentId);

    const result = await agent.run(input, {
      caseId,
      runId: newId('agentRun'),
      traceId: c.traceId,
      now: c.context.now,
    });

    if (body.persist) store.recordAgentResult(caseId, result);
    res.ok(result);
  }),
);

/**
 * Rebuilds an agent's input from a case. Mirrors the orchestrator's dependency
 * map; returns null when a required upstream output is missing.
 *
 * NOTE: intentionally duplicated rather than exported from the orchestrator —
 * this is a debugging path and must never be able to mutate pipeline state.
 */
function buildInputFromCase(agentId: AgentId, caseId: string): Record<string, unknown> | null {
  const c = store.getCase(caseId);
  const context = c.context!;
  const intent = c.intent!;
  const out = {
    eligibility: c.agentResults.eligibility?.output ?? null,
    sentiment: c.agentResults.sentiment?.output ?? null,
    resolution: c.agentResults.resolution?.output ?? null,
    logistics: c.agentResults.logistics?.output ?? null,
    sustainability: c.agentResults.sustainability?.output ?? null,
  };

  switch (agentId) {
    case 'eligibility':
    case 'sentiment':
      return { caseId, intent, context };

    case 'resolution':
      if (!out.eligibility || !out.sentiment) return null;
      return { caseId, intent, context, eligibility: out.eligibility, sentiment: out.sentiment };

    case 'logistics':
      if (!out.resolution) return null;
      return { caseId, context, resolution: out.resolution };

    case 'sustainability':
      if (!out.resolution || !out.logistics) return null;
      return { caseId, context, resolution: out.resolution, logistics: out.logistics };

    case 'communication':
      if (!out.eligibility || !out.sentiment) return null;
      return {
        caseId,
        context,
        eligibility: out.eligibility,
        sentiment: out.sentiment,
        resolution: out.resolution,
        logistics: out.logistics,
        sustainability: out.sustainability,
        pipelineHalted: c.escalations.some((e) => e.blocking && e.resolvedAt === null),
      };

    case 'insights':
      return { caseId, intent, context, ...out };

    default:
      throw notFound('Agent', agentId);
  }
}
