/**
 * ELIGIBILITY RULES — pure functions, one per rule in the contract.
 *
 * OWNER: <assign> (see docs/workstream_assignments.md)
 *
 * Each function takes only what it needs and returns a `RuleEvaluation`, so it
 * is trivially unit-testable with no orchestrator, no HTTP and no fixtures.
 * The agent composes them; it contains no branching logic of its own.
 *
 * STATUS: wireframe. Bodies marked `TODO` return deterministic placeholders
 * that keep the end-to-end demo running. Replace them one at a time — the
 * agent and the API need no changes.
 */
import type { RuleEvaluation } from '../../domain/common.schema';
import type { CaseContext } from '../../domain/case-context.schema';
import { MERCHANT_FAULT_REASONS, isMerchantFault, type ReturnIntent } from '../../domain/return.schema';
import { daysBetween } from '../../core/clock';
import type { FraudAssessment, WindowAssessment } from './eligibility.contract';

/** Stable rule IDs. Referenced by tests and rendered in the UI trace. */
export const ELIGIBILITY_RULE_IDS = {
  ORDER_MATCH: 'ELG_ORDER_MATCH',
  CATEGORY_RETURNABLE: 'ELG_CATEGORY_RETURNABLE',
  RETURN_WINDOW: 'ELG_RETURN_WINDOW',
  REGIONAL_STATUTE: 'ELG_REGIONAL_STATUTE',
  DAMAGE_ON_ARRIVAL: 'ELG_DAMAGE_ON_ARRIVAL',
  EVIDENCE_REQUIRED: 'ELG_EVIDENCE_REQUIRED',
  FRAUD_SCREEN: 'ELG_FRAUD_SCREEN',
  RESTOCKING_FEE: 'ELG_RESTOCKING_FEE',
} as const;

// Fault attribution is shared domain knowledge (see return.schema.ts), not this
// agent's private rule — Logistics and Communication must reach the same answer.
// Imported for local use here and re-exported so existing callers of
// `rules.isMerchantFault` keep working.
export { MERCHANT_FAULT_REASONS, isMerchantFault };

/* -------------------------------------------------------------------------- */
/* RULE 1 — order / line-item integrity                                        */
/* -------------------------------------------------------------------------- */

export function evaluateOrderMatch(ctx: CaseContext, intent: ReturnIntent): RuleEvaluation {
  const { order, orderItem, customer } = ctx;
  const ownsOrder = order.customerId === customer.customerId;
  const remaining = orderItem.quantity - orderItem.returnedQuantity;
  const hasQuantity = remaining >= intent.quantity;
  const delivered = order.deliveredAt !== null;
  const pass = ownsOrder && hasQuantity && delivered;

  return {
    ruleId: ELIGIBILITY_RULE_IDS.ORDER_MATCH,
    ruleName: 'Order and line item verified',
    outcome: pass ? 'PASS' : 'FAIL',
    detail: pass
      ? `Order ${order.orderId} belongs to this customer, was delivered, and has ${remaining} unit(s) available to return.`
      : !ownsOrder
        ? `Order ${order.orderId} is not associated with customer ${customer.customerId}.`
        : !delivered
          ? `Order ${order.orderId} has not been delivered yet, so a return cannot be started.`
          : `Only ${remaining} unit(s) remain returnable but ${intent.quantity} were requested.`,
    observed: { orderId: order.orderId, ownsOrder, remaining, requested: intent.quantity, delivered },
    waivedBy: null,
  };
}

/* -------------------------------------------------------------------------- */
/* RULE 2 — category returnability                                             */
/* -------------------------------------------------------------------------- */

export function evaluateCategoryReturnable(ctx: CaseContext): RuleEvaluation {
  const { product, policy } = ctx;
  const blocked = !policy.categoryPolicy.returnable || product.isFinalSale || product.isPerishable;

  return {
    ruleId: ELIGIBILITY_RULE_IDS.CATEGORY_RETURNABLE,
    ruleName: 'Product category is returnable',
    outcome: blocked ? 'FAIL' : 'PASS',
    detail: blocked
      ? (policy.categoryPolicy.nonReturnableReason ??
        `${product.name} is not eligible for return (${product.isFinalSale ? 'final sale' : 'restricted category'}).`)
      : `${product.category} items are returnable under policy ${policy.policyId}.`,
    observed: {
      category: product.category,
      returnable: policy.categoryPolicy.returnable,
      isFinalSale: product.isFinalSale,
      isPerishable: product.isPerishable,
    },
    waivedBy: null,
  };
}

/* -------------------------------------------------------------------------- */
/* RULE 3 — return window                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Computes the window assessment. The effective window is precomputed by the
 * orchestrator (`policy.effectiveReturnWindowDays`); this function shows the
 * derivation and decides pass/fail.
 */
export function assessWindow(ctx: CaseContext): WindowAssessment {
  const { order, policy } = ctx;
  // Legally the clock starts at delivery; fall back to order date if the order
  // has no delivery scan.
  const useDelivered = order.deliveredAt !== null;
  const clockStartAt = useDelivered ? order.deliveredAt! : order.placedAt;
  const daysElapsed = daysBetween(clockStartAt, ctx.now);
  const effective = policy.effectiveReturnWindowDays;

  return {
    clockStart: useDelivered ? 'DELIVERED_AT' : 'PLACED_AT',
    clockStartAt,
    daysElapsed,
    basePolicyWindowDays: policy.categoryPolicy.returnWindowDays,
    tierExtensionDays: policy.tierBenefit.windowExtensionDays,
    reasonExtensionDays: policy.reasonPolicy.windowExtensionDays,
    statutoryWindowDays: policy.regionalRule.statutoryWindowDays,
    effectiveWindowDays: effective,
    withinWindow: daysElapsed <= effective,
    daysRemaining: effective - daysElapsed,
  };
}

export function evaluateReturnWindow(window: WindowAssessment): RuleEvaluation {
  return {
    ruleId: ELIGIBILITY_RULE_IDS.RETURN_WINDOW,
    ruleName: 'Within the return window',
    outcome: window.withinWindow ? 'PASS' : 'FAIL',
    detail: window.withinWindow
      ? `Requested ${window.daysElapsed} day(s) after delivery, inside the ${window.effectiveWindowDays}-day window (${window.daysRemaining} day(s) remaining).`
      : `Requested ${window.daysElapsed} day(s) after delivery, ${Math.abs(window.daysRemaining)} day(s) past the ${window.effectiveWindowDays}-day window.`,
    observed: { ...window },
    waivedBy: null,
  };
}

/* -------------------------------------------------------------------------- */
/* RULE 4 — regional statutory override                                        */
/* -------------------------------------------------------------------------- */

/**
 * TODO(owner): if the statutory window is more generous than store policy AND
 * the category is not in `exemptCategories`, return outcome WAIVED with
 * waivedBy REGIONAL_LAW and cite `regionalRule.statutoryReference`.
 * Returns NOT_APPLICABLE when store policy is already at least as generous.
 */
export function evaluateRegionalStatute(ctx: CaseContext, window: WindowAssessment): RuleEvaluation {
  const { policy } = ctx;
  const statuteMoreGenerous = policy.regionalRule.statutoryWindowDays > policy.categoryPolicy.returnWindowDays;
  const applies = statuteMoreGenerous && !window.withinWindow === false;

  return {
    ruleId: ELIGIBILITY_RULE_IDS.REGIONAL_STATUTE,
    ruleName: 'Regional consumer-protection statute',
    outcome: statuteMoreGenerous ? (applies ? 'WAIVED' : 'PASS') : 'NOT_APPLICABLE',
    detail: statuteMoreGenerous
      ? `${policy.regionalRule.regionName} guarantees ${policy.regionalRule.statutoryWindowDays} days (${policy.regionalRule.statutoryReference}), which supersedes the ${policy.categoryPolicy.returnWindowDays}-day store policy.`
      : `Store policy (${policy.categoryPolicy.returnWindowDays} days) already meets or exceeds the ${policy.regionalRule.regionName} statutory minimum.`,
    observed: {
      statutoryWindowDays: policy.regionalRule.statutoryWindowDays,
      storeWindowDays: policy.categoryPolicy.returnWindowDays,
      reference: policy.regionalRule.statutoryReference,
    },
    waivedBy: statuteMoreGenerous && applies ? 'REGIONAL_LAW' : null,
  };
}

/* -------------------------------------------------------------------------- */
/* RULE 5 — damage on arrival                                                  */
/* -------------------------------------------------------------------------- */

export function evaluateDamageOnArrival(ctx: CaseContext, intent: ReturnIntent): RuleEvaluation {
  const merchantFault = isMerchantFault(intent.reason);
  const deliveryScanCorroborates = ctx.order.deliveryCondition === 'PACKAGE_DAMAGED' || ctx.order.deliveryCondition === 'CARRIER_EXCEPTION';

  return {
    ruleId: ELIGIBILITY_RULE_IDS.DAMAGE_ON_ARRIVAL,
    ruleName: 'Merchant-fault return (damage / defect)',
    outcome: merchantFault ? 'PASS' : 'NOT_APPLICABLE',
    detail: merchantFault
      ? `Reason "${intent.reason}" places fault with the merchant or carrier${deliveryScanCorroborates ? ', and the delivery scan recorded package damage' : ''}. Fees are waived and the window is extended by ${ctx.policy.reasonPolicy.windowExtensionDays} day(s).`
      : `Reason "${intent.reason}" is a customer-initiated return; standard policy applies.`,
    observed: { reason: intent.reason, deliveryCondition: ctx.order.deliveryCondition, deliveryScanCorroborates },
    waivedBy: merchantFault ? 'DAMAGE_ON_ARRIVAL' : null,
  };
}

/* -------------------------------------------------------------------------- */
/* RULE 6 — evidence requirement                                               */
/* -------------------------------------------------------------------------- */

/**
 * TODO(owner): require photo evidence when the category demands it and the
 * claim is damage-based. Outcome WARN (not FAIL) — this yields
 * APPROVED_WITH_CONDITIONS, and the Communication Agent asks for the photo.
 */
export function evaluateEvidenceRequired(ctx: CaseContext, intent: ReturnIntent): RuleEvaluation {
  const needed =
    (ctx.policy.categoryPolicy.requiresProofOfDamage || ctx.policy.reasonPolicy.requiresEvidence) &&
    isMerchantFault(intent.reason);
  const satisfied = !needed || intent.hasPhotoEvidence;

  return {
    ruleId: ELIGIBILITY_RULE_IDS.EVIDENCE_REQUIRED,
    ruleName: 'Proof of damage supplied',
    outcome: !needed ? 'NOT_APPLICABLE' : satisfied ? 'PASS' : 'WARN',
    detail: !needed
      ? 'No photographic evidence is required for this category and reason.'
      : satisfied
        ? 'Photo evidence was supplied with the request.'
        : 'Photo evidence is required for damage claims in this category and has not been supplied yet. The return is approved on the condition that a photo is uploaded.',
    observed: { needed, hasPhotoEvidence: intent.hasPhotoEvidence },
    waivedBy: null,
  };
}

/* -------------------------------------------------------------------------- */
/* RULE 7 — fraud screen                                                       */
/* -------------------------------------------------------------------------- */

/**
 * TODO(owner): expand the signal set. Current placeholder screens on the two
 * pre-aggregated counters plus the watchlist flag, which is enough for the
 * "repeat serial returner" demo scenario.
 */
export function assessFraud(ctx: CaseContext): FraudAssessment {
  const { customer, policy } = ctx;
  const h = customer.returnHistory;
  const flags: string[] = [];

  if (h.returnsLast90Days >= policy.thresholds.fraudReviewReturnsLast90Days) flags.push('HIGH_FREQUENCY');
  if (h.returnRate >= policy.thresholds.fraudReviewReturnRate) flags.push('HIGH_RETURN_RATE');
  if (customer.flags.includes('FRAUD_WATCHLIST')) flags.push('WATCHLIST');
  if (h.disputedReturns > 0) flags.push('PRIOR_DISPUTES');

  // Simple additive risk score; tune the weights during implementation.
  const riskScore = Math.min(100, flags.length * 30);
  const riskLevel = riskScore >= 60 ? 'HIGH' : riskScore >= 30 ? 'MEDIUM' : 'LOW';

  return {
    riskLevel,
    riskScore,
    returnsLast90Days: h.returnsLast90Days,
    lifetimeReturnRate: h.returnRate,
    flags,
    requiresManualReview: riskLevel === 'HIGH',
  };
}

export function evaluateFraudScreen(fraud: FraudAssessment): RuleEvaluation {
  return {
    ruleId: ELIGIBILITY_RULE_IDS.FRAUD_SCREEN,
    ruleName: 'Return abuse screening',
    outcome: fraud.requiresManualReview ? 'FAIL' : fraud.riskLevel === 'MEDIUM' ? 'WARN' : 'PASS',
    detail: fraud.requiresManualReview
      ? `Return-abuse risk is HIGH (${fraud.returnsLast90Days} returns in 90 days, ${(fraud.lifetimeReturnRate * 100).toFixed(0)}% lifetime return rate). Routed for manual review.`
      : `Return-abuse risk is ${fraud.riskLevel}: ${fraud.returnsLast90Days} returns in the last 90 days.`,
    observed: { ...fraud },
    waivedBy: null,
  };
}

/* -------------------------------------------------------------------------- */
/* RULE 8 — restocking fee                                                     */
/* -------------------------------------------------------------------------- */

/**
 * TODO(owner): returns the fee percentage plus the reason it was or was not
 * charged. Waived by: merchant fault, tier benefit, regional prohibition.
 */
export function computeRestockingFee(
  ctx: CaseContext,
  intent: ReturnIntent,
): { pct: number; evaluation: RuleEvaluation } {
  const basePct = ctx.policy.categoryPolicy.restockingFeePct;
  const waivedByFault = isMerchantFault(intent.reason) || ctx.policy.reasonPolicy.feesWaived;
  const waivedByTier = ctx.policy.tierBenefit.restockingFeeWaived;
  const waivedByLaw = ctx.policy.regionalRule.restockingFeeProhibited;
  const waived = waivedByFault || waivedByTier || waivedByLaw;
  const pct = waived ? 0 : basePct;

  const waivedBy = waivedByFault
    ? ('DAMAGE_ON_ARRIVAL' as const)
    : waivedByLaw
      ? ('REGIONAL_LAW' as const)
      : waivedByTier
        ? ('LOYALTY_TIER' as const)
        : null;

  return {
    pct,
    evaluation: {
      ruleId: ELIGIBILITY_RULE_IDS.RESTOCKING_FEE,
      ruleName: 'Restocking fee',
      outcome: basePct === 0 ? 'NOT_APPLICABLE' : waived ? 'WAIVED' : 'PASS',
      detail:
        basePct === 0
          ? 'No restocking fee applies to this category.'
          : waived
            ? `The ${basePct}% restocking fee is waived (${waivedBy?.toLowerCase().replace(/_/g, ' ')}).`
            : `A ${basePct}% restocking fee applies to this return.`,
      observed: { basePct, appliedPct: pct, waivedByFault, waivedByTier, waivedByLaw },
      waivedBy,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Composite score                                                             */
/* -------------------------------------------------------------------------- */

/**
 * TODO(owner): composite 0-100 confidence that this return is clearly eligible.
 * Placeholder: proportion of applicable rules that passed or were waived.
 */
export function computeEligibilityScore(trace: RuleEvaluation[]): number {
  const applicable = trace.filter((r) => r.outcome !== 'NOT_APPLICABLE');
  if (applicable.length === 0) return 50;
  const good = applicable.filter((r) => r.outcome === 'PASS' || r.outcome === 'WAIVED').length;
  return Math.round((good / applicable.length) * 100);
}
