/**
 * CONFLICT RESOLVER — an orchestrator responsibility, not an agent's.
 *
 * The PRD says the Orchestration Engine "resolves conflicts and ensures the
 * best combined outcome for customer and business". Two agents can each be
 * right in their own frame and still disagree:
 *
 *   COST_VS_CARBON            Logistics picks the cheapest/fastest carrier;
 *                             Sustainability wants the consolidated green one.
 *   ELIGIBILITY_VS_RETENTION  Eligibility denies; Sentiment says this customer
 *                             is too valuable to turn away empty-handed.
 *   GOODWILL_OVER_BUDGET      Resolution granted more goodwill than the tier
 *                             budget allows.
 *
 * Keeping these decisions here — not inside an agent — means the trade-off is
 * made once, explicitly, with a named policy, and is written to the case's
 * `conflicts[]` so it can be audited and shown in the UI.
 *
 * DESIGN RULE: the resolver never invents new options. It only chooses between
 * options the agents already produced, and records why.
 */
import { clock } from '../core/clock';
import { newId } from '../core/ids';
import type { AgentId } from '../domain/agent.schema';
import type { ConflictRecord } from '../domain/case-state.schema';
import type { LogisticsOutput } from '../agents/logistics/logistics.contract';
import type { SustainabilityOutput } from '../agents/sustainability/sustainability.contract';
import type { EligibilityOutput } from '../agents/eligibility/eligibility.contract';
import type { SentimentOutput } from '../agents/sentiment/sentiment.contract';
import type { ResolutionOutput } from '../agents/resolution/resolution.contract';

/**
 * Named resolution policies. Externalizing the names (rather than burying the
 * logic) means the audit log says WHY, not just WHAT.
 */
export const RESOLUTION_POLICY = {
  GREEN_WHEN_CHEAP: 'green_adopted_when_cost_delta_under_2usd_and_delay_under_2_days',
  GREEN_WHEN_CUSTOMER_CHOOSES: 'green_offered_to_customer_when_delay_material',
  COST_WINS: 'cost_retained_when_carbon_saving_not_worth_the_premium',
  GREEN_ALREADY_OPTIMAL: 'no_conflict_selected_option_already_greenest',
  RETENTION_OVERRIDE: 'goodwill_authorized_above_policy_for_vip_at_churn_risk',
  POLICY_WINS: 'policy_denial_upheld_legal_or_fraud_grounds',
} as const;

/* -------------------------------------------------------------------------- */
/* 1. COST vs CARBON — the demo's marquee conflict                             */
/* -------------------------------------------------------------------------- */

export interface LogisticsSelectionDecision {
  /** The option the case should actually use. */
  finalOptionId: string | null;
  /** True when the orchestrator overrode the Logistics Agent's pick. */
  overridden: boolean;
  /** Null when there was nothing to resolve. */
  conflict: ConflictRecord | null;
  /** True when the customer should be offered the choice instead. */
  offerCustomerChoice: boolean;
}

/**
 * Decides the final return route.
 *
 * The Sustainability Agent has already computed the trade-off and expressed a
 * verdict; the orchestrator's job is to APPLY it, record the decision, and own
 * the accountability for the money/time spent on carbon.
 */
export function resolveLogisticsSelection(
  logistics: LogisticsOutput,
  sustainability: SustainabilityOutput | null,
): LogisticsSelectionDecision {
  const provisional = logistics.provisionalSelectionId;

  // Nothing to decide: no shipment, or sustainability did not run.
  if (!logistics.required || !provisional || !sustainability) {
    return { finalOptionId: provisional, overridden: false, conflict: null, offerCustomerChoice: false };
  }

  const greenest = sustainability.greenestOptionId;

  // No conflict — the cost-optimal pick is already the greenest.
  if (greenest === provisional) {
    return {
      finalOptionId: provisional,
      overridden: false,
      conflict: null,
      offerCustomerChoice: false,
    };
  }

  const t = sustainability.tradeoff;
  const parties: AgentId[] = ['logistics', 'sustainability'];
  const provisionalOption = logistics.candidateOptions.find((o) => o.optionId === provisional);
  const greenOption = logistics.candidateOptions.find((o) => o.optionId === greenest);

  const positions = [
    {
      agentId: 'logistics' as AgentId,
      position: `Use ${provisionalOption?.customerFacingLabel ?? provisional} — best on cost, speed and convenience.`,
      value: { optionId: provisional, costUsd: provisionalOption?.costUsd, days: provisionalOption?.totalDaysToResolution },
    },
    {
      agentId: 'sustainability' as AgentId,
      position: `Use ${greenOption?.customerFacingLabel ?? greenest} — saves ${t.co2SavingKg}kg CO2.`,
      value: { optionId: greenest, costDeltaUsd: t.costDeltaUsd, daysDelta: t.transitDaysDelta, co2SavingKg: t.co2SavingKg },
    },
  ];

  const base = {
    conflictId: newId('event'),
    type: 'COST_VS_CARBON' as const,
    parties,
    description: `The cost-optimal route and the lowest-carbon route differ by $${t.costDeltaUsd.toFixed(2)} and ${t.transitDaysDelta} day(s) for ${t.co2SavingKg}kg of CO2.`,
    positions,
    resolvedAt: clock.nowIso(),
  };

  switch (t.verdict) {
    case 'ADOPT_GREEN':
      return {
        finalOptionId: greenest,
        overridden: true,
        offerCustomerChoice: false,
        conflict: {
          ...base,
          resolution: `Adopted the lower-carbon route. ${t.reason}`,
          winningAgentId: 'sustainability',
          resolutionPolicy: RESOLUTION_POLICY.GREEN_WHEN_CHEAP,
          tradeoffAccepted: { extraCostUsd: t.costDeltaUsd, extraDays: t.transitDaysDelta, co2SavedKg: t.co2SavingKg },
        },
      };

    case 'OFFER_CUSTOMER_CHOICE':
      // Keep the fast option as the default so the customer is never made to
      // wait by a decision they did not make — but surface the green option.
      return {
        finalOptionId: provisional,
        overridden: false,
        offerCustomerChoice: true,
        conflict: {
          ...base,
          resolution: `Kept the faster route as the default and offered the greener option to the customer. ${t.reason}`,
          winningAgentId: null,
          resolutionPolicy: RESOLUTION_POLICY.GREEN_WHEN_CUSTOMER_CHOOSES,
          tradeoffAccepted: { extraCostUsd: 0, extraDays: 0, co2ForgoneKg: t.co2SavingKg },
        },
      };

    case 'KEEP_CURRENT':
    default:
      return {
        finalOptionId: provisional,
        overridden: false,
        offerCustomerChoice: false,
        conflict: {
          ...base,
          resolution: `Kept the cost-optimal route. ${t.reason}`,
          winningAgentId: 'logistics',
          resolutionPolicy: RESOLUTION_POLICY.COST_WINS,
          tradeoffAccepted: { savedCostUsd: Math.abs(t.costDeltaUsd), co2ForgoneKg: t.co2SavingKg },
        },
      };
  }
}

/* -------------------------------------------------------------------------- */
/* 2. ELIGIBILITY vs RETENTION                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Detects the case where policy says no but customer value says "do something".
 *
 * The Resolution Planning Agent is expected to have already handled this by
 * offering store credit or an apology gesture. This function's job is to RECORD
 * that the tension existed and confirm which way it went — the audit trail the
 * retention desk and legal team both need.
 *
 * A denial on LEGAL or FRAUD grounds is never overridden.
 */
export function resolveEligibilityRetentionConflict(
  eligibility: EligibilityOutput,
  sentiment: SentimentOutput,
  resolution: ResolutionOutput | null,
): ConflictRecord | null {
  const denied = eligibility.decision === 'DENIED';
  const wantsRetention = sentiment.retention.warranted && sentiment.customerValue.valueBand !== 'STANDARD';
  if (!denied || !wantsRetention) return null;

  // Fraud and statutory denials are not negotiable.
  const hardDenial = eligibility.fraud.requiresManualReview || eligibility.decision === 'MANUAL_REVIEW';
  const gestureGranted = (resolution?.goodwill.length ?? 0) > 0 || resolution?.recommended.type === 'STORE_CREDIT';

  return {
    conflictId: newId('event'),
    type: 'ELIGIBILITY_VS_RETENTION',
    parties: ['eligibility', 'sentiment'],
    description: `Policy denies this return, but the customer is ${sentiment.customerValue.valueBand} value with $${sentiment.customerValue.revenueAtRiskUsd.toFixed(0)} at risk.`,
    positions: [
      {
        agentId: 'eligibility',
        position: eligibility.customerFacingSummary,
        value: { decision: eligibility.decision, citation: eligibility.policyCitation },
      },
      {
        agentId: 'sentiment',
        position: `Retention gesture warranted within a $${sentiment.retention.maxGoodwillBudgetUsd.toFixed(2)} budget.`,
        value: { churnScore: sentiment.churnRisk.score, valueBand: sentiment.customerValue.valueBand },
      },
    ],
    resolution: hardDenial
      ? 'Denial upheld — fraud screening or statutory grounds cannot be overridden by retention value.'
      : gestureGranted
        ? `Denial upheld on the return itself, but a goodwill gesture was granted to protect the relationship (${resolution?.recommended.type}).`
        : 'Denial upheld and no gesture granted; flagged for retention-desk review.',
    winningAgentId: hardDenial ? 'eligibility' : gestureGranted ? 'sentiment' : 'eligibility',
    resolutionPolicy: hardDenial ? RESOLUTION_POLICY.POLICY_WINS : RESOLUTION_POLICY.RETENTION_OVERRIDE,
    tradeoffAccepted: {
      goodwillUsd: resolution?.costs.goodwillUsd ?? 0,
      revenueProtectedUsd: resolution?.estimatedRetainedValueUsd ?? 0,
    },
    resolvedAt: clock.nowIso(),
  };
}

/* -------------------------------------------------------------------------- */
/* 3. GOODWILL OVER BUDGET                                                     */
/* -------------------------------------------------------------------------- */

export function resolveGoodwillBudgetConflict(
  sentiment: SentimentOutput,
  resolution: ResolutionOutput,
): ConflictRecord | null {
  if (!resolution.goodwillBudgetExceeded) return null;

  return {
    conflictId: newId('event'),
    type: 'GOODWILL_OVER_BUDGET',
    parties: ['sentiment', 'resolution'],
    description: `Goodwill of $${resolution.costs.goodwillUsd.toFixed(2)} exceeds the $${sentiment.retention.maxGoodwillBudgetUsd.toFixed(2)} ${sentiment.customerValue.loyaltyTier} tier budget.`,
    positions: [
      {
        agentId: 'sentiment',
        position: `Budget cap is $${sentiment.retention.maxGoodwillBudgetUsd.toFixed(2)}.`,
        value: { budgetUsd: sentiment.retention.maxGoodwillBudgetUsd },
      },
      {
        agentId: 'resolution',
        position: 'A larger gesture is justified by the revenue at risk.',
        value: { goodwillUsd: resolution.costs.goodwillUsd, retainedValueUsd: resolution.estimatedRetainedValueUsd },
      },
    ],
    resolution: 'Routed for human approval before the gesture is applied — above-budget generosity requires sign-off.',
    winningAgentId: null,
    resolutionPolicy: RESOLUTION_POLICY.RETENTION_OVERRIDE,
    tradeoffAccepted: {
      overspendUsd: Math.max(0, resolution.costs.goodwillUsd - sentiment.retention.maxGoodwillBudgetUsd),
    },
    resolvedAt: clock.nowIso(),
  };
}
