/**
 * INSIGHTS RULES — pure functions.
 *
 * OWNER: <assign>
 * STATUS: wireframe. Signal extraction is implemented; the promotion
 * thresholds and impact model are the tuning work.
 */
import { newId } from '../../core/ids';
import type { CaseContext } from '../../domain/case-context.schema';
import type { CaseSignal, Insight, InsightSeverity, InsightType, RecommendedAction } from '../../domain/insight.schema';
import type { ReturnIntent } from '../../domain/return.schema';
import type { EligibilityOutput } from '../eligibility/eligibility.contract';
import type { SentimentOutput } from '../sentiment/sentiment.contract';
import type { ResolutionOutput } from '../resolution/resolution.contract';
import type { LogisticsOutput } from '../logistics/logistics.contract';
import type { SustainabilityOutput } from '../sustainability/sustainability.contract';

/**
 * PROMOTION THRESHOLDS — the guard that keeps "actionable insights" a
 * meaningful KPI. A signal must clear these to become an Insight.
 * TODO(owner): move to a fixture so analytics can tune without a deploy.
 */
export const PROMOTION = {
  /** Minimum supporting cases in the window. */
  minSampleSize: 3,
  /** Minimum period-over-period spike, in percent. */
  minSpikePct: 50,
  /** SKU return rate as a multiple of its category rate. */
  categoryRateMultiple: 2,
  /** Region return rate excess over global, in percentage points. */
  regionExcessPct: 5,
} as const;

/* -------------------------------------------------------------------------- */
/* STEP 1 — signal extraction                                                  */
/* -------------------------------------------------------------------------- */

export interface SignalInputs {
  intent: ReturnIntent;
  context: CaseContext;
  eligibility: EligibilityOutput | null;
  sentiment: SentimentOutput | null;
  resolution: ResolutionOutput | null;
  logistics: LogisticsOutput | null;
  sustainability: SustainabilityOutput | null;
}

export function extractSignals(i: SignalInputs): CaseSignal[] {
  const { intent, context } = i;
  const signals: CaseSignal[] = [];
  const scope = {
    sku: context.product.sku,
    category: context.product.category as string,
    regionCode: context.regionCode,
  };

  const isDamage = ['DAMAGED_ON_ARRIVAL', 'DEFECTIVE'].includes(intent.reason);
  const deliveryScanShowedDamage = ['PACKAGE_DAMAGED', 'CARRIER_EXCEPTION'].includes(context.order.deliveryCondition);

  /* -- product defect vs packaging failure ------------------------------- */
  // The valuable distinction: damage inside INTACT packaging means the
  // packaging under-protected the item, not that the carrier mishandled it.
  if (isDamage && deliveryScanShowedDamage) {
    signals.push({
      signalType: 'PACKAGING_FAILURE',
      ...scope,
      strength: 0.9,
      note: `Item arrived damaged and the delivery scan recorded package damage — likely transit handling or insufficient outer protection.`,
    });
  } else if (isDamage) {
    signals.push({
      signalType: 'PRODUCT_DEFECT_TREND',
      ...scope,
      strength: 0.85,
      note: `Item arrived damaged inside intact packaging — points to a product or inner-packaging defect rather than carrier handling.`,
    });
    signals.push({
      signalType: 'PACKAGING_FAILURE',
      ...scope,
      strength: 0.6,
      note: 'Inner packaging did not protect the unit despite an intact outer box.',
    });
  }

  /* -- policy friction ---------------------------------------------------- */
  if (i.eligibility) {
    const waived = i.eligibility.ruleTrace.filter((r) => r.outcome === 'WAIVED');
    const failed = i.eligibility.ruleTrace.filter((r) => r.outcome === 'FAIL');
    if (i.eligibility.decision === 'DENIED' && failed.length > 0) {
      signals.push({
        signalType: 'POLICY_FRICTION',
        ...scope,
        strength: 0.8,
        note: `Return denied by ${failed.map((r) => r.ruleId).join(', ')} — a candidate for policy review.`,
      });
    }
    if (waived.length > 0) {
      // A waiver means the written policy was wrong for this case.
      signals.push({
        signalType: 'POLICY_FRICTION',
        ...scope,
        strength: 0.5,
        note: `${waived.length} policy rule(s) had to be waived (${waived.map((r) => r.ruleId).join(', ')}) — the written policy did not fit this case.`,
      });
    }
    if (i.eligibility.fraud.riskLevel === 'HIGH') {
      signals.push({
        signalType: 'FRAUD_PATTERN',
        ...scope,
        strength: 0.95,
        note: `Return-abuse signals: ${i.eligibility.fraud.flags.join(', ')}.`,
      });
    }
  }

  /* -- regional -------------------------------------------------------- */
  const h = context.historicalAggregates;
  if (h.regionReturnRatePct - h.categoryReturnRatePct >= PROMOTION.regionExcessPct) {
    signals.push({
      signalType: 'REGIONAL_PATTERN',
      ...scope,
      strength: 0.7,
      note: `${context.regionCode} returns run ${(h.regionReturnRatePct - h.categoryReturnRatePct).toFixed(1)}pp above the category rate.`,
    });
  }

  /* -- CX / retention -------------------------------------------------- */
  if (i.sentiment && (i.sentiment.churnRisk.band === 'HIGH' || i.sentiment.churnRisk.band === 'CRITICAL')) {
    signals.push({
      signalType: 'CX_FRICTION',
      ...scope,
      strength: 0.75,
      note: `Churn risk ${i.sentiment.churnRisk.score}/100 with $${i.sentiment.customerValue.revenueAtRiskUsd.toFixed(0)} of lifetime value at risk.`,
    });
  }

  /* -- logistics efficiency -------------------------------------------- */
  const itemValue = context.orderItem.unitPriceUsd;
  if (i.logistics?.required && itemValue > 0 && i.logistics.estimatedCostUsd / itemValue > 0.4) {
    signals.push({
      signalType: 'LOGISTICS_INEFFICIENCY',
      ...scope,
      strength: 0.65,
      note: `Reverse logistics cost $${i.logistics.estimatedCostUsd.toFixed(2)} against an item value of $${itemValue.toFixed(2)} (${((i.logistics.estimatedCostUsd / itemValue) * 100).toFixed(0)}%).`,
    });
  }

  /* -- sustainability -------------------------------------------------- */
  if (i.sustainability?.record.greenOptionDeclined) {
    signals.push({
      signalType: 'SUSTAINABILITY_OPPORTUNITY',
      ...scope,
      strength: 0.6,
      note: `A lower-carbon route existed (${i.sustainability.tradeoff.co2SavingKg}kg CO2 saving) but was not adopted: ${i.sustainability.tradeoff.reason}`,
    });
  }

  /* -- catalogue / sizing ---------------------------------------------- */
  if (intent.reason === 'NOT_AS_DESCRIBED') {
    signals.push({ signalType: 'CATALOG_ACCURACY', ...scope, strength: 0.7, note: 'Customer reported the item did not match its listing.' });
  }
  if (intent.reason === 'SIZE_FIT_ISSUE') {
    signals.push({ signalType: 'SIZING_GUIDANCE', ...scope, strength: 0.7, note: 'Size/fit return — sizing guidance may be inadequate.' });
  }

  return signals;
}

/* -------------------------------------------------------------------------- */
/* STEP 2 — trending and promotion                                             */
/* -------------------------------------------------------------------------- */

export function computeSpikePct(current: number, previous: number): number {
  return Math.round(((current - previous) / Math.max(1, previous)) * 100);
}

/**
 * The gate. A signal becomes an Insight only with enough evidence AND enough
 * materiality. Returning false is the normal, correct outcome for most cases.
 */
export function shouldPromote(signal: CaseSignal, ctx: CaseContext): { promote: boolean; reason: string } {
  const h = ctx.historicalAggregates;
  const spikePct = computeSpikePct(h.skuReturnsLast30Days, h.skuReturnsPrevious30Days);
  const sampleSize = h.skuReturnsLast30Days;

  if (sampleSize < PROMOTION.minSampleSize) {
    return { promote: false, reason: `Only ${sampleSize} return(s) for this SKU in 30 days; below the ${PROMOTION.minSampleSize}-case minimum.` };
  }

  const rateMultiple = h.categoryReturnRatePct > 0 ? h.skuReturnRatePct / h.categoryReturnRatePct : 0;
  const material = spikePct >= PROMOTION.minSpikePct || rateMultiple >= PROMOTION.categoryRateMultiple;

  if (!material) {
    return {
      promote: false,
      reason: `Return volume up ${spikePct}% and ${rateMultiple.toFixed(1)}x the category rate — below the ${PROMOTION.minSpikePct}% / ${PROMOTION.categoryRateMultiple}x promotion thresholds.`,
    };
  }

  // Fraud always promotes: the risk team needs the queue item regardless.
  if (signal.signalType === 'FRAUD_PATTERN') return { promote: true, reason: 'Fraud signals always promote.' };

  return {
    promote: true,
    reason: `${sampleSize} returns in 30 days, up ${spikePct}%, at ${rateMultiple.toFixed(1)}x the category rate.`,
  };
}

/* -------------------------------------------------------------------------- */
/* STEP 3 — insight construction                                               */
/* -------------------------------------------------------------------------- */

export function severityFor(signal: CaseSignal, spikePct: number): InsightSeverity {
  const s = signal.strength;
  if (s >= 0.85 && spikePct >= 100) return 'CRITICAL';
  if (s >= 0.75 && spikePct >= 50) return 'HIGH';
  if (s >= 0.6) return 'MEDIUM';
  if (s >= 0.4) return 'LOW';
  return 'INFO';
}

/** TODO(owner): replace with a real impact model using margin and volume. */
export function estimateAnnualImpactUsd(ctx: CaseContext, signal: CaseSignal): number {
  const monthlyReturns = ctx.historicalAggregates.skuReturnsLast30Days;
  const costPerReturn = ctx.orderItem.unitPriceUsd * 0.35 + 10;
  // Assume a fix addresses ~60% of the affected volume.
  return Math.round(monthlyReturns * 12 * costPerReturn * 0.6);
}

/** Team ownership per signal type. */
export const OWNER_BY_TYPE: Record<InsightType, RecommendedAction['owningTeam']> = {
  PRODUCT_DEFECT_TREND: 'PRODUCT',
  PACKAGING_FAILURE: 'PACKAGING',
  REGIONAL_PATTERN: 'SUPPLY_CHAIN',
  POLICY_FRICTION: 'POLICY_LEGAL',
  SUPPLIER_QUALITY: 'SUPPLY_CHAIN',
  CATALOG_ACCURACY: 'MERCHANDISING',
  SIZING_GUIDANCE: 'MERCHANDISING',
  FRAUD_PATTERN: 'FRAUD_RISK',
  LOGISTICS_INEFFICIENCY: 'SUPPLY_CHAIN',
  SUSTAINABILITY_OPPORTUNITY: 'SUSTAINABILITY',
  CX_FRICTION: 'CUSTOMER_EXPERIENCE',
};

/**
 * Builds a full Insight. Every one MUST carry evidence and at least one action
 * with an owner and a success metric — that is what makes it "actionable".
 * TODO(owner): expand the action playbook per signal type.
 */
export function buildInsight(signal: CaseSignal, ctx: CaseContext, caseId: string, promotionReason: string): Insight {
  const h = ctx.historicalAggregates;
  const spikePct = computeSpikePct(h.skuReturnsLast30Days, h.skuReturnsPrevious30Days);
  const severity = severityFor(signal, spikePct);
  const owningTeam = OWNER_BY_TYPE[signal.signalType];
  const impact = estimateAnnualImpactUsd(ctx, signal);

  return {
    insightId: newId('insight'),
    type: signal.signalType,
    severity,
    status: 'NEW',
    title: titleFor(signal, ctx, spikePct),
    summary: `${signal.note} ${promotionReason} Estimated annual exposure $${impact.toLocaleString()}.`,
    sku: signal.sku,
    productName: ctx.product.name,
    category: signal.category,
    regionCode: signal.regionCode,
    supplierId: ctx.product.supplierId,
    evidence: [
      {
        metric: 'sku_returns_30d',
        value: h.skuReturnsLast30Days,
        unit: 'returns',
        comparisonValue: h.skuReturnsPrevious30Days,
        comparisonLabel: 'previous 30 days',
        deltaPct: spikePct,
        sampleSize: h.skuReturnsLast30Days,
        windowDays: 30,
        supportingCaseIds: [caseId],
      },
      {
        metric: 'sku_return_rate_pct',
        value: h.skuReturnRatePct,
        unit: '%',
        comparisonValue: h.categoryReturnRatePct,
        comparisonLabel: `${ctx.product.category} category average`,
        deltaPct: h.categoryReturnRatePct > 0 ? Math.round(((h.skuReturnRatePct - h.categoryReturnRatePct) / h.categoryReturnRatePct) * 100) : null,
        sampleSize: h.totalReturnsLast30Days,
        windowDays: 30,
        supportingCaseIds: [caseId],
      },
    ],
    recommendedActions: actionsFor(signal, ctx, impact),
    owningTeam,
    confidence: Math.min(0.95, signal.strength),
    priorityScore: Math.min(
      100,
      Math.round(signal.strength * 40 + { INFO: 0, LOW: 10, MEDIUM: 25, HIGH: 40, CRITICAL: 60 }[severity]),
    ),
    estimatedAnnualImpactUsd: impact,
    contributingCaseIds: [caseId],
    firstObservedAt: ctx.now,
    lastObservedAt: ctx.now,
    observationCount: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

function titleFor(signal: CaseSignal, ctx: CaseContext, spikePct: number): string {
  switch (signal.signalType) {
    case 'PRODUCT_DEFECT_TREND':
      return `${ctx.product.name} damage-on-arrival returns up ${spikePct}% in 30 days`;
    case 'PACKAGING_FAILURE':
      return `Packaging failing to protect ${ctx.product.name} in transit`;
    case 'POLICY_FRICTION':
      return `Return policy causing friction on ${ctx.product.category.toLowerCase()} returns`;
    case 'FRAUD_PATTERN':
      return `Possible return abuse pattern detected`;
    case 'REGIONAL_PATTERN':
      return `${signal.regionCode} return rate above category average`;
    case 'LOGISTICS_INEFFICIENCY':
      return `Reverse logistics cost disproportionate for ${ctx.product.name}`;
    case 'SUSTAINABILITY_OPPORTUNITY':
      return `Lower-carbon return route available but unused`;
    case 'CX_FRICTION':
      return `High-value customers at churn risk after returns`;
    case 'CATALOG_ACCURACY':
      return `${ctx.product.name} listing may be misleading customers`;
    case 'SIZING_GUIDANCE':
      return `Sizing guidance driving returns in ${ctx.product.category.toLowerCase()}`;
    default:
      return `Return pattern detected for ${ctx.product.name}`;
  }
}

function actionsFor(signal: CaseSignal, ctx: CaseContext, impact: number): RecommendedAction[] {
  const base = { estimatedAnnualSavingUsd: Math.round(impact * 0.6) };
  switch (signal.signalType) {
    case 'PRODUCT_DEFECT_TREND':
      return [
        {
          actionId: newId('event'),
          description: `Open a quality investigation with the supplier for ${ctx.product.sku}, focused on the batch shipped in the last 30 days.`,
          owningTeam: 'PRODUCT',
          effort: 'MEDIUM',
          expectedImpact: 'HIGH',
          ...base,
          successMetric: `Reduce ${ctx.product.name} damage-on-arrival rate by 40% within one quarter.`,
        },
      ];
    case 'PACKAGING_FAILURE':
      return [
        {
          actionId: newId('event'),
          description: `Redesign the inner packaging for ${ctx.product.category.toLowerCase()} shipments to add impact protection.`,
          owningTeam: 'PACKAGING',
          effort: 'MEDIUM',
          expectedImpact: 'HIGH',
          ...base,
          successMetric: 'Cut transit-damage returns for this category by half.',
        },
      ];
    case 'POLICY_FRICTION':
      return [
        {
          actionId: newId('event'),
          description: `Review the ${ctx.product.category.toLowerCase()} return window; rules are being waived or are denying otherwise legitimate requests.`,
          owningTeam: 'POLICY_LEGAL',
          effort: 'LOW',
          expectedImpact: 'MEDIUM',
          ...base,
          successMetric: 'Reduce policy-driven denials and waivers by 30%.',
        },
      ];
    case 'FRAUD_PATTERN':
      return [
        {
          actionId: newId('event'),
          description: 'Review this account for return abuse and decide whether to apply return limits.',
          owningTeam: 'FRAUD_RISK',
          effort: 'LOW',
          expectedImpact: 'MEDIUM',
          ...base,
          successMetric: 'Confirm or clear the account within 48 hours.',
        },
      ];
    default:
      return [
        {
          actionId: newId('event'),
          description: signal.note,
          owningTeam: OWNER_BY_TYPE[signal.signalType],
          effort: 'LOW',
          expectedImpact: 'MEDIUM',
          ...base,
          successMetric: 'Review and decide on a corrective action.',
        },
      ];
  }
}
