/**
 * OPERATIONS ROUTES — shipments, notifications, sustainability records,
 * insights and analytics. The read surfaces behind the logistics,
 * sustainability and executive dashboards.
 *
 * Base paths: /api/v1/shipments, /notifications, /sustainability, /insights,
 *             /analytics
 */
import { Router, type Request, type Response } from 'express';
import { clock } from '../../core/clock';
import { notFound } from '../../core/errors';
import { db } from '../../repositories/db';
import { paginate } from '../../repositories/memory-collection';
import { validate } from '../middleware/validate';
import type { PaginationQuery } from '../../domain/common.schema';
import {
  AdvanceShipmentRequestSchema,
  AnalyticsQuerySchema,
  InsightIdParamsSchema,
  InsightListQuerySchema,
  NotificationListQuerySchema,
  ShipmentIdParamsSchema,
  SustainabilityListQuerySchema,
  TrendQuerySchema,
  UpdateInsightRequestSchema,
  type AdvanceShipmentRequest,
  type AnalyticsQuery,
  type UpdateInsightRequest,
} from '../contracts/api.schema';
import * as shipmentService from '../../services/shipment.service';
import * as analytics from '../../services/analytics.service';

export const shipmentsRouter = Router();
export const notificationsRouter = Router();
export const sustainabilityRouter = Router();
export const insightsRouter = Router();
export const analyticsRouter = Router();

/* ========================================================================== */
/* Shipments                                                                  */
/* ========================================================================== */

shipmentsRouter.get('/', (req: Request, res: Response) => {
  res.ok(
    shipmentService.listShipments({
      caseId: req.query.caseId as string | undefined,
      returnId: req.query.returnId as string | undefined,
    }),
  );
});

shipmentsRouter.get('/:shipmentId', validate(ShipmentIdParamsSchema, 'params'), (req: Request, res: Response) => {
  res.ok(shipmentService.getShipment(req.params.shipmentId as string));
});

/** Tracking timeline only — real and projected events. */
shipmentsRouter.get('/:shipmentId/tracking', validate(ShipmentIdParamsSchema, 'params'), (req: Request, res: Response) => {
  const shipment = shipmentService.getShipment(req.params.shipmentId as string);
  res.ok({
    shipmentId: shipment.shipmentId,
    status: shipment.status,
    trackingNumber: shipment.label?.trackingNumber ?? null,
    carrierName: shipment.carrierName,
    estimatedArrivalAt: shipment.estimatedArrivalAt,
    events: shipment.trackingEvents,
  });
});

/**
 * POST /api/v1/shipments/:shipmentId/advance
 * DEMO CONTROL: steps the parcel to its next tracking state (or jumps to a
 * given status), so a presenter can walk the whole journey on stage.
 */
shipmentsRouter.post(
  '/:shipmentId/advance',
  validate(ShipmentIdParamsSchema, 'params'),
  validate(AdvanceShipmentRequestSchema),
  (req: Request, res: Response) => {
    const body = req.body as AdvanceShipmentRequest;
    res.ok(shipmentService.advanceShipment(req.params.shipmentId as string, body));
  },
);

/* ========================================================================== */
/* Notifications (the mock outbox)                                            */
/* ========================================================================== */

/**
 * GET /api/v1/notifications
 * The demo renders this as the customer's inbox — proof that the Communication
 * Agent actually produced tone-matched, variable-bound messages.
 */
notificationsRouter.get('/', validate(NotificationListQuerySchema, 'query'), (req: Request, res: Response) => {
  const q = req.query as unknown as PaginationQuery & { caseId?: string; customerId?: string; channel?: string };

  let items = db.notifications.all();
  if (q.caseId) items = items.filter((n) => n.caseId === q.caseId);
  if (q.customerId) items = items.filter((n) => n.customerId === q.customerId);
  if (q.channel) items = items.filter((n) => n.channel === q.channel);

  items = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const { items: page, pagination } = paginate(items, q.page, q.pageSize);
  res.ok(page, pagination);
});

notificationsRouter.get('/:messageId', (req: Request, res: Response) => {
  const message = db.notifications.get(req.params.messageId as string);
  if (!message) throw notFound('Notification', req.params.messageId as string);
  res.ok(message);
});

/* ========================================================================== */
/* Sustainability                                                             */
/* ========================================================================== */

sustainabilityRouter.get('/records', validate(SustainabilityListQuerySchema, 'query'), (req: Request, res: Response) => {
  const q = req.query as unknown as PaginationQuery & { caseId?: string; sku?: string; grade?: string };

  let items = db.sustainabilityRecords.all();
  if (q.caseId) items = items.filter((r) => r.caseId === q.caseId);
  if (q.sku) items = items.filter((r) => r.sku === q.sku);
  if (q.grade) items = items.filter((r) => r.grade === q.grade);

  items = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const { items: page, pagination } = paginate(items, q.page, q.pageSize);
  res.ok(page, pagination);
});

sustainabilityRouter.get('/records/:recordId', (req: Request, res: Response) => {
  const record = db.sustainabilityRecords.get(req.params.recordId as string);
  if (!record) throw notFound('Sustainability record', req.params.recordId as string);
  res.ok(record);
});

/** GET /api/v1/sustainability/summary — the sustainability lead's dashboard. */
sustainabilityRouter.get('/summary', (_req: Request, res: Response) => {
  res.ok(analytics.getSustainabilitySummary());
});

/* ========================================================================== */
/* Insights                                                                   */
/* ========================================================================== */

insightsRouter.get('/', validate(InsightListQuerySchema, 'query'), (req: Request, res: Response) => {
  const q = req.query as unknown as PaginationQuery & {
    type?: string;
    status?: string;
    severity?: string;
    sku?: string;
    owningTeam?: string;
    sort: 'priorityScore' | 'lastObservedAt' | 'estimatedAnnualImpactUsd';
  };

  let items = db.insights.all();
  if (q.type) items = items.filter((i) => i.type === q.type);
  if (q.status) items = items.filter((i) => i.status === q.status);
  if (q.severity) items = items.filter((i) => i.severity === q.severity);
  if (q.sku) items = items.filter((i) => i.sku === q.sku);
  if (q.owningTeam) items = items.filter((i) => i.owningTeam === q.owningTeam);

  items = items.sort((a, b) => {
    if (q.sort === 'lastObservedAt') return b.lastObservedAt.localeCompare(a.lastObservedAt);
    if (q.sort === 'estimatedAnnualImpactUsd') return (b.estimatedAnnualImpactUsd ?? 0) - (a.estimatedAnnualImpactUsd ?? 0);
    return b.priorityScore - a.priorityScore;
  });

  const { items: page, pagination } = paginate(items, q.page, q.pageSize);
  res.ok(page, pagination);
});

insightsRouter.get('/:insightId', validate(InsightIdParamsSchema, 'params'), (req: Request, res: Response) => {
  const insight = db.insights.get(req.params.insightId as string);
  if (!insight) throw notFound('Insight', req.params.insightId as string);
  res.ok(insight);
});

/**
 * PATCH /api/v1/insights/:insightId
 * Lets the executive/product view acknowledge, action or dismiss a finding.
 * "Insights actioned" is a PRD KPI, so this endpoint is what makes it real.
 */
insightsRouter.patch(
  '/:insightId',
  validate(InsightIdParamsSchema, 'params'),
  validate(UpdateInsightRequestSchema),
  (req: Request, res: Response) => {
    const insightId = req.params.insightId as string;
    const body = req.body as UpdateInsightRequest;

    if (!db.insights.has(insightId)) throw notFound('Insight', insightId);

    const updated = db.insights.update(insightId, {
      status: body.status,
      updatedAt: clock.nowIso(),
      summary: body.note
        ? `${db.insights.get(insightId)!.summary}\n\n[${body.updatedBy}] ${body.note}`
        : db.insights.get(insightId)!.summary,
    });

    res.ok(updated);
  },
);

/* ========================================================================== */
/* Analytics                                                                  */
/* ========================================================================== */

/** GET /api/v1/analytics/kpis — the executive dashboard (persona "Finley"). */
analyticsRouter.get('/kpis', validate(AnalyticsQuerySchema, 'query'), (req: Request, res: Response) => {
  const q = req.query as unknown as AnalyticsQuery;
  res.ok(analytics.getKpiSnapshot(q.windowDays));
});

/** GET /api/v1/analytics/metrics — the metric keys /trends accepts. */
analyticsRouter.get('/metrics', (_req: Request, res: Response) => {
  res.ok(analytics.listMetrics());
});

analyticsRouter.get('/trends', validate(TrendQuerySchema, 'query'), (req: Request, res: Response) => {
  const metric = req.query.metric as string;
  const series = analytics.getTrend(metric);
  if (!series) {
    res.fail('NOT_FOUND', `No trend series named '${metric}'. See GET /api/v1/analytics/metrics.`, 404, {
      available: analytics.listMetrics().map((m) => m.metric),
    });
    return;
  }
  res.ok(series);
});

/** All series in one call — convenient for a dashboard's initial load. */
analyticsRouter.get('/trends/all', (_req: Request, res: Response) => {
  res.ok(analytics.getAllTrends());
});

/** GET /api/v1/analytics/root-causes — insight types ranked by exposure. */
analyticsRouter.get('/root-causes', (_req: Request, res: Response) => {
  res.ok(analytics.getRootCauses());
});
