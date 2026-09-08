/**
 * RESOLUTION PLANNING RULES — pure functions.
 *
 * OWNER: <assign>
 * STATUS: wireframe. Candidate generation and the scoring skeleton are in
 * place; the per-dimension scoring curves are marked TODO.
 *
 * The four steps mirror the contract: generate -> score -> weight -> goodwill.
 */
import { newId } from '../../core/ids';
import type { CaseContext } from '../../domain/case-context.schema';
import type { ReturnIntent } from '../../domain/return.schema';
import type { GoodwillGrant, ResolutionOption, ResolutionType } from '../../domain/resolution.schema';
import type { EligibilityOutput } from '../eligibility/eligibility.contract';
import type { SentimentOutput } from '../sentiment/sentiment.contract';
import type { DecisionWeights } from './resolution.contract';

/** Default trade-off weights. Must sum to 1.0. */
export const DEFAULT_WEIGHTS = { satisfaction: 0.35, cost: 0.3, retention: 0.25, sustainability: 0.1 } as const;

/** Baseline satisfaction by resolution type, before adjustments (0-100). */
export const BASE_SATISFACTION: Record<ResolutionType, number> = {
  REPLACEMENT: 90,
  KEEP_AND_REFUND: 95,
  REFUND: 75,
  EXCHANGE: 80,
  STORE_CREDIT: 60,
  REPAIR: 50,
  PARTIAL_REFUND: 45,
  ESCALATE: 35,
  DENY: 10,
};

/** Provisional sustainability ranking of resolution TYPES (0-100). The
 *  Sustainability Agent refines the logistics side, not this. */
export const BASE_SUSTAINABILITY: Record<ResolutionType, number> = {
  KEEP_AND_REFUND: 100, // nothing moves at all
  PARTIAL_REFUND: 95,
  REPAIR: 85,
  REPLACEMENT: 55,
  EXCHANGE: 55,
  REFUND: 60,
  STORE_CREDIT: 65,
  DENY: 90,
  ESCALATE: 70,
};

/** Hours to resolution by type — feeds the SLA promise. */
export const BASE_SLA_HOURS: Record<ResolutionType, number> = {
  KEEP_AND_REFUND: 2,
  REFUND: 72,
  STORE_CREDIT: 2,
  REPLACEMENT: 48,
  EXCHANGE: 72,
  PARTIAL_REFUND: 4,
  REPAIR: 240,
  ESCALATE: 24,
  DENY: 1,
};

/* -------------------------------------------------------------------------- */
/* STEP 1 — candidate generation                                               */
/* -------------------------------------------------------------------------- */

export interface FeasibilityVerdict {
  type: ResolutionType;
  feasible: boolean;
  reason: string | null;
}

/**
 * Decides which resolution types are even possible for this case.
 * TODO(owner): add EXCHANGE variant lookup once the product fixture carries
 * variant relationships.
 */
export function assessFeasibility(
  ctx: CaseContext,
  intent: ReturnIntent,
  eligibility: EligibilityOutput,
): FeasibilityVerdict[] {
  const itemValue = ctx.orderItem.unitPriceUsd * intent.quantity;
  const t = ctx.policy.thresholds;
  // Rough reverse-shipping estimate; the Logistics Agent computes the real one.
  const estimatedReverseShippingUsd = 6 + ctx.product.dimensions.weightKg * 1.5;
  const denied = eligibility.decision === 'DENIED';

  const verdicts: FeasibilityVerdict[] = [
    {
      type: 'REPLACEMENT',
      feasible: !denied && ctx.inventory.availableUnits > 0,
      reason:
        denied ? 'Return was not approved.'
        : ctx.inventory.availableUnits > 0 ? null
        : `No units of ${ctx.product.sku} in stock (restock ETA ${ctx.inventory.restockEtaDays ?? 'unknown'} days).`,
    },
    {
      type: 'REFUND',
      feasible: !denied && ctx.order.paymentInstrumentValid,
      reason: denied ? 'Return was not approved.' : ctx.order.paymentInstrumentValid ? null : 'Original payment instrument is no longer valid.',
    },
    {
      type: 'STORE_CREDIT',
      // Always available — the universal fallback, and the goodwill vehicle
      // when a return is denied but the customer is worth keeping.
      feasible: true,
      reason: null,
    },
    {
      type: 'KEEP_AND_REFUND',
      feasible:
        !denied &&
        (itemValue <= t.keepAndRefundMaxItemUsd || estimatedReverseShippingUsd >= itemValue * t.keepAndRefundCostRatio),
      reason:
        denied ? 'Return was not approved.'
        : itemValue <= t.keepAndRefundMaxItemUsd || estimatedReverseShippingUsd >= itemValue * t.keepAndRefundCostRatio
          ? null
          : `Return shipping ($${estimatedReverseShippingUsd.toFixed(2)}) is not disproportionate to item value ($${itemValue.toFixed(2)}).`,
    },
    {
      type: 'REPAIR',
      feasible: !denied && ctx.product.repairable && ctx.product.warrantyMonths > 0,
      reason: denied ? 'Return was not approved.' : ctx.product.repairable ? null : 'This product is not serviceable.',
    },
    {
      type: 'EXCHANGE',
      feasible: !denied && ctx.inventory.availableUnits > 0 && intent.reason === 'SIZE_FIT_ISSUE',
      reason: 'Exchange applies only to size/fit returns with stock available.',
    },
    {
      type: 'PARTIAL_REFUND',
      feasible: !denied && ['USED_GOOD', 'OPENED_LIKE_NEW'].includes(intent.reportedCondition),
      reason: 'Partial refund requires the item to remain usable.',
    },
    { type: 'DENY', feasible: denied, reason: denied ? null : 'Return is eligible, so denial does not apply.' },
    { type: 'ESCALATE', feasible: true, reason: null },
  ];

  return verdicts;
}

/* -------------------------------------------------------------------------- */
/* STEP 2 — scoring                                                            */
/* -------------------------------------------------------------------------- */

/** Full cost of one resolution type. TODO(owner): refine the cost model. */
export function estimateCost(
  type: ResolutionType,
  ctx: CaseContext,
  intent: ReturnIntent,
  eligibility: EligibilityOutput,
): { total: number; parts: Record<string, number> } {
  const itemValue = ctx.orderItem.unitPriceUsd * intent.quantity;
  const refundable = eligibility.refundableAmountUsd;
  const unitCost = ctx.product.unitCostUsd * intent.quantity;
  const reverseShipping = 6 + ctx.product.dimensions.weightKg * 1.5;
  const outboundShipping = 8;
  const processing = 4;
  // Restockable items recover most of their value; damaged ones recover little.
  const recoveryRatio = intent.reportedCondition === 'NEW_UNOPENED' ? 0.9 : ctx.product.sustainability.refurbishable ? 0.45 : 0.05;

  const parts: Record<string, number> = {};
  switch (type) {
    case 'REFUND':
      parts.refund = refundable;
      parts.reverseShipping = reverseShipping;
      parts.processing = processing;
      parts.recovered = -(unitCost * recoveryRatio);
      break;
    case 'REPLACEMENT':
      parts.goods = unitCost;
      parts.outboundShipping = outboundShipping;
      parts.reverseShipping = reverseShipping;
      parts.processing = processing;
      parts.recovered = -(unitCost * recoveryRatio);
      break;
    case 'EXCHANGE':
      parts.goods = unitCost;
      parts.outboundShipping = outboundShipping;
      parts.reverseShipping = reverseShipping;
      parts.processing = processing;
      parts.recovered = -(unitCost * recoveryRatio);
      break;
    case 'STORE_CREDIT':
      // Credit is issued at a small uplift but stays inside the business.
      parts.storeCredit = refundable * 1.05 * 0.6;
      parts.reverseShipping = reverseShipping;
      parts.processing = processing;
      parts.recovered = -(unitCost * recoveryRatio);
      break;
    case 'KEEP_AND_REFUND':
      // No reverse logistics at all — often the cheapest AND greenest.
      parts.refund = refundable;
      break;
    case 'PARTIAL_REFUND':
      parts.refund = refundable * 0.4;
      break;
    case 'REPAIR':
      parts.repair = unitCost * 0.3;
      parts.reverseShipping = reverseShipping;
      parts.outboundShipping = outboundShipping;
      break;
    case 'DENY':
      break;
    case 'ESCALATE':
      parts.humanHandling = 18;
      break;
  }

  const total = Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 100) / 100;
  return { total: Math.max(0, total), parts };
}

/** TODO(owner): tune. Currently: base score + request match + speed bonus. */
export function scoreSatisfaction(type: ResolutionType, intent: ReturnIntent): number {
  let score = BASE_SATISFACTION[type];
  const requested = intent.requestedOutcome;
  if (requested !== 'UNSPECIFIED' && requested === typeToRequestedOutcome(type)) score += 15;
  // Faster resolutions feel better.
  score += Math.max(-10, 10 - BASE_SLA_HOURS[type] / 12);
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Higher = cheaper. Normalized against the most expensive candidate. */
export function scoreCost(costUsd: number, maxCostUsd: number): number {
  if (maxCostUsd <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(100 - (costUsd / maxCostUsd) * 100)));
}

/** TODO(owner): tie to the gesture model's expectedChurnReduction. */
export function scoreRetention(type: ResolutionType, sentiment: SentimentOutput): number {
  const generosity = BASE_SATISFACTION[type];
  const valueMultiplier = { STANDARD: 0.8, HIGH: 1.0, VIP: 1.2 }[sentiment.customerValue.valueBand];
  const riskMultiplier = 1 + sentiment.churnRisk.score / 200;
  return Math.max(0, Math.min(100, Math.round(generosity * valueMultiplier * riskMultiplier * 0.75)));
}

function typeToRequestedOutcome(type: ResolutionType): string {
  const map: Partial<Record<ResolutionType, string>> = {
    REFUND: 'REFUND',
    KEEP_AND_REFUND: 'REFUND',
    PARTIAL_REFUND: 'REFUND',
    REPLACEMENT: 'REPLACEMENT',
    EXCHANGE: 'EXCHANGE',
    STORE_CREDIT: 'STORE_CREDIT',
    REPAIR: 'REPAIR',
  };
  return map[type] ?? 'UNSPECIFIED';
}

/* -------------------------------------------------------------------------- */
/* STEP 3 — weighting                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Shifts weight from cost to satisfaction proportionally to the sentiment
 * agent's boost. This is the single lever that makes a VIP's outcome better.
 */
export function computeWeights(sentiment: SentimentOutput): DecisionWeights {
  const boost = sentiment.retention.satisfactionWeightBoost; // 0..3
  const shift = Math.min(0.2, boost * 0.07);

  const satisfaction = DEFAULT_WEIGHTS.satisfaction + shift;
  const cost = Math.max(0.05, DEFAULT_WEIGHTS.cost - shift);
  const retention = DEFAULT_WEIGHTS.retention;
  const sustainability = DEFAULT_WEIGHTS.sustainability;
  const sum = satisfaction + cost + retention + sustainability;

  return {
    satisfaction: round4(satisfaction / sum),
    cost: round4(cost / sum),
    retention: round4(retention / sum),
    sustainability: round4(sustainability / sum),
    adjustmentReason:
      shift > 0
        ? `Satisfaction weighted +${(shift * 100).toFixed(0)}pp over cost: ${sentiment.complaintSeverity} severity, ${sentiment.customerValue.valueBand} value band.`
        : null,
  };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function weightedScore(
  option: Pick<ResolutionOption, 'satisfactionScore' | 'costScore' | 'retentionScore' | 'sustainabilityScore'>,
  w: DecisionWeights,
): number {
  return Math.round(
    option.satisfactionScore * w.satisfaction +
      option.costScore * w.cost +
      option.retentionScore * w.retention +
      option.sustainabilityScore * w.sustainability,
  );
}

/* -------------------------------------------------------------------------- */
/* STEP 4 — goodwill                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Converts the Sentiment Agent's recommended gestures into actual grants,
 * respecting the stated budget. Returns the grants plus whether the budget was
 * exceeded (which forces human approval).
 */
export function grantGoodwill(
  sentiment: SentimentOutput,
  ctx: CaseContext,
): { grants: GoodwillGrant[]; exceeded: boolean } {
  if (!sentiment.retention.warranted) return { grants: [], exceeded: false };

  const budget = sentiment.retention.maxGoodwillBudgetUsd;
  let spent = 0;
  const grants: GoodwillGrant[] = [];

  for (const g of sentiment.retention.recommendedGestures) {
    if (spent + g.estimatedCostUsd > budget) continue;
    spent += g.estimatedCostUsd;
    grants.push({
      grantId: newId('goodwill'),
      type: g.type === 'UPGRADED_RESOLUTION' ? 'BONUS_POINTS' : g.type,
      value: g.value,
      unit: g.unit,
      costUsd: g.estimatedCostUsd,
      code: g.type === 'DISCOUNT_CODE' ? `COSMIC-${Math.floor(Math.random() * 90000 + 10000)}` : null,
      rationale: g.rationale,
      expiresAt: null,
    });
  }

  // VIP override: allow one gesture beyond budget, but flag it for approval.
  const exceeded = sentiment.customerValue.valueBand === 'VIP' && spent > budget;
  return { grants, exceeded };
}

export function customerFacingSummary(type: ResolutionType, ctx: CaseContext, grants: GoodwillGrant[]): string {
  const points = grants.find((g) => g.unit === 'POINTS')?.value;
  const suffix = points ? ` We've also added ${points} Cosmic Rewards points for the inconvenience.` : '';
  switch (type) {
    case 'REPLACEMENT':
      return `We've approved a replacement ${ctx.product.name}.${suffix}`;
    case 'REFUND':
      return `We've approved a full refund for your ${ctx.product.name}.${suffix}`;
    case 'KEEP_AND_REFUND':
      return `We've refunded your ${ctx.product.name} — no need to send it back.${suffix}`;
    case 'STORE_CREDIT':
      return `We've issued Cosmic store credit for your ${ctx.product.name}.${suffix}`;
    case 'EXCHANGE':
      return `We've approved an exchange for your ${ctx.product.name}.${suffix}`;
    case 'REPAIR':
      return `We've arranged a warranty repair for your ${ctx.product.name}.${suffix}`;
    case 'PARTIAL_REFUND':
      return `We've issued a partial refund and you can keep your ${ctx.product.name}.${suffix}`;
    case 'ESCALATE':
      return `A Cosmic specialist is reviewing your ${ctx.product.name} return and will be in touch shortly.`;
    case 'DENY':
      return `Unfortunately we're not able to accept this return.${suffix}`;
  }
}
