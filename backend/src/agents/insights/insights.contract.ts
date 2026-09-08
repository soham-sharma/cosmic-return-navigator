/**
 * ============================================================================
 * AGENT CONTRACT 7/7 — INSIGHTS AGENT
 * ============================================================================
 *
 * PURPOSE
 *   Turn each individual return into organizational intelligence. Emits signals
 *   from this case, updates rolling trends, raises decision-ready Insights with
 *   evidence and recommended actions, and refreshes the executive KPI deltas.
 *
 * PIPELINE POSITION
 *   Stage 5, runs IN PARALLEL with the Communication Agent.
 *   Reads every upstream output. Emits nothing the customer sees, so it can
 *   never delay the customer response — if it fails, the case still completes
 *   successfully (its failure is non-blocking BY DESIGN).
 *
 * DECISION LOGIC (simulated — signal extraction + threshold trending)
 *
 *   STEP 1: EXTRACT CASE SIGNALS (always, every case)
 *     PRODUCT_DEFECT_TREND   reason in {DAMAGED_ON_ARRIVAL, DEFECTIVE} and
 *                            condition in {DAMAGED, NOT_FUNCTIONAL}
 *                            strength scaled by whether the delivery scan also
 *                            showed PACKAGE_DAMAGED.
 *     PACKAGING_FAILURE      damage present BUT delivery condition GOOD ->
 *                            damage happened inside intact packaging, i.e. the
 *                            packaging under-protected the item. This
 *                            distinction is the agent's most valuable trick.
 *     POLICY_FRICTION        eligibility DENIED on window/category, or a rule
 *                            was WAIVED (a waiver means policy was wrong, not
 *                            the customer).
 *     REGIONAL_PATTERN       region return rate exceeds the global rate by a
 *                            configured margin.
 *     FRAUD_PATTERN          eligibility.fraud.riskLevel is HIGH.
 *     SUSTAINABILITY_OPPORTUNITY  a greener option existed and was declined.
 *     LOGISTICS_INEFFICIENCY reverse shipping cost > 40% of item value.
 *     CX_FRICTION            churnRisk HIGH/CRITICAL or human handoff needed.
 *     SIZING_GUIDANCE        reason SIZE_FIT_ISSUE in APPAREL.
 *     CATALOG_ACCURACY       reason NOT_AS_DESCRIBED.
 *
 *   STEP 2: TREND AND THRESHOLD
 *     For each signal, compare against `context.historicalAggregates`:
 *       spikePct = (skuReturnsLast30Days - skuReturnsPrevious30Days)
 *                  / max(1, skuReturnsPrevious30Days) * 100
 *     Promote a signal to a full Insight only when it clears BOTH:
 *       - minimum sample size (default 3 supporting cases), AND
 *       - a materiality threshold (e.g. spikePct >= 50, or SKU return rate
 *         >= 2x its category rate).
 *     Below threshold it stays a `caseSignal` and merely increments counters.
 *     WHY: an "insight" generated from a single return is noise, and the PRD
 *     KPI is *actionable* insights. Guarding the threshold protects that metric.
 *
 *   STEP 3: BUILD THE INSIGHT
 *     Severity from impact x confidence. Every Insight MUST carry:
 *       - >= 1 InsightEvidence with a real metric, sample size and window
 *       - >= 1 RecommendedAction with an owning team and a success metric
 *       - an estimatedAnnualImpactUsd where computable
 *     Deduplicate against existing open Insights: same (type, sku, region) ->
 *     update `lastObservedAt`, append the case ID, bump observationCount and
 *     recompute severity, rather than creating a duplicate.
 *
 *   STEP 4: KPI DELTAS
 *     Contribute this case's numbers to the rolling KPI snapshot: TAT,
 *     cost per return, automation rate, CO2 prevented, deflection.
 *
 * ESCALATION / EDGE CASES
 *   This agent raises NO blocking escalations — ever. It is an observer.
 *   FRAUD_PATTERN signals produce a non-blocking escalation to FRAUD_REVIEW so
 *   the risk team gets a queue item without stalling the customer's return.
 *   MISSING_REQUIRED_DATA when historicalAggregates are empty (cold start) ->
 *   emits signals only, no insights, and says so in the rationale.
 *   On internal failure it returns status FAILED with a rationale; the
 *   orchestrator treats this as non-fatal and still finalizes the case.
 * ============================================================================
 */
import { z } from 'zod';
import { agentResultSchema } from '../../domain/agent.schema';
import { CaseContextSchema } from '../../domain/case-context.schema';
import { ScoreSchema } from '../../domain/common.schema';
import { CaseSignalSchema, InsightSchema, InsightTypeSchema, OwningTeamSchema } from '../../domain/insight.schema';
import { ReturnIntentSchema } from '../../domain/return.schema';
import { EligibilityOutputSchema } from '../eligibility/eligibility.contract';
import { SentimentOutputSchema } from '../sentiment/sentiment.contract';
import { ResolutionOutputSchema } from '../resolution/resolution.contract';
import { LogisticsOutputSchema } from '../logistics/logistics.contract';
import { SustainabilityOutputSchema } from '../sustainability/sustainability.contract';

/* --------------------------------- INPUT ---------------------------------- */

export const InsightsInputSchema = z.object({
  caseId: z.string(),
  intent: ReturnIntentSchema,
  context: CaseContextSchema,
  /** All upstream outputs. Nullable because the pipeline may have halted early
   *  — a denied case is itself a policy-friction signal worth recording. */
  eligibility: EligibilityOutputSchema.nullable(),
  sentiment: SentimentOutputSchema.nullable(),
  resolution: ResolutionOutputSchema.nullable(),
  logistics: LogisticsOutputSchema.nullable(),
  sustainability: SustainabilityOutputSchema.nullable(),
});
export type InsightsInput = z.infer<typeof InsightsInputSchema>;

/* --------------------------------- OUTPUT --------------------------------- */

/** A rolling metric this case moved. */
export const TrendUpdateSchema = z.object({
  metric: z.string().describe('e.g. "sku_damaged_on_arrival_30d"'),
  scope: z.enum(['SKU', 'CATEGORY', 'REGION', 'SUPPLIER', 'GLOBAL']),
  scopeValue: z.string(),
  previousValue: z.number(),
  newValue: z.number(),
  deltaPct: z.number(),
  windowDays: z.number().int().positive(),
  /** True when the delta crossed a materiality threshold. */
  breachedThreshold: z.boolean().default(false),
  thresholdValue: z.number().nullable().default(null),
});
export type TrendUpdate = z.infer<typeof TrendUpdateSchema>;

/** Threshold alert routed to a team's channel. */
export const InsightAlertSchema = z.object({
  alertId: z.string(),
  metric: z.string(),
  observedValue: z.number(),
  thresholdValue: z.number(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  message: z.string(),
  notifyTeams: z.array(OwningTeamSchema).min(1),
});
export type InsightAlert = z.infer<typeof InsightAlertSchema>;

/** This case's contribution to the executive KPI rollup. */
export const KpiContributionSchema = z.object({
  turnaroundHours: z.number().nonnegative().nullable().default(null),
  costUsd: z.number().nonnegative().nullable().default(null),
  co2PreventedKg: z.number().nonnegative().nullable().default(null),
  /** True when the case closed with zero human involvement. */
  fullyAutomated: z.boolean(),
  /** True when automation avoided a support ticket. */
  ticketDeflected: z.boolean(),
  retainedRevenueUsd: z.number().nonnegative().nullable().default(null),
  escalated: z.boolean(),
});
export type KpiContribution = z.infer<typeof KpiContributionSchema>;

export const InsightsOutputSchema = z.object({
  /** Always emitted, one per detected pattern. Cheap, unfiltered. */
  caseSignals: z.array(CaseSignalSchema).default([]),
  /** Only signals that cleared the materiality threshold. Often empty — that
   *  is correct behaviour, not a bug. */
  insights: z.array(InsightSchema).default([]),
  /** Insights that already existed and were reinforced by this case. */
  updatedInsightIds: z.array(z.string()).default([]),

  trendUpdates: z.array(TrendUpdateSchema).default([]),
  alerts: z.array(InsightAlertSchema).default([]),
  kpiContribution: KpiContributionSchema,

  /** Why nothing was promoted, when `insights` is empty. Keeps the UI honest
   *  instead of showing a blank panel. */
  suppressedReason: z.string().nullable().default(null),
  /** Highest priority score among emitted insights, for the UI badge. */
  topPriorityScore: ScoreSchema.nullable().default(null),
  /** One-line executive summary of what this case taught the business. */
  executiveSummary: z.string(),
});
export type InsightsOutput = z.infer<typeof InsightsOutputSchema>;

/* --------------------------------- RESULT --------------------------------- */

export const InsightsResultSchema = agentResultSchema(InsightsOutputSchema);
export type InsightsResult = z.infer<typeof InsightsResultSchema>;
