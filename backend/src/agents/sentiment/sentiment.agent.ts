/**
 * SENTIMENT & RETENTION AGENT — implementation shell.
 * Contract, decision logic and escalation matrix: sentiment.contract.ts
 */
import { BaseAgent, escalate } from '../base/base-agent';
import type { AgentExecutionContext, AgentExecutionOutput, DraftEscalation } from '../base/agent.interface';
import type { AgentId } from '../../domain/agent.schema';
import {
  SentimentInputSchema,
  SentimentOutputSchema,
  type SentimentInput,
  type SentimentOutput,
} from './sentiment.contract';
import * as rules from './sentiment.rules';

export class SentimentAgent extends BaseAgent<SentimentInput, SentimentOutput> {
  readonly id: AgentId = 'sentiment';
  readonly stage = 1;
  readonly inputSchema = SentimentInputSchema;
  readonly outputSchema = SentimentOutputSchema;

  async execute(input: SentimentInput, ctx: AgentExecutionContext): Promise<AgentExecutionOutput<SentimentOutput>> {
    const { intent, context } = input;
    const warnings: AgentExecutionOutput<SentimentOutput>['warnings'] = [];

    if (!intent.rawText.trim()) {
      warnings.push({
        code: 'EMPTY_INPUT_TEXT',
        message: 'No customer text available; sentiment defaults to neutral and confidence is reduced.',
        field: 'intent.rawText',
      });
    }

    /* -- (a)-(f) from the contract ---------------------------------------- */
    const sentiment = rules.analyzeSentiment(intent);
    const { severity, threatMarkersFound } = rules.assessSeverity(intent, sentiment, context);
    const churnRisk = rules.scoreChurnRisk(context, sentiment, severity);
    const customerValue = rules.assessCustomerValue(context, churnRisk.score);
    const budget = rules.computeGoodwillBudget(context, severity);
    const gestures = rules.recommendGestures(context, churnRisk, severity, customerValue, budget);
    const social = rules.assessSocialRisk(context, severity, threatMarkersFound);

    const askedForHuman = rules.HUMAN_REQUEST_MARKERS.some((m) => intent.rawText.toLowerCase().includes(m));
    const warranted =
      churnRisk.score >= context.policy.thresholds.retentionInterventionChurnScore ||
      severity === 'HIGH' ||
      severity === 'CRITICAL' ||
      intent.faultAttribution === 'MERCHANT' ||
      ['DAMAGED_ON_ARRIVAL', 'DEFECTIVE', 'WRONG_ITEM_SENT'].includes(intent.reason);

    /* -- weight boost handed to the Resolution Planning Agent -------------- */
    // TODO(owner): calibrate. 0 = pure policy, 3 = maximum generosity.
    const boost =
      (severity === 'CRITICAL' ? 1.5 : severity === 'HIGH' ? 1.0 : severity === 'MODERATE' ? 0.5 : 0) +
      (customerValue.valueBand === 'VIP' ? 1.0 : customerValue.valueBand === 'HIGH' ? 0.5 : 0);

    /* -- tone: this agent owns tone selection ------------------------------ */
    const recommendedTone =
      severity === 'CRITICAL' ? 'APOLOGETIC'
      : sentiment.score <= -0.3 ? 'EMPATHETIC'
      : churnRisk.band === 'HIGH' ? 'REASSURING'
      : 'NEUTRAL_INFORMATIVE';

    /* -- escalations -------------------------------------------------------- */
    const escalations: DraftEscalation[] = [];
    if (severity === 'CRITICAL') {
      escalations.push(
        escalate('CRITICAL_SENTIMENT', {
          severity: 'CRITICAL',
          reason: 'This customer is extremely upset and should hear from a person.',
          blocking: true,
          requiresHuman: true,
          suggestedQueue: 'RETENTION_DESK',
          priority: 5,
          suggestedAction: 'Call the customer within 30 minutes and confirm the resolution personally.',
          context: { churnScore: churnRisk.score, revenueAtRiskUsd: customerValue.revenueAtRiskUsd },
        }),
      );
    }
    if (customerValue.valueBand === 'VIP' && sentiment.score < 0) {
      escalations.push(
        escalate('VIP_RETENTION_OVERRIDE', {
          severity: 'MEDIUM',
          reason: 'High-value customer — above-policy generosity is authorized for this case.',
          blocking: false,
          requiresHuman: false,
          priority: 2,
          internalDetail: `LTV $${customerValue.lifetimeValueUsd.toFixed(0)}, tier ${customerValue.loyaltyTier}, goodwill budget $${budget.toFixed(2)}.`,
          context: { budgetUsd: budget, valuePercentile: customerValue.valuePercentile },
        }),
      );
    }
    if (social.likelihood >= 0.5) {
      escalations.push(
        escalate('PUBLIC_COMPLAINT_RISK', {
          severity: 'MEDIUM',
          reason: 'There is a meaningful chance this customer complains publicly if the outcome disappoints.',
          blocking: false,
          requiresHuman: false,
          suggestedQueue: 'RETENTION_DESK',
          priority: 3,
          context: { likelihood: social.likelihood, priorPublicComplaints: social.priorPublicComplaints },
        }),
      );
    }
    if (askedForHuman) {
      escalations.push(
        escalate('HUMAN_AGENT_REQUESTED', {
          severity: 'HIGH',
          reason: 'The customer explicitly asked to speak with a person.',
          blocking: false,
          requiresHuman: true,
          suggestedQueue: 'TIER1_SUPPORT',
          priority: 4,
        }),
      );
    }

    const output: SentimentOutput = {
      sentiment,
      complaintSeverity: severity,
      urgency:
        severity === 'CRITICAL' ? 'IMMEDIATE' : severity === 'HIGH' ? 'HIGH' : severity === 'MODERATE' ? 'NORMAL' : 'LOW',
      customerValue,
      churnRisk,
      retention: {
        warranted,
        recommendedGestures: warranted ? gestures : [],
        maxGoodwillBudgetUsd: budget,
        satisfactionWeightBoost: Math.min(3, Math.round(boost * 10) / 10),
        recommendUpgradedResolution: customerValue.valueBand !== 'STANDARD' && (severity === 'HIGH' || severity === 'CRITICAL'),
        targetCsat: severity === 'LOW' ? 4.0 : 4.5,
      },
      socialRisk: {
        publicComplaintLikelihood: social.likelihood,
        band: social.likelihood >= 0.7 ? 'CRITICAL' : social.likelihood >= 0.5 ? 'HIGH' : social.likelihood >= 0.25 ? 'MEDIUM' : 'LOW',
        priorPublicComplaints: social.priorPublicComplaints,
        rationale:
          social.likelihood >= 0.5
            ? `Elevated public-complaint risk: ${severity} severity with ${social.priorPublicComplaints} prior public complaint(s).`
            : 'Low public-complaint risk based on tone and interaction history.',
      },
      recommendedTone,
      humanTouchRecommended: severity === 'CRITICAL' || askedForHuman,
      supportBriefing: [
        `${context.customer.firstName} ${context.customer.lastName} (${customerValue.loyaltyTier}, LTV $${customerValue.lifetimeValueUsd.toFixed(0)}).`,
        `Returning ${context.product.name} — reason: ${intent.reason}.`,
        `Sentiment ${sentiment.label} (${sentiment.score}); severity ${severity}; churn risk ${churnRisk.score}/100.`,
        warranted ? `Goodwill budget available: $${budget.toFixed(2)}.` : 'No retention gesture indicated.',
      ].join(' '),
    };

    return {
      output,
      rationale: `${sentiment.label.replace('_', ' ').toLowerCase()} sentiment (${sentiment.score}) with ${severity.toLowerCase()} complaint severity. ${context.customer.loyaltyTier} member, $${customerValue.lifetimeValueUsd.toFixed(0)} lifetime value, churn risk ${churnRisk.score}/100 — $${customerValue.revenueAtRiskUsd.toFixed(0)} at risk. ${warranted ? `Retention gesture recommended within a $${budget.toFixed(2)} budget.` : 'No retention gesture needed.'}`,
      confidence: intent.rawText.trim() ? 0.87 : 0.4,
      warnings,
      escalations,
      inputsUsed: ['intent.rawText', 'context.customer', 'context.policy.tierBenefit', 'context.policy.thresholds'],
    };
  }
}

export const sentimentAgent = new SentimentAgent();
