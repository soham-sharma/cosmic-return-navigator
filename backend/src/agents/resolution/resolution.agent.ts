/**
 * RESOLUTION PLANNING AGENT — implementation shell.
 * Contract, 5-step decision logic and escalation matrix: resolution.contract.ts
 */
import { newId } from '../../core/ids';
import { BaseAgent, escalate } from '../base/base-agent';
import type { AgentExecutionContext, AgentExecutionOutput, DraftEscalation } from '../base/agent.interface';
import type { AgentId } from '../../domain/agent.schema';
import type { ResolutionOption, ResolutionType } from '../../domain/resolution.schema';
import {
  ResolutionInputSchema,
  ResolutionOutputSchema,
  type DecisionMatrixRow,
  type ResolutionInput,
  type ResolutionOutput,
} from './resolution.contract';
import * as rules from './resolution.rules';

/** Resolution types that require the item to physically come back. */
const NEEDS_RETURN_SHIPMENT: ResolutionType[] = ['REFUND', 'REPLACEMENT', 'EXCHANGE', 'STORE_CREDIT', 'REPAIR'];
/** Resolution types that ship something out to the customer. */
const NEEDS_OUTBOUND: ResolutionType[] = ['REPLACEMENT', 'EXCHANGE', 'REPAIR'];

export class ResolutionAgent extends BaseAgent<ResolutionInput, ResolutionOutput> {
  readonly id: AgentId = 'resolution';
  readonly stage = 2;
  readonly inputSchema = ResolutionInputSchema;
  readonly outputSchema = ResolutionOutputSchema;

  async execute(input: ResolutionInput, ctx: AgentExecutionContext): Promise<AgentExecutionOutput<ResolutionOutput>> {
    const { context, intent, eligibility, sentiment } = input;
    const escalations: DraftEscalation[] = [];
    const warnings: AgentExecutionOutput<ResolutionOutput>['warnings'] = [];

    /* -- STEP 1: candidates ------------------------------------------------ */
    const verdicts = rules.assessFeasibility(context, intent, eligibility);
    const costs = new Map<ResolutionType, ReturnType<typeof rules.estimateCost>>();
    for (const v of verdicts) costs.set(v.type, rules.estimateCost(v.type, context, intent, eligibility));
    const maxCost = Math.max(...[...costs.values()].map((c) => c.total), 1);

    /* -- STEP 3 (weights first, needed for scoring) ------------------------ */
    const weights = rules.computeWeights(sentiment);

    /* -- STEP 2: score ----------------------------------------------------- */
    const itemValue = context.orderItem.unitPriceUsd * intent.quantity;
    const options: ResolutionOption[] = verdicts.map((v) => {
      const cost = costs.get(v.type)!;
      const scores = {
        satisfactionScore: rules.scoreSatisfaction(v.type, intent),
        costScore: rules.scoreCost(cost.total, maxCost),
        retentionScore: rules.scoreRetention(v.type, sentiment),
        sustainabilityScore: rules.BASE_SUSTAINABILITY[v.type],
      };
      return {
        optionId: newId('resolution'),
        type: v.type,
        refundAmountUsd: v.type === 'REFUND' || v.type === 'KEEP_AND_REFUND' ? eligibility.refundableAmountUsd : v.type === 'PARTIAL_REFUND' ? Math.round(eligibility.refundableAmountUsd * 0.4 * 100) / 100 : null,
        currency: 'USD',
        storeCreditAmountUsd: v.type === 'STORE_CREDIT' ? Math.round(eligibility.refundableAmountUsd * 1.05 * 100) / 100 : null,
        replacementSku: NEEDS_OUTBOUND.includes(v.type) ? context.product.sku : null,
        // Refurbished stock is cheaper and greener; prefer it when new is short.
        replacementIsRefurbished: v.type === 'REPLACEMENT' && context.inventory.availableUnits === 0 && context.inventory.refurbishedUnits > 0,
        restockingFeeUsd: eligibility.restockingFeeUsd,
        returnShippingPaidBy: eligibility.returnShippingPaidBy,
        requiresReturnShipment: NEEDS_RETURN_SHIPMENT.includes(v.type),
        estimatedResolutionHours: rules.BASE_SLA_HOURS[v.type],
        ...scores,
        weightedScore: rules.weightedScore(scores, weights),
        estimatedCostUsd: cost.total,
        feasible: v.feasible,
        infeasibleReason: v.reason,
        customerFacingSummary: rules.customerFacingSummary(v.type, context, []),
        internalNotes: `Cost parts: ${JSON.stringify(cost.parts)}`,
      };
    });

    /* -- STEP 3: rank ------------------------------------------------------ */
    const feasible = options.filter((o) => o.feasible).sort((a, b) => b.weightedScore - a.weightedScore);
    if (feasible.length === 0) {
      // Should be impossible — ESCALATE is always feasible — but guard anyway.
      escalations.push(
        escalate('NO_FEASIBLE_RESOLUTION', {
          severity: 'CRITICAL',
          reason: 'We could not find a way to resolve this automatically.',
          blocking: true,
          requiresHuman: true,
          suggestedQueue: 'TIER2_SPECIALIST',
          priority: 5,
        }),
      );
    }
    const recommended = feasible[0] ?? options.find((o) => o.type === 'ESCALATE')!;

    /* -- STEP 4: goodwill -------------------------------------------------- */
    const { grants, exceeded } = rules.grantGoodwill(sentiment, context);
    const goodwillCost = grants.reduce((sum, g) => sum + g.costUsd, 0);
    recommended.customerFacingSummary = rules.customerFacingSummary(recommended.type, context, grants);

    /* -- non-blocking fallback notices ------------------------------------ */
    if (context.inventory.availableUnits === 0 && intent.requestedOutcome === 'REPLACEMENT') {
      escalations.push(
        escalate('REPLACEMENT_OUT_OF_STOCK', {
          severity: 'LOW',
          reason: `${context.product.name} is temporarily out of stock, so we selected the next best option.`,
          blocking: false,
          requiresHuman: false,
          priority: 2,
          context: { sku: context.product.sku, restockEtaDays: context.inventory.restockEtaDays },
        }),
      );
    }
    if (!context.order.paymentInstrumentValid && recommended.type === 'STORE_CREDIT') {
      escalations.push(
        escalate('PAYMENT_INSTRUMENT_INVALID', {
          severity: 'LOW',
          reason: 'The original payment method is no longer valid, so we issued store credit instead of a card refund.',
          blocking: false,
          requiresHuman: false,
          priority: 2,
        }),
      );
    }

    /* -- STEP 5: approval gate -------------------------------------------- */
    const costParts = costs.get(recommended.type)!.parts;
    const netCost = Math.round((recommended.estimatedCostUsd + goodwillCost) * 100) / 100;
    const requiresApproval =
      netCost > context.policy.thresholds.autoApproveMaxUsd ||
      eligibility.decision === 'MANUAL_REVIEW' ||
      exceeded ||
      recommended.type === 'ESCALATE';

    if (requiresApproval && netCost > context.policy.thresholds.autoApproveMaxUsd) {
      escalations.push(
        escalate('HIGH_VALUE_APPROVAL_REQUIRED', {
          severity: 'MEDIUM',
          reason: 'This resolution needs a quick sign-off before we finalize it.',
          blocking: true,
          requiresHuman: true,
          suggestedQueue: 'TIER2_SPECIALIST',
          priority: 3,
          suggestedAction: `Approve or adjust a ${recommended.type} worth $${netCost.toFixed(2)}.`,
          context: { netCostUsd: netCost, threshold: context.policy.thresholds.autoApproveMaxUsd },
        }),
      );
    }
    if (exceeded) {
      escalations.push(
        escalate('VIP_RETENTION_OVERRIDE', {
          severity: 'MEDIUM',
          reason: 'Goodwill granted above the standard tier budget for a high-value customer.',
          blocking: false,
          requiresHuman: true,
          suggestedQueue: 'RETENTION_DESK',
          priority: 3,
          context: { goodwillCostUsd: goodwillCost, budgetUsd: sentiment.retention.maxGoodwillBudgetUsd },
        }),
      );
    }

    /* -- decision matrix (explainability artifact) ------------------------ */
    const decisionMatrix: DecisionMatrixRow[] = options
      .sort((a, b) => b.weightedScore - a.weightedScore)
      .map((o) => ({
        optionId: o.optionId,
        type: o.type,
        label: o.type.replace(/_/g, ' ').toLowerCase(),
        satisfactionScore: o.satisfactionScore,
        costScore: o.costScore,
        retentionScore: o.retentionScore,
        sustainabilityScore: o.sustainabilityScore,
        weightedScore: o.weightedScore,
        estimatedCostUsd: o.estimatedCostUsd,
        feasible: o.feasible,
        selected: o.optionId === recommended.optionId,
        verdict:
          o.optionId === recommended.optionId
            ? `Selected — highest weighted score (${o.weightedScore}).`
            : !o.feasible
              ? `Not available: ${o.infeasibleReason}`
              : `Scored ${o.weightedScore} versus ${recommended.weightedScore} for the selected option.`,
      }));

    const output: ResolutionOutput = {
      recommended,
      alternatives: options.filter((o) => o.optionId !== recommended.optionId).slice(0, 5),
      decisionMatrix,
      weights,
      goodwill: grants,
      goodwillBudgetExceeded: exceeded,
      costs: {
        refundUsd: costParts.refund ?? 0,
        storeCreditUsd: costParts.storeCredit ?? 0,
        replacementGoodsCostUsd: costParts.goods ?? 0,
        outboundShippingUsd: costParts.outboundShipping ?? 0,
        reverseShippingUsd: costParts.reverseShipping ?? 0,
        processingUsd: costParts.processing ?? 0,
        goodwillUsd: goodwillCost,
        recoveredValueUsd: Math.abs(costParts.recovered ?? 0),
        netCostUsd: netCost,
      },
      estimatedRetainedValueUsd: Math.round(sentiment.customerValue.revenueAtRiskUsd * 0.7 * 100) / 100,
      retentionRoi: netCost > 0 ? Math.round((sentiment.customerValue.revenueAtRiskUsd * 0.7 / netCost) * 100) / 100 : null,
      requiresReturnShipment: recommended.requiresReturnShipment,
      requiresOutboundShipment: NEEDS_OUTBOUND.includes(recommended.type),
      requiresHumanApproval: requiresApproval,
      approvalReason: requiresApproval
        ? netCost > context.policy.thresholds.autoApproveMaxUsd
          ? `Net cost $${netCost.toFixed(2)} exceeds the $${context.policy.thresholds.autoApproveMaxUsd} auto-approval limit.`
          : eligibility.decision === 'MANUAL_REVIEW'
            ? 'Eligibility was routed to manual review.'
            : 'Goodwill exceeded the tier budget.'
        : null,
      slaHours: recommended.estimatedResolutionHours,
      customerFacingSummary: recommended.customerFacingSummary,
      internalRationale: `Chose ${recommended.type} (weighted ${recommended.weightedScore}) over ${decisionMatrix.filter((r) => r.feasible && !r.selected).length} other feasible options. Weights — satisfaction ${weights.satisfaction}, cost ${weights.cost}, retention ${weights.retention}, sustainability ${weights.sustainability}.${weights.adjustmentReason ? ` ${weights.adjustmentReason}` : ''} Net cost $${netCost.toFixed(2)} against $${output_retained(sentiment)} of revenue at risk.`,
    };

    return {
      output,
      rationale: `Recommended ${recommended.type.replace(/_/g, ' ').toLowerCase()} for the ${context.product.name} ($${itemValue.toFixed(2)}). It scored ${recommended.weightedScore}/100 — satisfaction ${recommended.satisfactionScore}, cost ${recommended.costScore}, retention ${recommended.retentionScore}. ${grants.length ? `Added ${grants.map((g) => `${g.value} ${g.unit.toLowerCase()}`).join(' and ')} of goodwill.` : 'No goodwill gesture was needed.'} Net cost $${netCost.toFixed(2)}.`,
      confidence: feasible.length > 1 ? 0.9 : 0.7,
      warnings,
      escalations,
      inputsUsed: ['eligibility.decision', 'eligibility.refundableAmountUsd', 'sentiment.retention', 'sentiment.churnRisk', 'context.inventory', 'context.policy.thresholds'],
    };
  }
}

const output_retained = (s: ResolutionInput['sentiment']) => s.customerValue.revenueAtRiskUsd.toFixed(0);

export const resolutionAgent = new ResolutionAgent();
