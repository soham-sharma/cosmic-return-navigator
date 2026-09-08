/**
 * Fallback snapshot, used only when the backend is unreachable so the page
 * always renders something truthful-looking during pure UI work.
 *
 * Copied from backend/src/mocks/fixtures/history.json -> kpiBaseline, which is
 * exactly what GET /analytics/kpis returns before any live case has run.
 */
import type { KpiSnapshot } from './types.js';

export const MOCK_KPI_SNAPSHOT: KpiSnapshot = {
  windowDays: 30,
  generatedAt: '2026-09-08T00:00:00.000Z',

  totalReturns: 214,
  returnRatePct: 5.1,
  avgTurnaroundHours: 38.4,
  automationRatePct: 78.5,
  ticketDeflectionPct: 71.2,

  avgCostPerReturnUsd: 24.8,
  totalReturnCostUsd: 5307.2,
  retainedRevenueUsd: 148300.0,
  repeatPurchaseRatePct: 62.4,

  avgCsat: 4.3,
  nps: 31,

  co2PreventedKg: 412.6,
  sustainableReturnPct: 31.0,
  packagingWasteAvoidedKg: 58.2,

  escalationRatePct: 12.6,
  insightsGenerated: 17,
  insightsActioned: 6,

  deltas: {
    returnRatePct: -0.4,
    avgTurnaroundHours: -19.6,
    automationRatePct: 12.3,
    avgCostPerReturnUsd: -6.2,
    avgCsat: 0.5,
    nps: 9,
    co2PreventedKg: 118.4,
    sustainableReturnPct: 8.0,
    ticketDeflectionPct: 15.1,
  },
};
