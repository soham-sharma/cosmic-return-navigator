/**
 * RETURN ELIGIBILITY AGENT — implementation shell.
 *
 * The agent is deliberately thin: it runs the rules in order, folds their
 * outcomes into a decision, and assembles the output. All judgement lives in
 * `eligibility.rules.ts`, which is pure and unit-testable.
 *
 * See eligibility.contract.ts for the full contract, rule precedence and
 * escalation matrix.
 */
import { BaseAgent, escalate } from '../base/base-agent';
import type { AgentExecutionContext, AgentExecutionOutput } from '../base/agent.interface';
import type { AgentId } from '../../domain/agent.schema';
import type { RuleEvaluation } from '../../domain/common.schema';
import {
  EligibilityInputSchema,
  EligibilityOutputSchema,
  type EligibilityDecision,
  type EligibilityInput,
  type EligibilityOutput,
} from './eligibility.contract';
import * as rules from './eligibility.rules';

export class EligibilityAgent extends BaseAgent<EligibilityInput, EligibilityOutput> {
  readonly id: AgentId = 'eligibility';
  readonly stage = 1;
  readonly inputSchema = EligibilityInputSchema;
  readonly outputSchema = EligibilityOutputSchema;

  async execute(
    input: EligibilityInput,
    ctx: AgentExecutionContext,
  ): Promise<AgentExecutionOutput<EligibilityOutput>> {
    const { intent, context } = input;
    ctx.log.debug('Evaluating eligibility', { orderId: context.order.orderId, reason: intent.reason });

    /* -- 1. run every rule, in precedence order -------------------------- */
    const window = rules.assessWindow(context);
    const fraud = rules.assessFraud(context);
    const fee = rules.computeRestockingFee(context, intent);

    const trace: RuleEvaluation[] = [
      rules.evaluateOrderMatch(context, intent),
      rules.evaluateCategoryReturnable(context),
      rules.evaluateReturnWindow(window),
      rules.evaluateRegionalStatute(context, window),
      rules.evaluateDamageOnArrival(context, intent),
      rules.evaluateEvidenceRequired(context, intent),
      rules.evaluateFraudScreen(fraud),
      fee.evaluation,
    ];

    /* -- 2. fold rule outcomes into a decision ---------------------------- */
    const byId = (id: string) => trace.find((r) => r.ruleId === id);
    const failed = (id: string) => byId(id)?.outcome === 'FAIL';
    const warned = (id: string) => byId(id)?.outcome === 'WARN';
    const windowWaived = byId(rules.ELIGIBILITY_RULE_IDS.REGIONAL_STATUTE)?.waivedBy === 'REGIONAL_LAW';

    let decision: EligibilityDecision;
    if (failed(rules.ELIGIBILITY_RULE_IDS.ORDER_MATCH)) {
      decision = 'DENIED';
    } else if (fraud.requiresManualReview) {
      // Fraud outranks approval: never auto-approve a flagged account.
      decision = 'MANUAL_REVIEW';
    } else if (failed(rules.ELIGIBILITY_RULE_IDS.CATEGORY_RETURNABLE)) {
      decision = 'DENIED';
    } else if (failed(rules.ELIGIBILITY_RULE_IDS.RETURN_WINDOW) && !windowWaived) {
      decision = 'DENIED';
    } else if (warned(rules.ELIGIBILITY_RULE_IDS.EVIDENCE_REQUIRED) || context.policy.categoryPolicy.requiresInspection) {
      decision = 'APPROVED_WITH_CONDITIONS';
    } else {
      decision = 'APPROVED';
    }

    /* -- 3. financial consequences ---------------------------------------- */
    const declaredValue = context.orderItem.unitPriceUsd * intent.quantity;
    const restockingFeeUsd = Math.round(declaredValue * (fee.pct / 100) * 100) / 100;
    const merchantFault = rules.isMerchantFault(intent.reason);

    /* -- 4. conditions ----------------------------------------------------- */
    const conditions: EligibilityOutput['conditions'] = [];
    if (warned(rules.ELIGIBILITY_RULE_IDS.EVIDENCE_REQUIRED)) {
      conditions.push({
        code: 'PHOTO_EVIDENCE',
        description: 'Upload a photo of the damaged item so we can verify the claim.',
        blocksResolution: false,
      });
    }
    if (context.policy.categoryPolicy.requiresInspection) {
      conditions.push({
        code: 'WAREHOUSE_INSPECTION',
        description: 'The item will be inspected on arrival before the refund is released.',
        blocksResolution: false,
      });
    }
    if (context.policy.categoryPolicy.requiresOriginalPackaging) {
      conditions.push({
        code: 'ORIGINAL_PACKAGING',
        description: 'Please return the item in its original packaging.',
        blocksResolution: false,
      });
    }

    /* -- 5. escalations ---------------------------------------------------- */
    const escalations = [];
    if (decision === 'MANUAL_REVIEW') {
      escalations.push(
        escalate('FRAUD_SIGNAL_DETECTED', {
          severity: 'HIGH',
          reason: 'This request needs a quick manual check before we can confirm it.',
          blocking: true,
          requiresHuman: true,
          suggestedQueue: 'FRAUD_REVIEW',
          priority: 4,
          suggestedAction: 'Review the return history and confirm or deny the request.',
          internalDetail: `Fraud flags: ${fraud.flags.join(', ') || 'none'} (score ${fraud.riskScore}).`,
          context: { ...fraud },
        }),
      );
    }
    if (decision === 'DENIED' && failed(rules.ELIGIBILITY_RULE_IDS.RETURN_WINDOW)) {
      escalations.push(
        escalate('OUTSIDE_RETURN_WINDOW', {
          severity: 'MEDIUM',
          reason: `This order was delivered ${window.daysElapsed} days ago, outside the ${window.effectiveWindowDays}-day return window.`,
          // Non-blocking: Resolution Planning may still offer goodwill to a
          // high-value customer. Only the finalizer decides the case is denied.
          blocking: false,
          requiresHuman: false,
          suggestedQueue: 'TIER1_SUPPORT',
          priority: 2,
          context: { ...window },
        }),
      );
    }
    if (decision === 'DENIED' && failed(rules.ELIGIBILITY_RULE_IDS.CATEGORY_RETURNABLE)) {
      escalations.push(
        escalate(context.product.isFinalSale ? 'FINAL_SALE_ITEM' : 'CATEGORY_NOT_RETURNABLE', {
          severity: 'MEDIUM',
          reason: byId(rules.ELIGIBILITY_RULE_IDS.CATEGORY_RETURNABLE)?.detail ?? 'This item cannot be returned.',
          blocking: false,
          requiresHuman: false,
          suggestedQueue: 'TIER1_SUPPORT',
          priority: 2,
          context: { category: context.product.category, sku: context.product.sku },
        }),
      );
    }
    if (windowWaived) {
      escalations.push(
        escalate('REGIONAL_LAW_OVERRIDE', {
          severity: 'INFO',
          reason: `Approved under ${context.policy.regionalRule.regionName} consumer-protection law.`,
          blocking: false,
          requiresHuman: false,
          priority: 1,
          internalDetail: context.policy.regionalRule.statutoryReference,
        }),
      );
    }
    if (conditions.some((c) => c.code === 'PHOTO_EVIDENCE')) {
      escalations.push(
        escalate('PROOF_OF_DAMAGE_REQUIRED', {
          severity: 'LOW',
          reason: 'We need a photo of the damage to complete the claim.',
          blocking: false,
          requiresHuman: false,
          priority: 2,
        }),
      );
    }

    /* -- 6. assemble ------------------------------------------------------- */
    const output: EligibilityOutput = {
      decision,
      eligibilityScore: rules.computeEligibilityScore(trace),
      normalizedReason: intent.reason,
      faultAttribution: merchantFault ? 'MERCHANT' : intent.faultAttribution,
      window,
      fraud,
      ruleTrace: trace,
      refundableAmountUsd: Math.max(0, declaredValue - restockingFeeUsd),
      restockingFeePct: fee.pct,
      restockingFeeUsd,
      returnShippingPaidBy: merchantFault || context.policy.tierBenefit.freeReturnShipping ? 'MERCHANT' : 'CUSTOMER',
      conditions,
      regionalOverridesApplied: windowWaived
        ? [
            {
              regionCode: context.regionCode,
              provision: context.policy.regionalRule.statutoryReference,
              effect: `Return window extended to ${context.policy.regionalRule.statutoryWindowDays} days.`,
            },
          ]
        : [],
      requiresInspection: context.policy.categoryPolicy.requiresInspection,
      policyCitation: `${context.policy.policyId} v${context.policy.policyVersion} — ${context.product.category}, ${context.policy.regionalRule.regionName}`,
      customerFacingSummary: buildCustomerSummary(decision, window, intent.reason),
    };

    return {
      output,
      rationale: buildRationale(decision, window, trace, intent.reason),
      confidence: decision === 'MANUAL_REVIEW' ? 0.6 : 0.94,
      escalations,
      inputsUsed: ['intent', 'context.order', 'context.orderItem', 'context.product', 'context.customer', 'context.policy'],
    };
  }
}

/* ------------------------------ presentation ------------------------------- */

function buildCustomerSummary(
  decision: EligibilityDecision,
  window: ReturnType<typeof rules.assessWindow>,
  reason: string,
): string {
  switch (decision) {
    case 'APPROVED':
      return `Approved — your request is within the ${window.effectiveWindowDays}-day return window.`;
    case 'APPROVED_WITH_CONDITIONS':
      return 'Approved, with one quick step needed from you.';
    case 'MANUAL_REVIEW':
      return 'We need a moment to review this request manually.';
    case 'DENIED':
      return reason === 'CHANGE_OF_MIND'
        ? `This order is outside the ${window.effectiveWindowDays}-day window for change-of-mind returns.`
        : 'Unfortunately this item is not eligible for return.';
  }
}

function buildRationale(
  decision: EligibilityDecision,
  window: ReturnType<typeof rules.assessWindow>,
  trace: RuleEvaluation[],
  reason: string,
): string {
  const decisive = trace.filter((r) => r.outcome === 'FAIL' || r.outcome === 'WAIVED');
  const headline =
    decision === 'APPROVED' || decision === 'APPROVED_WITH_CONDITIONS'
      ? `Eligible: requested ${window.daysElapsed} day(s) after delivery, inside the ${window.effectiveWindowDays}-day window, reason "${reason}".`
      : decision === 'MANUAL_REVIEW'
        ? 'Held for manual review because return-abuse screening flagged this account.'
        : `Not eligible: ${decisive[0]?.detail ?? 'policy conditions were not met'}`;
  const detail = decisive.length
    ? ` Decisive rules: ${decisive.map((r) => `${r.ruleId} (${r.outcome})`).join(', ')}.`
    : ` All ${trace.length} policy rules passed.`;
  return headline + detail;
}

export const eligibilityAgent = new EligibilityAgent();
