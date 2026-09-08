/**
 * DATA MODEL: Insight
 *
 * Produced by the Insights Agent. An Insight is a *decision-ready* finding:
 * it names the pattern, cites its evidence, quantifies the impact, and assigns
 * an owning team with concrete recommended actions. Anything that cannot do
 * all four is a `caseSignal`, not an Insight.
 */
import { z } from 'zod';
import { ConfidenceSchema, IsoDateTimeSchema, RegionCodeSchema, ScoreSchema } from './common.schema';

export const InsightTypeSchema = z.enum([
  /** Same SKU failing the same way repeatedly. */
  'PRODUCT_DEFECT_TREND',
  /** Damage occurring in transit -> packaging/carrier problem. */
  'PACKAGING_FAILURE',
  /** Return rate concentrated in a region. */
  'REGIONAL_PATTERN',
  /** Customers tripping over a policy rule (window, category). */
  'POLICY_FRICTION',
  /** A supplier's batch underperforming. */
  'SUPPLIER_QUALITY',
  /** Listing/photos misleading customers. */
  'CATALOG_ACCURACY',
  /** Sizing guidance failing. */
  'SIZING_GUIDANCE',
  /** Coordinated or repeat abusive returns. */
  'FRAUD_PATTERN',
  /** Reverse-logistics inefficiency. */
  'LOGISTICS_INEFFICIENCY',
  /** A greener path is systematically available but unused. */
  'SUSTAINABILITY_OPPORTUNITY',
  /** Support experience gap. */
  'CX_FRICTION',
]);
export type InsightType = z.infer<typeof InsightTypeSchema>;

export const InsightSeveritySchema = z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type InsightSeverity = z.infer<typeof InsightSeveritySchema>;

export const OwningTeamSchema = z.enum([
  'PRODUCT',
  'MERCHANDISING',
  'SUPPLY_CHAIN',
  'PACKAGING',
  'CUSTOMER_EXPERIENCE',
  'POLICY_LEGAL',
  'SUSTAINABILITY',
  'FRAUD_RISK',
  'MARKETING',
]);
export type OwningTeam = z.infer<typeof OwningTeamSchema>;

/** A single case's contribution to the trend pool. Lightweight; emitted on
 *  every run even when no full Insight crosses the reporting threshold. */
export const CaseSignalSchema = z.object({
  signalType: InsightTypeSchema,
  sku: z.string().nullable().default(null),
  category: z.string().nullable().default(null),
  regionCode: RegionCodeSchema.nullable().default(null),
  /** 0-1 how strongly this case evidences the pattern. */
  strength: z.number().min(0).max(1),
  note: z.string(),
});
export type CaseSignal = z.infer<typeof CaseSignalSchema>;

/** Quantified backing for an insight — what makes it credible. */
export const InsightEvidenceSchema = z.object({
  metric: z.string().describe('e.g. "damaged_on_arrival_rate"'),
  value: z.number(),
  unit: z.string().describe('e.g. "%", "returns", "USD"'),
  /** Comparison point: previous period, category average, etc. */
  comparisonValue: z.number().nullable().default(null),
  comparisonLabel: z.string().nullable().default(null),
  /** Percentage change vs. comparison. */
  deltaPct: z.number().nullable().default(null),
  sampleSize: z.number().int().nonnegative(),
  windowDays: z.number().int().positive(),
  /** Case IDs backing this metric — clickable in the UI. */
  supportingCaseIds: z.array(z.string()).default([]),
});
export type InsightEvidence = z.infer<typeof InsightEvidenceSchema>;

export const RecommendedActionSchema = z.object({
  actionId: z.string(),
  description: z.string(),
  owningTeam: OwningTeamSchema,
  effort: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  expectedImpact: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  /** Annualized USD impact if actioned. Drives the ROI slide. */
  estimatedAnnualSavingUsd: z.number().nonnegative().nullable().default(null),
  /** e.g. "Reduce smartwatch DOA rate by 40%". */
  successMetric: z.string(),
});
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

export const InsightStatusSchema = z.enum(['NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ACTIONED', 'DISMISSED']);
export type InsightStatus = z.infer<typeof InsightStatusSchema>;

export const InsightSchema = z.object({
  insightId: z.string().describe('e.g. INS-000001'),
  type: InsightTypeSchema,
  severity: InsightSeveritySchema,
  status: InsightStatusSchema.default('NEW'),

  title: z.string().describe('Headline, <=80 chars, executive-readable'),
  summary: z.string().describe('2-3 sentence narrative'),

  /** Scope of the finding — any subset may be null. */
  sku: z.string().nullable().default(null),
  productName: z.string().nullable().default(null),
  category: z.string().nullable().default(null),
  regionCode: RegionCodeSchema.nullable().default(null),
  supplierId: z.string().nullable().default(null),

  evidence: z.array(InsightEvidenceSchema).min(1),
  recommendedActions: z.array(RecommendedActionSchema).default([]),
  owningTeam: OwningTeamSchema,

  /** Statistical confidence in the pattern (not the agent's mood). */
  confidence: ConfidenceSchema,
  /** 0-100 composite of severity x confidence x impact, used for ranking. */
  priorityScore: ScoreSchema,
  estimatedAnnualImpactUsd: z.number().nullable().default(null),

  /** Case IDs that triggered/updated this insight. */
  contributingCaseIds: z.array(z.string()).default([]),
  firstObservedAt: IsoDateTimeSchema,
  lastObservedAt: IsoDateTimeSchema,
  observationCount: z.number().int().positive().default(1),

  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Insight = z.infer<typeof InsightSchema>;

/* ------------------------------ Analytics --------------------------------- */

/** Executive KPI snapshot — the dashboard payload for persona "Finley". */
export const KpiSnapshotSchema = z.object({
  windowDays: z.number().int().positive(),
  generatedAt: IsoDateTimeSchema,

  totalReturns: z.number().int().nonnegative(),
  /** Returns / orders, as a percentage. */
  returnRatePct: z.number(),
  /** Mean hours from intake to resolved — the PRD's TAT metric. */
  avgTurnaroundHours: z.number().nonnegative(),
  /** Share of cases closed with no human touch. */
  automationRatePct: z.number().min(0).max(100),
  /** Support tickets avoided by automation. */
  ticketDeflectionPct: z.number().min(0).max(100),

  avgCostPerReturnUsd: z.number().nonnegative(),
  totalReturnCostUsd: z.number().nonnegative(),
  /** Revenue preserved by retention-oriented resolutions. */
  retainedRevenueUsd: z.number().nonnegative(),
  repeatPurchaseRatePct: z.number().min(0).max(100),

  avgCsat: z.number().min(0).max(5),
  nps: z.number().min(-100).max(100),

  co2PreventedKg: z.number().nonnegative(),
  sustainableReturnPct: z.number().min(0).max(100),
  packagingWasteAvoidedKg: z.number().nonnegative(),

  escalationRatePct: z.number().min(0).max(100),
  insightsGenerated: z.number().int().nonnegative(),
  insightsActioned: z.number().int().nonnegative(),

  /** Signed change vs. the previous equivalent window, for trend arrows. */
  deltas: z.record(z.string(), z.number()).default({}),
});
export type KpiSnapshot = z.infer<typeof KpiSnapshotSchema>;

/** Generic time series for chart endpoints. */
export const TrendPointSchema = z.object({
  bucket: z.string().describe('ISO date or label, e.g. "2026-09-01"'),
  value: z.number(),
  secondaryValue: z.number().nullable().default(null),
  label: z.string().nullable().default(null),
});
export type TrendPoint = z.infer<typeof TrendPointSchema>;

export const TrendSeriesSchema = z.object({
  metric: z.string(),
  unit: z.string(),
  granularity: z.enum(['DAY', 'WEEK', 'MONTH']),
  points: z.array(TrendPointSchema),
});
export type TrendSeries = z.infer<typeof TrendSeriesSchema>;
