/**
 * API REQUEST/RESPONSE CONTRACTS.
 *
 * One file, so the frontend team has a single import for every request shape
 * the backend accepts. Response shapes are the domain schemas wrapped in the
 * standard envelope (see core/envelope.ts).
 *
 * FRONTEND USAGE:
 *   import { IntakeRequestSchema, type IntakeRequest } from '<backend>/api/contracts/api.schema';
 * or copy this file into the frontend package — it has no runtime dependency
 * beyond zod.
 */
import { z } from 'zod';
import { ChannelSchema, PaginationQuerySchema } from '../../domain/common.schema';
import { AgentIdSchema } from '../../domain/agent.schema';
import { CaseStatusSchema } from '../../domain/case-state.schema';
import { InsightStatusSchema, InsightTypeSchema } from '../../domain/insight.schema';

/* ========================================================================== */
/* Intake                                                                     */
/* ========================================================================== */

/**
 * POST /api/v1/returns/intake
 *
 * `text` is the only required field. Supplying `customerId`/`orderId` skips
 * fuzzy entity resolution and is the path the UI uses once the customer has
 * picked an order from their history.
 */
export const IntakeRequestSchema = z.object({
  text: z.string().min(3, 'Tell us a little more about the return.').max(2000),
  customerId: z.string().optional(),
  orderId: z.string().optional(),
  orderItemId: z.string().optional(),
  channel: ChannelSchema.optional(),
  hasPhotoEvidence: z.boolean().optional(),
  /**
   * false (default) -> wait for the pipeline and return the completed case.
   * true            -> return `{ caseId }` immediately; the client streams
   *                    progress from /stream. Use this for the live demo.
   */
  async: z.boolean().default(false),
  /** Tags the case as a named demo scenario. */
  scenarioId: z.string().optional(),
});
export type IntakeRequest = z.infer<typeof IntakeRequestSchema>;

/** POST /api/v1/returns/intake/parse — parse only, run nothing. */
export const ParsePreviewRequestSchema = IntakeRequestSchema.pick({
  text: true,
  customerId: true,
  orderId: true,
  orderItemId: true,
  channel: true,
  hasPhotoEvidence: true,
});
export type ParsePreviewRequest = z.infer<typeof ParsePreviewRequestSchema>;

/* ========================================================================== */
/* Case queries                                                               */
/* ========================================================================== */

export const CaseListQuerySchema = PaginationQuerySchema.extend({
  status: CaseStatusSchema.optional(),
  customerId: z.string().optional(),
  scenarioId: z.string().optional(),
  /** Only cases with an unresolved blocking escalation — the support queue. */
  escalatedOnly: z.coerce.boolean().optional(),
  sort: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type CaseListQuery = z.infer<typeof CaseListQuerySchema>;

export const CaseIdParamsSchema = z.object({ caseId: z.string().min(1) });
export const AgentRunParamsSchema = z.object({ caseId: z.string().min(1), agentId: AgentIdSchema });

/** GET /api/v1/returns/cases/:caseId?include=... — trims the payload. */
export const CaseDetailQuerySchema = z.object({
  /** Comma-separated: context,trace,outputs,conflicts. Default: everything. */
  include: z.string().optional(),
});

/* ========================================================================== */
/* Case actions                                                               */
/* ========================================================================== */

/** POST /api/v1/returns/cases/:caseId/decision */
export const HumanDecisionRequestSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT', 'OVERRIDE_RESOLUTION', 'REQUEST_INFO', 'RESUME', 'CANCEL']),
  decidedBy: z.string().min(1).describe('Support agent identifier (mocked)'),
  note: z.string().max(1000).optional(),
  escalationId: z.string().optional(),
  /** Required when action is OVERRIDE_RESOLUTION. */
  overrideOptionId: z.string().optional(),
}).refine((v) => v.action !== 'OVERRIDE_RESOLUTION' || Boolean(v.overrideOptionId), {
  message: 'overrideOptionId is required when action is OVERRIDE_RESOLUTION.',
  path: ['overrideOptionId'],
});
export type HumanDecisionRequest = z.infer<typeof HumanDecisionRequestSchema>;

/** POST /api/v1/returns/cases/:caseId/logistics-selection */
export const SelectLogisticsRequestSchema = z.object({
  optionId: z.string().min(1),
  chosenBy: z.string().default('CUSTOMER'),
});
export type SelectLogisticsRequest = z.infer<typeof SelectLogisticsRequestSchema>;

/* ========================================================================== */
/* Direct agent invocation                                                    */
/* ========================================================================== */

/**
 * POST /api/v1/agents/:agentId/invoke
 *
 * THE KEY ENDPOINT FOR PARALLEL TEAM DEVELOPMENT. Each agent owner can build
 * and test their agent in isolation on day one, before the orchestrator or any
 * upstream agent is finished.
 *
 * Two ways to supply the input:
 *   1. `input`  — a complete, contract-shaped input object. Full control;
 *                 what unit and contract tests use.
 *   2. `caseId` — reuse a real case's hydrated context and upstream outputs.
 *                 Convenient for debugging a specific case.
 * Exactly one is required.
 */
export const AgentInvokeRequestSchema = z
  .object({
    input: z.record(z.string(), z.unknown()).optional(),
    caseId: z.string().optional(),
    /** With `caseId`: persist the result onto the case instead of just
     *  returning it. Defaults to false so debugging is non-destructive. */
    persist: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.input) !== Boolean(v.caseId), {
    message: 'Provide exactly one of `input` or `caseId`.',
  });
export type AgentInvokeRequest = z.infer<typeof AgentInvokeRequestSchema>;

export const AgentIdParamsSchema = z.object({ agentId: AgentIdSchema });

/* ========================================================================== */
/* Catalogue queries                                                          */
/* ========================================================================== */

export const CustomerIdParamsSchema = z.object({ customerId: z.string().min(1) });
export const OrderIdParamsSchema = z.object({ orderId: z.string().min(1) });
export const SkuParamsSchema = z.object({ sku: z.string().min(1) });
export const ShipmentIdParamsSchema = z.object({ shipmentId: z.string().min(1) });
export const InsightIdParamsSchema = z.object({ insightId: z.string().min(1) });
export const ScenarioIdParamsSchema = z.object({ scenarioId: z.string().min(1) });

export const OrderListQuerySchema = PaginationQuerySchema.extend({
  customerId: z.string().optional(),
  status: z.string().optional(),
  /** Only orders with at least one still-returnable line item. */
  returnableOnly: z.coerce.boolean().optional(),
});

export const NotificationListQuerySchema = PaginationQuerySchema.extend({
  caseId: z.string().optional(),
  customerId: z.string().optional(),
  channel: ChannelSchema.optional(),
});

export const SustainabilityListQuerySchema = PaginationQuerySchema.extend({
  caseId: z.string().optional(),
  sku: z.string().optional(),
  grade: z.enum(['A', 'B', 'C', 'D', 'F']).optional(),
});

export const InsightListQuerySchema = PaginationQuerySchema.extend({
  type: InsightTypeSchema.optional(),
  status: InsightStatusSchema.optional(),
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  sku: z.string().optional(),
  owningTeam: z.string().optional(),
  sort: z.enum(['priorityScore', 'lastObservedAt', 'estimatedAnnualImpactUsd']).default('priorityScore'),
});

/** PATCH /api/v1/insights/:insightId */
export const UpdateInsightRequestSchema = z.object({
  status: InsightStatusSchema,
  note: z.string().max(1000).optional(),
  updatedBy: z.string().default('DEMO_USER'),
});
export type UpdateInsightRequest = z.infer<typeof UpdateInsightRequestSchema>;

/* ========================================================================== */
/* Analytics                                                                  */
/* ========================================================================== */

export const AnalyticsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
  regionCode: z.string().optional(),
  category: z.string().optional(),
});
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

export const TrendQuerySchema = AnalyticsQuerySchema.extend({
  /** Metric key from GET /analytics/metrics. */
  metric: z.string().default('returns_per_day'),
  granularity: z.enum(['DAY', 'WEEK', 'MONTH']).default('DAY'),
});

/* ========================================================================== */
/* Shipments (demo simulation)                                                */
/* ========================================================================== */

/**
 * POST /api/v1/shipments/:shipmentId/advance
 * Demo-only: promotes the next projected tracking event to actual, so a
 * presenter can walk the parcel through its journey on stage.
 */
export const AdvanceShipmentRequestSchema = z.object({
  /** Jump straight to a status instead of stepping one event. */
  toStatus: z
    .enum(['PICKED_UP', 'IN_TRANSIT', 'AT_FACILITY', 'DELIVERED', 'EXCEPTION'])
    .optional(),
  note: z.string().max(500).optional(),
});
export type AdvanceShipmentRequest = z.infer<typeof AdvanceShipmentRequestSchema>;

/* ========================================================================== */
/* Demo control                                                               */
/* ========================================================================== */

/** POST /api/v1/demo/scenarios/:scenarioId/run */
export const RunScenarioRequestSchema = z.object({
  async: z.boolean().default(false),
  /** Reset the database first, so the run is fully reproducible. */
  reset: z.boolean().default(false),
});
export type RunScenarioRequest = z.infer<typeof RunScenarioRequestSchema>;
