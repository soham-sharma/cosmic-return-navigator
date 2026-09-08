/**
 * ANALYTICS SERVICE — powers the executive and sustainability dashboards.
 *
 * OWNER: <assign — pairs naturally with the Insights Agent owner>
 *
 * Strategy: start from the seeded `kpiBaseline` (so the dashboard is never
 * empty at demo time) and fold in the live cases run during the session. That
 * way a presenter sees the numbers MOVE when they run a scenario, which is the
 * whole point of the executive view.
 */
import { clock } from '../core/clock';
import { db } from '../repositories/db';
import { listCases } from '../orchestrator/state-store';
import type { Insight, KpiSnapshot, TrendSeries } from '../domain/insight.schema';
import type { ReturnCase } from '../domain/case-state.schema';

/* -------------------------------------------------------------------------- */
/* KPI snapshot                                                                */
/* -------------------------------------------------------------------------- */

export function getKpiSnapshot(windowDays = 30): KpiSnapshot {
  const base = db.kpiBaseline;
  const live = listCases().filter((c) => c.status === 'COMPLETED' || c.status === 'ESCALATED' || c.status === 'DENIED');

  if (live.length === 0) return { ...base, windowDays, generatedAt: clock.nowIso() };

  const contributions = live.map(extractContribution);
  const liveCount = contributions.length;

  const sum = (pick: (c: Contribution) => number | null): number =>
    contributions.reduce((acc, c) => acc + (pick(c) ?? 0), 0);
  const countWhere = (pred: (c: Contribution) => boolean): number => contributions.filter(pred).length;

  const totalReturns = base.totalReturns + liveCount;
  const liveCost = sum((c) => c.costUsd);
  const liveCo2 = sum((c) => c.co2PreventedKg);
  const liveTat = sum((c) => c.turnaroundHours);
  const liveRetained = sum((c) => c.retainedRevenueUsd);
  const automated = countWhere((c) => c.fullyAutomated);
  const deflected = countWhere((c) => c.ticketDeflected);
  const escalated = countWhere((c) => c.escalated);
  const sustainable = countWhere((c) => (c.co2PreventedKg ?? 0) > 0);

  /** Weighted blend of the baseline and live values. */
  const blend = (baseValue: number, liveTotal: number): number =>
    round2((baseValue * base.totalReturns + liveTotal) / Math.max(1, totalReturns));

  return {
    windowDays,
    generatedAt: clock.nowIso(),
    totalReturns,
    returnRatePct: base.returnRatePct,
    avgTurnaroundHours: blend(base.avgTurnaroundHours, liveTat),
    automationRatePct: round2(((base.automationRatePct / 100) * base.totalReturns + automated) / totalReturns * 100),
    ticketDeflectionPct: round2(((base.ticketDeflectionPct / 100) * base.totalReturns + deflected) / totalReturns * 100),
    avgCostPerReturnUsd: blend(base.avgCostPerReturnUsd, liveCost),
    totalReturnCostUsd: round2(base.totalReturnCostUsd + liveCost),
    retainedRevenueUsd: round2(base.retainedRevenueUsd + liveRetained),
    repeatPurchaseRatePct: base.repeatPurchaseRatePct,
    avgCsat: base.avgCsat,
    nps: base.nps,
    co2PreventedKg: round2(base.co2PreventedKg + liveCo2),
    sustainableReturnPct: round2(((base.sustainableReturnPct / 100) * base.totalReturns + sustainable) / totalReturns * 100),
    packagingWasteAvoidedKg: round2(
      base.packagingWasteAvoidedKg +
        db.sustainabilityRecords.all().reduce((a, r) => a + r.packagingWasteAvoidedGrams / 1000, 0),
    ),
    escalationRatePct: round2(((base.escalationRatePct / 100) * base.totalReturns + escalated) / totalReturns * 100),
    insightsGenerated: base.insightsGenerated + db.insights.count((i) => i.contributingCaseIds.length > 0),
    insightsActioned: db.insights.count((i) => i.status === 'ACTIONED') + base.insightsActioned,
    deltas: base.deltas,
  };
}

interface Contribution {
  turnaroundHours: number | null;
  costUsd: number | null;
  co2PreventedKg: number | null;
  retainedRevenueUsd: number | null;
  fullyAutomated: boolean;
  ticketDeflected: boolean;
  escalated: boolean;
}

/**
 * Prefers the Insights Agent's own `kpiContribution` (it already computed this)
 * and falls back to reading the other agent outputs when insights was skipped
 * or failed.
 */
function extractContribution(c: ReturnCase): Contribution {
  const fromInsights = c.agentResults.insights?.output?.kpiContribution;
  if (fromInsights) return fromInsights;

  const escalated = c.escalations.some((e) => e.blocking);
  return {
    turnaroundHours: c.totalDurationMs !== null ? round2(c.totalDurationMs / 3_600_000) : null,
    costUsd: c.agentResults.resolution?.output?.costs.netCostUsd ?? null,
    co2PreventedKg: c.agentResults.sustainability?.output?.co2PreventedKg ?? null,
    retainedRevenueUsd: c.agentResults.resolution?.output?.estimatedRetainedValueUsd ?? null,
    fullyAutomated: c.finalOutcome?.fullyAutomated ?? !escalated,
    ticketDeflected: !escalated && c.status === 'COMPLETED',
    escalated,
  };
}

/* -------------------------------------------------------------------------- */
/* Trends                                                                      */
/* -------------------------------------------------------------------------- */

export function listMetrics(): { metric: string; unit: string; granularity: string; description: string }[] {
  return [
    { metric: 'returns_per_day', unit: 'returns', granularity: 'DAY', description: 'Daily return volume, with damaged-on-arrival as the secondary series.' },
    { metric: 'co2_prevented_kg_per_day', unit: 'kg', granularity: 'DAY', description: 'CO2 prevented per day versus the express-single-shipment baseline.' },
    { metric: 'returns_by_reason', unit: 'returns', granularity: 'MONTH', description: 'Return volume grouped by normalized reason.' },
    { metric: 'returns_by_category', unit: 'returns', granularity: 'MONTH', description: 'Return volume by product category, with return rate as the secondary series.' },
  ];
}

export function getTrend(metric: string): TrendSeries | null {
  return db.trendSeries.find((s) => s.metric === metric) ?? null;
}

export function getAllTrends(): TrendSeries[] {
  return db.trendSeries;
}

/* -------------------------------------------------------------------------- */
/* Root causes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Root-cause view for the executive dashboard: which insight types account for
 * the most exposure, ranked by estimated annual impact.
 */
export function getRootCauses(): {
  type: string;
  insightCount: number;
  observationCount: number;
  estimatedAnnualImpactUsd: number;
  topInsightId: string;
  topInsightTitle: string;
  owningTeam: string;
}[] {
  const grouped = new Map<string, Insight[]>();

  for (const insight of db.insights.all()) {
    const list = grouped.get(insight.type) ?? [];
    list.push(insight);
    grouped.set(insight.type, list);
  }

  return [...grouped.entries()]
    .map(([type, insights]) => {
      const top = [...insights].sort((a, b) => b.priorityScore - a.priorityScore)[0]!;
      return {
        type,
        insightCount: insights.length,
        observationCount: insights.reduce((a, i) => a + i.observationCount, 0),
        estimatedAnnualImpactUsd: insights.reduce((a, i) => a + (i.estimatedAnnualImpactUsd ?? 0), 0),
        topInsightId: top.insightId,
        topInsightTitle: top.title,
        owningTeam: top.owningTeam,
      };
    })
    .sort((a, b) => b.estimatedAnnualImpactUsd - a.estimatedAnnualImpactUsd);
}

/* -------------------------------------------------------------------------- */
/* Sustainability rollup                                                       */
/* -------------------------------------------------------------------------- */

export function getSustainabilitySummary() {
  const records = db.sustainabilityRecords.all();

  const byGrade = records.reduce<Record<string, number>>((acc, r) => {
    acc[r.grade] = (acc[r.grade] ?? 0) + 1;
    return acc;
  }, {});

  const byDisposition = records.reduce<Record<string, number>>((acc, r) => {
    acc[r.disposition] = (acc[r.disposition] ?? 0) + 1;
    return acc;
  }, {});

  const totalPrevented = records.reduce((a, r) => a + r.co2PreventedKg, 0);

  return {
    // Baseline plus this session's live records, so the number is never zero.
    totalCo2PreventedKg: round2(db.kpiBaseline.co2PreventedKg + totalPrevented),
    liveCo2PreventedKg: round2(totalPrevented),
    totalFootprintKg: round2(records.reduce((a, r) => a + r.footprintKg, 0)),
    packagingWasteAvoidedKg: round2(records.reduce((a, r) => a + r.packagingWasteAvoidedGrams, 0) / 1000),
    recoveredValueUsd: round2(records.reduce((a, r) => a + r.recoveredValueUsd, 0)),
    avgSustainabilityScore: records.length ? round2(records.reduce((a, r) => a + r.sustainabilityScore, 0) / records.length) : null,
    avgCircularityScore: records.length ? round2(records.reduce((a, r) => a + r.circularityScore, 0) / records.length) : null,
    recordCount: records.length,
    greenOptionDeclinedCount: records.filter((r) => r.greenOptionDeclined).length,
    noGreenerOptionCount: records.filter((r) => !r.greenerAlternativeExisted).length,
    byGrade,
    byDisposition,
    equivalents: {
      carKmAvoided: round2((db.kpiBaseline.co2PreventedKg + totalPrevented) / 0.17),
      treesPlantedEquivalent: round2((db.kpiBaseline.co2PreventedKg + totalPrevented) / 21.8),
    },
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
