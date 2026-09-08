/**
 * INSIGHTS AGENT — implementation shell.
 * Contract, 4-step decision logic and escalation matrix: insights.contract.ts
 *
 * This agent is an OBSERVER. It never blocks the customer's return.
 */
import { newId } from '../../core/ids';
import { hoursBetween } from '../../core/clock';
import { BaseAgent, escalate } from '../base/base-agent';
import type { AgentExecutionContext, AgentExecutionOutput, DraftEscalation } from '../base/agent.interface';
import type { AgentId } from '../../domain/agent.schema';
import type { Insight } from '../../domain/insight.schema';
import {
  InsightsInputSchema,
  InsightsOutputSchema,
  type InsightAlert,
  type InsightsInput,
  type InsightsOutput,
  type TrendUpdate,
} from './insights.contract';
import * as rules from './insights.rules';

export class InsightsAgent extends BaseAgent<InsightsInput, InsightsOutput> {
  readonly id: AgentId = 'insights';
  readonly stage = 5;
  readonly inputSchema = InsightsInputSchema;
  readonly outputSchema = InsightsOutputSchema;

  async execute(input: InsightsInput, ctx: AgentExecutionContext): Promise<AgentExecutionOutput<InsightsOutput>> {
    const { context, intent, eligibility, sentiment, resolution, logistics, sustainability } = input;
    const escalations: DraftEscalation[] = [];
    const warnings: AgentExecutionOutput<InsightsOutput>['warnings'] = [];
    const h = context.historicalAggregates;

    /* -- STEP 1: extract signals ------------------------------------------ */
    const caseSignals = rules.extractSignals({ intent, context, eligibility, sentiment, resolution, logistics, sustainability });

    /* -- cold start guard -------------------------------------------------- */
    const coldStart = h.totalReturnsLast30Days === 0;
    if (coldStart) {
      warnings.push({
        code: 'COLD_START',
        message: 'No historical return data available; signals recorded but no trends computed.',
        field: 'context.historicalAggregates',
      });
    }

    /* -- STEP 2: trend and promote ---------------------------------------- */
    const spikePct = rules.computeSpikePct(h.skuReturnsLast30Days, h.skuReturnsPrevious30Days);
    const insights: Insight[] = [];
    const suppressionReasons: string[] = [];

    if (!coldStart) {
      // Deduplicate by signal type so one case cannot emit two insights of the
      // same kind. Cross-case dedupe happens in the insight service.
      const seen = new Set<string>();
      for (const signal of caseSignals.sort((a, b) => b.strength - a.strength)) {
        if (seen.has(signal.signalType)) continue;
        seen.add(signal.signalType);

        const { promote, reason } = rules.shouldPromote(signal, context);
        if (promote) {
          insights.push(rules.buildInsight(signal, context, input.caseId, reason));
        } else {
          suppressionReasons.push(`${signal.signalType}: ${reason}`);
        }
      }
    }

    /* -- trend updates ---------------------------------------------------- */
    const trendUpdates: TrendUpdate[] = [
      {
        metric: 'sku_returns_30d',
        scope: 'SKU',
        scopeValue: context.product.sku,
        previousValue: h.skuReturnsPrevious30Days,
        newValue: h.skuReturnsLast30Days,
        deltaPct: spikePct,
        windowDays: 30,
        breachedThreshold: spikePct >= rules.PROMOTION.minSpikePct,
        thresholdValue: rules.PROMOTION.minSpikePct,
      },
      {
        metric: 'sku_damaged_on_arrival_30d',
        scope: 'SKU',
        scopeValue: context.product.sku,
        previousValue: Math.max(0, h.skuDamagedOnArrivalLast30Days - 1),
        newValue: h.skuDamagedOnArrivalLast30Days,
        deltaPct: rules.computeSpikePct(h.skuDamagedOnArrivalLast30Days, Math.max(0, h.skuDamagedOnArrivalLast30Days - 1)),
        windowDays: 30,
        breachedThreshold: h.skuDamagedOnArrivalLast30Days >= rules.PROMOTION.minSampleSize,
        thresholdValue: rules.PROMOTION.minSampleSize,
      },
      {
        metric: 'region_return_rate_pct',
        scope: 'REGION',
        scopeValue: context.regionCode,
        previousValue: h.categoryReturnRatePct,
        newValue: h.regionReturnRatePct,
        deltaPct: Math.round(h.regionReturnRatePct - h.categoryReturnRatePct),
        windowDays: 30,
        breachedThreshold: h.regionReturnRatePct - h.categoryReturnRatePct >= rules.PROMOTION.regionExcessPct,
        thresholdValue: rules.PROMOTION.regionExcessPct,
      },
    ];

    /* -- alerts ------------------------------------------------------------ */
    const alerts: InsightAlert[] = insights
      .filter((i) => i.severity === 'HIGH' || i.severity === 'CRITICAL')
      .map((i) => ({
        alertId: newId('event'),
        metric: i.evidence[0]?.metric ?? 'sku_returns_30d',
        observedValue: i.evidence[0]?.value ?? 0,
        thresholdValue: rules.PROMOTION.minSpikePct,
        severity: i.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
        message: i.title,
        notifyTeams: [i.owningTeam],
      }));

    /* -- fraud gets a non-blocking queue item ----------------------------- */
    if (caseSignals.some((s) => s.signalType === 'FRAUD_PATTERN')) {
      escalations.push(
        escalate('FRAUD_SIGNAL_DETECTED', {
          severity: 'MEDIUM',
          reason: 'Return-abuse pattern logged for risk review.',
          // Non-blocking BY DESIGN: the customer's return is not held up while
          // the risk team looks at the account.
          blocking: false,
          requiresHuman: true,
          suggestedQueue: 'FRAUD_REVIEW',
          priority: 3,
          context: { customerId: context.customer.customerId, flags: eligibility?.fraud.flags ?? [] },
        }),
      );
    }

    /* -- STEP 4: KPI contribution ----------------------------------------- */
    const escalatedAnywhere =
      (eligibility?.decision === 'MANUAL_REVIEW') ||
      (resolution?.requiresHumanApproval ?? false) ||
      (sentiment?.humanTouchRecommended ?? false);

    const kpiContribution: InsightsOutput['kpiContribution'] = {
      turnaroundHours: hoursBetween(context.order.deliveredAt ?? context.order.placedAt, context.now),
      costUsd: resolution?.costs.netCostUsd ?? null,
      co2PreventedKg: sustainability?.co2PreventedKg ?? null,
      fullyAutomated: !escalatedAnywhere,
      // Automation deflects a ticket whenever a resolution landed without a human.
      ticketDeflected: !escalatedAnywhere && resolution !== null,
      retainedRevenueUsd: resolution?.estimatedRetainedValueUsd ?? null,
      escalated: escalatedAnywhere,
    };

    const output: InsightsOutput = {
      caseSignals,
      insights,
      updatedInsightIds: [], // cross-case dedupe is done by the insight service
      trendUpdates,
      alerts,
      kpiContribution,
      suppressedReason: insights.length === 0 ? (coldStart ? 'No historical data yet — signals recorded only.' : suppressionReasons.join(' | ')) : null,
      topPriorityScore: insights.length ? Math.max(...insights.map((i) => i.priorityScore)) : null,
      executiveSummary: buildExecutiveSummary(caseSignals, insights, context.product.name, spikePct),
    };

    return {
      output,
      rationale: `Extracted ${caseSignals.length} signal(s) from this case; ${insights.length} cleared the promotion thresholds. ${insights.length ? `Top finding: ${insights[0]!.title}.` : (output.suppressedReason ?? 'Nothing material to report.')}`,
      confidence: coldStart ? 0.5 : 0.86,
      warnings,
      escalations,
      inputsUsed: ['intent.reason', 'context.historicalAggregates', 'context.order.deliveryCondition', 'eligibility.ruleTrace', 'sentiment.churnRisk', 'logistics.estimatedCostUsd', 'sustainability.record'],
    };
  }
}

function buildExecutiveSummary(
  signals: InsightsOutput['caseSignals'],
  insights: Insight[],
  productName: string,
  spikePct: number,
): string {
  if (insights.length > 0) {
    return `${insights[0]!.title}. ${insights.length > 1 ? `${insights.length - 1} further finding(s) logged. ` : ''}Owned by ${insights[0]!.owningTeam.replace(/_/g, ' ').toLowerCase()}.`;
  }
  if (signals.length > 0) {
    return `Logged ${signals.length} signal(s) for ${productName} (30-day volume ${spikePct >= 0 ? '+' : ''}${spikePct}%). None yet material enough to raise an insight.`;
  }
  return `No notable patterns in this return.`;
}

export const insightsAgent = new InsightsAgent();
