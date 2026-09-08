/**
 * Mirrors the backend contract. Keep in sync with:
 *   backend/src/domain/insight.schema.ts  (KpiSnapshotSchema)
 *   backend/src/core/envelope.ts          (ApiEnvelope)
 *
 * SHARED FILE — add other domain types here as the rest of the frontend lands.
 */

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  durationMs?: number;
  pagination?: { page: number; pageSize: number; total: number; totalPages: number };
}

export type ApiEnvelope<T> =
  | { success: true; data: T; meta: ResponseMeta }
  | {
      success: false;
      error: { code: string; message: string; details?: unknown; retryable: boolean };
      meta: ResponseMeta;
    };

/** GET /api/v1/analytics/kpis */
export interface KpiSnapshot {
  windowDays: number;
  generatedAt: string;

  totalReturns: number;
  returnRatePct: number;
  avgTurnaroundHours: number;
  automationRatePct: number;
  ticketDeflectionPct: number;

  avgCostPerReturnUsd: number;
  totalReturnCostUsd: number;
  retainedRevenueUsd: number;
  repeatPurchaseRatePct: number;

  avgCsat: number;
  nps: number;

  co2PreventedKg: number;
  sustainableReturnPct: number;
  packagingWasteAvoidedKg: number;

  escalationRatePct: number;
  insightsGenerated: number;
  insightsActioned: number;

  /** Signed change vs the previous equivalent window. Sparse — most keys absent. */
  deltas: Record<string, number>;
}

/** Numeric keys of KpiSnapshot — the only things a tile may point at. */
export type KpiMetricKey = {
  [K in keyof KpiSnapshot]: KpiSnapshot[K] extends number ? K : never;
}[keyof KpiSnapshot];
